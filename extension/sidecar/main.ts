// Playwright sidecar child process.
//
// Spawned by the extension host. Talks newline-delimited JSON:
//   stdin  <- SidecarRequest  (one JSON object per line)
//   stdout -> SidecarResponse (one JSON object per line)
//   stderr -> human/debug logs only (never protocol data)
//
// Owns ONE headless Playwright Chromium and ONE persistent Page. All command
// handling is serialized through a promise-chain mutex so concurrent requests
// can never race on the shared page.
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import * as readline from "node:readline";
import type {
  SidecarRequest,
  SidecarResponse,
  ConsoleEntry,
  NetworkEntry,
  LinkInfo,
} from "../src/types";

const RING_CAP = 200;
const consoleBuf: ConsoleEntry[] = [];
const networkBuf: NetworkEntry[] = [];

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

function pushCapped<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > RING_CAP) buf.shift();
}

function clearBuffers(): void {
  consoleBuf.length = 0;
  networkBuf.length = 0;
}

function attachListeners(pg: Page): void {
  pg.on("console", (msg) => {
    const loc = msg.location();
    const location =
      loc && loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined;
    pushCapped<ConsoleEntry>(consoleBuf, {
      type: msg.type(),
      text: msg.text(),
      location,
      t: Date.now(),
    });
  });
  pg.on("pageerror", (err) => {
    pushCapped<ConsoleEntry>(consoleBuf, {
      type: "error",
      text: err instanceof Error ? err.message : String(err),
      t: Date.now(),
    });
  });
  pg.on("response", (resp) => {
    pushCapped<NetworkEntry>(networkBuf, {
      url: resp.url(),
      status: resp.status(),
      method: resp.request().method(),
      failed: false,
      t: Date.now(),
    });
  });
  pg.on("requestfailed", (req) => {
    pushCapped<NetworkEntry>(networkBuf, {
      url: req.url(),
      status: 0,
      method: req.method(),
      failed: true,
      t: Date.now(),
    });
  });
}

// Lazily launch headless Chromium + one context + one page. Honors
// PLAYWRIGHT_BROWSERS_PATH automatically via playwright-core; otherwise the
// default cache (~/Library/Caches/ms-playwright) is used. Recovers if the
// browser was lost.
async function ensurePage(): Promise<Page> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    context = undefined; // old context belonged to the dead browser
    page = undefined;
  }
  if (!page || page.isClosed()) {
    if (context) {
      await context.close().catch(() => {}); // don't leak the previous context on recovery
    }
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    page = await context.newPage();
    attachListeners(page);
    clearBuffers(); // new page → drop the previous page's stale diagnostics
  }
  return page;
}

function respond(res: SidecarResponse): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}

async function shutdown(id: number): Promise<void> {
  process.stdout.write(JSON.stringify({ id, ok: true } satisfies SidecarResponse) + "\n", () => {
    void (async () => {
      try {
        await browser?.close();
      } catch {
        // ignore
      }
      process.exit(0);
    })();
  });
}

async function handle(req: SidecarRequest): Promise<void> {
  try {
    switch (req.cmd) {
      case "goto": {
        const pg = await ensurePage();
        clearBuffers();
        const resp = await pg.goto(req.url, { waitUntil: "load" });
        respond({ id: req.id, ok: true, url: pg.url(), title: await pg.title(), status: resp?.status() });
        break;
      }
      case "screenshot": {
        const pg = await ensurePage();
        const png = req.selector
          ? await pg.locator(req.selector).screenshot()
          : await pg.screenshot({ fullPage: !!req.fullPage });
        respond({ id: req.id, ok: true, pngBase64: png.toString("base64") });
        break;
      }
      case "click": {
        const pg = await ensurePage();
        const before = pg.url();
        // Detect navigation by flagging any main-frame navigation during the click — more
        // robust than a final URL diff (catches same-URL reloads and load-state races).
        let navd = false;
        const onNav = (f: import("playwright-core").Frame) => {
          if (f === pg.mainFrame()) navd = true;
        };
        pg.on("framenavigated", onNav);
        try {
          if (req.selector) {
            // .first() so a selector matching >1 element (e.g. a link repeated in nav +
            // body — common in docs) clicks the first match instead of throwing a
            // Playwright strict-mode violation. Mirrors the forgiving text path below.
            await pg.locator(req.selector).first().click();
          } else if (req.text) {
            await pg.getByText(req.text).first().click();
          } else {
            throw new Error("click requires a selector or text");
          }
          // Settle any navigation the click may have triggered before reading url.
          await pg.waitForLoadState("load").catch(() => {});
        } finally {
          pg.off("framenavigated", onNav);
        }
        const after = pg.url();
        respond({
          id: req.id,
          ok: true,
          navigated: navd || before !== after,
          url: after,
          title: await pg.title(),
        });
        break;
      }
      case "getText": {
        const pg = await ensurePage();
        respond({ id: req.id, ok: true, text: await pg.innerText("body") });
        break;
      }
      case "getLinks": {
        const pg = await ensurePage();
        const links = await pg.$$eval("a[href]", (els) =>
          (els as HTMLAnchorElement[]).map((a) => ({
            href: a.href,
            text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          })),
        );
        respond({ id: req.id, ok: true, links: links as LinkInfo[] });
        break;
      }
      case "getTitle": {
        const pg = await ensurePage();
        respond({ id: req.id, ok: true, url: pg.url(), title: await pg.title() });
        break;
      }
      case "getConsole": {
        respond({ id: req.id, ok: true, console: consoleBuf.slice() });
        break;
      }
      case "getNetwork": {
        respond({ id: req.id, ok: true, network: networkBuf.slice() });
        break;
      }
      case "currentUrl": {
        const pg = await ensurePage();
        respond({ id: req.id, ok: true, url: pg.url() });
        break;
      }
      case "back": {
        const pg = await ensurePage();
        clearBuffers();
        const r = await pg.goBack({ waitUntil: "load" });
        if (!r) {
          respond({ id: req.id, ok: true, navigated: false });
        } else {
          respond({
            id: req.id,
            ok: true,
            navigated: true,
            url: pg.url(),
            title: await pg.title(),
            status: r.status(),
          });
        }
        break;
      }
      case "forward": {
        const pg = await ensurePage();
        clearBuffers();
        const r = await pg.goForward({ waitUntil: "load" });
        if (!r) {
          respond({ id: req.id, ok: true, navigated: false });
        } else {
          respond({
            id: req.id,
            ok: true,
            navigated: true,
            url: pg.url(),
            title: await pg.title(),
            status: r.status(),
          });
        }
        break;
      }
      case "reload": {
        const pg = await ensurePage();
        clearBuffers();
        const resp = await pg.reload({ waitUntil: "load" });
        respond({ id: req.id, ok: true, url: pg.url(), title: await pg.title(), status: resp?.status() });
        break;
      }
      case "shutdown": {
        await shutdown(req.id);
        break;
      }
      default: {
        const anyReq = req as { id?: number };
        respond({
          id: typeof anyReq.id === "number" ? anyReq.id : 0,
          ok: false,
          error: `unknown cmd`,
        });
      }
    }
  } catch (e) {
    respond({
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Serialize handling: each line waits for the previous command to settle.
let chain: Promise<void> = Promise.resolve();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: SidecarRequest;
  try {
    req = JSON.parse(trimmed) as SidecarRequest;
  } catch {
    console.error("[sidecar] ignoring malformed line:", trimmed);
    return;
  }
  chain = chain.then(() => handle(req)).catch((e) => {
    console.error("[sidecar] handler error:", e);
  });
});

rl.on("close", () => {
  // stdin closed (parent gone): shut down cleanly.
  void (async () => {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    process.exit(0);
  })();
});

console.error("[sidecar] ready");
