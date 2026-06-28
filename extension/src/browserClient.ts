// Extension-host-side client to the Playwright sidecar child process.
//
// Implements BrowserEngine by framing newline-delimited JSON over the child's
// stdin/stdout: every method becomes a SidecarRequest with an incrementing id;
// responses are matched back by id and mapped to the typed result.
import type {
  BrowserEngine,
  CreateBrowserEngine,
  SidecarRequest,
  SidecarResponse,
} from "./types";

export const createBrowserEngine: CreateBrowserEngine = (child) => {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: SidecarResponse) => void; reject: (e: Error) => void }
  >();
  let stdoutBuf = "";
  let exited = false;
  let onExit: (() => void) | null = null;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: SidecarResponse;
      try {
        msg = JSON.parse(line) as SidecarResponse;
      } catch {
        continue; // not protocol data
      }
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  });

  child.on("exit", () => {
    exited = true;
    for (const p of pending.values()) p.reject(new Error("sidecar exited"));
    pending.clear();
    onExit?.();
  });
  child.on("error", (err) => {
    exited = true;
    for (const p of pending.values()) p.reject(err instanceof Error ? err : new Error(String(err)));
    pending.clear();
    onExit?.();
  });

  function send(req: SidecarRequest): Promise<SidecarResponse> {
    return new Promise<SidecarResponse>((resolve, reject) => {
      if (exited) {
        reject(new Error("sidecar is not running"));
        return;
      }
      pending.set(req.id, { resolve, reject });
      try {
        child.stdin?.write(JSON.stringify(req) + "\n");
      } catch (e) {
        pending.delete(req.id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // Send a request and reject on a non-ok response.
  async function call(req: SidecarRequest): Promise<SidecarResponse> {
    const res = await send(req);
    if (!res.ok) throw new Error(res.error || "sidecar error");
    return res;
  }

  const engine: BrowserEngine = {
    async goto(url) {
      const r = await call({ id: nextId++, cmd: "goto", url });
      return { url: r.url ?? "", title: r.title ?? "", status: r.status };
    },
    async screenshot(opts) {
      const r = await call({
        id: nextId++,
        cmd: "screenshot",
        fullPage: opts?.fullPage,
        selector: opts?.selector,
      });
      return Buffer.from(r.pngBase64 ?? "", "base64");
    },
    async click(target) {
      const r = await call({
        id: nextId++,
        cmd: "click",
        selector: target.selector,
        text: target.text,
      });
      return { url: r.url ?? "", title: r.title ?? "", navigated: r.navigated === true };
    },
    async getText() {
      const r = await call({ id: nextId++, cmd: "getText" });
      return r.text ?? "";
    },
    async getLinks() {
      const r = await call({ id: nextId++, cmd: "getLinks" });
      return r.links ?? [];
    },
    async getTitle() {
      const r = await call({ id: nextId++, cmd: "getTitle" });
      return { url: r.url ?? "", title: r.title ?? "" };
    },
    async getConsole() {
      const r = await call({ id: nextId++, cmd: "getConsole" });
      return r.console ?? [];
    },
    async getNetwork() {
      const r = await call({ id: nextId++, cmd: "getNetwork" });
      return r.network ?? [];
    },
    async back() {
      const r = await call({ id: nextId++, cmd: "back" });
      if (r.navigated === false) return null;
      return { url: r.url ?? "", title: r.title ?? "", status: r.status };
    },
    async forward() {
      const r = await call({ id: nextId++, cmd: "forward" });
      if (r.navigated === false) return null;
      return { url: r.url ?? "", title: r.title ?? "", status: r.status };
    },
    async reload() {
      const r = await call({ id: nextId++, cmd: "reload" });
      return { url: r.url ?? "", title: r.title ?? "", status: r.status };
    },
    async currentUrl() {
      const r = await call({ id: nextId++, cmd: "currentUrl" });
      return r.url ?? "";
    },
    dispose() {
      return new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        onExit = finish;
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          finish();
        }, 4000);
        try {
          child.stdin?.write(JSON.stringify({ id: nextId++, cmd: "shutdown" }) + "\n");
        } catch {
          try {
            child.kill();
          } catch {
            // ignore
          }
          finish();
        }
      });
    },
  };

  return engine;
};
