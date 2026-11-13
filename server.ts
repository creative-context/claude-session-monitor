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
import { createServer, parentGone as kitParentGone, safe } from "./src/server-kit.ts";

// Next to this file, both in a checkout and in the app, where server.js is the bundle.
const PUBLIC = join(import.meta.dir, "public");
const STATUS_LINE = join(import.meta.dir, "hooks", "statusline.sh");

// ---------------------------------------------------------------- web server

// What every app of the family does the same way (the host check, /api/state and the
// stream, the page's files, exit 3, stopping with the app, the 3 s tick) is in the app
// kit, vendored as src/server-kit.ts. This file keeps Session Monitor's own.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function routes(req: Request, url: URL): Response | undefined {
  if (url.pathname === "/api/history") {
    persist(); // so this week's latest changes are in it
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    return Response.json(history(q, limit, offset));
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
  return undefined;
}

export { report, safe } from "./src/server-kit.ts";
export const parentGone = (pid = Number(process.env.CSM_PARENT_PID) || 0) => kitParentGone(pid);

// ---------------------------------------------------------------- sending on change

let server: ReturnType<typeof createServer> | undefined;

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
    safe("send", () => server?.broadcast())();
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

  server = createServer({
    name: "Claude Session Monitor",
    port: PORT,
    publicDir: PUBLIC,
    parentEnv: "CSM_PARENT_PID",
    serverVersion: SERVER.version,
    state: () => JSON.stringify(snapshot()),
    stateVersion: () => version,
    routes,
    startedWords: () => `${sessions.size} sessions from the log`,
    // Write everything once more on the way out (the app stops the server on quit).
    stop: () => { persist(true); savePosition(); db.close(); },
    start: () => {
      mkdirSync(DIR, { recursive: true, mode: 0o700 });
      openDatabase();
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
    },
    // One tick every 3 s for everything that changes with the clock or that a file event
    // could miss, so the server wakes about once in 3 s when nothing happens.
    ticks: [
      [1, "checkQuietTurns", checkQuietTurns],
      [1, "checkRelayed", checkRelayed],
      [1, "scanAllAgents", scanAllAgents],
      [1, "checkTurns", checkTurns], // in case a timeout was missed
      [1, "watchLog", watchLog],
      [2, "pump", pump], // in case a file event was missed
      [2, "usage", usageTick],
      [3, "checkProcesses", checkProcesses],
      [5, "readDesktopSessions", readDesktopSessions],
      [10, "tasks", taskTick],
      [20, "forgetOld", forgetOld],
    ],
  });
  server.start();

  // The usage probe: every 10 minutes at most, and only after something happened here.
  setTimeout(safe("probeUsage", () => probeUsage(STATUS_LINE)), 20_000);
  setInterval(safe("probeUsage", () => probeUsage(STATUS_LINE)), PROBE_EVERY);
}

if (import.meta.main) start();
