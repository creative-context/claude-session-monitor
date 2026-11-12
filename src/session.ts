// The state machine: what each hook event does to its session.

import { existsSync, statSync } from "node:fs";
import { nextRun, parseCron } from "../cron.ts";
import { type Status, type Step, type Ev, type Session, sessions, bump } from "./state.ts";
import { readRange } from "./log.ts";
import { readAppFileSoon, readDesktopSoon } from "./desktop.ts";
import { timeOf } from "./tasks.ts";

// A repeating reminder stops after 7 days, as Claude Code does.
const REMINDER_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function setStatus(s: Session, status: Status, t: number) {
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
    s.waitAgent = undefined;
    s.waitPrev = undefined;
  }
}

export function setWaiting(s: Session, kind: Session["waitKind"], text: string, t: number, agent?: string) {
  if (s.status !== "waiting") s.waitPrev = s.status;
  setStatus(s, "waiting", t);
  s.waitKind = kind;
  s.wait = text;
  s.waitAgent = agent;
}

// A subagent's permission request blocks the session until that agent moves on: its
// tool runs (or fails), or it starts another. The main agent may stay silent the whole
// time (a workflow runs without it), so only the agent itself can end the wait. The
// session then goes back to what it was doing.
export function resumeAfterAgent(s: Session, e: Ev) {
  if (s.status !== "waiting" || !s.waitAgent || s.waitAgent !== e.agent) return;
  const moved = e.ev === "PostToolUse" || e.ev === "PostToolUseFailure" || (e.ev === "PreToolUse" && e.t > s.since);
  if (!moved) return;
  const prev = s.waitPrev && s.waitPrev !== "waiting" ? s.waitPrev : "working";
  setStatus(s, prev, e.t);
  if (prev === "done") s.classified = false; // read again how its turn ended
}

export function applyPlan(plan: Step[] | undefined, x: any): Step[] | undefined {
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

export const completeCurrent = (plan?: Step[]) =>
  plan?.map((st) => (st.s === "in_progress" ? { ...st, s: "completed" as const } : st));

// A session we first meet halfway (hooks installed later, or the server was off)
// gets its plan and last recap from the transcript, replayed with the same rules.
export function hydrate(s: Session) {
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
  bump(s);
}

// Workflow agents never send SubagentStart, so an agent is created by whatever we
// hear from it first: a hook event here, or its files in scanAgents().
export function touchAgent(s: Session, e: Ev) {
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
  if (e.ev === "SubagentStop") {
    a.finished = true;
    a.stoppedAt = e.t;
  } else if (a.finished && a.stoppedAt != null && e.t > a.stoppedAt) {
    // A stopped agent the session sent another message to: it works again.
    a.finished = false;
    a.tailMtime = undefined;
  }
}

// A reminder the session set, changed or dropped, or a scheduled task it set up.
export function noteSchedule(s: Session, e: Ev) {
  const x = e.x;
  if (e.tool === "ScheduleWakeup") {
    // One wakeup at a time: each new one replaces the last, and stop ends the loop.
    const rest = (s.reminders ?? []).filter((r) => r.id !== "wake");
    const delay = Math.min(3600, Math.max(60, Number(x.delay) || 0)) * 1000;
    const given = timeOf(x.at);
    const at = given != null && given > e.t - 60_000 ? given : x.delay ? e.t + delay : undefined;
    s.reminders = x.stop || !at ? rest : [...rest, { id: "wake", at }];
  } else if (e.tool === "CronCreate" && typeof x.cron === "string") {
    const c = parseCron(x.cron);
    const given = timeOf(x.at);
    const at = given != null && given > e.t - 60_000 ? given : c ? nextRun(c, e.t) : null;
    if (at == null) return;
    const rec = x.rec !== false;
    const id = typeof x.id === "string" ? x.id : `cron ${x.cron}`;
    s.reminders = [...(s.reminders ?? []).filter((r) => r.id !== id),
      { id, at, cron: x.cron, rec, until: rec ? e.t + REMINDER_DAYS_MS : undefined }];
  } else if (e.tool === "CronDelete" && typeof x.id === "string") {
    s.reminders = s.reminders?.filter((r) => r.id !== x.id);
  } else if (e.tool === "mcp__scheduled-tasks__create_scheduled_task" && typeof x.task === "string") {
    s.made = [...(s.made ?? []).filter((m) => m.id !== x.task), { id: x.task, t: e.t }];
  } else return;
  bump(s);
}

export function apply(e: Ev) {
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
  if (fromSubagent) {
    touchAgent(s, e);
    resumeAfterAgent(s, e);
  } else s.lastMain = Math.max(s.lastMain, e.t);

  switch (e.ev) {
    case "SessionStart":
      if (s.status === "ended") setStatus(s, "idle", e.t);
      break;

    case "SessionEnd":
      setStatus(s, "ended", e.t);
      s.inFlight = 0;
      s.reminders = undefined; // they lived in its process
      break;

    case "UserPromptSubmit":
      setStatus(s, "working", e.t);
      s.lastPrompt = e.t;
      s.prompt = e.prompt ?? s.prompt;
      // A plan with every step done belongs to the last request, not to this one.
      if (s.plan?.length && s.plan.every((st) => st.s === "completed")) s.plan = undefined;
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
      if (e.ev === "PostToolUse" && e.x) noteSchedule(s, e);
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
      setWaiting(s, "permission", e.tool ? `Wants permission to use ${e.tool}` : "Wants permission", e.t, e.agent);
      break;

    case "Notification":
      // Lesson from agents-observe: a notification puts the session in "waiting"
      // until the next real activity clears it.
      if (e.nt === "permission_prompt") {
        // The prompt a subagent's request raises: keep it tied to that agent.
        const same = s.status === "waiting" && s.waitAgent && e.t - s.since < 30_000 ? s.waitAgent : undefined;
        setWaiting(s, "permission", e.msg ?? "Wants permission", e.t, same);
      }
      else if (e.nt === "elicitation_dialog") setWaiting(s, "input", e.msg ?? "Needs input from you", e.t);
      // idle_prompt only repeats that the turn ended; nothing to change.
      break;

    case "Stop":
      setStatus(s, "done", e.t);
      s.since = e.t;
      s.inFlight = 0;
      s.tool = s.detail = undefined;
      s.classified = false; // checkTurns() reads how it ended
      // And the app's summary of the turn, for a desktop session; not for old lines read at startup.
      if (Date.now() - e.t < 30_000) readAppFileSoon(s.sid);
      s.outcome = s.askText = s.errorText = undefined;
      break;

    case "PreCompact":
      // The Claude app also compacts a session that sits idle after its turn ended, and
      // no Stop follows that. Only a compaction in the middle of a turn shows.
      if (s.status !== "working") break;
      s.tool = "Compact";
      s.detail = undefined;
      break;
  }
  bump(s);
}
