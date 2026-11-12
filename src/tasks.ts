// The desktop app's scheduled tasks, and the reminders a session set for itself.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describeCron, nextRun, parseCron, prevRun } from "../cron.ts";
import { type Session, type Reminder, type Task, tasks, taskChanged, sessions } from "./state.ts";
import { db } from "./db.ts";
import { activeAgents } from "./agents.ts";
import { type Shown, needsYou, shownStatus } from "./snapshot.ts";

// The desktop app's scheduled tasks. Times may come as numbers or ISO strings.
export const timeOf = (v: unknown) =>
  typeof v === "number" ? v : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined;
export function readTasks(file: string): Task[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const list: any[] = Array.isArray(j?.scheduledTasks) ? j.scheduledTasks : [];
    // When the app can't start a run it tries again each minute and notes the time and
    // why: recordedSkips, by task.
    const skipsOf = (id: string, after = 0) => {
      const raw = j?.recordedSkips?.[id];
      return (Array.isArray(raw) ? raw : [])
        .map((k: any) => ({ at: timeOf(k?.at), reason: typeof k?.reason === "string" ? k.reason.slice(0, 40) : "" }))
        .filter((k): k is { at: number; reason: string } => k.at != null && k.at > after)
        .sort((a, b) => a.at - b.at);
    };
    return list
      // Repeating tasks have a cron expression; one-time tasks a moment to fire at.
      .filter((t) => typeof t?.id === "string" && (typeof t?.cronExpression === "string" || timeOf(t?.fireAt) != null))
      .map((t) => ({
        id: t.id,
        name: typeof t.displayName === "string" && t.displayName.trim() ? t.displayName.trim() : t.id,
        cron: typeof t.cronExpression === "string" ? t.cronExpression : undefined,
        at: typeof t.cronExpression === "string" ? undefined : timeOf(t.fireAt),
        enabled: t.enabled !== false,
        cwd: typeof t.cwd === "string" ? t.cwd : undefined,
        file: typeof t.filePath === "string" ? t.filePath : undefined,
        created: timeOf(t.createdAt),
        lastRunAt: timeOf(t.lastRunAt),
        lastScheduledFor: timeOf(t.lastScheduledFor),
        skips: skipsOf(t.id, timeOf(t.lastRunAt) ?? 0),
      }));
  } catch {
    return [];
  }
}

// When each reminder fires next, soonest first: a one-off one until its time, a
// repeating one until its 7 days are up, and none once the session has closed.
export function pendingReminders(s: Session, now: number): (Reminder & { next: number })[] {
  if (s.status === "ended" || !s.reminders?.length) return [];
  const out: (Reminder & { next: number })[] = [];
  for (const r of s.reminders) {
    let next: number | null = r.at;
    if (r.rec && r.cron) {
      if (next <= now) {
        const c = parseCron(r.cron);
        next = c ? nextRun(c, now) : null;
      }
      if (next == null || (r.until != null && next > r.until)) continue;
    } else if (next <= now) continue;
    out.push({ ...r, next });
  }
  return out.sort((a, b) => a.next - b.next);
}

// The next run of a scheduled task, if it has one.
export function nextOf(t: Task, now: number): number | null {
  if (!t.enabled) return null;
  if (t.at != null) return t.at > now ? t.at : null;
  const c = t.cron ? parseCron(t.cron) : null;
  return c ? nextRun(c, now) : null;
}

// The scheduled tasks a session set up, as the Claude app lists them now; one it later
// deleted is gone. The app can change the ID it was asked for ("nightly-check-2"), so a
// task with an ID that starts the same, created right then, counts too.
export function madeTasks(made: Session["made"], now: number) {
  const out: { id: string; name: string; enabled: boolean; next: number | null }[] = [];
  for (const m of made ?? []) {
    const want = m.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const t = tasks.get(m.id) ?? [...tasks.values()].find((t) =>
      t.id.startsWith(want) && t.created != null && Math.abs(t.created - m.t) < 5 * 60_000);
    if (t && !out.some((o) => o.id === t.id)) out.push({ id: t.id, name: t.name, enabled: t.enabled, next: nextOf(t, now) });
  }
  return out;
}

export function reminderView(s: Session, now: number) {
  const pend = pendingReminders(s, now);
  const r = pend[0];
  if (!r) return null;
  return {
    at: r.next,
    every: r.rec && r.cron ? describeCron(r.cron) ?? r.cron : undefined,
    until: r.rec ? r.until : undefined,
    more: pend.length - 1,
  };
}

const MISSED_GRACE_MS = 10 * 60 * 1000; // a run gets this long to start before it counts as missed
const BLOCK_STALE_MS = 3 * 60 * 1000; // no skip for this long: the app stopped trying (it's closed, say)
const STUCK_MS = 30 * 60 * 1000; // a run that says it's working with no activity for this long is stuck
const RUNS_SHOWN = 7;

export type RunView = {
  sid: string; status: Shown; needsYou: boolean; first: number; last: number; since?: number;
  ask?: string; error?: string; recap?: string; note?: string; tool?: string; detail?: string; wait?: string;
};

// The latest saved runs of every task, newest first, in one query.
export function savedRuns(): Map<string, any[]> {
  const out = new Map<string, any[]>();
  if (!db) return out;
  const rows = db.query(`SELECT task, sid, status, outcome, first_at, last_at, ask, error, recap, note FROM (
      SELECT *, row_number() OVER (PARTITION BY task ORDER BY first_at DESC) AS n FROM sessions WHERE task IS NOT NULL)
    WHERE n <= ${RUNS_SHOWN} ORDER BY task, first_at DESC`).all() as any[];
  for (const r of rows) {
    const list = out.get(r.task);
    if (list) list.push(r);
    else out.set(r.task, [r]);
  }
  return out;
}

// A task's latest runs, newest first: this week's from memory (live), older ones from
// the database (pass savedRuns() when asking for many tasks).
export function taskRuns(t: Task, now: number, saved?: Map<string, any[]>): RunView[] {
  const runs = new Map<string, RunView>();
  if (db) {
    const rows = saved ? saved.get(t.id) ?? [] : db.query(`SELECT sid, status, outcome, first_at, last_at, ask, error, recap, note FROM sessions
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
// "Once, Oct 23 at 12:00 PM", in local time like the cron schedules.
export function onceWords(at: number) {
  const d = new Date(at);
  return `Once, ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

// "today at 3:05 PM", "yesterday at …", "Tue at …", "Oct 23 at …", in local time like the
// page's own words.
export function whenWords(t: number, now: number) {
  const start = (days: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return d.getTime();
  };
  const at = new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (t >= start(0) && t < start(-1)) return `today at ${at}`;
  if (t >= start(1) && t < start(0)) return `yesterday at ${at}`;
  if (t >= start(-1) && t < start(-2)) return `tomorrow at ${at}`;
  const near = Math.abs(t - now) < 6 * 86_400_000;
  return `${new Date(t).toLocaleDateString("en-US", near ? { weekday: "short" } : { month: "short", day: "numeric" })} at ${at}`;
}

export type Blocked = {
  since: number; last: number; tries: number; reason: string; queued: boolean;
  run: { sid: string; status: Shown; at: number; last: number } | null;
};

// Why a task didn't run, in the words the window's card uses.
export function blockedWhy(b: Blocked, now: number) {
  if (b.reason === "per_task_limit") {
    if (!b.run) return "a run of it is still open";
    const from = `the run from ${whenWords(b.run.at, now)}`;
    if (b.queued) return `it starts once ${from} ends`;
    return b.run.status === "working" ? `${from} has had no activity since ${whenWords(b.run.last, now)}`
      : b.run.status === "waiting" || b.run.status === "asks" ? `${from} is waiting for you` : `${from} is still open`;
  }
  return b.reason ? `the Claude app skipped it (${b.reason.replace(/_/g, " ")})` : "the Claude app skipped it";
}
export const blockedWords = (b: Blocked, now: number) => `Didn't run ${whenWords(b.since, now)}: ${blockedWhy(b, now)}`;

export function taskList(now: number) {
  const saved = savedRuns();
  return [...tasks.values()].map((t) => {
    const c = t.cron ? parseCron(t.cron) : null;
    const runs = taskRuns(t, now, saved);
    const lastRun = runs[0] ?? null;
    const prev = t.at != null ? (t.at <= now - MISSED_GRACE_MS ? t.at : null) : c ? prevRun(c, now - MISSED_GRACE_MS) : null;
    // A one-time task that has run is done, not paused or missed. The app turns it off
    // then; if it doesn't, its last run time still tells.
    const ran = t.at != null && ((t.lastRunAt ?? 0) >= t.at - 60_000 || (!t.enabled && lastRun != null));
    // The app tried and gave up, so it isn't missed, it's blocked: since the first skip
    // after its last run, for as long as the app keeps trying (each minute while it's
    // open). per_task_limit means a run of it is still open; that's the newest one before.
    const skips = !ran ? t.skips ?? [] : [];
    const trying = skips.length > 0 && now - skips.at(-1)!.at < BLOCK_STALE_MS;
    const started = skips.length > 0 && lastRun != null && lastRun.first >= skips[0].at - 60_000;
    const open = skips.length ? runs.find((r) => r.first < skips[0].at && r.status !== "ended") : undefined;
    // If the run that holds it up is busy and moving, there's nothing to do but wait:
    // the app starts this one once that one ends. Otherwise (it waits on you, it's stuck,
    // or it's done and still open) it needs you.
    const queued = open?.status === "working" && now - open.last < STUCK_MS;
    const blocked: Blocked | null = t.enabled && trying && !started ? {
      since: skips[0].at, last: skips.at(-1)!.at, tries: skips.length, reason: skips.at(-1)!.reason,
      run: open ? { sid: open.sid, status: open.status, at: open.first, last: open.last } : null,
      queued,
    } : null;
    const missed = Boolean(
      t.enabled && !ran && !blocked && prev != null && prev > Math.max(t.created ?? 0, taskChanged.get(t.id) ?? 0) &&
      prev > (t.lastScheduledFor ?? 0) + 60_000 &&
      !(lastRun && lastRun.first >= prev - 60_000), // it ran, the file just hasn't caught up
    );
    const running = lastRun?.status === "working" || lastRun?.status === "waiting";
    const rank = ran ? 5 : !t.enabled ? 4 : (blocked && !blocked.queued) || lastRun?.needsYou ? 0 : running || blocked ? 1 : missed ? 2 : 3;
    return {
      id: t.id,
      name: t.name,
      schedule: t.cron ? describeCron(t.cron) : onceWords(t.at!),
      cron: t.cron ?? "",
      once: t.at ?? null,
      ran,
      enabled: t.enabled,
      project: t.cwd ? basename(t.cwd) : "",
      cwd: t.cwd ?? "",
      file: t.file ?? "",
      next: nextOf(t, now),
      missed: missed ? prev : null,
      blocked,
      // The app can't start it and waiting won't help: it needs you, like a session that
      // stopped on an error. (Its runs that need you are counted as sessions.)
      needsYou: Boolean(blocked && !blocked.queued),
      lastRun,
      runs: runs.map((r) => ({ sid: r.sid, status: r.status, needsYou: r.needsYou, at: r.first })),
      rank,
    };
  }).sort((a, b) => a.rank - b.rank || (a.next ?? Infinity) - (b.next ?? Infinity) || a.name.localeCompare(b.name));
}
