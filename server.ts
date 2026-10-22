// Claude Session Monitor server. Reads the events the hook appends to ~/.claude-session-monitor/events.jsonl, keeps
// one small state per Claude Code session, and pushes it to the strip page.
//
//   bun server.ts            → http://127.0.0.1:4747
//
// Read-only toward Claude: it never writes to ~/.claude or to the desktop app's files.

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, statSync, watch,
} from "node:fs";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describeCron, nextRun, parseCron, prevRun } from "./cron.ts";

const PORT = Number(process.env.CSM_PORT ?? 4747);
const DIR = process.env.CSM_DIR ?? join(homedir(), ".claude-session-monitor");
const LOG = join(DIR, "events.jsonl");
const APP_SESSIONS = process.env.CSM_APP_SESSIONS ?? join(homedir(), "Library/Application Support/Claude/claude-code-sessions");
const PROJECTS = process.env.CSM_PROJECTS ?? join(homedir(), ".claude", "projects");
const PUBLIC = join(import.meta.dir, "public");

const MAX_LOG_BYTES = 8 * 1024 * 1024; // rotate past this
const REPLAY_BYTES = 4 * 1024 * 1024; // read this much of the log on startup
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS; // sessions live in the main view this long, then only in History
const FORGET_MS = WEEK_MS + DAY_MS; // and leave memory a day later (the database keeps them)
const MAX_SESSIONS = 2000; // hard cap so memory stays flat
const AGENT_QUIET_MS = 15 * 60 * 1000; // a subagent with no sign of life this long is not shown
const RUN_DIR_MS = 6 * 60 * 60 * 1000; // workflow folders older than this are not scanned

type Status = "working" | "waiting" | "done" | "idle" | "ended";
type Step = { c: string; s: "pending" | "in_progress" | "completed" };

// A subagent: one started with the Agent tool, or one agent of a workflow.
type Agent = {
  id: string;
  run?: string; // workflow run id (wf_…) when it belongs to a workflow
  file?: string; // its transcript
  label?: string; // e.g. "review:api · high"
  phase?: string; // workflow phase
  model?: string;
  background?: boolean;
  tool?: string;
  detail?: string;
  tokens?: number; // context size of its last message, like the app's panel
  startedAt: number;
  lastAt: number;
  finished?: boolean;
  metaRead?: boolean;
  tailMtime?: number; // transcript mtime we last read the tail at
};

type Run = { id: string; startedAt: number; finished: boolean };

type Ev = {
  t: number; pid?: number; ev: string; sid: string; cwd?: string; tp?: string; pm?: string;
  agent?: string; tool?: string; d?: string; nt?: string; msg?: string; src?: string;
  why?: string; prompt?: string; x?: any;
};

type Session = {
  sid: string;
  cwd?: string;
  tp?: string;
  pid?: number;
  pidChecked?: number; // the pid we already confirmed is a claude process
  pm?: string;
  status: Status;
  since: number; // when the status last changed
  first: number; // when we first saw it
  last: number; // last event, from Claude or a subagent
  lastMain: number; // last event from the main agent
  inFlight: number; // main-agent tools started and not finished
  tool?: string;
  detail?: string;
  wait?: string; // what it needs from you
  waitKind?: "permission" | "question" | "plan" | "input";
  prompt?: string;
  recap?: string;
  ask?: string;
  plan?: Step[];
  agents: Map<string, Agent>;
  runs: Map<string, Run>;
  note?: string; // e.g. "You stopped it"
  // How the last turn ended, read from the transcript once it's over
  classified?: boolean;
  outcome?: "done" | "asks" | "error";
  askText?: string; // the question its closing message ends on
  errorText?: string;
  hydrated?: boolean; // plan and last recap already read from the transcript
  // From the desktop app's own session file, when there is one
  title?: string;
  archived?: boolean;
  model?: string;
  appCwd?: string; // the folder the app opened the session in; needed to reopen it
  task?: string; // the scheduled task this session is a run of
};

// A scheduled task of the Claude desktop app, from its scheduled-tasks.json. Only its
// name, schedule, folder and times are read, never what the task does.
type Task = {
  id: string; name: string; cron: string; enabled: boolean; cwd?: string; file?: string;
  created?: number; lastRunAt?: number; lastScheduledFor?: number;
};
const tasks = new Map<string, Task>();
const taskChanged = new Map<string, number>(); // when a task was last resumed or rescheduled

const sessions = new Map<string, Session>();
let version = 0; // bumps on every change, so the stream only sends when needed

// ---------------------------------------------------------------- state machine

function setStatus(s: Session, status: Status, t: number) {
  if (s.status !== status) {
    s.status = status;
    s.since = t;
  }
  if (status !== "done") {
    s.classified = false;
    s.outcome = s.askText = s.errorText = undefined;
  }
  if (status !== "waiting") {
    s.wait = undefined;
    s.waitKind = undefined;
  }
}

function setWaiting(s: Session, kind: Session["waitKind"], text: string, t: number) {
  setStatus(s, "waiting", t);
  s.waitKind = kind;
  s.wait = text;
}

function applyPlan(plan: Step[] | undefined, x: any): Step[] | undefined {
  if (!x) return plan;
  if (Array.isArray(x.items)) {
    // Hook lines use {c, s}; the transcript keeps the original {content, status}.
    return x.items.map((i: any) => ({ c: String(i.c ?? i.content ?? "").slice(0, 90), s: i.s ?? i.status }));
  }
  if (!plan) return plan;
  const p = plan.map((st) => ({ ...st }));
  if (x.advance) {
    const cur = p.findIndex((st) => st.s === "in_progress");
    if (cur >= 0) p[cur].s = "completed";
    const next = p.findIndex((st) => st.s === "pending");
    if (next >= 0) p[next].s = "in_progress";
  }
  if (Array.isArray(x.done)) for (const n of x.done) if (p[n - 1]) p[n - 1].s = "completed";
  if (typeof x.start === "number" && p[x.start - 1]) p[x.start - 1].s = "in_progress";
  return p;
}

const completeCurrent = (plan?: Step[]) =>
  plan?.map((st) => (st.s === "in_progress" ? { ...st, s: "completed" as const } : st));

// A session we first meet halfway (hooks installed later, or the server was off)
// gets its plan and last recap from the transcript, replayed with the same rules.
function hydrate(s: Session) {
  if (s.hydrated || !s.tp || !existsSync(s.tp)) return;
  s.hydrated = true;
  const size = statSync(s.tp).size;
  const lines = readRange(s.tp, Math.max(0, size - 2_000_000), size).split("\n");
  let plan: Step[] | undefined;
  let recap: string | undefined;
  let ask: string | undefined;
  for (const line of lines) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain || row.isMeta) continue;
    const content = row.message?.content;
    if (row.type === "user") {
      const isPrompt = typeof content === "string" ||
        (Array.isArray(content) && content.some((b: any) => b?.type === "text") &&
          !content.some((b: any) => b?.type === "tool_result"));
      if (isPrompt) recap = ask = undefined;
      continue;
    }
    if (row.type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "mcp__ccd_turn__update_plan") plan = applyPlan(plan, b.input);
      if (b.name === "mcp__ccd_turn__wrap_up") {
        recap = b.input?.recap;
        ask = b.input?.ask;
        plan = completeCurrent(plan);
      }
    }
  }
  if (!s.plan) s.plan = plan;
  if (s.status === "done" && !s.recap && !s.ask) {
    s.recap = recap?.slice(0, 300);
    s.ask = ask?.slice(0, 140);
  }
  version++;
}

// Workflow agents never send SubagentStart, so an agent is created by whatever we
// hear from it first: a hook event here, or its files in scanAgents().
function touchAgent(s: Session, e: Ev) {
  const id = e.agent!;
  let a = s.agents.get(id);
  if (!a) {
    a = { id, startedAt: e.t, lastAt: e.t };
    s.agents.set(id, a);
  }
  a.lastAt = Math.max(a.lastAt, e.t);
  if (e.ev === "PreToolUse" && e.tool) {
    a.tool = e.tool;
    a.detail = e.d;
  }
  if (e.ev === "SubagentStop") a.finished = true;
}

function apply(e: Ev) {
  if (!e || typeof e.sid !== "string" || typeof e.ev !== "string" || typeof e.t !== "number") return;

  let s = sessions.get(e.sid);
  if (!s) {
    s = {
      sid: e.sid, status: "idle", since: e.t, first: e.t, last: e.t, lastMain: e.t, inFlight: 0,
      agents: new Map(), runs: new Map(),
    };
    sessions.set(e.sid, s);
    readDesktopSoon(); // a scheduled run shows on its task's card in seconds, not on the next pass
  }
  s.last = Math.max(s.last, e.t);
  if (e.cwd) s.cwd = e.cwd;
  if (e.tp) s.tp = e.tp;
  if (e.pm) s.pm = e.pm;
  if (e.pid && e.pid > 1 && e.pid !== s.pid) {
    s.pid = e.pid;
    s.pidChecked = undefined;
  }

  // Lesson from Vibe Notch (#36, #18): subagent events must not change the
  // session's own status or fire alerts. Only a permission prompt counts,
  // because it blocks the whole session.
  // Subagent events are still tracked, per agent, so the card can show them.
  const fromSubagent = Boolean(e.agent);
  if (fromSubagent) touchAgent(s, e);
  else s.lastMain = Math.max(s.lastMain, e.t);

  switch (e.ev) {
    case "SessionStart":
      if (s.status === "ended") setStatus(s, "idle", e.t);
      break;

    case "SessionEnd":
      setStatus(s, "ended", e.t);
      s.inFlight = 0;
      break;

    case "UserPromptSubmit":
      setStatus(s, "working", e.t);
      s.prompt = e.prompt ?? s.prompt;
      s.recap = s.ask = s.note = s.tool = s.detail = undefined;
      s.inFlight = 0;
      break;

    case "PreToolUse": {
      if (fromSubagent) break;
      if (e.tool === "mcp__ccd_turn__update_plan") {
        s.plan = applyPlan(s.plan, e.x);
        break;
      }
      if (e.tool === "mcp__ccd_turn__wrap_up") {
        s.recap = e.x?.recap;
        s.ask = e.x?.ask;
        s.plan = completeCurrent(s.plan);
        break;
      }
      s.inFlight++;
      s.note = undefined;
      if (e.tool === "AskUserQuestion") {
        setWaiting(s, "question", e.x?.q ?? "Asks you a question", e.t);
      } else if (e.tool === "ExitPlanMode") {
        setWaiting(s, "plan", "Waiting for you to approve the plan", e.t);
      } else {
        setStatus(s, "working", e.t);
        s.tool = e.tool;
        s.detail = e.d;
      }
      break;
    }

    case "PostToolUse":
    case "PostToolUseFailure":
      if (fromSubagent) break;
      if (e.tool?.startsWith("mcp__ccd_turn__")) break;
      s.inFlight = Math.max(0, s.inFlight - 1);
      // Lesson from Vibe Notch (#98): a PostToolUse that arrives after Stop
      // (a backgrounded Bash, for example) must not flip a finished session
      // back to "working".
      if (s.status === "done" || s.status === "idle" || s.status === "ended") break;
      if (s.status === "waiting") setStatus(s, "working", e.t); // answered or approved
      break;

    case "PermissionRequest":
      setWaiting(s, "permission", e.tool ? `Wants permission to use ${e.tool}` : "Wants permission", e.t);
      break;

    case "Notification":
      // Lesson from agents-observe: a notification puts the session in "waiting"
      // until the next real activity clears it.
      if (e.nt === "permission_prompt") setWaiting(s, "permission", e.msg ?? "Wants permission", e.t);
      else if (e.nt === "elicitation_dialog") setWaiting(s, "input", e.msg ?? "Needs input from you", e.t);
      // idle_prompt only repeats that the turn ended; nothing to change.
      break;

    case "Stop":
      setStatus(s, "done", e.t);
      s.since = e.t;
      s.inFlight = 0;
      s.tool = s.detail = undefined;
      s.classified = false; // checkTurns() reads how it ended
      s.outcome = s.askText = s.errorText = undefined;
      break;

    case "PreCompact":
      if (s.status !== "waiting") setStatus(s, "working", e.t);
      s.tool = "Compact";
      s.detail = undefined;
      break;
  }
  version++;
}

// ---------------------------------------------------------------- reading the log

let offset = 0;
let partial = "";

function readRange(file: string, from: number, to: number): string {
  if (to <= from) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function consume(text: string) {
  const lines = (partial + text).split("\n");
  partial = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    try {
      apply(JSON.parse(line));
    } catch {
      // A broken line never stops the rest.
    }
  }
}

function pump() {
  if (!existsSync(LOG)) {
    offset = 0;
    partial = "";
    return;
  }
  const size = statSync(LOG).size;
  if (size < offset) {
    offset = 0; // the file was replaced
    partial = "";
  }
  if (size > offset) {
    consume(readRange(LOG, offset, size));
    offset = size;
    for (const s of sessions.values()) if (!s.hydrated && s.tp) hydrate(s);
  }
  if (offset > MAX_LOG_BYTES) rotate();
}

function rotate() {
  const old = join(DIR, "events.1.jsonl");
  renameSync(LOG, old);
  // Pick up anything a hook appended between our last read and the rename.
  const size = statSync(old).size;
  consume(readRange(old, offset, size));
  offset = 0;
  partial = "";
}

function replay() {
  if (!existsSync(LOG)) return;
  const size = statSync(LOG).size;
  const from = Math.max(0, size - REPLAY_BYTES);
  let text = readRange(LOG, from, size);
  if (from > 0) text = text.slice(text.indexOf("\n") + 1); // skip the cut first line
  consume(text);
  offset = size;
}

// ---------------------------------------------------------------- checks that run on a timer

function isClaudeProcess(pid: number): boolean {
  const r = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)]);
  return /claude/i.test(r.stdout.toString());
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

// Lessons from claude-glance and Vibe Notch: the hook's parent pid tells us whether
// the session's process still exists, and we confirm once that it is Claude so a
// recycled pid does not keep a dead session on the strip.
function checkProcesses() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === "ended" || !s.pid) continue;
    let alive = isAlive(s.pid);
    if (alive && s.pidChecked !== s.pid) {
      alive = isClaudeProcess(s.pid);
      if (alive) s.pidChecked = s.pid;
    }
    if (!alive) {
      if (s.status === "working" || s.status === "waiting") s.note = "Closed in the middle of a turn";
      setStatus(s, "ended", now);
      version++;
    }
  }
}

// How the newest turn in a transcript ended, from its last user or assistant line:
//   interrupted  you stopped it (Claude Code writes a marker line)
//   error        an API error ended it (isApiErrorMessage, e.g. server_error, rate_limit)
//   text         a closing message; its text says whether it asks you something
//   none         still mid-turn (a tool call or a tool result is the last thing)
type LastTurn = { kind: "interrupted" | "error" | "text" | "none"; text?: string };

const textOf = (row: any): string => {
  const c = row.message?.content;
  return typeof c === "string" ? c
    : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n") : "";
};

function readLastTurn(tp: string): LastTurn {
  const size = statSync(tp).size;
  const from = Math.max(0, size - 262144);
  const lines = readRange(tp, from, size).split("\n");
  // The first line is only cut short when we started reading mid-file.
  for (let i = lines.length - 1; i >= (from > 0 ? 1 : 0); i--) {
    let row: any;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.isSidechain || row.isMeta) continue;
    if (row.type === "user") {
      return textOf(row).includes("[Request interrupted by user") ? { kind: "interrupted" } : { kind: "none" };
    }
    if (row.type !== "assistant") continue;
    const text = textOf(row).trim();
    if (row.isApiErrorMessage) return { kind: "error", text: text || row.error || "API error" };
    return text ? { kind: "text", text } : { kind: "none" };
  }
  return { kind: "none" };
}

// The last sentences of a closing message's last paragraph.
function closingSentences(text: string, count: number): string[] {
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]/g, "").trim();
  const last = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).at(-1) ?? "";
  const sentences = (last.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
  return sentences.slice(-count);
}

// The question a closing message ends on: one of the last two sentences of its last
// paragraph ("¿…?" works too). A question earlier in the text doesn't count.
function closingQuestion(text: string): string | undefined {
  const q = closingSentences(text, 2).reverse().find((s) => s.endsWith("?"));
  return q && q.length > 3 ? q.slice(0, 160) : undefined;
}

// Requests without a question mark ("Solo me falta saber cuál prefieres", "Con un
// 'adelante' lo hago", "Let me know which one"). Courtesy closings ("if you need
// anything else") don't count.
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const REQUEST = [
  /\b(me falta saber|solo falta|necesito (saber|que)|falta que (me )?(digas|confirmes|decidas|elijas|apruebes))\b/,
  /\b(dime|dimelo|confirmame|avisame|decide|elige|escoge|aprueba|indicame|me dices|me confirmas|me avisas)\b/,
  /\b(quieres que|prefieres|te parece (bien )?que|lo hago yo|lo mando yo|lo envio yo)\b/,
  /\bcon (un|una) ["'“‘][^"'”’]{1,40}["'”’] (lo|la|los|las|te|me|sigo|arranco)\b/,
  /\b(let me know|tell me|should i|do you want|would you like|want me to|shall i|please confirm|your call|say the word|which (one|option|do you)|approve|i need (you|your)|waiting (for|on) (you|your))\b/,
];
const COURTESY = /\b(si necesitas (algo|cualquier)|cualquier (cosa|duda)|if you (need|have) (anything|any)|any (other )?questions|happy to help)\b/;

function closingRequest(text: string): string | undefined {
  // The first request in the closing lines says the most ("which of the two"); the
  // ones after it tend to be the how ("say 'send it' and I send it").
  const hit = closingSentences(text, 3).find((s) => {
    const f = fold(s);
    return !COURTESY.test(f) && REQUEST.some((re) => re.test(f));
  });
  return hit ? hit.slice(0, 160) : undefined;
}

// Once a turn has ended, tell apart "done", "asks you" and "error". Waits a moment
// after Stop so the closing message is in the transcript.
function classifyTurn(s: Session) {
  s.classified = true;
  const last: LastTurn = s.tp && existsSync(s.tp) ? readLastTurn(s.tp) : { kind: "none" };
  if (last.kind === "error") {
    s.outcome = "error";
    s.errorText = last.text?.slice(0, 160);
  } else if (s.ask) {
    s.outcome = "asks"; // the question in the app's next-step box
  } else if (last.kind === "text" && (closingQuestion(last.text!) ?? closingRequest(last.text!))) {
    s.outcome = "asks";
    s.askText = closingQuestion(last.text!) ?? closingRequest(last.text!);
  } else {
    s.outcome = "done";
  }
  version++;
}

function checkTurns() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === "done" && !s.classified && now - s.since >= 800) classifyTurn(s);
  }
}

// Lesson from Vibe Notch: pressing Stop (Esc) ends a turn without a Stop hook, and so
// does an API error. If a session looks busy but went quiet with no tool running,
// look at how its transcript ends.
function checkQuietTurns() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status !== "working" || s.inFlight > 0 || !s.tp) continue;
    if (now - s.lastMain < 8000 || !existsSync(s.tp)) continue;
    const last = readLastTurn(s.tp);
    if (last.kind !== "interrupted" && last.kind !== "error") continue;
    setStatus(s, "done", now);
    s.tool = s.detail = undefined;
    s.classified = true;
    if (last.kind === "interrupted") {
      s.note = "You stopped it";
      s.outcome = "done";
    } else {
      s.outcome = "error";
      s.errorText = last.text?.slice(0, 160);
    }
    version++;
  }
}

// ---------------------------------------------------------------- history (SQLite)
//
// Every session is kept in ~/.claude-session-monitor/sessions.db: the main view shows
// the last 7 days, History shows all of it. Only what the cards show is stored (titles,
// status, the last recap or question), never the conversation.

let db: Database;
let upsert: ReturnType<Database["prepare"]>;

function openDatabase() {
  db = new Database(join(DIR, "sessions.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, title TEXT, prompt TEXT, project TEXT, cwd TEXT, app_cwd TEXT, tp TEXT,
    first_at INTEGER, last_at INTEGER, status TEXT, outcome TEXT, recap TEXT, ask TEXT, error TEXT,
    note TEXT, model TEXT, pid INTEGER, archived INTEGER NOT NULL DEFAULT 0)`);
  // Added later: databases from before have no task column yet.
  const cols = (db.query("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
  if (!cols.includes("task")) db.exec("ALTER TABLE sessions ADD COLUMN task TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_at)");
  db.exec("CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task, first_at)");
  upsert = db.prepare(`INSERT INTO sessions
    (sid, title, prompt, project, cwd, app_cwd, tp, first_at, last_at, status, outcome, recap, ask, error, note, model, pid, archived, task)
    VALUES ($sid, $title, $prompt, $project, $cwd, $app_cwd, $tp, $first_at, $last_at, $status, $outcome, $recap, $ask, $error, $note, $model, $pid, $archived, $task)
    ON CONFLICT(sid) DO UPDATE SET
      title = coalesce(excluded.title, title), prompt = coalesce(excluded.prompt, prompt),
      project = coalesce(excluded.project, project), cwd = coalesce(excluded.cwd, cwd),
      app_cwd = coalesce(excluded.app_cwd, app_cwd), tp = coalesce(excluded.tp, tp),
      first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at),
      status = excluded.status, outcome = excluded.outcome, recap = excluded.recap, ask = excluded.ask,
      error = excluded.error, note = excluded.note, model = coalesce(excluded.model, model),
      pid = excluded.pid, archived = excluded.archived, task = coalesce(excluded.task, task)`);
}

const rowOf = (s: Session) => ({
  $sid: s.sid, $title: s.title ?? null, $prompt: s.prompt ?? null,
  $project: s.appCwd ? basename(s.appCwd) : s.cwd ? basename(s.cwd) : null, // the app's folder is steadier than the shell's
  $cwd: s.cwd ?? null, $app_cwd: s.appCwd ?? null, $tp: s.tp ?? null,
  $first_at: s.first, $last_at: s.last, $status: s.status, $outcome: s.outcome ?? null,
  $recap: s.recap ?? null, $ask: s.ask ?? s.askText ?? null, $error: s.errorText ?? null,
  $note: s.note ?? null, $model: s.model ?? null, $pid: s.pid ?? null, $archived: s.archived ? 1 : 0,
  $task: s.task ?? null,
});

// Writes the sessions that changed since the last write.
const written = new Map<string, string>();
function persist() {
  const changed: Session[] = [];
  for (const s of sessions.values()) {
    const sig = JSON.stringify(rowOf(s));
    if (written.get(s.sid) !== sig) {
      written.set(s.sid, sig);
      changed.push(s);
    }
  }
  if (changed.length) db.transaction(() => { for (const s of changed) upsert.run(rowOf(s)); })();
}

// On startup, the last week comes back from the database, so a restart loses nothing.
function loadRecent() {
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
    });
  }
}

// History: every session, newest first, optionally filtered by words in its title,
// first prompt, project or last recap.
function history(q: string, limit: number, offset: number) {
  const like = q ? `%${q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%` : null;
  const where = like
    ? "WHERE lower(coalesce(title,'') || ' ' || coalesce(prompt,'') || ' ' || coalesce(project,'') || ' ' || coalesce(recap,'')) LIKE $like ESCAPE '\\'"
    : "";
  const params: any = like ? { $like: like } : {};
  const total = (db.query(`SELECT count(*) AS n FROM sessions ${where}`).get(params) as any).n;
  const rows = db.query(`SELECT * FROM sessions ${where} ORDER BY last_at DESC LIMIT $limit OFFSET $offset`)
    .all({ ...params, $limit: limit, $offset: offset }) as any[];
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
      recap: r.recap ?? undefined,
      ask: r.ask ?? undefined,
      error: r.error ?? undefined,
      note: r.note ?? undefined,
      archived: Boolean(r.archived),
      task: r.task ?? undefined,
      taskName: r.task ? tasks.get(r.task)?.name : undefined,
    })),
  };
}

// Where a session's transcript lives: ~/.claude/projects/<folder>/<sid>.jsonl.
const transcripts = new Map<string, string>();
let indexedAt = 0;
function findTranscript(sid: string): string | undefined {
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

// Titles and archive flags come from the desktop app's own session files. Their
// format is not documented, so every field is optional and errors are ignored.
// The same files fill the history with sessions from before this app existed, and
// bring this week's sessions to the main view even if they've been quiet since.
// The desktop app's scheduled tasks. Times may come as numbers or ISO strings.
const timeOf = (v: unknown) =>
  typeof v === "number" ? v : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined;
function readTasks(file: string): Task[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const list: any[] = Array.isArray(j?.scheduledTasks) ? j.scheduledTasks : [];
    return list
      .filter((t) => typeof t?.id === "string" && typeof t?.cronExpression === "string")
      .map((t) => ({
        id: t.id,
        name: typeof t.displayName === "string" && t.displayName.trim() ? t.displayName.trim() : t.id,
        cron: t.cronExpression,
        enabled: t.enabled !== false,
        cwd: typeof t.cwd === "string" ? t.cwd : undefined,
        file: typeof t.filePath === "string" ? t.filePath : undefined,
        created: timeOf(t.createdAt),
        lastRunAt: timeOf(t.lastRunAt),
        lastScheduledFor: timeOf(t.lastScheduledFor),
      }));
  } catch {
    return [];
  }
}

let desktopTimer: ReturnType<typeof setTimeout> | undefined;
function readDesktopSoon() {
  clearTimeout(desktopTimer);
  desktopTimer = setTimeout(readDesktopSessions, 1500);
}

function readDesktopSessions() {
  if (!existsSync(APP_SESSIONS)) return;
  const byCli = new Map<string, {
    title?: string; archived?: boolean; model?: string; cwd?: string; created?: number; last?: number; task?: string;
  }>();
  const found = new Map<string, Task>();
  try {
    for (const account of readdirSync(APP_SESSIONS)) {
      const accDir = join(APP_SESSIONS, account);
      if (!statSync(accDir).isDirectory()) continue;
      for (const org of readdirSync(accDir)) {
        const orgDir = join(accDir, org);
        if (!statSync(orgDir).isDirectory()) continue;
        for (const f of readdirSync(orgDir)) {
          if (f === "scheduled-tasks.json") {
            for (const t of readTasks(join(orgDir, f))) found.set(t.id, t);
            continue;
          }
          if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
          try {
            const j = JSON.parse(readFileSync(join(orgDir, f), "utf8"));
            if (typeof j.cliSessionId === "string") {
              byCli.set(j.cliSessionId, {
                title: j.title, archived: j.isArchived === true, model: j.model, cwd: j.originCwd ?? j.cwd,
                created: typeof j.createdAt === "number" ? j.createdAt : undefined,
                last: typeof j.lastActivityAt === "number" ? j.lastActivityAt : undefined,
                task: typeof j.scheduledTaskId === "string" ? j.scheduledTaskId : undefined,
              });
            }
          } catch {}
        }
      }
    }
  } catch {
    return;
  }
  if (JSON.stringify([...found.values()]) !== JSON.stringify([...tasks.values()])) {
    for (const [id, t] of found) {
      const old = tasks.get(id);
      if (old && (old.cron !== t.cron || (t.enabled && !old.enabled))) taskChanged.set(id, Date.now());
    }
    tasks.clear();
    for (const [id, t] of found) tasks.set(id, t);
    version++;
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
      version++;
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
    if (d.title !== s.title || d.archived !== s.archived || d.model !== s.model || d.cwd !== s.appCwd || d.task !== s.task) {
      s.title = d.title;
      s.archived = d.archived;
      s.model = d.model;
      s.appCwd = d.cwd;
      s.task = d.task;
      version++;
    }
  }
  if (fromApp.length && db) {
    db.transaction(() => {
      for (const s of fromApp) {
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
  }
}

// ---------------------------------------------------------------- subagents and workflows
//
// Claude Code keeps each session's subagents next to its transcript:
//   <session>/subagents/agent-<id>.jsonl + .meta.json            (Agent tool)
//   <session>/subagents/workflows/<run>/agent-<id>.jsonl + .meta.json + journal.jsonl
//   <session>/workflows/<run>.json                                (written when a run ends)
// None of this is documented, so every read is optional.

const sessionDir = (s: Session) => (s.tp?.endsWith(".jsonl") ? s.tp.slice(0, -6) : undefined);

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// Agent ids a workflow's journal already reports as finished.
function finishedInJournal(runDir: string): Set<string> {
  const done = new Set<string>();
  const file = join(runDir, "journal.jsonl");
  if (!existsSync(file)) return done;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"result"') && !line.includes('"failed"')) continue;
    try {
      const j = JSON.parse(line);
      if ((j.type === "result" || j.type === "failed") && j.agentId) done.add(j.agentId);
    } catch {}
  }
  return done;
}

// Reads the end of an agent's transcript: the size of its context (what the app's
// panel calls tokens), its last tool when no hook told us, and whether its last
// message closed the turn.
function readAgentTail(a: Agent, mtime: number) {
  if (!a.file || a.tailMtime === mtime) return;
  a.tailMtime = mtime;
  const size = statSync(a.file).size;
  // Tool results can be big (images), so read a generous tail.
  const from = Math.max(0, size - 262144);
  const lines = readRange(a.file, from, size).split("\n");
  let midTurn = false; // a tool result came after the last assistant message
  for (let i = lines.length - 1; i >= (from > 0 ? 1 : 0); i--) {
    let row: any;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.type === "user") {
      midTurn = true;
      continue;
    }
    if (row.type !== "assistant") continue;
    const u = row.message?.usage;
    if (u) {
      a.tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    const blocks: any[] = Array.isArray(row.message?.content) ? row.message.content : [];
    const use = blocks.findLast((b) => b?.type === "tool_use");
    if (use && !a.tool) {
      a.tool = use.name;
      const i2 = use.input ?? {};
      a.detail = i2.description ?? i2.file_path ?? i2.command ?? i2.pattern ?? i2.url;
    }
    if (!midTurn && row.message?.stop_reason === "end_turn" && !use) a.finished = true;
    return;
  }
}

function scanAgents(s: Session) {
  const dir = sessionDir(s);
  if (!dir) return;
  const sub = join(dir, "subagents");
  if (!existsSync(sub)) return;
  const now = Date.now();

  const consider = (file: string, run?: string) => {
    const m = basename(file).match(/^agent-([0-9a-z]+)\.jsonl$/);
    if (!m) return undefined;
    const id = m[1];
    const st = statSync(file);
    let a = s.agents.get(id);
    if (!a) {
      if (now - st.mtimeMs > AGENT_QUIET_MS) return undefined; // old, never seen live
      a = { id, startedAt: st.birthtimeMs || st.mtimeMs, lastAt: st.mtimeMs };
      s.agents.set(id, a);
    }
    a.file = file;
    a.run = run ?? a.run;
    a.lastAt = Math.max(a.lastAt, st.mtimeMs);
    if (!a.metaRead) {
      a.metaRead = true;
      const meta = readJson(join(dirname(file), `agent-${id}.meta.json`));
      if (meta) {
        a.label = meta.description;
        a.phase = meta.workflowPhase;
        a.model = meta.model;
        a.background = meta.requestShape === "background";
      }
    }
    if (!a.finished) readAgentTail(a, st.mtimeMs);
    return a;
  };

  for (const f of readdirSync(sub)) if (f.startsWith("agent-") && f.endsWith(".jsonl")) consider(join(sub, f));

  const wfDir = join(sub, "workflows");
  if (!existsSync(wfDir)) return;
  for (const runId of readdirSync(wfDir)) {
    const runDir = join(wfDir, runId);
    let st;
    try {
      st = statSync(runDir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || (now - st.mtimeMs > RUN_DIR_MS && !s.runs.has(runId))) continue;
    const finished = existsSync(join(dir, "workflows", `${runId}.json`));
    const run = s.runs.get(runId) ?? { id: runId, startedAt: st.birthtimeMs || st.mtimeMs, finished };
    run.finished = finished;
    s.runs.set(runId, run);
    const done = finished ? undefined : finishedInJournal(runDir);
    for (const f of readdirSync(runDir)) {
      const a = consider(join(runDir, f), runId);
      if (a && (finished || done?.has(a.id))) a.finished = true;
    }
  }
}

// The app's panel names a workflow after its script file (nightly-review.js → nightly-review).
// The run id shows up in the Workflow call's result in the transcript; its input has
// the script path, or the script itself with `meta.name`.
const runNames = new Map<string, { name?: string; description?: string; tried: number }>();

function runName(s: Session, runId: string): { name?: string; description?: string } {
  const key = `${s.sid}:${runId}`;
  const cached = runNames.get(key);
  if (cached && (cached.name || Date.now() - cached.tried < 30_000)) return cached;
  const entry = { name: undefined as string | undefined, description: undefined as string | undefined, tried: Date.now() };
  runNames.set(key, entry);
  if (!s.tp || !existsSync(s.tp)) return entry;
  const size = statSync(s.tp).size;
  const lines = readRange(s.tp, Math.max(0, size - 4_000_000), size).split("\n");
  let toolUseId: string | undefined;
  for (let i = lines.length - 1; i >= 0 && !toolUseId; i--) {
    if (!lines[i].includes(runId) || !lines[i].includes("tool_result")) continue;
    try {
      const row = JSON.parse(lines[i]);
      const hit = (row.message?.content ?? []).find((b: any) =>
        b?.type === "tool_result" && JSON.stringify(b.content ?? "").includes(runId));
      toolUseId = hit?.tool_use_id;
    } catch {}
  }
  if (!toolUseId) return entry;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(toolUseId) || !lines[i].includes('"Workflow"')) continue;
    try {
      const row = JSON.parse(lines[i]);
      const use = (row.message?.content ?? []).find((b: any) => b?.type === "tool_use" && b.id === toolUseId);
      if (!use) continue;
      const input = use.input ?? {};
      let script: string = input.script ?? "";
      if (input.scriptPath) {
        entry.name = basename(input.scriptPath).replace(/\.[cm]?js$/, "");
        if (!script && existsSync(input.scriptPath)) script = readFileSync(input.scriptPath, "utf8").slice(0, 4000);
      }
      if (!entry.name && input.name) entry.name = input.name;
      entry.name ??= script.match(/name:\s*['"`]([^'"`]+)['"`]/)?.[1];
      entry.description = script.match(/description:\s*['"`]([^'"`]+)['"`]/)?.[1]?.slice(0, 160);
    } catch {}
    break;
  }
  return entry;
}

// Agents the card should show right now.
function activeAgents(s: Session): Agent[] {
  if (s.status === "ended") return [];
  const now = Date.now();
  return [...s.agents.values()]
    .filter((a) => !a.finished && now - a.lastAt < AGENT_QUIET_MS)
    .filter((a) => !a.run || !s.runs.get(a.run)?.finished)
    .sort((a, b) => a.startedAt - b.startedAt);
}

let agentSig = "";
function scanAllAgents() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === "ended" || now - s.last > FORGET_MS) continue;
    try {
      scanAgents(s);
    } catch {}
    // Keep memory flat: finished agents and runs go after a while.
    for (const [id, a] of s.agents) if ((a.finished || now - a.lastAt > AGENT_QUIET_MS) && now - a.lastAt > 600_000) s.agents.delete(id);
    for (const [id, r] of s.runs) if (r.finished && now - r.startedAt > RUN_DIR_MS) s.runs.delete(id);
  }
  const sig = JSON.stringify([...sessions.values()].map((s) =>
    [s.sid, activeAgents(s).map((a) => [a.id, a.tool, a.detail, a.tokens, a.phase])]));
  if (sig !== agentSig) {
    agentSig = sig;
    version++;
  }
}

// After a week a session leaves the main view, a day later it leaves memory. It stays
// in the database, so History keeps it.
function forgetOld() {
  persist();
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

// ---------------------------------------------------------------- what the page gets

// What the card shows. A finished turn splits into done, asks (it ended with a question
// for you) and error. Most urgent first.
type Shown = Status | "asks" | "error";
const ORDER: Record<Shown, number> = { waiting: 0, asks: 1, error: 2, working: 3, done: 4, idle: 5, ended: 6 };

// The one rule for "needs you", so the window, the Dock badge and the menu bar agree:
// blocked on you, or a question or an error from the last day.
const needsYou = (shown: Shown, last: number, now: number) =>
  shown === "waiting" || ((shown === "asks" || shown === "error") && now - last < DAY_MS);

// A session whose own turn ended but still has subagents or a workflow running is
// busy: the card says so instead of "Done". A question or an error still wins.
function shownStatus(s: Session, agents: Agent[]): Shown {
  if (s.status === "done" && s.outcome === "asks") return "asks";
  if (s.status === "done" && s.outcome === "error") return "error";
  return (s.status === "done" || s.status === "idle") && agents.length ? "working" : s.status;
}

// ---------------------------------------------------------------- scheduled tasks

const MISSED_GRACE_MS = 10 * 60 * 1000; // a run gets this long to start before it counts as missed
const RUNS_SHOWN = 7;

type RunView = {
  sid: string; status: Shown; needsYou: boolean; first: number; last: number; since?: number;
  ask?: string; error?: string; recap?: string; note?: string; tool?: string; detail?: string; wait?: string;
};

// A task's latest runs, newest first: this week's from memory (live), older ones from
// the database.
function taskRuns(t: Task, now: number): RunView[] {
  const runs = new Map<string, RunView>();
  if (db) {
    const rows = db.query(`SELECT sid, status, outcome, first_at, last_at, ask, error, recap, note FROM sessions
      WHERE task = ? ORDER BY first_at DESC LIMIT ${RUNS_SHOWN}`).all(t.id) as any[];
    for (const r of rows) {
      // Saved as busy but no longer in memory: it isn't busy anymore.
      const raw = r.status === "done" ? r.outcome ?? "done" : r.status;
      const status: Shown = raw === "working" || raw === "waiting" ? "ended" : raw ?? "ended";
      runs.set(r.sid, {
        sid: r.sid, status, needsYou: needsYou(status, r.last_at, now), first: r.first_at ?? r.last_at, last: r.last_at,
        ask: r.ask ?? undefined, error: r.error ?? undefined, recap: r.recap ?? undefined, note: r.note ?? undefined,
      });
    }
  }
  for (const s of sessions.values()) {
    if (s.task !== t.id) continue;
    const agents = activeAgents(s);
    const status = shownStatus(s, agents);
    const last = Math.max(s.last, ...agents.map((a) => a.lastAt));
    runs.set(s.sid, {
      sid: s.sid, status, needsYou: needsYou(status, s.last, now), first: s.first, last, since: s.since,
      ask: s.ask ?? s.askText, error: s.errorText, recap: s.recap, note: s.note,
      tool: status === "working" ? s.tool : undefined, detail: status === "working" ? s.detail : undefined,
      wait: status === "waiting" ? s.wait : undefined,
    });
  }
  return [...runs.values()].sort((a, b) => b.first - a.first).slice(0, RUNS_SHOWN);
}

// One entry per task for the Scheduled view: its schedule in words, its next run, how
// the last one went, and whether a run that should have happened didn't.
function taskList(now: number) {
  return [...tasks.values()].map((t) => {
    const c = parseCron(t.cron);
    const runs = taskRuns(t, now);
    const lastRun = runs[0] ?? null;
    const prev = c ? prevRun(c, now - MISSED_GRACE_MS) : null;
    const missed = Boolean(
      t.enabled && prev != null && prev > Math.max(t.created ?? 0, taskChanged.get(t.id) ?? 0) &&
      prev > (t.lastScheduledFor ?? 0) + 60_000 &&
      !(lastRun && lastRun.first >= prev - 60_000), // it ran, the file just hasn't caught up
    );
    const running = lastRun?.status === "working" || lastRun?.status === "waiting";
    const rank = !t.enabled ? 4 : lastRun?.needsYou ? 0 : running ? 1 : missed ? 2 : 3;
    return {
      id: t.id,
      name: t.name,
      schedule: describeCron(t.cron),
      cron: t.cron,
      enabled: t.enabled,
      project: t.cwd ? basename(t.cwd) : "",
      cwd: t.cwd ?? "",
      file: t.file ?? "",
      next: t.enabled && c ? nextRun(c, now) : null,
      missed: missed ? prev : null,
      lastRun,
      runs: runs.map((r) => ({ sid: r.sid, status: r.status, needsYou: r.needsYou, at: r.first })),
      rank,
    };
  }).sort((a, b) => a.rank - b.rank || (a.next ?? Infinity) - (b.next ?? Infinity) || a.name.localeCompare(b.name));
}

function snapshot() {
  const now = Date.now();
  const list = [...sessions.values()]
    .filter((s) => !s.archived)
    .map((s) => ({ s, agents: activeAgents(s) }))
    .map((x) => ({ ...x, shown: shownStatus(x.s, x.agents) }))
    // The main view is the last 7 days; anything still running stays regardless.
    .filter(({ s, shown }) => shown === "working" || shown === "waiting" || now - s.last < WEEK_MS)
    // Most urgent first. Working sessions keep a fixed order (newest started first):
    // sorting them by last activity would swap two busy cards every few seconds.
    .sort((a, b) => ORDER[a.shown] - ORDER[b.shown] || (a.shown === "working" ? b.s.first - a.s.first : b.s.last - a.s.last))
    .map(({ s, agents, shown }) => {
      const total = s.plan?.length ?? 0;
      const done = s.plan?.filter((st) => st.s === "completed").length ?? 0;
      const current = s.plan?.find((st) => st.s === "in_progress");
      // Group workflow agents by run, newest run first.
      const runIds = [...new Set(agents.map((a) => a.run).filter(Boolean) as string[])];
      const workflows = runIds.map((id) => {
        const mine = agents.filter((a) => a.run === id);
        const meta = runName(s, id);
        return {
          id,
          name: meta.name ?? "Workflow",
          description: meta.description,
          phase: mine.at(-1)?.phase,
          agents: mine.length,
          tokens: mine.reduce((n, a) => n + (a.tokens ?? 0), 0),
          startedAt: s.runs.get(id)?.startedAt ?? mine[0]?.startedAt,
        };
      }).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      return {
        sid: s.sid,
        title: s.title || s.prompt || (s.cwd ? basename(s.cwd) : "Session"),
        project: s.appCwd ? basename(s.appCwd) : s.cwd ? basename(s.cwd) : "", // the session's own folder, not wherever its shell is now
        status: shown,
        needsYou: needsYou(shown, s.last, now),
        cwd: s.appCwd ?? s.cwd ?? "", // for Reveal in Finder
        task: s.task,
        taskName: s.task ? tasks.get(s.task)?.name : undefined,
        background: shown === "working" && s.status !== "working", // only its agents are working
        since: s.since,
        first: s.first,
        last: Math.max(s.last, ...agents.map((a) => a.lastAt)),
        tool: s.tool,
        detail: s.detail,
        wait: s.wait,
        waitKind: s.waitKind,
        recap: s.recap,
        ask: s.ask ?? s.askText,
        error: s.errorText,
        note: s.note,
        model: s.model,
        agents: agents.slice(0, 6).map((a) => ({
          id: a.id,
          label: a.label,
          phase: a.phase,
          model: a.model,
          run: a.run,
          background: a.background,
          tool: a.tool,
          detail: a.detail,
          tokens: a.tokens,
          startedAt: a.startedAt,
          lastAt: a.lastAt,
        })),
        agentCount: agents.length,
        workflows,
        plan: total ? { done, total, current: current?.c, index: s.plan!.indexOf(current!) + 1 } : null,
      };
    });
  return { now, needs: list.filter((x) => x.needsYou).length, sessions: list, tasks: taskList(now) };
}

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

const server = Bun.serve({
  hostname: "127.0.0.1", // never reachable from other machines
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
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
  },
});

// ---------------------------------------------------------------- start

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
  });
} catch {}

setInterval(pump, 1000); // safety net in case a file event is missed
setInterval(checkQuietTurns, 3000);
setInterval(checkTurns, 500);
setInterval(scanAllAgents, 3000);
setInterval(checkProcesses, 10_000);
setInterval(readDesktopSessions, 15_000);
// A task's next run and a missed run change with the clock, not with an event.
let taskClock = "";
setInterval(() => {
  const sig = JSON.stringify(taskList(Date.now()).map((t) => [t.id, t.next, t.missed]));
  if (sig !== taskClock) {
    taskClock = sig;
    version++;
  }
}, 30_000);
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
