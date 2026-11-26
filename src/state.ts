// The types, and the state every part shares: the sessions, the desktop app's scheduled
// tasks and what its files say about sessions, and a version that bumps on every change.

export type Status = "working" | "waiting" | "done" | "idle" | "ended";
export type Step = { c: string; s: "pending" | "in_progress" | "completed" };

// A subagent: one started with the Agent tool, or one agent of a workflow.
export type Agent = {
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
  stoppedAt?: number; // when its SubagentStop came
  metaRead?: boolean;
  tailMtime?: number; // transcript mtime we last read the tail at
  commands?: Command[]; // its own background commands that haven't said they finished
  commandsRead?: number; // transcript size we last read them at
};

export type Run = { id: string; startedAt: number; finished: boolean };

export type Ev = {
  t: number; pid?: number; ev: string; sid: string; cwd?: string; tp?: string; pm?: string;
  agent?: string; tool?: string; d?: string; nt?: string; msg?: string; src?: string;
  why?: string; prompt?: string; x?: any;
};

export type Session = {
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
  lastPrompt?: number; // when it last got a message (yours, or another session's)
  relays?: string[]; // sessions its closing message says are waiting for you (Claude Code IDs)
  relaysAhead?: boolean; // its closing says a session it starts will ask you, naming none
  relayed?: string[]; // the ones whose question it asks you now
  inFlight: number; // main-agent tools started and not finished
  tool?: string;
  detail?: string;
  wait?: string; // what it needs from you
  waitKind?: "permission" | "question" | "plan" | "input" | "app";
  askSoon?: { tool: string; text: string; at: number }; // asked in the Claude app's own dialog, not answered yet (checkAppAsks)
  waitAgent?: string; // the subagent whose permission request it waits on, if it's one
  waitPrev?: Status; // what it was doing before it started waiting
  prompt?: string;
  recap?: string;
  ask?: string;
  answers?: Answer[]; // the answer buttons under its question (wrap_up's actions), only with an ask
  reply?: Reply; // an answer you gave from its card, a button or your words, on its way (in memory only)
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
  model?: string; // the app's model ID; for a session in a terminal, the model of its last reply
  effort?: string; // low, medium, high, xhigh or max, as the app saves it
  ultra?: boolean; // ultracode is on
  appCwd?: string; // the folder the app opened the session in; needed to reopen it
  task?: string; // the scheduled task this session is a run of
  appAsk?: { text: string; edge: number }; // what the Claude app says its last turn needs from you ("" = nothing)
  reminders?: Reminder[]; // what it set to wake itself up: a /loop wakeup or a cron job
  made?: { id: string; t: number }[]; // scheduled tasks of the Claude app it set up, as asked
  commands?: Command[]; // commands it moved to the background that haven't said they finished
  commandsRead?: number; // the transcript's size when they were read
  // The model that advises it (/advisor), while one is turned on. Only the model is saved (src/advisor.ts).
  advisor?: { model: string };
  advisorRead?: number; // how far its transcript was read for it; none while its first scan is under way
  worked?: import("./worked.ts").Worked; // its time working, per day (src/worked.ts)
};

// An answer button the session offered with its question: its words, and the Claude app's
// action when it's one (commit, create_pr, ...), which only the app can do.
export type Answer = { label: string; app?: string };
// An answer you gave on its card, a button's (i, its index) or words you dictated and sent
// (i is -1): pending until the session's answers mod picks it up (at once when it's asking),
// then sent, or failed when none does. Never saved.
export type Reply = { text: string; i: number; at: number; state: "pending" | "sent" | "failed" };

// A shell command running in the background: Claude Code wakes the session up when it ends.
// Its ID, when it started and its short description, never the command itself.
export type Command = { id: string; at: number; detail?: string; monitor?: boolean; until?: number }; // until: when a Monitor expires

// A reminder a session set for itself (ScheduleWakeup, CronCreate). Only when and how
// often, never what it will do. They live in the session's process, so they go when it
// closes, and a repeating one stops after 7 days, as Claude Code does.
export type Reminder = { id: string; at: number; cron?: string; rec?: boolean; until?: number };

// A scheduled task of the Claude desktop app, from its scheduled-tasks.json. Only its
// name, schedule, folder and times are read, never what the task does.
export type Task = {
  id: string; name: string; cron?: string; at?: number; enabled: boolean; cwd?: string; file?: string; // cron, or at for a one-time task
  created?: number; lastRunAt?: number; lastScheduledFor?: number;
  skips?: { at: number; reason: string }[]; // tries to start a run the app gave up on, since its last run
};
export const tasks = new Map<string, Task>();
export const taskChanged = new Map<string, number>(); // when a task was last resumed or rescheduled

export const sessions = new Map<string, Session>();
// The sessions you pinned, by ID: this week's and older ones alike, from sessions.db
// (src/db.ts keeps the two in step). Only the ID and when it was pinned are stored.
export const pins = new Set<string>();
export let version = 0; // bumps on every change, so the stream only sends when needed

// What changed since the last write to the database: the sessions a bump named, or all
// of them when it didn't say. persist() looks only at these.
export const dirty = new Set<string>();
export let allDirty = true; // the first write looks at everything
export function clean() {
  dirty.clear();
  allDirty = false;
}

// The server listens here to send the change to the page and to plan the next write,
// instead of polling the version.
let listener: ((write: boolean) => void) | undefined;
export const onBump = (fn: ((write: boolean) => void) | undefined) => {
  listener = fn;
};

// A change: of the session given, or of any (all are looked at before the next write).
export const bump = (s?: Session | string) => {
  version++;
  if (s == null) allDirty = true;
  else dirty.add(typeof s === "string" ? s : s.sid);
  listener?.(true);
};
// A change only the page sees, with nothing to write: the clock moved a task or a usage window.
export const bumpView = () => {
  version++;
  listener?.(false);
};

// The Claude app's own session IDs (as in its "#local_…" links) → Claude Code's.
export const localToCli = new Map<string, string>();

// Session titles from the desktop app's files, by Claude Code session ID.
export const appTitles = new Map<string, string>();

// What a session waits on in the Claude app's own dialog or card, which no permission event
// announces: the words for it, or undefined for any other tool. Taking over the screen, using
// apps or guiding you on screen (computer-use), a new session offered to you (an offer only:
// the hook keeps its initiation), changing a session's permissions or a setting, opening a folder.
const APP_ASKS: [RegExp, string][] = [
  [/^mcp__computer[-_]use__request_full_control$/, "Wants to take over your screen"],
  [/^mcp__computer[-_]use__request_access$/, "Wants access to apps on your Mac"],
  [/^mcp__computer[-_]use__request_teach_access$/, "Wants to guide you on your screen"],
  [/^mcp__ccd_session__start_session$/, "Asks whether to start a new session"],
  [/^mcp__ccd_session_mgmt__set_session_permission_mode$/, "Wants to change a session's permissions"],
  [/^mcp__ccd_settings__set_setting$/, "Wants to change a setting"],
  [/^mcp__ccd_directory__request_directory$/, "Wants access to a folder"],
];
export function appAsk(tool?: string, x?: Record<string, unknown>): string | undefined {
  if (!tool || (tool === "mcp__ccd_session__start_session" && x?.init !== "offer")) return undefined;
  return APP_ASKS.find(([re]) => re.test(tool))?.[1];
}

// One check at the door, for every line the log hands the state machine. The hook writes these
// fields as strings, cut; anything else in the log (another writer, a damaged line, a newer
// Claude Code) is set to its shape here: a field of the wrong type goes, text is capped, a time
// that isn't a number becomes now, and one past now (a clock set back after it ran ahead) is
// brought back to now, so a session can't sit at the top of the lists for good. A line with no
// session ID or event name isn't an event.
const TEXT_CAPS: Record<string, number> = { cwd: 1000, tp: 1000, pm: 40, agent: 120, tool: 200, d: 400, nt: 80, msg: 400, src: 60, why: 120, prompt: 400 };
export const FUTURE_SLACK_MS = 5 * 60_000;
export function cleanEvent(raw: unknown, now = Date.now()): Ev | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sid !== "string" || !r.sid || r.sid.length > 120 || typeof r.ev !== "string" || r.ev.length > 60) return null;
  const t = typeof r.t === "number" && Number.isFinite(r.t) && r.t > 0 ? Math.min(r.t, now + FUTURE_SLACK_MS) : now;
  const e: Ev = { t, ev: r.ev, sid: r.sid };
  if (typeof r.pid === "number" && Number.isFinite(r.pid)) e.pid = r.pid;
  for (const [k, cap] of Object.entries(TEXT_CAPS)) {
    const v = r[k];
    if (typeof v === "string") (e as Record<string, unknown>)[k] = v.length > cap ? v.slice(0, cap) : v;
  }
  if (r.x && typeof r.x === "object" && !Array.isArray(r.x)) e.x = cleanX(r.x as Record<string, unknown>);
  return e;
}

// The extra fields the hook keeps (a plan's steps, a closing recap and question, a reminder's
// time): text, numbers and flags as they are, text capped; the plan's steps, step numbers and
// answer buttons in their own shape; anything else nested goes. So a recap that arrives as an
// object can't reach the database, where one bad value would stop every row from being written.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, cap: number) => (typeof v === "string" ? v.slice(0, cap) : undefined);
function cleanX(x: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === "string") o[k] = v.slice(0, 400);
    else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || v === null) o[k] = v;
    else if (k === "items" && Array.isArray(v)) o.items = v.filter(isObj).slice(0, 20).map((i) => ({ c: str(i.c ?? i.content, 200) ?? "", s: str(i.s ?? i.status, 30) }));
    else if (k === "acts" && Array.isArray(v)) o.acts = v.filter(isObj).slice(0, 2).map((a) => ({ l: str(a.l, 60), a: str(a.a, 40) }));
    else if ((k === "done" || k === "start") && Array.isArray(v)) o[k] = v.filter((n) => typeof n === "number" && Number.isFinite(n)).slice(0, 20);
  }
  return o;
}
