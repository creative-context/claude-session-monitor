// History, in SQLite.

import { Database } from "bun:sqlite";
import { basename, join } from "node:path";
import { DIR, WEEK_MS, FORGET_MS, MAX_SESSIONS } from "./config.ts";
import { type Status, type Session, type Reminder, tasks, sessions, dirty, allDirty, clean } from "./state.ts";
import { relativesOf } from "./desktop.ts";
import { madeTasks } from "./tasks.ts";
import { activeAgents } from "./agents.ts";
import { type Shown, needsYou, shownStatus } from "./snapshot.ts";

// Every session is kept in ~/.claude-session-monitor/sessions.db: the main view shows
// the last 7 days, History shows all of it. Only what the cards show is stored (titles,
// status, the last recap or question), never the conversation.

export let db: Database;
let upsert: ReturnType<Database["prepare"]>;

export function openDatabase() {
  db = new Database(join(DIR, "sessions.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, title TEXT, prompt TEXT, project TEXT, cwd TEXT, app_cwd TEXT, tp TEXT,
    first_at INTEGER, last_at INTEGER, status TEXT, outcome TEXT, recap TEXT, ask TEXT, error TEXT,
    note TEXT, model TEXT, pid INTEGER, archived INTEGER NOT NULL DEFAULT 0)`);
  // Added later: databases from before have no task column yet.
  const cols = (db.query("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
  if (!cols.includes("task")) db.exec("ALTER TABLE sessions ADD COLUMN task TEXT");
  if (!cols.includes("sched")) db.exec("ALTER TABLE sessions ADD COLUMN sched TEXT"); // its reminders and the tasks it set up
  db.exec("CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_at)");
  db.exec("CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task, first_at)");
  upsert = db.prepare(`INSERT INTO sessions
    (sid, title, prompt, project, cwd, app_cwd, tp, first_at, last_at, status, outcome, recap, ask, error, note, model, pid, archived, task, sched)
    VALUES ($sid, $title, $prompt, $project, $cwd, $app_cwd, $tp, $first_at, $last_at, $status, $outcome, $recap, $ask, $error, $note, $model, $pid, $archived, $task, $sched)
    ON CONFLICT(sid) DO UPDATE SET
      title = coalesce(excluded.title, title), prompt = coalesce(excluded.prompt, prompt),
      project = coalesce(excluded.project, project), cwd = coalesce(excluded.cwd, cwd),
      app_cwd = coalesce(excluded.app_cwd, app_cwd), tp = coalesce(excluded.tp, tp),
      first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at),
      status = excluded.status, outcome = excluded.outcome, recap = excluded.recap, ask = excluded.ask,
      error = excluded.error, note = excluded.note, model = coalesce(excluded.model, model),
      pid = excluded.pid, archived = excluded.archived, task = coalesce(excluded.task, task), sched = excluded.sched`);
}

export const rowOf = (s: Session) => ({
  $sid: s.sid, $title: s.title ?? null, $prompt: s.prompt ?? null,
  $project: s.appCwd ? basename(s.appCwd) : s.cwd ? basename(s.cwd) : null, // the app's folder is steadier than the shell's
  $cwd: s.cwd ?? null, $app_cwd: s.appCwd ?? null, $tp: s.tp ?? null,
  $first_at: s.first, $last_at: s.last, $status: s.status, $outcome: s.outcome ?? null,
  $recap: s.recap ?? null, $ask: s.ask ?? s.askText ?? null, $error: s.errorText ?? null,
  $note: s.note ?? null, $model: s.model ?? null, $pid: s.pid ?? null, $archived: s.archived ? 1 : 0,
  $task: s.task ?? null,
  $sched: s.reminders?.length || s.made?.length ? JSON.stringify({ r: s.reminders ?? [], m: s.made ?? [] }) : null,
});
export const schedOf = (v: unknown): { r?: Reminder[]; m?: Session["made"] } => {
  try { return typeof v === "string" ? JSON.parse(v) : {}; } catch { return {}; }
};

// Writes the sessions that changed since the last write: the ones a bump marked, or every
// one when a bump didn't say which (all = true looks at every one anyway). A row is
// written only when one of its fields differs from what was written last.
type Row = ReturnType<typeof rowOf>;
const written = new Map<string, Row>();
const sameRow = (a: Row | undefined, b: Row) => {
  if (!a) return false;
  for (const k in b) if ((a as any)[k] !== (b as any)[k]) return false;
  return true;
};
export function persist(all = false) {
  if (!db || (!all && !allDirty && !dirty.size)) return;
  const look = all || allDirty ? sessions.values() : [...dirty].flatMap((sid) => sessions.get(sid) ?? []);
  clean();
  const changed: Row[] = [];
  for (const s of look) {
    const row = rowOf(s);
    if (sameRow(written.get(s.sid), row)) continue;
    written.set(s.sid, row);
    changed.push(row);
  }
  if (changed.length) db.transaction(() => { for (const row of changed) upsert.run(row); })();
}

// On startup, the last week comes back from the database, so a restart loses nothing.
export function loadRecent() {
  const rows = db.query("SELECT * FROM sessions WHERE last_at >= ? AND archived = 0").all(Date.now() - WEEK_MS) as any[];
  for (const r of rows) {
    // A session saved as busy with no process to check is not busy anymore.
    const status: Status = (r.status === "working" || r.status === "waiting") && !r.pid ? "idle" : r.status ?? "idle";
    sessions.set(r.sid, {
      sid: r.sid, status, since: r.last_at, first: r.first_at ?? r.last_at, last: r.last_at, lastMain: r.last_at,
      inFlight: 0, agents: new Map(), runs: new Map(),
      cwd: r.cwd ?? undefined, appCwd: r.app_cwd ?? undefined, tp: r.tp ?? undefined, pid: r.pid ?? undefined,
      title: r.title ?? undefined, prompt: r.prompt ?? undefined, model: r.model ?? undefined,
      recap: r.recap ?? undefined, askText: r.ask ?? undefined, errorText: r.error ?? undefined,
      note: r.note ?? undefined, outcome: r.outcome ?? undefined, classified: Boolean(r.outcome),
      archived: false, task: r.task ?? undefined,
      reminders: schedOf(r.sched).r, made: schedOf(r.sched).m,
    });
  }
}

// The same rule as the main view: a session in memory by its live state; one only in the
// database can't be waiting on you anymore, and an archived one never needs you.
export function rowNeedsYou(r: { sid: string; status: string | null; outcome: string | null; last_at: number; archived: number }, now: number) {
  if (r.archived) return false;
  const s = sessions.get(r.sid);
  if (s) return !s.archived && needsYou(shownStatus(s, activeAgents(s)), s.last, now);
  const shown = (r.status === "done" ? r.outcome ?? "done" : r.status) as Shown;
  return shown !== "waiting" && needsYou(shown, r.last_at, now);
}

// History: every session, newest first, optionally filtered by words in its title,
// first prompt, project or last recap.
export function history(q: string, limit: number, offset: number) {
  const like = q ? `%${q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%` : null;
  const where = like
    ? "WHERE lower(coalesce(title,'') || ' ' || coalesce(prompt,'') || ' ' || coalesce(project,'') || ' ' || coalesce(recap,'')) LIKE $like ESCAPE '\\'"
    : "";
  const params: any = like ? { $like: like } : {};
  const total = (db.query(`SELECT count(*) AS n FROM sessions ${where}`).get(params) as any).n;
  const rows = db.query(`SELECT * FROM sessions ${where} ORDER BY last_at DESC LIMIT $limit OFFSET $offset`)
    .all({ ...params, $limit: limit, $offset: offset }) as any[];
  const now = Date.now();
  return {
    total,
    sessions: rows.map((r) => ({
      sid: r.sid,
      title: r.title || r.prompt || r.project || "Session",
      prompt: r.prompt ?? undefined, // shown when a search matched only the prompt
      project: r.project ?? "",
      cwd: r.app_cwd ?? r.cwd ?? "",
      first: r.first_at,
      last: r.last_at,
      status: r.status === "done" ? (r.outcome ?? "done") : r.status,
      needsYou: rowNeedsYou(r, now),
      recap: r.recap ?? undefined,
      ask: r.ask ?? undefined,
      error: r.error ?? undefined,
      note: r.note ?? undefined,
      archived: Boolean(r.archived),
      task: r.task ?? undefined,
      taskName: r.task ? tasks.get(r.task)?.name : undefined,
      made: madeTasks(schedOf(r.sched).m, Date.now()),
      ...relativesOf(r.sid),
    })),
  };
}
// After a week a session leaves the main view, a day later it leaves memory. It stays
// in the database, so History keeps it.
export function forgetOld() {
  persist(true); // a sweep of every session, in case a change came without a bump
  const now = Date.now();
  const drop = (sid: string) => {
    sessions.delete(sid);
    written.delete(sid);
  };
  for (const [sid, s] of sessions) if (now - s.last > FORGET_MS) drop(sid);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.last - b.last);
    for (const s of oldest.slice(0, sessions.size - MAX_SESSIONS)) drop(s.sid);
  }
}
