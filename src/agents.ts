// Subagents, workflows and background commands, from the files next to a session's transcript.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FORGET_MS, AGENT_QUIET_MS, COMMAND_MAX_MS, RUN_DIR_MS } from "./config.ts";
import { type Agent, type Session, type Command, sessions, bump } from "./state.ts";
import { readRange } from "./log.ts";

// Claude Code keeps each session's subagents next to its transcript:
//   <session>/subagents/agent-<id>.jsonl + .meta.json            (Agent tool)
//   <session>/subagents/workflows/<run>/agent-<id>.jsonl + .meta.json + journal.jsonl
//   <session>/workflows/<run>.json                                (written when a run ends)
// None of this is documented, so every read is optional.

export const sessionDir = (s: Session) => (s.tp?.endsWith(".jsonl") ? s.tp.slice(0, -6) : undefined);

export function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// Agent ids a workflow's journal already reports as finished.
// Read again only when the journal grows.
const journals = new Map<string, { size: number; done: Set<string> }>();
export function finishedInJournal(runDir: string): Set<string> {
  const done = new Set<string>();
  const file = join(runDir, "journal.jsonl");
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return done;
  }
  const cached = journals.get(file);
  if (cached?.size === size) return cached.done;
  if (journals.size > 500) journals.clear(); // runs come and go; keep memory flat
  journals.set(file, { size, done });
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"result"') && !line.includes('"failed"')) continue;
    try {
      const j = JSON.parse(line);
      if ((j.type === "result" || j.type === "failed") && j.agentId) done.add(j.agentId);
    } catch {}
  }
  return done;
}

// A detail is cut as the hook cuts it: one line, 160 characters at most.
export const short = (v: unknown, n = 160) => (typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, n) : undefined);

// Reads the end of an agent's transcript: the size of its context (what the app's
// panel calls tokens), its last tool when no hook told us, and whether its last
// message closed the turn.
export function readAgentTail(a: Agent, mtime: number) {
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
      a.detail = short(i2.description ?? i2.file_path ?? i2.command ?? i2.pattern ?? i2.url);
    }
    if (!midTurn && row.message?.stop_reason === "end_turn" && !use) a.finished = true;
    return;
  }
}

export function scanAgents(s: Session) {
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
        a.label = short(meta.description);
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
// the script path, or the script itself with `meta.name`. Only the transcript is read:
// never the script file, which can be anywhere on disk.
const runNames = new Map<string, { name?: string; description?: string; tried: number }>();

export function runName(s: Session, runId: string): { name?: string; description?: string } {
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
      const script = typeof input.script === "string" ? input.script.slice(0, 4000) : "";
      if (typeof input.scriptPath === "string") entry.name = basename(input.scriptPath).replace(/\.[cm]?js$/, "");
      if (!entry.name && typeof input.name === "string") entry.name = input.name;
      entry.name ??= script.match(/name:\s*['"`]([^'"`]+)['"`]/)?.[1];
      entry.name = short(entry.name, 80);
      entry.description = short(script.match(/description:\s*['"`]([^'"`]+)['"`]/)?.[1]);
    } catch {}
    break;
  }
  return entry;
}

// Agents the card should show right now.
export function activeAgents(s: Session): Agent[] {
  if (s.status === "ended") return [];
  const now = Date.now();
  return [...s.agents.values()]
    .filter((a) => !a.finished && now - a.lastAt < AGENT_QUIET_MS)
    .filter((a) => !a.run || !s.runs.get(a.run)?.finished)
    .sort((a, b) => a.startedAt - b.startedAt);
}

// Background commands, from the end of the transcript. A Bash call that ran past its timeout,
// or was started in the background, returns a task ID; when the command ends, Claude Code
// queues a <task-notification> with that ID to wake the session up. TaskStop ends one too.
export function scanCommands(s: Session) {
  if (!s.tp || !existsSync(s.tp)) return;
  const size = statSync(s.tp).size;
  if (s.commandsRead === size) return;
  const from = Math.max(0, size - 262144);
  const lines = readRange(s.tp, from, size).split("\n");
  const described = new Map<string, string | undefined>(); // Bash calls, by tool-use ID
  const started = new Map<string, Command>();
  const ended = new Set<string>();
  // The first line is only cut short when we started reading mid-file.
  for (let i = from > 0 ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("tool_use") && !line.includes("task-notification")) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain) continue;
    if (row.type === "queue-operation") {
      for (const m of line.matchAll(/<task-id>([^<]+)<\/task-id>/g)) ended.add(m[1]);
      continue;
    }
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    for (const b of content) {
      if (b?.type === "tool_use" && b.name === "Bash") described.set(b.id, b.input?.description);
      if (b?.type === "tool_use" && (b.name === "TaskStop" || b.name === "KillShell")) ended.add(b.input?.task_id ?? b.input?.shell_id);
      const task = row.toolUseResult?.backgroundTaskId;
      if (b?.type === "tool_result" && typeof task === "string") {
        const at = Date.parse(row.timestamp);
        started.set(task, { id: task, at: Number.isFinite(at) ? at : Date.now(), detail: described.get(b.tool_use_id) });
      }
    }
  }
  s.commands = [...started.values()].filter((c) => !ended.has(c.id));
  s.commandsRead = size;
}

// Background commands the card should show right now.
export function activeCommands(s: Session): Command[] {
  if (s.status === "ended") return [];
  const now = Date.now();
  return (s.commands ?? []).filter((c) => now - c.at < COMMAND_MAX_MS);
}

// A folder's time changes when a file is added to it, not when one grows. So a session with
// no agent at work and no workflow run still open needs a walk only when its subagents
// folder or its workflows folder changed: a new agent or a new run.
const folderSig = new Map<string, string>();
export function folderSignature(s: Session): string {
  const dir = sessionDir(s);
  if (!dir) return "";
  const mtime = (p: string) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  };
  const sub = join(dir, "subagents");
  return `${dir}|${mtime(sub)}|${mtime(join(sub, "workflows"))}|${mtime(join(dir, "workflows"))}`;
}
export function needsWalk(s: Session, now = Date.now()): boolean {
  if (activeAgents(s).length) return true; // its transcript grows without the folder changing
  for (const r of s.runs.values()) if (!r.finished && now - r.startedAt < RUN_DIR_MS) return true;
  for (const a of s.agents.values()) if (!a.finished && !a.file) return true; // heard from, file not found yet
  const sig = folderSignature(s);
  if (folderSig.get(s.sid) === sig) return false;
  folderSig.set(s.sid, sig);
  return true;
}
export let walks = 0; // sessions walked since the start, for tests

let agentSig = "";
export function scanAllAgents() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === "ended" || now - s.last > FORGET_MS) {
      folderSig.delete(s.sid);
      continue;
    }
    try {
      if (needsWalk(s, now)) {
        walks++;
        scanAgents(s);
      }
    } catch {
      folderSig.delete(s.sid); // try again next pass
    }
    // A finished turn may have left a command running; one still at work shows anyway.
    if ((s.status === "done" || s.status === "idle") && now - s.last < COMMAND_MAX_MS) {
      try {
        scanCommands(s);
      } catch {}
    }
    // Keep memory flat: finished agents and runs go after a while.
    for (const [id, a] of s.agents) if ((a.finished || now - a.lastAt > AGENT_QUIET_MS) && now - a.lastAt > 600_000) s.agents.delete(id);
    for (const [id, r] of s.runs) if (r.finished && now - r.startedAt > RUN_DIR_MS) s.runs.delete(id);
  }
  const sig = JSON.stringify([...sessions.values()].map((s) =>
    [s.sid, activeAgents(s).map((a) => [a.id, a.tool, a.detail, a.tokens, a.phase]), activeCommands(s).map((c) => c.id)]));
  if (sig !== agentSig) {
    agentSig = sig;
    bump();
  }
}
