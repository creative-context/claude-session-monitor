// Claude Session Monitor server. Reads the events the hook appends to ~/.claude-session-monitor/events.jsonl, keeps
// one small state per Claude Code session, and pushes it to the strip page.
//
//   bun server.ts            → http://127.0.0.1:4747
//
// Read-only toward Claude: it never writes to ~/.claude or to the desktop app's files.
// This file is the web server, the timers and startup; the parts live in src/, and the app
// carries them bundled into one server.js (app/build.sh).

import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { DIR, PORT } from "./src/config.ts";
import { bump, sessions, version } from "./src/state.ts";
import { hydrate } from "./src/session.ts";
import { pump, replay } from "./src/log.ts";
import { checkProcesses, checkQuietTurns, checkRelayed, checkTurns } from "./src/turns.ts";
import { db, forgetOld, history, loadRecent, openDatabase, persist } from "./src/db.ts";
import { readDesktopSessions } from "./src/desktop.ts";
import { scanAllAgents } from "./src/agents.ts";
import { taskList } from "./src/tasks.ts";
import { loadHistory, PROBE_EVERY, probeUsage, readUsage, usageView } from "./src/usage.ts";
import { snapshot } from "./src/snapshot.ts";

// Next to this file, both in a checkout and in the app, where server.js is the bundle.
const PUBLIC = join(import.meta.dir, "public");
const STATUS_LINE = join(import.meta.dir, "hooks", "statusline.sh");

// ---------------------------------------------------------------- web server

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

function broadcast() {
  const msg = enc.encode(`data: ${JSON.stringify(snapshot())}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(msg);
    } catch {
      clients.delete(c);
    }
  }
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function fetch(req: Request): Promise<Response> {
  // Blocks DNS-rebinding tricks: only answer to our own host name.
  if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);

  if (url.pathname === "/api/state") return Response.json(snapshot());

  if (url.pathname === "/api/history") {
    persist(); // so this week's latest changes are in it
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    return Response.json(history(q, limit, offset));
  }

  if (url.pathname === "/api/stream") {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(enc.encode(`data: ${JSON.stringify(snapshot())}\n\n`));
        },
        cancel() {
          clients.delete(ctrl);
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    );
  }

  // Opens the session in the desktop app. POST plus a custom header means a
  // web page on another site cannot trigger it (the browser would need a
  // preflight we never answer).
  const open = url.pathname.match(/^\/api\/open\/(.+)$/);
  if (open && req.method === "POST" && req.headers.get("x-csm") === "1") {
    // From this week's sessions, or from History.
    const live = sessions.get(open[1]);
    const row = live ? null : (db.query("SELECT sid, cwd, app_cwd FROM sessions WHERE sid = ?").get(open[1]) as any);
    const s = live ?? (row ? { sid: row.sid as string, appCwd: row.app_cwd ?? undefined, cwd: row.cwd ?? undefined } : null);
    if (!s || !UUID.test(s.sid)) return new Response("Not found", { status: 404 });
    const cwd = s.appCwd ?? s.cwd;
    const link = `claude://resume?session=${encodeURIComponent(s.sid)}` +
      (cwd ? `&cwd=${encodeURIComponent(cwd)}` : "");
    Bun.spawn(["open", link]);
    return new Response(null, { status: 204 });
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(file)) return new Response("Not found", { status: 404 });
  const f = Bun.file(join(PUBLIC, file));
  return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------- start

// Only when run, so the parts above and in src/ can be imported without starting anything.
export function start() {
  const server = Bun.serve({
    hostname: "127.0.0.1", // never reachable from other machines
    port: PORT,
    idleTimeout: 60,
    fetch,
  });

  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  openDatabase();
  loadRecent(); // the last week, as it was when the server stopped
  replay(); // then whatever the hooks wrote since
  for (const s of sessions.values()) hydrate(s);
  readDesktopSessions();
  checkProcesses();
  scanAllAgents();
  checkTurns(); // sessions that ended while the server was off
  persist();

  setInterval(persist, 2000);
  // Write everything once more on the way out (the app stops the server on quit).
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      try { persist(); db.close(); } catch {}
      process.exit(0);
    });
  }

  let sent = -1;
  let pumpQueued = false;
  function schedulePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    setTimeout(() => {
      pumpQueued = false;
      pump();
    }, 50);
  }

  try {
    watch(DIR, (_, name) => {
      if (!name || name === "events.jsonl") schedulePump();
      if (!name || name === "usage.json") readUsage();
    });
  } catch {}

  setInterval(pump, 1000); // safety net in case a file event is missed
  setInterval(checkQuietTurns, 3000);
  setInterval(checkRelayed, 3000);
  setInterval(checkTurns, 500);
  setInterval(scanAllAgents, 3000);
  setInterval(checkProcesses, 10_000);
  setInterval(readDesktopSessions, 15_000);
  // A task's next run, a missed run and a blocked one change with the clock, not with an event.
  let taskClock = "";
  setInterval(() => {
    const sig = JSON.stringify(taskList(Date.now()).map((t) => [t.id, t.next, t.missed, t.blocked?.since, t.blocked?.run?.sid, t.blocked?.queued]));
    if (sig !== taskClock) {
      taskClock = sig;
      bump();
    }
  }, 30_000);
  // The usage file is read when it changes, and a window leaves the header when it resets.
  loadHistory();
  readUsage();
  let usageClock = "";
  setInterval(() => {
    readUsage();
    const sig = JSON.stringify(usageView(Date.now()));
    if (sig !== usageClock) {
      usageClock = sig;
      bump();
    }
  }, 5000);
  setTimeout(() => probeUsage(STATUS_LINE), 20_000);
  setInterval(() => probeUsage(STATUS_LINE), PROBE_EVERY);
  setInterval(forgetOld, 60_000);
  // Lesson from agents-observe: throttle what goes to the page, at most every 250 ms.
  setInterval(() => {
    if (version !== sent) {
      sent = version;
      broadcast();
    }
  }, 250);
  // A ping every 10 s keeps the stream open through idle timeouts, and lets the page
  // notice a dead server even when the connection doesn't close (a proxy, a sleeping Mac).
  setInterval(() => {
    for (const c of clients) {
      try {
        c.enqueue(enc.encode("event: ping\ndata: {}\n\n"));
      } catch {
        clients.delete(c);
      }
    }
  }, 10_000);

  console.log(`Claude Session Monitor server on http://${server.hostname}:${server.port}  (${sessions.size} sessions from the log)`);
}

if (import.meta.main) start();
