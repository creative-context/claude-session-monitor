// mac-app-kit 0.1.0 (server-kit.ts). Vendored: don't edit here. Change it in the kit and vendor again.
// The local server's life, shared by the family's Mac apps. Each app's server.ts keeps its
// own data and routes; this holds what they all do the same way:
//   - it listens on 127.0.0.1 only and answers only its own host name (no DNS rebinding);
//   - it exits with code 3 when the port is taken, so the app looks at that copy instead
//     of starting it again;
//   - it stops when the app that started it is gone (its pid comes in an env variable);
//   - a throw in a timer or a stray rejection is logged and the server carries on;
//   - /api/state and /api/stream: the page's state as JSON, streamed only when what the page
//     would draw changed, with a ping every 9 s so the page notices a dead server;
//   - the page's files, flat in one folder;
//   - one tick every 3 s for what changes with the clock.

import { join } from "node:path";

// ---------------------------------------------------------------- staying up

// A throw is written to the log (server.log, in the app) once every 10 minutes at most.
const reported = new Map<string, number>();
export function report(name: string, e: unknown) {
  const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
  const key = `${name}\n${text.split("\n", 1)[0]}`;
  const t = Date.now();
  if (t - (reported.get(key) ?? 0) < 10 * 60_000) return;
  reported.set(key, t);
  console.error(`${new Date(t).toISOString()} ${name} failed, still running: ${text.split("\n").slice(0, 6).join("\n")}`);
}
export const safe = (name: string, fn: () => void) => () => {
  try {
    fn();
  } catch (e) {
    report(name, e);
  }
};

// Whether the process with this pid is gone. 0 means no app to watch.
export function parentGone(pid: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e: any) {
    return e?.code === "ESRCH";
  }
}

// ---------------------------------------------------------------- the server

export type Tick = [every: number, name: string, fn: () => void]; // every n ticks of 3 s

export type ServerOptions = {
  name: string; // "Claude Session Monitor": for the log line
  port: number;
  publicDir: string; // the page's files, flat
  parentEnv: string; // the env variable with the app's pid: "CSM_PARENT_PID"
  serverVersion: string; // the app's version, for the log and /api/state's server field
  state: () => string; // the page's state as JSON, starting with {"now":…,
  stateVersion: () => number; // bumps when the state changed, so the JSON is built again
  routes?: (req: Request, url: URL) => Response | Promise<Response> | undefined; // the app's own /api/…
  start?: () => void; // after the port is ours: open the database, read what's there
  stop?: () => void; // on the way out: write what's left
  ticks?: Tick[];
  startedWords?: () => string; // more for the log line: "(12 sessions from the log, …)"
  noStore?: boolean; // the state and the page's files with cache-control: no-store
  typed?: boolean; // the page's files with a content type from their extension (otherwise Bun's)
};

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" };
export const TICK_MS = 3000;

export function createServer(o: ServerOptions) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const parent = Number(process.env[o.parentEnv]) || 0;
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);

  // The state as JSON, built once per change and shared by the stream and /api/state. A
  // second old at most, for the times in it.
  let built = { version: -1, at: 0, json: "" };
  function stateJson() {
    const t = Date.now();
    const v = o.stateVersion();
    if (built.version !== v || t - built.at > 1000) built = { version: v, at: t, json: o.state() };
    return built.json;
  }

  // Sends the state to the page when it changed, and only then: the same JSON but for the
  // clock sends nothing.
  let sentKey = "";
  function broadcast() {
    if (!clients.size) return;
    const json = stateJson();
    const key = json.replace(/^\{"now":\d+,/, "{");
    if (key === sentKey) return;
    sentKey = key;
    const msg = enc.encode(`data: ${json}\n\n`);
    for (const c of clients) {
      try {
        c.enqueue(msg);
      } catch {
        clients.delete(c);
      }
    }
  }

  // A ping keeps the stream open through idle timeouts, and lets the page notice a dead
  // server even when the connection doesn't close (a proxy, a sleeping Mac).
  function ping() {
    for (const c of clients) {
      try {
        c.enqueue(enc.encode("event: ping\ndata: {}\n\n"));
      } catch {
        clients.delete(c);
      }
    }
  }

  function stop(code: number) {
    try { o.stop?.(); } catch {}
    process.exit(code);
  }

  const noStore = o.noStore ? { "cache-control": "no-store" } : {};

  async function fetch(req: Request): Promise<Response> {
    // Blocks DNS-rebinding tricks: only answer to our own host name.
    if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);

    if (url.pathname === "/api/state") return new Response(stateJson(), { headers: { "content-type": "application/json", ...noStore } });

    if (url.pathname === "/api/stream") {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            clients.add(c);
            c.enqueue(enc.encode(`data: ${stateJson()}\n\n`));
          },
          cancel() {
            clients.delete(ctrl);
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    }

    const own = await o.routes?.(req, url);
    if (own) return own;

    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[\w.-]+$/.test(file)) return new Response("Not found", { status: 404 });
    const f = Bun.file(join(o.publicDir, file));
    if (!(await f.exists())) return new Response("Not found", { status: 404 });
    if (!o.typed && !o.noStore) return new Response(f);
    const ext = file.split(".").pop() ?? "";
    return new Response(f, { headers: { ...(o.typed ? { "content-type": TYPES[ext] ?? "application/octet-stream" } : {}), ...noStore } });
  }

  // Only when run, so an app's parts can be imported without starting anything.
  function start() {
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1", // never reachable from other machines
        port: o.port,
        idleTimeout: 60,
        fetch,
      });
    } catch (e: any) {
      // Another copy has the port: exit 3 tells the app to look at that one, not to restart.
      if (e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use|port \d+ in use/i.test(String(e?.message ?? e))) {
        console.error(`${new Date().toISOString()} port ${o.port} is taken`);
        process.exit(3);
      }
      throw e;
    }

    o.start?.();
    // From here on nothing ends the server: what fails is logged, and it carries on.
    process.on("uncaughtException", (e) => report("uncaught", e));
    process.on("unhandledRejection", (e) => report("unhandled rejection", e));
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop(0));

    // One tick every 3 s for what changes with the clock or that a file event could miss.
    // Each part on its own, so one that throws doesn't stop the rest.
    const every: Tick[] = [
      [1, "parent", () => { if (parentGone(parent)) { console.error(`${new Date().toISOString()} the app is gone (pid ${parent}); stopping`); stop(0); } }],
      ...(o.ticks ?? []),
      [3, "ping", ping],
    ];
    const parts = every.map(([n, name, fn]) => [n, safe(name, fn)] as const);
    let ticks = 0;
    setInterval(() => {
      ticks++;
      for (const [n, fn] of parts) if (ticks % n === 0) fn();
    }, TICK_MS);

    console.log(`${o.name} server on http://${server.hostname}:${server.port}  (${o.startedWords ? o.startedWords() + ", " : ""}version ${o.serverVersion}, pid ${process.pid})`);
    return server;
  }

  return { start, stop, broadcast, stateJson, clients };
}
