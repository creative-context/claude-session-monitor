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
  relayed?: string[]; // the ones whose question it asks you now
  inFlight: number; // main-agent tools started and not finished
  tool?: string;
  detail?: string;
  wait?: string; // what it needs from you
  waitKind?: "permission" | "question" | "plan" | "input";
  waitAgent?: string; // the subagent whose permission request it waits on, if it's one
  waitPrev?: Status; // what it was doing before it started waiting
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
  appAsk?: { text: string; edge: number }; // what the Claude app says its last turn needs from you ("" = nothing)
  reminders?: Reminder[]; // what it set to wake itself up: a /loop wakeup or a cron job
  made?: { id: string; t: number }[]; // scheduled tasks of the Claude app it set up, as asked
  commands?: Command[]; // commands it moved to the background that haven't said they finished
  commandsRead?: number; // the transcript's size when they were read
};

// A shell command running in the background: Claude Code wakes the session up when it ends.
// Its ID, when it started and its short description, never the command itself.
export type Command = { id: string; at: number; detail?: string };

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
