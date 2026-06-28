import { chromium, type Browser, type Page } from "playwright";

// Modest, deterministic viewport so screenshots stay small (token budget) and stable.
const VIEWPORT = { width: 1280, height: 800 };

let browser: Browser | undefined;
let page: Page | undefined;

/**
 * Return the single shared page, lazily launching one headless Chromium for the
 * lifetime of the process. Reused across every tool call so navigate -> screenshot
 * -> get_text operate on the same page. Recovers if the browser crashed/disconnected.
 */
export async function getPage(): Promise<Page> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    browser.on("disconnected", () => {
      browser = undefined;
      page = undefined;
    });
    page = undefined;
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  }
  return page;
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = undefined;
  page = undefined;
  await b?.close().catch(() => {});
}

// Promise-chain mutex: serialize tool bodies so concurrent calls can't race on the
// shared page (e.g. a screenshot landing mid-navigation). Each call waits for the
// previous to settle, regardless of success/failure.
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}
