// Checks that run on a timer: whether a session's process is still there, and how a turn ended.

import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { classifyClosing, type Other } from "../closing.ts";
import { type Session, sessions, bump, localToCli, appTitles } from "./state.ts";
import { setStatus } from "./session.ts";
import { readRange } from "./log.ts";
import { APP_SUMMARY_WAIT_MS, applyAppAsk, hasAppFile } from "./desktop.ts";
import { activeAgents, scanCommands } from "./agents.ts";
import { pendingReminders } from "./tasks.ts";

export function isClaudeProcess(pid: number): boolean {
  const r = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)]);
  return /claude/i.test(r.stdout.toString());
}

export function isAlive(pid: number): boolean {
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
export function checkProcesses() {
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
      s.reminders = undefined; // they lived in its process
      bump();
    }
  }
  // Drop reminders that have fired or run out, so the cards update on their own.
  for (const s of sessions.values()) {
    if (!s.reminders?.length) continue;
    const keep = new Set(pendingReminders(s, now).map((r) => r.id));
    if (keep.size !== s.reminders.length) {
      s.reminders = s.reminders.filter((r) => keep.has(r.id));
      bump();
    }
  }
}

// How the newest turn in a transcript ended, from its last user or assistant line:
//   interrupted  you stopped it (Claude Code writes a marker line)
//   error        an API error ended it (isApiErrorMessage, e.g. server_error, rate_limit)
//   text         a closing message; its text says whether it asks you something
//   none         still mid-turn (a tool call or a tool result is the last thing)
// ended: Claude Code wrote that the turn's Stop hooks ran after its last reply.
export type LastTurn = { kind: "interrupted" | "error" | "text" | "none"; text?: string; ended?: boolean };

export const textOf = (row: any): string => {
  const c = row.message?.content;
  return typeof c === "string" ? c
    : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n") : "";
};

export function readLastTurn(tp: string): LastTurn {
  const size = statSync(tp).size;
  const from = Math.max(0, size - 262144);
  const lines = readRange(tp, from, size).split("\n");
  let ended = false;
  // The first line is only cut short when we started reading mid-file.
  for (let i = lines.length - 1; i >= (from > 0 ? 1 : 0); i--) {
    let row: any;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.isSidechain || row.isMeta) continue;
    if (row.type === "system" && row.subtype === "stop_hook_summary") {
      ended = true;
      continue;
    }
    if (row.type === "user") {
      return textOf(row).includes("[Request interrupted by user") ? { kind: "interrupted" } : { kind: "none" };
    }
    if (row.type !== "assistant") continue;
    const text = textOf(row).trim();
    if (row.isApiErrorMessage) return { kind: "error", text: text || row.error || "API error" };
    return text ? { kind: "text", text, ended } : { kind: "none", ended };
  }
  return { kind: "none" };
}

// What the closing rules read a message against: every other session, with the app's ID
// for it and its names (titles and folder), and this session's own names.
export function closingContext(s: Session): [Other[], string[]] {
  const namesOf = (sid: string) => {
    const x = sessions.get(sid);
    return [x?.title, appTitles.get(sid), x?.cwd ? basename(x.cwd) : undefined].filter((n): n is string => Boolean(n));
  };
  const localOf = new Map([...localToCli].map(([local, sid]) => [sid, local]));
  const sids = new Set([...sessions.keys(), ...localToCli.values()]);
  sids.delete(s.sid);
  return [[...sids].map((sid) => ({ sid, local: localOf.get(sid), names: namesOf(sid) })), namesOf(s.sid)];
}

// A turn that asks you something on behalf of a session it links to is answered once that
// session gets a message after the turn ended: you went there and answered.
export function checkRelayed() {
  for (const s of sessions.values()) {
    if (s.status !== "done" || s.outcome !== "asks" || !s.relayed?.length) continue;
    if (s.relayed.some((sid) => (sessions.get(sid)?.lastPrompt ?? 0) > s.since)) {
      s.outcome = "done";
      s.askText = undefined;
      s.relayed = undefined;
      bump();
    }
  }
}

// Once a turn has ended, tell apart "done", "asks you" and "error". Waits a moment
// after Stop so the closing message is in the transcript.
export function classifyTurn(s: Session) {
  const last: LastTurn = s.tp && existsSync(s.tp) ? readLastTurn(s.tp) : { kind: "none" };
  const closing = last.kind === "text" ? classifyClosing(last.text!, ...closingContext(s)) : undefined;
  // A request without a question mark is a guess, and the Claude app's summary of the turn
  // can say it's done. For a session the app knows, wait a few seconds for that summary
  // (desktop.ts watches its file), so a wrong guess never sounds or badges first.
  const guess = !s.ask && closing?.ask && !(closing.askText ?? "").includes("?");
  const summaryIn = s.appAsk && s.appAsk.edge >= s.since - 10_000;
  if (guess && !summaryIn && hasAppFile(s.sid) && Date.now() - s.since < 800 + APP_SUMMARY_WAIT_MS) return;
  s.classified = true;
  try {
    scanCommands(s); // now, so a command that ended during the turn doesn't show for a moment
  } catch {}
  s.relays = closing?.relays;
  s.relayed = undefined;
  if (last.kind === "error") {
    s.outcome = "error";
    s.errorText = last.text?.slice(0, 160);
  } else if (s.ask) {
    s.outcome = "asks"; // the question in the app's next-step box
  } else if (closing?.ask) {
    s.outcome = "asks";
    s.askText = closing.askText;
    s.relayed = closing.relayed;
  } else {
    s.outcome = "done";
  }
  bump();
  applyAppAsk(s); // the app's summary may already be in
}

export function checkTurns() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === "done" && !s.classified && now - s.since >= 800) classifyTurn(s);
  }
}

// Lesson from Vibe Notch: pressing Stop (Esc) ends a turn without a Stop hook, and so
// does an API error. If a session looks busy but went quiet with no tool running,
// look at how its transcript ends.
export function checkQuietTurns() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status !== "working" || s.inFlight > 0 || !s.tp) continue;
    if (now - s.lastMain < 8000 || !existsSync(s.tp)) continue;
    const last = readLastTurn(s.tp);
    // A turn that ended without its Stop reaching us (a session saved as working
    // before the app's idle compaction stopped counting as work): it's over.
    if (last.ended && now - s.lastMain >= 60_000 && activeAgents(s).length === 0) {
      setStatus(s, "done", s.lastMain || now);
      s.tool = s.detail = undefined;
      s.classified = false; // checkTurns() reads how it ended
      bump();
      continue;
    }
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
    bump();
  }
}
