// History, in SQLite.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { DIR, LOG, WEEK_MS, FORGET_MS, MAX_SESSIONS } from "./config.ts";
import { type Status, type Session, type Reminder, tasks, sessions, pins, dirty, allDirty, clean, bump, FUTURE_SLACK_MS } from "./state.ts";
import { relativesOf } from "./desktop.ts";
import { madeTasks } from "./tasks.ts";
import { activeAgents } from "./agents.ts";
import { type Shown, brokenOnce, needsYou, sessionNeedsYou, shownStatus, mostActive } from "./snapshot.ts";
import { addWorked, mergeWorked, parseWorked, setWorkedLoader, storedWorked, totalOf, workedMs, workedOf, workedFromLog } from "./worked.ts";

// Every session is kept in ~/.claude-session-monitor/sessions.db: the main view shows
// the last 7 days, History shows all of it. Only what the cards show is stored (titles,
// status, the last recap or question), never the conversation.

export let db: Database;
let upsert: ReturnType<Database["prepare"]>;

// A sessions.db that can't be opened (not a database, or damaged) is moved aside as
// sessions.db.bad, with its -wal and -shm, and a fresh one starts: History starts over, but the
// server never fails at startup again and again over it.
export function openDatabase() {
  const file = join(DIR, "sessions.db");
  try {
    open(file);
  } catch (e) {
    try { db?.close(); } catch {}
    // Only a file that isn't a database or is damaged moves aside; a locked one, a full disk
    // or a permission error is not the file's fault and is thrown for the caller to see.
    const code = (e as { code?: string })?.code ?? "";
    if (code !== "SQLITE_NOTADB" && code !== "SQLITE_CORRUPT") throw e;
    let bad = `${file}.bad`;
    for (let n = 2; existsSync(bad); n++) bad = `${file}.bad${n}`; // never over an earlier one
    for (const end of ["", "-wal", "-shm"]) if (existsSync(file + end)) renameSync(file + end, `${bad}${end}`);
    console.error(`${new Date().toISOString()} sessions.db couldn't be opened (${e instanceof Error ? e.message : e}); moved it to ${bad.split("/").pop()} and started a new one`);
    open(file);
  }
}

// Without accents or capitals, for History's search: "Éxito", "ÉXITO" and "exito" are one word.
export const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const searchText = (r: { title?: string | null; prompt?: string | null; project?: string | null; recap?: string | null }) =>
  fold([r.title, r.prompt, r.project, r.recap].filter(Boolean).join(" "));
let textOf: ReturnType<Database["prepare"]> | undefined;
let setSearch: ReturnType<Database["prepare"]> | undefined;
const refused = new Set<string>();
// A row's search text, from the row as saved: a title or prompt left out of a write keeps its
// saved one. Every write of a row calls it, the Claude app's own rows included (src/desktop.ts).
export function refreshSearch(sid: string) {
  const saved = textOf?.get(sid) as any;
  if (saved) setSearch!.run(searchText(saved), sid);
}

function open(file: string) {
  db = new Database(file);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, title TEXT, prompt TEXT, project TEXT, cwd TEXT, app_cwd TEXT, tp TEXT,
    first_at INTEGER, last_at INTEGER, status TEXT, outcome TEXT, recap TEXT, ask TEXT, error TEXT,
    note TEXT, model TEXT, pid INTEGER, archived INTEGER NOT NULL DEFAULT 0)`);
  // Added later: databases from before have no task column yet.
  const cols = (db.query("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
  if (!cols.includes("task")) db.exec("ALTER TABLE sessions ADD COLUMN task TEXT");
  if (!cols.includes("sched")) db.exec("ALTER TABLE sessions ADD COLUMN sched TEXT"); // its reminders and the tasks it set up
  if (!cols.includes("wait")) db.exec("ALTER TABLE sessions ADD COLUMN wait TEXT"); // what a waiting session waits on
  if (!cols.includes("relay")) db.exec("ALTER TABLE sessions ADD COLUMN relay TEXT"); // its turn start and whose question it passes on
  if (!cols.includes("advisor")) db.exec("ALTER TABLE sessions ADD COLUMN advisor TEXT"); // the model that advises it, while one is on
  if (!cols.includes("advisor_read")) db.exec("ALTER TABLE sessions ADD COLUMN advisor_read INTEGER"); // how far its transcript was read for it
  // When you pinned it, or null. Only the pin route writes it: the upsert below never touches it.
  if (!cols.includes("pinned_at")) db.exec("ALTER TABLE sessions ADD COLUMN pinned_at INTEGER");
  // Its time working per day, the last 8 days, how far it was counted and when a turn still
  // working started (src/worked.ts). Times only.
  if (!cols.includes("worked")) db.exec("ALTER TABLE sessions ADD COLUMN worked TEXT");
  // What History's search looks in (title, prompt, folder and recap), without accents or
  // capitals: SQLite's lower() knows only A to Z, so "Éxito" was never found by "éxito".
  if (!cols.includes("search")) db.exec("ALTER TABLE sessions ADD COLUMN search TEXT");
  // Things done once, such as filling in the working times from the log (backfillWorked).
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_at)");
  // A time saved past now (a clock that ran ahead) would keep its session on top for good.
  db.query("UPDATE sessions SET last_at = ?1 WHERE last_at > ?2").run(Date.now(), Date.now() + FUTURE_SLACK_MS);
  db.exec("CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task, first_at)");
  upsert = db.prepare(`INSERT INTO sessions
    (sid, title, prompt, project, cwd, app_cwd, tp, first_at, last_at, status, outcome, recap, ask, error, note, model, pid, archived, task, sched, wait, relay, advisor, advisor_read, worked)
    VALUES ($sid, $title, $prompt, $project, $cwd, $app_cwd, $tp, $first_at, $last_at, $status, $outcome, $recap, $ask, $error, $note, $model, $pid, $archived, $task, $sched, $wait, $relay, $advisor, $advisor_read, $worked)
    ON CONFLICT(sid) DO UPDATE SET
      title = coalesce(excluded.title, title), prompt = coalesce(excluded.prompt, prompt),
      project = coalesce(excluded.project, project), cwd = coalesce(excluded.cwd, cwd),
      app_cwd = coalesce(excluded.app_cwd, app_cwd), tp = coalesce(excluded.tp, tp),
      first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at),
      status = excluded.status, outcome = excluded.outcome, recap = excluded.recap, ask = excluded.ask,
      error = excluded.error, note = excluded.note, model = coalesce(excluded.model, model),
      pid = excluded.pid, archived = excluded.archived, task = coalesce(excluded.task, task), sched = excluded.sched,
      wait = excluded.wait, relay = excluded.relay,
      -- The advisor and how far its transcript was read go together: while a scan is under way
      -- (no offset), the row keeps the pair it has.
      advisor = CASE WHEN excluded.advisor_read IS NULL THEN advisor ELSE excluded.advisor END,
      advisor_read = coalesce(excluded.advisor_read, advisor_read),
      -- A session met again in memory reads its row's count first (src/worked.ts); one not read yet keeps it.
      worked = coalesce(excluded.worked, worked)`);
  textOf = db.prepare("SELECT title, prompt, project, recap FROM sessions WHERE sid = ?");
  setSearch = db.prepare("UPDATE sessions SET search = ?1 WHERE sid = ?2 AND search IS NOT ?1"); // only when it differs
  // Rows from before the search column, or written by an older version, get theirs once.
  const missing = db.query("SELECT sid, title, prompt, project, recap FROM sessions WHERE search IS NULL").all() as any[];
  if (missing.length) db.transaction(() => { for (const r of missing) setSearch!.run(searchText(r), r.sid); })();
  const one = db.prepare("SELECT worked FROM sessions WHERE sid = ?");
  setWorkedLoader((sid) => parseWorked((one.get(sid) as { worked?: string } | null)?.worked));
  pins.clear();
  for (const r of db.query("SELECT sid FROM sessions WHERE pinned_at IS NOT NULL").all() as { sid: string }[]) pins.add(r.sid);
}

// Pins a session or takes its pin off, from its card or its row: this week's (written first
// if it isn't in the database yet) or one only History has. False for a session it doesn't know.
export function setPin(sid: string, on: boolean, now = Date.now()) {
  if (sessions.has(sid) && !written.has(sid)) {
    dirty.add(sid);
    persist();
  }
  const r = db.query("UPDATE sessions SET pinned_at = CASE WHEN $on THEN coalesce(pinned_at, $now) ELSE NULL END WHERE sid = $sid")
    .run({ $on: on ? 1 : 0, $now: now, $sid: sid });
  if (!r.changes) return false;
  if (on) pins.add(sid); else pins.delete(sid);
  bump(sid); // the stream sends it; nothing else of the session changed, so no row is written again
  return true;
}

// Once: the working times of the turns read before counting began, from the event log
// (src/worked.ts says how, and why it never counts twice). Only sessions sessions.db knows get
// any; then it's marked done in meta, so a restart doesn't do it again.
export function backfillWorked() {
  if (db.query("SELECT 1 FROM meta WHERE key = 'worked_backfill'").get()) return;
  const texts = [join(DIR, "events.1.jsonl"), LOG].filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8"));
  const found = workedFromLog(texts);
  const get = db.prepare("SELECT worked FROM sessions WHERE sid = ?");
  const put = db.prepare("UPDATE sessions SET worked = ? WHERE sid = ?");
  const changed: Session[] = [];
  db.transaction(() => {
    for (const [sid, w] of found) {
      const row = get.get(sid) as { worked: string | null } | null;
      if (!row) continue; // a session without a row gets nothing
      const s = sessions.get(sid);
      const merged = mergeWorked(s ? workedOf(s) : parseWorked(row.worked), w);
      put.run(storedWorked(merged), sid);
      if (s) { s.worked = merged; changed.push(s); }
    }
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('worked_backfill', ?)").run(String(Date.now()));
  })();
  for (const s of changed) bump(s);
  if (!changed.length) bump();
}

// A text column gets text or nothing, whatever reached the session.
const text = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
export const rowOf = (s: Session) => ({
  $sid: s.sid, $title: text(s.title), $prompt: text(s.prompt),
  $project: s.appCwd ? basename(s.appCwd) : s.cwd ? basename(s.cwd) : null, // the app's folder is steadier than the shell's
  $cwd: s.cwd ?? null, $app_cwd: s.appCwd ?? null, $tp: s.tp ?? null,
  $first_at: s.first, $last_at: s.last, $status: s.status, $outcome: s.outcome ?? null,
  $recap: text(s.recap), $ask: text(s.ask ?? s.askText), $error: text(s.errorText),
  $note: text(s.note), $model: text(s.model), $pid: s.pid ?? null, $archived: s.archived ? 1 : 0,
  $task: s.task ?? null,
  $sched: s.reminders?.length || s.made?.length ? JSON.stringify({ r: s.reminders ?? [], m: s.made ?? [] }) : null,
  // The log resumes where it stopped, so a wait it read before a restart isn't read again.
  $wait: s.status === "waiting" ? JSON.stringify({ w: s.wait, k: s.waitKind, a: s.waitAgent, p: s.waitPrev }) : null,
  // When its turn started, and whose question it passes on: checkRelayed() needs them, and the
  // turns read before a restart aren't read again. Session IDs and a time, nothing typed.
  $relay: s.lastPrompt != null || s.relaysAhead || s.relayed?.length
    ? JSON.stringify({ p: s.lastPrompt, a: s.relaysAhead || undefined, d: s.relayed?.length ? s.relayed : undefined }) : null,
  // The model that advises it, so the card keeps its mark after a restart, and how far its
  // transcript was read for it, so a restart reads only what was added since (src/advisor.ts).
  $advisor: s.advisor?.model ?? null, $advisor_read: s.advisorRead ?? null,
  // Its time working per day, without the part of a turn still working (src/worked.ts).
  $worked: storedWorked(s.worked),
});
const relayOf = (v: unknown): Partial<Session> => {
  try {
    const r = typeof v === "string" ? JSON.parse(v) : null;
    if (!r) return {};
    const ids = Array.isArray(r.d) ? r.d.filter((x: unknown) => typeof x === "string") : [];
    return {
      lastPrompt: typeof r.p === "number" ? r.p : undefined,
      relaysAhead: r.a === true || undefined,
      relayed: ids.length ? ids : undefined,
    };
  } catch { return {}; }
};
const waitOf = (v: unknown): Partial<Session> => {
  try {
    const w = typeof v === "string" ? JSON.parse(v) : null;
    return w ? { wait: w.w ?? undefined, waitKind: w.k ?? undefined, waitAgent: w.a ?? undefined, waitPrev: w.p ?? undefined } : {};
  } catch { return {}; }
};
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
// Whether SQLite refused a row for what's in it (a constraint, a type, a size), rather than
// for the database's own trouble (locked, busy, full, a missing table), which stops every row.
const rowsFault = (e: unknown) => {
  const n = (e as any)?.errno;
  return typeof n !== "number" || [18, 19, 20, 25].includes(n & 0xff); // TOOBIG, CONSTRAINT, MISMATCH, RANGE
};
export function persist(all = false) {
  if (!db || (!all && !allDirty && !dirty.size)) return;
  const look = all || allDirty ? [...sessions.values()] : [...dirty].flatMap((sid) => sessions.get(sid) ?? []);
  clean();
  const changed: Row[] = [];
  for (const s of look) {
    let row: Row;
    try { row = rowOf(s); } catch (e) { brokenOnce(s.sid, "not saved", e); continue; } // the others still are
    if (!sameRow(written.get(s.sid), row)) changed.push(row);
  }
  if (!changed.length) return;
  try {
    db.transaction(() => {
      for (const row of changed) {
        // One row SQLite refuses is left out alone (logged once); trouble with the database
        // itself stops them all, to be tried again on the next write.
        try {
          upsert.run(row);
        } catch (e) {
          if (!rowsFault(e)) throw e;
          brokenOnce(row.$sid, "not saved", e);
          refused.add(row.$sid);
          continue;
        }
        refreshSearch(row.$sid);
      }
    })();
  } catch (e) {
    for (const row of changed) dirty.add(row.$sid); // still to write: the next write tries them again
    throw e;
  }
  // Only once they're in: a write that failed leaves them as not written.
  for (const row of changed) if (!refused.delete(row.$sid)) written.set(row.$sid, row);
}

// On startup, the last week comes back from the database, so a restart loses nothing.
export function loadRecent() {
  const rows = db.query("SELECT * FROM sessions WHERE last_at >= ? AND archived = 0").all(Date.now() - WEEK_MS) as any[];
  for (const r of rows) {
    // A session saved as busy with no process to check is not busy anymore.
    const status: Status = (r.status === "working" || r.status === "waiting") && !r.pid ? "idle" : r.status ?? "idle";
    // Its time working: a turn saved as working that no process can carry on ends at its last event.
    const worked = parseWorked(r.worked) ?? { to: 0, d: {} };
    if (status === "working" && worked.from == null) worked.from = r.last_at;
    // Only a row saved as working had a turn still open; any other start left behind counts nothing.
    if (status !== "working" && worked.from != null) {
      if (r.status === "working") addWorked(worked, worked.from, r.last_at);
      worked.from = undefined;
      worked.to = Math.max(worked.to, r.last_at);
    }
    sessions.set(r.sid, {
      sid: r.sid, status, since: r.last_at, first: r.first_at ?? r.last_at, last: r.last_at, lastMain: r.last_at,
      inFlight: 0, agents: new Map(), runs: new Map(),
      cwd: r.cwd ?? undefined, appCwd: r.app_cwd ?? undefined, tp: r.tp ?? undefined, pid: r.pid ?? undefined,
      title: r.title ?? undefined, prompt: r.prompt ?? undefined, model: r.model ?? undefined,
      recap: r.recap ?? undefined, askText: r.ask ?? undefined, errorText: r.error ?? undefined,
      note: r.note ?? undefined, outcome: r.outcome ?? undefined, classified: Boolean(r.outcome),
      archived: false, task: r.task ?? undefined,
      reminders: schedOf(r.sched).r, made: schedOf(r.sched).m,
      ...relayOf(r.relay),
      advisor: typeof r.advisor === "string" && /^claude-[a-z0-9.-]{1,60}$/.test(r.advisor) ? { model: r.advisor } : undefined,
      advisorRead: typeof r.advisor_read === "number" && r.advisor_read >= 0 ? r.advisor_read : undefined,
      ...(status === "waiting" ? waitOf(r.wait) : {}),
      worked,
    });
  }
}

// The same rule as the main view: a session in memory by its live state; one only in the
// database can't be waiting on you anymore, and an archived one never needs you.
export function rowNeedsYou(r: { sid: string; status: string | null; outcome: string | null; last_at: number; archived: number }, now: number) {
  if (r.archived) return false;
  const s = sessions.get(r.sid);
  if (s) return !s.archived && sessionNeedsYou(s, shownStatus(s, activeAgents(s)), now);
  const shown = (r.status === "done" ? r.outcome ?? "done" : r.status) as Shown;
  return shown !== "waiting" && needsYou(shown, r.last_at, now);
}

// History: every session, newest first, optionally filtered by words in its title,
// first prompt, project or last recap, and to the pinned ones. activeOnly: the Most active
// filter's sessions instead, the same ones as Last 7 Days, most time working first.
export function history(q: string, limit: number, offset: number, pinnedOnly = false, activeOnly = false) {
  const like = q ? `%${fold(q).replace(/[%_\\]/g, "\\$&")}%` : null;
  const conds = [
    // A row without its search text yet (written by another version while this one runs) is
    // looked at as before, by SQLite's lower().
    like ? "(search LIKE $like ESCAPE '\\' OR (search IS NULL AND lower(coalesce(title,'') || ' ' || coalesce(prompt,'') || ' ' || coalesce(project,'') || ' ' || coalesce(recap,'')) LIKE $like ESCAPE '\\'))" : "",
    pinnedOnly ? "pinned_at IS NOT NULL" : "", // the Pinned filter
  ].filter(Boolean);
  const now = Date.now();
  const top = activeOnly ? mostActive(now) : [];
  if (activeOnly) conds.push(`sid IN (${top.map((_, i) => `$s${i}`).join(", ") || "NULL"})`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const params: any = like ? { $like: like } : {};
  top.forEach((sid, i) => { params[`$s${i}`] = sid; });
  const total = (db.query(`SELECT count(*) AS n FROM sessions ${where}`).get(params) as any).n;
  let rows = db.query(`SELECT * FROM sessions ${where} ORDER BY last_at DESC LIMIT $limit OFFSET $offset`)
    .all({ ...params, $limit: activeOnly ? -1 : limit, $offset: activeOnly ? 0 : offset }) as any[];
  if (activeOnly) rows = offset ? [] : rows.sort((a, b) => top.indexOf(a.sid) - top.indexOf(b.sid));
  const workedOfRow = (r: any) => {
    const s = sessions.get(r.sid);
    return s ? workedMs(s, now) : totalOf(parseWorked(r.worked), now);
  };
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
      pinned: r.pinned_at != null || undefined,
      worked: workedOfRow(r) || undefined, // ms working in the last 7 days (src/worked.ts)
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
