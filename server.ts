// Claude Session Monitor server. Reads the events the hook appends to ~/.claude-session-monitor/events.jsonl, keeps
// one small state per Claude Code session, and pushes it to the strip page.
//
//   bun server.ts            → http://127.0.0.1:4747
//
// Read-only toward Claude: it never writes to ~/.claude or to the desktop app's files.
// This file is the web server, the timers and startup; the parts live in src/, and the app
// carries them bundled into one server.js (app/build.sh).

import { type FSWatcher, mkdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { DIR, LOG, PORT } from "./src/config.ts";
import { bumpView, onBump, sessions, version } from "./src/state.ts";
import { hydrate } from "./src/session.ts";
import { pump, replay, savePosition } from "./src/log.ts";
import { checkProcesses, checkQuietTurns, checkRelayed, checkTurns, relinkRelays } from "./src/turns.ts";
import { db, forgetOld, history, loadRecent, openDatabase, persist } from "./src/db.ts";
import { readDesktopSessions } from "./src/desktop.ts";
import { scanAllAgents } from "./src/agents.ts";
import { loadHistory, PROBE_EVERY, probeUsage, readUsage, usageView } from "./src/usage.ts";
import { SERVER, snapshot } from "./src/snapshot.ts";

// Next to this file, both in a checkout and in the app, where server.js is the bundle.
const PUBLIC = join(import.meta.dir, "public");
const STATUS_LINE = join(import.meta.dir, "hooks", "statusline.sh");

// ---------------------------------------------------------------- web server

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

// The state as JSON, built once per change and shared by the stream and /api/state. A
// second old at most, for the times in it.
let built = { version: -1, at: 0, json: "" };
function stateJson() {
  const t = Date.now();
  if (built.version !== version || t - built.at > 1000) built = { version, at: t, json: JSON.stringify(snapshot()) };
  return built.json;
}

// Sends the state to the page when it changed, and only then: a change that the page
// doesn't see (the same JSON but for the clock) sends nothing.
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

// ---------------------------------------------------------------- staying up

// A throw in a timer or a stray rejection is written to the log (server.log, in the app),
// and the server carries on. The same failure is written once every 10 minutes at most.
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

// The app passes its own pid: when it's gone (it crashed, or was forced to quit), so is
// the server, so no orphan keeps the port.
const PARENT = Number(process.env.CSM_PARENT_PID) || 0;
export function parentGone(pid = PARENT) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e: any) {
    return e?.code === "ESRCH";
  }
}

function stop(code: number) {
  try { persist(true); savePosition(); db.close(); } catch {}
  process.exit(code);
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function fetch(req: Request): Promise<Response> {
  // Blocks DNS-rebinding tricks: only answer to our own host name.
  if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);

  if (url.pathname === "/api/state") return new Response(stateJson(), { headers: { "content-type": "application/json" } });

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
          c.enqueue(enc.encode(`data: ${stateJson()}\n\n`));
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

// ---------------------------------------------------------------- sending on change

const SEND_SOON = 30; // a burst of events goes out as one
const SEND_GAP = 250; // lesson from agents-observe: at most every 250 ms
let sendTimer: ReturnType<typeof setTimeout> | undefined;
let lastSend = 0;
function sendSoon() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = undefined;
    lastSend = Date.now();
    safe("checkTurns", checkTurnsSoon)();
    safe("send", broadcast)();
  }, Math.max(SEND_SOON, SEND_GAP - (Date.now() - lastSend)));
}

// The database gets the change 2 s later, with whatever else changed by then.
let writeTimer: ReturnType<typeof setTimeout> | undefined;
function writeSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    safe("persist", persist)();
  }, 2000);
}

// A turn that ended is read a moment after its Stop, once the closing message is in the
// transcript (CLASSIFY_AFTER): a timeout for the first one due, instead of a poll. A turn
// that is still not read after its look (it waits for the Claude app's summary) is looked
// at again every RETRY_AFTER, as the old poll did.
const CLASSIFY_AFTER = 800;
const RETRY_AFTER = 500;
let turnTimer: ReturnType<typeof setTimeout> | undefined;
let turnAt = Infinity;
function checkTurnsSoon(again = false) {
  let due = Infinity;
  for (const s of sessions.values()) if (s.status === "done" && !s.classified) due = Math.min(due, s.since + CLASSIFY_AFTER);
  if (due === Infinity) return;
  if (again) due = Math.max(due, Date.now() + RETRY_AFTER);
  if (due >= turnAt) return;
  clearTimeout(turnTimer);
  turnAt = due;
  turnTimer = setTimeout(() => {
    turnTimer = undefined;
    turnAt = Infinity;
    safe("checkTurns", checkTurns)();
    safe("checkTurns", () => checkTurnsSoon(true))(); // one still waiting, or one that came meanwhile
  }, Math.max(0, due - Date.now()));
}

// ---------------------------------------------------------------- start

// Only when run, so the parts above and in src/ can be imported without starting anything.
export function start() {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1", // never reachable from other machines
      port: PORT,
      idleTimeout: 60,
      fetch,
    });
  } catch (e: any) {
    // Another copy has the port: exit 3 tells the app to look at that one, not to restart.
    if (e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use|port \d+ in use/i.test(String(e?.message ?? e))) {
      console.error(`${new Date().toISOString()} port ${PORT} is taken`);
      process.exit(3);
    }
    throw e;
  }

  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  openDatabase();
  // From here on nothing ends the server: what fails is logged, and it carries on.
  process.on("uncaughtException", (e) => report("uncaught", e));
  process.on("unhandledRejection", (e) => report("unhandled rejection", e));
  safe("loadRecent", loadRecent)(); // the last week, as it was when the server stopped
  safe("replay", replay)(); // then whatever the hooks wrote since
  for (const s of sessions.values()) safe("hydrate", () => hydrate(s))();
  safe("readDesktopSessions", readDesktopSessions)();
  safe("checkProcesses", checkProcesses)();
  safe("scanAllAgents", scanAllAgents)();
  safe("checkTurns", checkTurns)(); // sessions that ended while the server was off
  safe("relinkRelays", relinkRelays)(); // which of them pass on another session's question
  safe("checkRelayed", checkRelayed)(); // and which of those were answered meanwhile
  safe("persist", persist)();
  onBump((write) => {
    sendSoon();
    if (write) writeSoon();
  });

  // Write everything once more on the way out (the app stops the server on quit).
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop(0));

  let pumpQueued = false;
  function schedulePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    setTimeout(() => {
      pumpQueued = false;
      safe("pump", pump)();
    }, 50);
  }

  // The folder's watch doesn't always say when a file in it grows, so the log has a watch
  // of its own, set again when the file is replaced (rotated, or made anew by the hook).
  let logWatch: FSWatcher | undefined;
  let logIno = 0;
  function watchLog() {
    let ino = 0;
    try {
      ino = statSync(LOG).ino;
    } catch {}
    if (ino === logIno) return;
    logWatch?.close();
    logWatch = undefined;
    logIno = ino;
    if (!ino) return;
    try {
      logWatch = watch(LOG, () => schedulePump());
    } catch {
      logIno = 0;
    }
    schedulePump(); // what it got before the watch
  }
  watchLog();
  try {
    watch(DIR, (_, name) => {
      if (!name || name === "events.jsonl") {
        safe("watchLog", watchLog)();
        schedulePump();
      }
      if (!name || name === "usage.json") safe("readUsage", readUsage)();
    });
  } catch {}

  loadHistory();
  safe("readUsage", readUsage)();

  // One tick every 3 s for everything that changes with the clock or that a file event
  // could miss, so the server wakes about once in 3 s when nothing happens. Each part on
  // its own, so one that throws doesn't stop the rest.
  // A task's next run, a missed run and a blocked one change with the clock, not with an
  // event; so does whether a question from yesterday still needs you.
  let taskClock = "";
  const taskTick = () => {
    const snap = snapshot();
    const sig = JSON.stringify([
      snap.tasks.map((t) => [t.id, t.next, t.missed, t.blocked?.since, t.blocked?.run?.sid, t.blocked?.queued]),
      snap.attention.map((a) => [a.kind, a.id, a.words]),
    ]);
    if (sig !== taskClock) {
      taskClock = sig;
      bumpView();
    }
  };
  // A window leaves the header when it resets.
  let usageClock = "";
  const usageTick = () => {
    readUsage();
    const sig = JSON.stringify(usageView(Date.now()));
    if (sig !== usageClock) {
      usageClock = sig;
      bumpView();
    }
  };
  // A ping keeps the stream open through idle timeouts, and lets the page notice a dead
  // server even when the connection doesn't close (a proxy, a sleeping Mac).
  const ping = () => {
    for (const c of clients) {
      try {
        c.enqueue(enc.encode("event: ping\ndata: {}\n\n"));
      } catch {
        clients.delete(c);
      }
    }
  };
  const TICK = 3000;
  const every: [number, string, () => void][] = [
    [1, "parent", () => { if (parentGone()) { console.error(`${new Date().toISOString()} the app is gone (pid ${PARENT}); stopping`); stop(0); } }],
    [1, "checkQuietTurns", checkQuietTurns],
    [1, "checkRelayed", checkRelayed],
    [1, "scanAllAgents", scanAllAgents],
    [1, "checkTurns", checkTurns], // in case a timeout was missed
    [1, "watchLog", watchLog],
    [2, "pump", pump], // in case a file event was missed
    [2, "usage", usageTick],
    [3, "ping", ping],
    [3, "checkProcesses", checkProcesses],
    [5, "readDesktopSessions", readDesktopSessions],
    [10, "tasks", taskTick],
    [20, "forgetOld", forgetOld],
  ];
  const parts = every.map(([n, name, fn]) => [n, safe(name, fn)] as const);
  let ticks = 0;
  setInterval(() => {
    ticks++;
    for (const [n, fn] of parts) if (ticks % n === 0) fn();
  }, TICK);

  // The usage probe: every 10 minutes at most, and only after something happened here.
  setTimeout(safe("probeUsage", () => probeUsage(STATUS_LINE)), 20_000);
  setInterval(safe("probeUsage", () => probeUsage(STATUS_LINE)), PROBE_EVERY);

  console.log(`Claude Session Monitor server on http://${server.hostname}:${server.port}  (${sessions.size} sessions from the log, version ${SERVER.version}, pid ${process.pid})`);
}


if (import.meta.main) start();
