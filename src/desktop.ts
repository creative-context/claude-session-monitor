// The desktop app's own session files: titles, archive flags, side sessions, the app's
// summary of a turn, and the sessions from before this app existed.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fold, nameWords, relayTargets } from "../closing.ts";
import { APP_SESSIONS, PROJECTS, WEEK_MS } from "./config.ts";
import { type Session, type Task, tasks, taskChanged, sessions, bump, localToCli, appTitles } from "./state.ts";
import { hydrate } from "./session.ts";
import { closingContext } from "./turns.ts";
import { db, rowOf } from "./db.ts";
import { readTasks } from "./tasks.ts";

// Where a session's transcript lives: ~/.claude/projects/<folder>/<sid>.jsonl.
const transcripts = new Map<string, string>();
let indexedAt = 0;
export function findTranscript(sid: string): string | undefined {
  if (!transcripts.has(sid) && Date.now() - indexedAt > 60_000) {
    indexedAt = Date.now();
    try {
      for (const d of readdirSync(PROJECTS)) {
        try {
          for (const f of readdirSync(join(PROJECTS, d))) {
            if (f.endsWith(".jsonl")) transcripts.set(f.slice(0, -6), join(PROJECTS, d, f));
          }
        } catch {}
      }
    } catch {}
  }
  return transcripts.get(sid);
}

let desktopTimer: ReturnType<typeof setTimeout> | undefined;
export function readDesktopSoon() {
  clearTimeout(desktopTimer);
  desktopTimer = setTimeout(readDesktopSessions, 1500);
}

// The Claude app sums up each finished turn (postTurnSummary). When that summary is of the
// session's latest message and names something you need to do (needs_action), the turn
// asks you, even with no question in it. Only that one line is read.
export function appAskOf(j: any): { text: string; edge: number } | undefined {
  const p = j?.postTurnSummary;
  if (!p || typeof p !== "object") return undefined;
  if (!p.summarizes_uuid || p.summarizes_uuid !== j.lastAssistantUuid) return undefined; // about an older turn
  const edge = typeof j.lastTurnEdgeAt === "number" ? j.lastTurnEdgeAt : typeof j.lastActivityAt === "number" ? j.lastActivityAt : 0;
  const needs = typeof p.needs_action === "string" ? p.needs_action.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  if (needs) return { text: needs, edge };
  return p.status_category === "completed" ? { text: "", edge } : undefined; // done, nothing for you
}

// A turn we read as done that the app says needs you: it asks you, with the app's words.
// The app's note names another session in brackets ("Give the OK to [Billing] in …"): what
// needs doing is there, not in this session.
// Or it says where in words: "Answer in the Draft review session: …", "Contesta en la sesión
// de Draft review", when every word of that name is in another session's title and not all
// in this one's; or it says a related session's whole title ("Review the Pricing page …").
export function pointsElsewhere(s: Session, text: string): boolean {
  const own = titleOf(s.sid);
  const known = new Set([...[...sessions.values()].map((x) => x.title), ...appTitles.values()].filter(Boolean));
  if ([...text.matchAll(/\[([^\]]{1,120})\]/g)].some((m) => m[1] !== own && known.has(m[1]))) return true;
  for (const ws of sessionNames(text)) {
    if (hasWords(own, ws)) continue;
    if ([...known].some((t) => t !== own && hasWords(t, ws))) return true;
  }
  const rel = relativesOf(s.sid);
  const kin = [rel.from?.title, ...(rel.sides ?? []).map((x) => x.title)].filter((t): t is string => Boolean(t));
  return kin.some((t) => !saysTitle(own, t) && saysTitle(text, t));
}

// Session names in so many words: "in the Draft review session", "en la sesión de Draft
// review". Each as its words, whole, without the ones that name no session ("in the next
// session", "en la misma sesión").
const GENERIC = new Set(["this", "that", "next", "same", "other", "another", "previous", "last", "new", "main", "current",
  "first", "original", "parent", "side", "esta", "este", "esa", "ese", "siguiente", "misma", "mismo", "otra", "otro",
  "nueva", "nuevo", "anterior", "principal", "actual", "primera", "lateral"]);
export function sessionNames(text: string): string[][] {
  return [...fold(text).matchAll(/\bin the ([^,.:;]{3,60}?) session\b|\ben la sesion (?:de |del )?([^,.:;]{3,60})/g)]
    .map((m) => nameWords(m[1] ?? m[2] ?? "").filter((w) => !GENERIC.has(w)))
    .filter((ws) => ws.length > 0);
}
export function hasWords(title: string, ws: string[]): boolean {
  const tw = new Set(nameWords(title));
  return ws.every((w) => tw.has(w));
}
// Whether a text says a whole title, word for word.
export function saysTitle(text: string, title: string): boolean {
  const t = nameWords(title).join(" ");
  return t.length >= 6 && ` ${nameWords(text).join(" ")} `.includes(` ${t} `);
}

// A note that only invites the next piece of work ("Paste the next text so it can be…",
// "Send another file…") is an open offer, like one in the closing message: nothing waits.
// Only when it starts that way: "Give the OK to push, or ask for more changes" still asks.
const OPEN_NOTE = /^(paste|send|share|drop|upload)( me| us| it)? (the next|your next|another|any other)\b/i;

export function applyAppAsk(s: Session) {
  const a = s.appAsk;
  if (!a || s.status !== "done" || !s.classified) return;
  if (a.edge < s.since - 10_000) return; // the summary is of an earlier turn
  if (a.text && (pointsElsewhere(s, a.text) || OPEN_NOTE.test(a.text))) return;
  if (a.text && s.outcome === "done") {
    s.outcome = "asks";
    s.askText = a.text;
    // It passes on a linked session's question when the closing says that session waits
    // for you and the note names it, or the note itself says it waits there ("Answer
    // billing-api's questions in its session").
    const named = (s.relays ?? []).filter((sid) => {
      const t = titleOf(sid);
      return saysTitle(a.text!, t) || sessionNames(a.text!).some((ws) => hasWords(t, ws));
    });
    s.relayed = [...new Set([...named, ...relayTargets(a.text, ...closingContext(s))])];
    bump();
  } else if (!a.text && s.outcome === "asks" && !s.ask && !(s.askText ?? "").includes("?")) {
    // The app read the whole turn as done; a request without a question mark was a guess.
    s.outcome = "done";
    s.askText = undefined;
    bump();
  }
}

// Sessions the Claude app started from another one (a side session): child → parent,
// both as Claude Code session IDs. Only the app knows this; it says so in the child's file.
let spawnedFrom = new Map<string, string>();
export function titleOf(sid: string): string {
  const s = sessions.get(sid);
  return s?.title || appTitles.get(sid) || s?.prompt || "another session";
}
// What a session's card and row say about its relatives: where it came from, and the side
// sessions it started.
export function relativesOf(sid: string) {
  const parent = spawnedFrom.get(sid);
  const sides = [...spawnedFrom].filter(([, p]) => p === sid).map(([c]) => ({ sid: c, title: titleOf(c) }));
  return {
    from: parent ? { sid: parent, title: titleOf(parent) } : undefined,
    sides: sides.length ? sides : undefined,
  };
}

// What one app session file says, as far as this app needs it.
export type AppFile = {
  local: string; cli: string; from?: string; title?: string; archived?: boolean; model?: string; cwd?: string;
  created?: number; last?: number; task?: string; ask?: { text: string; edge: number };
};
export function parseAppFile(text: string, name: string): AppFile | undefined {
  const j = JSON.parse(text);
  if (typeof j?.cliSessionId !== "string") return undefined;
  const cwd = j.originCwd ?? j.cwd;
  return {
    local: typeof j.sessionId === "string" ? j.sessionId : name.slice(0, -5), cli: j.cliSessionId,
    from: typeof j.spawnedFrom?.sessionId === "string" ? j.spawnedFrom.sessionId : undefined,
    title: typeof j.title === "string" ? j.title : undefined, archived: j.isArchived === true,
    model: typeof j.model === "string" ? j.model : undefined, cwd: typeof cwd === "string" ? cwd : undefined,
    created: typeof j.createdAt === "number" ? j.createdAt : undefined,
    last: typeof j.lastActivityAt === "number" ? j.lastActivityAt : undefined,
    task: typeof j.scheduledTaskId === "string" ? j.scheduledTaskId : undefined,
    ask: appAskOf(j),
  };
}

// A file is parsed again only when its time or size changes: most are weeks old, and
// together they run to tens of megabytes.
type Cached = { mtime: number; size: number; file?: AppFile; tasks?: Task[] };
export const appFiles = new Map<string, Cached>();
let fileOfCli = new Map<string, string>(); // a Claude Code session ID → its app file
export let parses = 0; // files parsed since the start, for tests

export function readCached(path: string, name: string): Cached | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    appFiles.delete(path);
    return undefined;
  }
  const old = appFiles.get(path);
  if (old && old.mtime === st.mtimeMs && old.size === st.size) return old;
  const c: Cached = { mtime: st.mtimeMs, size: st.size };
  parses++;
  try {
    if (name === "scheduled-tasks.json") c.tasks = readTasks(path);
    else c.file = parseAppFile(readFileSync(path, "utf8"), name);
  } catch {}
  appFiles.set(path, c);
  return c;
}

// When a turn of a desktop session ends, the app writes its summary of that turn to the
// session's file within seconds. Watch that one file for a little while, so a request the
// summary says is done never waits for the next full pass.
const watching = new Map<string, ReturnType<typeof setInterval>>();
export const APP_SUMMARY_WAIT_MS = 4000; // how long a guessed ask waits for the app's summary
export const hasAppFile = (sid: string) => fileOfCli.has(sid);
export function readAppFileSoon(sid: string, every = 1000, until = 20_000) {
  const path = fileOfCli.get(sid);
  if (!path) return;
  clearInterval(watching.get(sid));
  const started = Date.now();
  const timer = setInterval(() => {
    const s = sessions.get(sid);
    const d = readCached(path, basename(path))?.file;
    if (s && d?.cli === sid && JSON.stringify(d.ask) !== JSON.stringify(s.appAsk)) {
      s.appAsk = d.ask;
      applyAppAsk(s);
      bump();
    }
    // Done once the summary of this turn is in, or after a while: the full pass takes over.
    const fresh = s && d?.ask && d.ask.edge >= s.since - 10_000;
    if (!s || fresh || s.status !== "done" || Date.now() - started >= until) {
      clearInterval(timer);
      watching.delete(sid);
    }
  }, every);
  watching.set(sid, timer);
}

// Titles and archive flags come from the desktop app's own session files. Their
// format is not documented, so every field is optional and errors are ignored.
// The same files fill the history with sessions from before this app existed, and
// bring this week's sessions to the main view even if they've been quiet since.
export function readDesktopSessions() {
  if (!existsSync(APP_SESSIONS)) return;
  const byCli = new Map<string, AppFile>();
  const found = new Map<string, Task>();
  const cliOf = localToCli; // the app's own session ID → Claude Code's
  const spawned = new Map<string, string>(); // a side session (Claude Code ID) → the app ID it came from
  const seen = new Set<string>();
  const files = new Map<string, string>();
  try {
    for (const account of readdirSync(APP_SESSIONS)) {
      const accDir = join(APP_SESSIONS, account);
      if (!statSync(accDir).isDirectory()) continue;
      for (const org of readdirSync(accDir)) {
        const orgDir = join(accDir, org);
        if (!statSync(orgDir).isDirectory()) continue;
        for (const f of readdirSync(orgDir)) {
          if (f !== "scheduled-tasks.json" && (!f.startsWith("local_") || !f.endsWith(".json"))) continue;
          const path = join(orgDir, f);
          seen.add(path);
          const c = readCached(path, f);
          for (const t of c?.tasks ?? []) found.set(t.id, t);
          const d = c?.file;
          if (!d) continue;
          files.set(d.cli, path);
          byCli.set(d.cli, d);
        }
      }
    }
  } catch {
    return;
  }
  for (const path of appFiles.keys()) if (!seen.has(path)) appFiles.delete(path);
  cliOf.clear();
  for (const path of seen) {
    const d = appFiles.get(path)?.file;
    if (!d) continue;
    cliOf.set(d.local, d.cli);
    if (d.from) spawned.set(d.cli, d.from);
  }
  fileOfCli = files;
  const links = new Map<string, string>();
  for (const [child, from] of spawned) {
    const parent = cliOf.get(from);
    if (parent && parent !== child) links.set(child, parent);
  }
  for (const [sid, d] of byCli) if (d.title) appTitles.set(sid, d.title);
  if (JSON.stringify([...links]) !== JSON.stringify([...spawnedFrom])) {
    spawnedFrom = links;
    bump();
  }
  if (JSON.stringify([...found.values()]) !== JSON.stringify([...tasks.values()])) {
    for (const [id, t] of found) {
      const old = tasks.get(id);
      if (old && (old.cron !== t.cron || old.at !== t.at || (t.enabled && !old.enabled))) taskChanged.set(id, Date.now());
    }
    tasks.clear();
    for (const [id, t] of found) tasks.set(id, t);
    bump();
  }
  const now = Date.now();
  const fromApp: Session[] = [];
  for (const [sid, d] of byCli) {
    let s = sessions.get(sid);
    const last = d.last ?? d.created ?? 0;
    if (!s && !d.archived && now - last < WEEK_MS && last > 0) {
      // A session from this week that has been quiet since we started watching.
      s = {
        sid, status: "done", since: last, first: d.created ?? last, last, lastMain: last,
        inFlight: 0, agents: new Map(), runs: new Map(), cwd: d.cwd, tp: findTranscript(sid), task: d.task,
      };
      sessions.set(sid, s);
      hydrate(s); // its plan and last recap, from the transcript
      bump();
    }
    if (!s) {
      // Older or archived: straight to the history, without touching memory.
      if (last > 0) fromApp.push({
        sid, status: "ended", since: last, first: d.created ?? last, last, lastMain: last,
        inFlight: 0, agents: new Map(), runs: new Map(), cwd: d.cwd, appCwd: d.cwd,
        title: d.title, model: d.model, archived: d.archived, tp: findTranscript(sid), task: d.task,
      });
      continue;
    }
    if (JSON.stringify(d.ask) !== JSON.stringify(s.appAsk)) {
      s.appAsk = d.ask;
      applyAppAsk(s);
    }
    if (d.title !== s.title || d.archived !== s.archived || d.model !== s.model || d.cwd !== s.appCwd || d.task !== s.task) {
      s.title = d.title;
      s.archived = d.archived;
      s.model = d.model;
      s.appCwd = d.cwd;
      s.task = d.task;
      bump();
    }
  }
  // Only the rows that changed since the last pass, so a quiet Mac writes nothing.
  const sigs = new Map(fromApp.map((s) => [s.sid, JSON.stringify(rowOf(s))]));
  const changed = fromApp.filter((s) => appRows.get(s.sid) !== sigs.get(s.sid));
  if (changed.length && db) {
    db.transaction(() => {
      for (const s of changed) {
        const row = rowOf(s);
        // Keep what we already know about it (status, recap); only fill the gaps.
        db.query(`INSERT INTO sessions (sid, title, project, cwd, app_cwd, tp, first_at, last_at, status, model, archived, task)
          VALUES ($sid, $title, $project, $cwd, $app_cwd, $tp, $first_at, $last_at, $status, $model, $archived, $task)
          ON CONFLICT(sid) DO UPDATE SET title = coalesce(excluded.title, title), archived = excluded.archived,
            app_cwd = coalesce(excluded.app_cwd, app_cwd), last_at = max(last_at, excluded.last_at),
            tp = coalesce(tp, excluded.tp), task = coalesce(excluded.task, task)`).run({
          $sid: row.$sid, $title: row.$title, $project: row.$project, $cwd: row.$cwd, $app_cwd: row.$app_cwd,
          $tp: row.$tp, $first_at: row.$first_at, $last_at: row.$last_at, $status: row.$status,
          $model: row.$model, $archived: row.$archived, $task: row.$task,
        });
      }
    })();
    for (const s of changed) appRows.set(s.sid, sigs.get(s.sid)!);
  }
}
// What was last written for each older session.
const appRows = new Map<string, string>();
