// What the page gets.

import { basename } from "node:path";
import { DAY_MS, WEEK_MS } from "./config.ts";
import { type Status, type Agent, type Session, tasks, sessions, pins } from "./state.ts";
import { relativesOf } from "./desktop.ts";
import { runName, activeAgents, activeCommands } from "./agents.ts";
import { type Blocked, blockedWords, madeTasks, reminderView, taskList } from "./tasks.ts";
import { usageView } from "./usage.ts";
import { canAnswer, sayable } from "./answers.ts";
import { permitOf } from "./permissions.ts";
import { TOP, workedMs } from "./worked.ts";

// What the card shows. A finished turn splits into done, asks (it ended with a question
// for you) and error. Most urgent first.
export type Shown = Status | "asks" | "error";
const ORDER: Record<Shown, number> = { waiting: 0, asks: 1, error: 2, working: 3, done: 4, idle: 5, ended: 6 };

// The one rule for "needs you", so the window, the Dock badge and the menu bar agree:
// blocked on you, or a question or an error from the last day.
export const needsYou = (shown: Shown, last: number, now: number) =>
  shown === "waiting" || ((shown === "asks" || shown === "error") && now - last < DAY_MS);

// The same rule for a live session, with the answer you gave from its card: one on its way
// means you answered; one that couldn't be sent needs you again. The same for a permission
// you allowed or denied from its card.
export function sessionNeedsYou(s: Session, shown: Shown, now: number) {
  if ((shown === "asks" || shown === "error") && s.reply) return s.reply.state === "failed";
  if (shown === "waiting") {
    const p = permitOf(s, now);
    if (p && (p.state === "sending" || p.state === "sent")) return false;
  }
  return needsYou(shown, s.last, now);
}

// A session whose own turn ended but still has subagents or a workflow running is
// busy: the card says so instead of "Done". A question or an error still wins.
// A session asks you itself: waiting on you, or a closing that asks.
const asksItself = (x: Session | undefined) =>
  !!x && !x.archived && (x.status === "waiting" || (x.status === "done" && x.outcome === "asks"));

export function shownStatus(s: Session, agents: Agent[]): Shown {
  // It passes on another session's question that the other one already shows: the
  // question is that session's, so it shows there once, not here too.
  if (s.status === "done" && s.outcome === "asks" && s.relayed?.some((sid) => {
    const x = sessions.get(sid);
    return asksItself(x) && !x!.relayed?.includes(s.sid);
  })) return "done";
  if (s.status === "done" && s.outcome === "asks") return "asks";
  if (s.status === "done" && s.outcome === "error") return "error";
  return (s.status === "done" || s.status === "idle") && (agents.length || activeCommands(s).length) ? "working" : s.status;
}

// The sessions of the main view: the last 7 days; anything still running stays regardless.
const weekOf = (now: number) => [...sessions.values()]
  .filter((s) => !s.archived)
  .map((s) => ({ s, agents: activeAgents(s) }))
  .map((x) => ({ ...x, shown: shownStatus(x.s, x.agents) }))
  .filter(({ s, shown }) => shown === "working" || shown === "waiting" || now - s.last < WEEK_MS);

// The Most active filter: the TOP sessions of the main view with the most time working in the
// last 7 days, most first (the page ranks Last 7 Days the same way; History asks for these).
export function mostActive(now: number) {
  return weekOf(now).map(({ s }) => ({ sid: s.sid, ms: workedMs(s, now) })).filter((x) => x.ms > 0)
    .sort((a, b) => b.ms - a.ms || (a.sid < b.sid ? -1 : 1)).slice(0, TOP).map((x) => x.sid);
}

export function snapshot() {
  const now = Date.now();
  const list = weekOf(now)
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
        needsYou: sessionNeedsYou(s, shown, now),
        cwd: s.appCwd ?? s.cwd ?? "", // for Reveal in Finder
        task: s.task,
        taskName: s.task ? tasks.get(s.task)?.name : undefined,
        ...relativesOf(s.sid),
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
        // Its answer buttons, while it asks: a label, and the Claude app's action for one only
        // the app can do. canAnswer: its answers mod is there to take a click.
        answers: shown === "asks" && s.answers ? s.answers.map((a) => ({ label: a.label, ...(a.app ? { app: a.app } : {}) })) : undefined,
        canAnswer: shown === "asks" && !!s.answers && canAnswer(s.sid, now),
        // canSay: it waits on you and its mod is listening, so the app's mic can answer it.
        canSay: sayable(s) && canAnswer(s.sid, now),
        // The answer you gave from the card, a button's or your words, while it waits on you.
        reply: (shown === "asks" || shown === "done" || shown === "error") && s.reply ? { text: s.reply.text, state: s.reply.state, said: s.reply.i < 0 || undefined } : undefined,
        // The permission it waits on, while the plugin's hook holds it: what it asks, with
        // Allow and Deny, then your decision on its way (src/permissions.ts). In memory only.
        permit: permitOf(s, now),
        error: s.errorText,
        note: s.note,
        model: s.model,
        effort: s.effort,
        ultra: s.ultra || undefined,
        // The model that advises it (src/advisor.ts).
        advisor: s.advisor?.model ? { model: s.advisor.model } : undefined,
        pinned: pins.has(s.sid) || undefined, // you pinned it (src/db.ts)
        worked: workedMs(s, now) || undefined, // ms its turns spent working in the last 7 days (src/worked.ts)
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
        commands: activeCommands(s).slice(0, 6).map((c) => ({ detail: c.detail, startedAt: c.at })),
        commandCount: activeCommands(s).length,
        workflows,
        plan: total ? { done, total, current: current?.c, index: s.plan!.indexOf(current!) + 1 } : null,
        reminder: reminderView(s, now),
        made: madeTasks(s.made, now),
      };
    });
  // A scheduled task the app can't start needs you too, like a session that stopped on an error.
  const taskViews = taskList(now);
  const attention = attentionOf(list, taskViews, now);
  // pins: every pinned session's ID, older ones too, for the Pinned filter's count and History's rows.
  return { now, server: SERVER, needs: attention.length, attention, sessions: list, tasks: taskViews, usage: usageView(now), pins: [...pins] };
}

// Which server answers: the app starts its own with its version, and replaces one that
// says another.
export const SERVER = { version: process.env.CSM_VERSION || "dev", pid: process.pid };

// Everything that needs you, in the window's order, with the words the menu bar shows:
// sessions waiting on you or asking, then tasks that can't run, then turns that ended on
// an error. The count on the header, the Dock and the menu bar is its length.
export type Attention = { kind: "session" | "error" | "blocked"; id: string; title: string; words: string; sid?: string; run?: string; error?: boolean };
type SessionLike = { sid: string; title: string; status: Shown; needsYou: boolean; wait?: string; ask?: string; error?: string; reply?: { state: string }; permit?: { state: string } };
type TaskLike = { id: string; name: string; needsYou: boolean; blocked: Blocked | null };
const WORDS_MAX = 300;
export function attentionOf(list: SessionLike[], taskViews: TaskLike[], now: number): Attention[] {
  const one = (s: SessionLike): Attention => {
    const error = s.status === "error";
    const words = s.status === "waiting" ? (s.permit?.state === "failed" ? "Couldn't send your answer" : s.wait || "Waiting for your answer")
      : error ? s.error || "The turn ended with an error"
      : s.reply?.state === "failed" ? "Couldn't send your answer"
      : s.ask || "It asked you something";
    return { kind: error ? "error" : "session", id: s.sid, title: s.title, words: words.slice(0, WORDS_MAX), sid: s.sid, error };
  };
  const mine = list.filter((s) => s.needsYou);
  const asking = mine.filter((s) => s.status !== "error").map(one);
  const errors = mine.filter((s) => s.status === "error").map(one);
  const blocked = taskViews.filter((t) => t.needsYou && t.blocked).map((t): Attention => ({
    kind: "blocked", id: t.id, title: t.name, words: blockedWords(t.blocked!, now).slice(0, WORDS_MAX),
    ...(t.blocked!.run ? { run: t.blocked!.run.sid } : {}), error: true,
  }));
  return [...asking, ...blocked, ...errors];
}
