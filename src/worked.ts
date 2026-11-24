// Time working: how long each session's own turn was working, per local day, for the Most
// active filter. A turn counts from when it starts working until it stops, waits on you,
// errors or ends; waiting on a permission or a question doesn't count, and neither do
// subagents or background commands still running after the turn ended (the session's own
// status isn't "working" then). Kept in sessions.db as one small JSON value per session.
//
// The log is read again at startup (a few seconds twice after a crash, or its last 4 MB when
// where reading stopped is lost), so the same turn can be seen twice: `to` is how far time has
// been counted, and only what comes after it is ever added.

import type { Session } from "./state.ts";

export type Worked = {
  to: number; // counted up to here
  d: Record<string, number>; // ms per local day, "2026-11-24"
  from?: number; // its turn has been working since then, not counted yet
};

const KEEP_DAYS = 8; // the last 7 days roll, with a day to spare
export const SHOW_DAYS = 7; // today and the 6 days before it
export const TOP = 10; // how many the filter shows

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// Local midnight `back` days before the day of t.
const dayStart = (t: number, back = 0) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
};
const nextMidnight = (t: number) => {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
};

// A session met for the first time in memory may already have a row (an old one, or an
// archived one): src/db.ts hands what the row keeps, so its count goes on from there.
let loader: ((sid: string) => Worked | undefined) | undefined;
export const setWorkedLoader = (fn: typeof loader) => { loader = fn; };

export function workedOf(s: Session): Worked {
  if (!s.worked) s.worked = loader?.(s.sid) ?? { to: 0, d: {} };
  return s.worked;
}

// Reads the stored value; anything malformed is dropped.
export function parseWorked(v: unknown): Worked | undefined {
  try {
    const w = typeof v === "string" ? JSON.parse(v) : null;
    if (!w || typeof w.to !== "number" || typeof w.d !== "object" || !w.d) return undefined;
    const d: Record<string, number> = {};
    for (const [k, n] of Object.entries(w.d)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof n === "number" && n > 0) d[k] = n;
    return { to: w.to, d, ...(typeof w.from === "number" ? { from: w.from } : {}) };
  } catch {
    return undefined;
  }
}
// Once anything was counted or closed (to > 0), the row keeps it, so a closed turn's start never lingers there.
export const storedWorked = (w: Worked | undefined) =>
  w && (Object.keys(w.d).length || w.from != null || w.to > 0) ? JSON.stringify(w) : null;

// Adds [from, end) to its days, only the part after what was already counted.
export function addWorked(w: Worked, from: number, end: number) {
  let a = Math.max(from, w.to);
  if (!(end > a)) return;
  while (a < end) {
    const b = Math.min(end, nextMidnight(a));
    const k = dayKey(a);
    w.d[k] = (w.d[k] ?? 0) + (b - a);
    a = b;
  }
  w.to = end;
  const oldest = dayKey(dayStart(Math.max(end, Date.now()), KEEP_DAYS - 1));
  for (const k of Object.keys(w.d)) if (k < oldest) delete w.d[k];
}

// Called on every status change (src/session.ts): entering "working" opens the count, leaving
// it closes it at `end` (the change's time, or the last sign of life for a turn found over later).
export function noteStatus(s: Session, was: Session["status"], next: Session["status"], t: number, end = t) {
  if (was === next) return;
  if (next === "working") {
    const w = workedOf(s);
    w.from = t;
  } else if (was === "working") {
    const w = workedOf(s);
    if (w.from != null) addWorked(w, w.from, end);
    w.from = undefined;
    w.to = Math.max(w.to, end); // closed up to here, even when nothing was left to count
  }
}

// Ms working in the last 7 days, with the part of a turn still working now.
export function workedMs(s: Session, now: number) {
  const w = workedOf(s);
  return totalOf(w, now, s.status === "working");
}
export function totalOf(w: Worked | undefined, now: number, working = false) {
  if (!w) return 0;
  const start = dayStart(now, SHOW_DAYS - 1), first = dayKey(start);
  let n = 0;
  for (const [k, ms] of Object.entries(w.d)) if (k >= first) n += ms;
  if (working && w.from != null) n += Math.max(0, now - Math.max(w.from, w.to, start));
  return n;
}

// ---------------------------------------------------------------- filling in from the log

// Counting began with the version that brought it, so the turns read before then had no time.
// Once, at a start, the server reads the event log again (events.1.jsonl, then events.jsonl,
// oldest first) and works out each session's working time with the same rules as above: from
// a turn's start until it stops, waits on you or ends; a subagent's own events never start a
// turn, and its permission request is a wait until that agent moves on. A turn that ended with
// no Stop (stopped with Esc, or an API error; the live count reads the transcript for those) is
// taken as over at its own last event when a new prompt comes, or when it went quiet for
// QUIET_MS with no tool running. A turn still open at the end of the log isn't counted: the
// live count has it. Broken lines are skipped.
const QUIET_MS = 2 * 60 * 60 * 1000;
type Sim = { w: Worked; on: boolean; from: number; wait?: { agent?: string; prev: boolean }; inFlight: number; last: number };
export function workedFromLog(texts: string[]): Map<string, Worked> {
  const sims = new Map<string, Sim>();
  const open = (x: Sim, t: number) => { if (!x.on) { x.on = true; x.from = t; } };
  const close = (x: Sim, end: number) => { if (x.on) addWorked(x.w, x.from, end); x.on = false; };
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!line) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e.sid !== "string" || typeof e.t !== "number" || typeof e.ev !== "string") continue;
      let x = sims.get(e.sid);
      if (!x) sims.set(e.sid, (x = { w: { to: 0, d: {} }, on: false, from: 0, inFlight: 0, last: e.t }));
      // Quiet for long with nothing running: that turn ended at its own last event.
      if (x.on && x.inFlight === 0 && e.t - x.last > QUIET_MS) close(x, x.last);
      const sub = typeof e.agent === "string" && e.agent !== "";
      // A subagent's permission is a wait until that agent moves on.
      if (sub && x.wait?.agent === e.agent && (e.ev === "PostToolUse" || e.ev === "PostToolUseFailure" || e.ev === "PreToolUse")) {
        if (x.wait.prev) open(x, e.t);
        x.wait = undefined;
      }
      const waitFor = (agent?: string) => { if (!x!.wait) x!.wait = { agent, prev: x!.on }; close(x!, e.t); };
      switch (e.ev) {
        case "UserPromptSubmit": close(x, x.last); x.wait = undefined; x.inFlight = 0; open(x, e.t); break; // a turn still open ended before it
        case "PreToolUse":
          if (sub || String(e.tool ?? "").startsWith("mcp__ccd_turn__")) break;
          x.inFlight++;
          if (e.tool === "AskUserQuestion" || e.tool === "ExitPlanMode") waitFor();
          else { x.wait = undefined; open(x, e.t); }
          break;
        case "PostToolUse": case "PostToolUseFailure":
          if (sub || String(e.tool ?? "").startsWith("mcp__ccd_turn__")) break;
          x.inFlight = Math.max(0, x.inFlight - 1);
          if (x.wait && !x.wait.agent) { x.wait = undefined; open(x, e.t); } // answered or approved
          break;
        case "PermissionRequest": waitFor(sub ? e.agent : undefined); break;
        case "Notification":
          if (e.nt === "permission_prompt" || e.nt === "elicitation_dialog") waitFor(x.wait?.agent);
          break;
        case "Stop": x.wait = undefined; x.inFlight = 0; close(x, e.t); break;
        // Closing a session ends a turn still open at its last event, as live counting does: a turn
        // stopped with Esc while a tool ran never sees its tool end, and could sit open for days.
        case "SessionEnd": x.wait = undefined; x.inFlight = 0; close(x, x.last); break;
      }
      if (!sub) x.last = Math.max(x.last, e.t); // the session's own last event, not its subagents'
    }
  }
  const out = new Map<string, Worked>();
  for (const [sid, x] of sims) if (Object.keys(x.w.d).length) out.set(sid, x.w);
  return out;
}

// Puts what the log says together with what the live count holds, day by day. Both come from
// the same events by the same rules, and the log holds every event the live count saw, so for
// each day the larger of the two already holds the other: taking it never counts a moment
// twice (where they disagree, it can only count less). `to` moves past the log's last counted
// moment, so the live count adds only what comes after it.
export function mergeWorked(live: Worked | undefined, log: Worked): Worked {
  const w: Worked = { to: Math.max(live?.to ?? 0, log.to), d: { ...(live?.d ?? {}) }, ...(live?.from != null ? { from: live.from } : {}) };
  for (const [k, ms] of Object.entries(log.d)) w.d[k] = Math.max(w.d[k] ?? 0, ms);
  return w;
}
