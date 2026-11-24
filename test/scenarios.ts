// End-to-end checks of the state machine against the cases that broke other tools.
// Starts a second server on port 4749 with its own temp folder, writes hook lines,
// and reads /api/state. Never touches ~/.claude-session-monitor.
//
//   bun test/scenarios.ts

import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCron, nextRun, parseCron, prevRun } from "../cron.ts";
import { playMod } from "./answer-mod.ts";

const PORT = 4749; // not the demo's 4748, so both can run at once
const dir = mkdtempSync(join(tmpdir(), "csm-test-"));
const log = join(dir, "events.jsonl");
writeFileSync(log, "");

let t = Date.now() - 60_000;
const ev = (sid: string, e: Record<string, unknown>) =>
  appendFileSync(log, JSON.stringify({ t: t++, sid, cwd: "/tmp/demo", ...e }) + "\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// A transcript whose last lines are the given rows
const transcript = (name: string, rows: object[]) => {
  const file = join(dir, name);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
};
const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

// 1. A PostToolUse that arrives after Stop keeps the session finished (Vibe Notch #98)
ev(id(1), { ev: "UserPromptSubmit", prompt: "Start the server" });
ev(id(1), { ev: "PreToolUse", tool: "Bash", d: "Start dev server" });
ev(id(1), { ev: "Stop" });
ev(id(1), { ev: "PostToolUse", tool: "Bash" });

// 50. The Claude app compacts a session that sits idle after its turn: it stays done
ev(id(50), { ev: "UserPromptSubmit", prompt: "Tidy the notes" });
ev(id(50), { ev: "Stop" });
ev(id(50), { ev: "PreCompact" });
ev(id(50), { ev: "SubagentStop", agent: "c50" });

// 51. A compaction in the middle of a turn shows as working
ev(id(51), { ev: "UserPromptSubmit", prompt: "Keep going" });
ev(id(51), { ev: "PreToolUse", tool: "Read", d: "/x/a.ts" });
ev(id(51), { ev: "PostToolUse", tool: "Read" });
ev(id(51), { ev: "PreCompact" });

// 52. Saved as working, but its transcript says the turn ended: it's done
{
  const tp = transcript("t52.jsonl", [said("Started."), said("All set, the notes are tidy."), { type: "system", subtype: "stop_hook_summary" }]);
  ev(id(52), { ev: "UserPromptSubmit", prompt: "Tidy more notes", tp, t: Date.now() - 5 * 60_000 });
}

// 53. A closing message that quotes a question it sent to someone else doesn't ask you
{
  const tp = transcript("t53.jsonl", [said("Yes, it went out. I checked it in the chat after sending it:\n\n> Could you send an example? A screen would work.")]);
  ev(id(53), { ev: "UserPromptSubmit", prompt: "Did you send it?", tp });
  ev(id(53), { ev: "Stop", tp });
}

// 2. Subagent events do not change the session's status (Vibe Notch #36),
//    and each agent is tracked by id until its SubagentStop
ev(id(2), { ev: "UserPromptSubmit", prompt: "Review everything" });
ev(id(2), { ev: "PreToolUse", tool: "Agent", d: "Review files" });
ev(id(2), { ev: "SubagentStart", agent: "a1" });
ev(id(2), { ev: "PreToolUse", tool: "Read", d: "/x/y.ts", agent: "a1" });
ev(id(2), { ev: "SubagentStop", agent: "a1" });
ev(id(2), { ev: "SubagentStart", agent: "a2" });

// 3. A question waits on you, and answering it resumes work
ev(id(3), { ev: "UserPromptSubmit", prompt: "Pick one" });
ev(id(3), { ev: "PreToolUse", tool: "AskUserQuestion", x: { q: "Which one do you prefer?" } });

// 4. A permission prompt waits until the next real activity (agents-observe)
ev(id(4), { ev: "UserPromptSubmit", prompt: "Install it" });
ev(id(4), { ev: "PreToolUse", tool: "Bash", d: "npm install" });
ev(id(4), { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash" });

// 5. Plan, then wrap-up and Stop: done with the recap and the question
ev(id(5), { ev: "UserPromptSubmit", prompt: "Make the plan" });
ev(id(5), { ev: "PreToolUse", tool: "mcp__ccd_turn__update_plan", x: { items: [{ c: "One", s: "in_progress" }, { c: "Two", s: "pending" }] } });
ev(id(5), { ev: "PreToolUse", tool: "mcp__ccd_turn__update_plan", x: { advance: true } });
ev(id(5), { ev: "PreToolUse", tool: "mcp__ccd_turn__wrap_up", x: { recap: "Plan is ready.", ask: "Should I publish it?" } });
ev(id(5), { ev: "Stop" });

// 6. A dead process ends the session (claude-glance, Vibe Notch)
ev(id(6), { ev: "UserPromptSubmit", prompt: "Something", pid: 999_999 });

// 7. Interrupt: the session goes quiet and the transcript ends with the marker
const tp = join(dir, "t7.jsonl");
writeFileSync(tp, [
  JSON.stringify({ type: "user", message: { content: "Do something long" } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "On it" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
].join("\n") + "\n");
ev(id(7), { ev: "UserPromptSubmit", prompt: "Do something long", tp });

// 8. A broken line does not stop the rest
appendFileSync(log, "{esto no es json\n");
ev(id(8), { ev: "UserPromptSubmit", prompt: "After the broken line" });

// 9. A workflow keeps a finished session busy. Its agents never send SubagentStart;
//    they are found from their files, and the run is named after its script file.
const tp9 = join(dir, "s9.jsonl");
const run9 = "wf_test0001-abc";
writeFileSync(tp9, [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_wf9", name: "Workflow", input: { scriptPath: "/tmp/nowhere/w9-test.js" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wf9", content: `Workflow started. Run ${run9}` }] } }),
].join("\n") + "\n");
const runDir = join(dir, "s9", "subagents", "workflows", run9);
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "journal.jsonl"), [
  JSON.stringify({ type: "launched" }),
  JSON.stringify({ type: "started", agentId: "aaa1", label: "design:x · high", phase: "Design" }),
].join("\n") + "\n");
writeFileSync(join(runDir, "agent-aaa1.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "design:x · high", workflowPhase: "Design", model: "opus" }));
writeFileSync(join(runDir, "agent-aaa1.jsonl"), JSON.stringify({
  type: "assistant",
  message: {
    stop_reason: "tool_use",
    usage: { input_tokens: 10, cache_read_input_tokens: 120000, output_tokens: 500 },
    content: [{ type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } }],
  },
}) + "\n");
ev(id(9), { ev: "UserPromptSubmit", prompt: "Run the workflow", tp: tp9 });
ev(id(9), { ev: "Stop", tp: tp9 });

// 11. A turn that ends on a question asks you, even without the app's next-step box
const tp11 = transcript("t11.jsonl", [
  { type: "user", message: { content: "Draft the post" } },
  said("Here is the draft.\n\nIt has 180 words. ¿Lo publico en el blog? Cuando me confirmes, lo subo."),
]);
ev(id(11), { ev: "UserPromptSubmit", prompt: "Draft the post", tp: tp11 });
ev(id(11), { ev: "Stop", tp: tp11 });

// 12. A turn that ends without a question is done
const tp12 = transcript("t12.jsonl", [
  { type: "user", message: { content: "Fix the bug" } },
  said("Fixed it? Yes. The test passes now and the build is green."),
]);
ev(id(12), { ev: "UserPromptSubmit", prompt: "Fix the bug", tp: tp12 });
ev(id(12), { ev: "Stop", tp: tp12 });

// 13. An API error that ends the turn, with a Stop
const tp13 = transcript("t13.jsonl", [
  { type: "user", message: { content: "Keep going" } },
  { type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit" }] } },
]);
ev(id(13), { ev: "UserPromptSubmit", prompt: "Keep going", tp: tp13 });
ev(id(13), { ev: "Stop", tp: tp13 });

// 14. An API error with no Stop at all: the session goes quiet
const tp14 = transcript("t14.jsonl", [
  { type: "user", message: { content: "Run it" } },
  { type: "assistant", isApiErrorMessage: true, error: "server_error", message: { content: [{ type: "text", text: "API Error: Can't reach the API server" }] } },
]);
ev(id(14), { ev: "UserPromptSubmit", prompt: "Run it", tp: tp14 });

// 0. A background Agent-tool subagent, finished by its SubagentStop
const tp0 = join(dir, "s0.jsonl");
writeFileSync(tp0, "");
const sub0 = join(dir, "s0", "subagents");
mkdirSync(sub0, { recursive: true });
writeFileSync(join(sub0, "agent-bbb2.meta.json"), JSON.stringify({ description: "Review files", requestShape: "background" }));
writeFileSync(join(sub0, "agent-bbb2.jsonl"), JSON.stringify({
  type: "assistant",
  message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
}) + "\n");
ev(id(0), { ev: "UserPromptSubmit", prompt: "Review in the background", tp: tp0 });
ev(id(0), { ev: "Stop", tp: tp0 });
ev(id(0), { ev: "PreToolUse", tool: "Grep", d: "TODO", agent: "bbb2", tp: tp0 });

// 15. A request with no question mark still asks you
const tp15 = transcript("t15.jsonl", [
  { type: "user", message: { content: "Draft the email" } },
  said("Quedó el borrador.\n\nSolo me falta saber si lo publicas tú o si lo publico yo. Con un \"publícalo\" lo subo."),
]);
ev(id(15), { ev: "UserPromptSubmit", prompt: "Draft the email", tp: tp15 });
ev(id(15), { ev: "Stop", tp: tp15 });

// 16. A courtesy closing is not a request
const tp16 = transcript("t16.jsonl", [
  { type: "user", message: { content: "Publish it" } },
  said("Publiqué el reporte y el enlace ya funciona. Si necesitas algo más, avísame."),
]);
ev(id(16), { ev: "UserPromptSubmit", prompt: "Publish it", tp: tp16 });
ev(id(16), { ev: "Stop", tp: tp16 });

// 17. A session from 8 days ago: out of Last 7 Days, still in All Sessions
ev(id(17), { ev: "UserPromptSubmit", prompt: "Migrate the billing tables", t: Date.now() - 8 * 86_400_000 });
ev(id(17), { ev: "Stop", t: Date.now() - 8 * 86_400_000 + 60_000 });

// 18. A question from two days ago is still a question, but it no longer needs you
const tp18 = transcript("t18.jsonl", [
  { type: "user", message: { content: "Draft the post" } },
  said("Escribí el borrador con los tres ejemplos. ¿Lo publico hoy?"),
]);
ev(id(18), { ev: "UserPromptSubmit", prompt: "Draft the post", tp: tp18, t: Date.now() - 2 * 86_400_000 });
ev(id(18), { ev: "Stop", tp: tp18, t: Date.now() - 2 * 86_400_000 + 60_000 });

// 19. A run of a scheduled task that ended asking you something. The tasks and the link
// come from the app's own files: scheduled-tasks.json and the run's session file.
ev(id(19), { ev: "UserPromptSubmit", prompt: "Weekday digest" });
ev(id(19), { ev: "PreToolUse", tool: "mcp__ccd_turn__wrap_up", x: { recap: "Three items today.", ask: "Should I send it to the team?" } });
ev(id(19), { ev: "Stop" });
const appDir = join(dir, "app", "account", "org");
mkdirSync(appDir, { recursive: true });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// The daily tasks below (34–38) are due at an hour that started at least 15 minutes ago,
// so the scenario holds at any time of day, just after dueAt too.
const dueAt = (() => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  if (Date.now() - d.getTime() < 15 * 60_000) d.setHours(d.getHours() - 1);
  return d.getTime();
})();
const daily = `0 ${new Date(dueAt).getHours()} * * *`;
const iso = (ms: number) => new Date(ms).toISOString();
writeFileSync(join(appDir, "scheduled-tasks.json"), JSON.stringify({ scheduledTasks: [
  { id: "t-digest", displayName: "Weekday digest", cronExpression: "30 9 * * 1-5", enabled: true, cwd: "/tmp/demo",
    createdAt: Date.now() - 30 * 24 * HOUR, lastScheduledFor: iso(prevRun(parseCron("30 9 * * 1-5")!, Date.now() - 11 * 60_000)!) },
  { id: "t-paused", displayName: "Paused report", cronExpression: "0 9 * * *", enabled: false, createdAt: Date.now() - 30 * 24 * HOUR },
  // Ran three hours ago, and not since: its last hourly run is missing.
  { id: "t-hourly", displayName: "Hourly check", cronExpression: "0 * * * *", enabled: true,
    createdAt: Date.now() - 2 * 24 * HOUR, lastScheduledFor: iso(Date.now() - 3 * HOUR) },
  // One-time tasks: one still to come, set up by session 33 under a changed ID, and one
  // that already ran and turned itself off.
  { id: "noon-check-2", displayName: "Noon check", fireAt: iso(Date.now() + 3 * HOUR), enabled: true, createdAt: Date.now() - 50_000 },
  { id: "t-once-ran", displayName: "Send the recap", fireAt: iso(Date.now() - 5 * HOUR), enabled: false,
    createdAt: Date.now() - 24 * HOUR, lastRunAt: iso(Date.now() - 5 * HOUR + 60_000) },
  { id: "t-once-on", displayName: "Left on after it ran", fireAt: iso(Date.now() - 6 * HOUR), enabled: true,
    createdAt: Date.now() - 24 * HOUR, lastRunAt: iso(Date.now() - 6 * HOUR + 30_000) },
  // 34. Due today and blocked: the app keeps skipping it because yesterday's run is
  // still open. 35. Skipped at first, then it started.
  { id: "t-blocked", displayName: "Midnight cleanup", cronExpression: daily, enabled: true, cwd: "/tmp/demo",
    createdAt: Date.now() - 30 * 24 * HOUR, lastRunAt: iso(dueAt - DAY + 6 * 60_000), lastScheduledFor: iso(dueAt - DAY) },
  // 37. Held up by a run that's busy and moving: it just waits. 38. By one that says it's
  // working but hasn't done anything since yesterday: stuck, so it needs you.
  { id: "t-queued", displayName: "Midnight sync", cronExpression: daily, enabled: true,
    createdAt: Date.now() - 30 * 24 * HOUR, lastRunAt: iso(dueAt - DAY + 6 * 60_000), lastScheduledFor: iso(dueAt - DAY) },
  { id: "t-stuck", displayName: "Midnight export", cronExpression: daily, enabled: true,
    createdAt: Date.now() - 30 * 24 * HOUR, lastRunAt: iso(dueAt - DAY + 6 * 60_000), lastScheduledFor: iso(dueAt - DAY) },
  { id: "t-stale", displayName: "Midnight report", cronExpression: daily, enabled: true,
    createdAt: Date.now() - 30 * 24 * HOUR, lastRunAt: iso(dueAt - DAY + 60_000), lastScheduledFor: iso(dueAt - DAY) },
  { id: "t-unblocked", displayName: "Midnight backup", cronExpression: daily, enabled: true,
    createdAt: Date.now() - 30 * 24 * HOUR, lastRunAt: iso(dueAt - DAY + 60_000), lastScheduledFor: iso(dueAt - DAY) },
], recordedSkips: {
  // Skipped since just after it was due, and still trying now.
  "t-blocked": [dueAt + 53_000, Date.now() - 2 * 60_000, Date.now() - 60_000].map((at) => ({ at, reason: "per_task_limit" }))
    .concat([{ at: dueAt - DAY - HOUR, reason: "per_task_limit" }]), // before its last run: old news
  "t-queued": [dueAt + 53_000, Date.now() - 2 * 60_000, Date.now() - 60_000].map((at) => ({ at, reason: "per_task_limit" })),
  "t-stuck": [dueAt + 53_000, Date.now() - 2 * 60_000, Date.now() - 60_000].map((at) => ({ at, reason: "per_task_limit" })),
  // 36. Skipped for a while, then the app stopped trying (it was closed): no longer blocked.
  "t-stale": [dueAt + 53_000, dueAt + 113_000].map((at) => ({ at, reason: "per_task_limit" })),
  "t-unblocked": [{ at: dueAt + 53_000, reason: "per_task_limit" }],
} }));
// Yesterday's run of the blocked task, still open; today's run of the other one.
writeFileSync(join(appDir, "local_run34.json"), JSON.stringify({
  cliSessionId: id(34), scheduledTaskId: "t-blocked", title: "Midnight cleanup", originCwd: "/tmp/demo",
  createdAt: dueAt - DAY + 6 * 60_000, lastActivityAt: dueAt - DAY + 9 * 60_000,
}));
writeFileSync(join(appDir, "local_run35.json"), JSON.stringify({
  cliSessionId: id(35), scheduledTaskId: "t-unblocked", title: "Midnight backup", originCwd: "/tmp/demo",
  createdAt: dueAt + 2 * 60_000, lastActivityAt: dueAt + 4 * 60_000,
}));
ev(id(34), { ev: "UserPromptSubmit", prompt: "Midnight cleanup", t: dueAt - DAY + 6 * 60_000 });
ev(id(34), { ev: "Stop", t: dueAt - DAY + 9 * 60_000 });
for (const [n, task, name] of [[37, "t-queued", "Midnight sync"], [38, "t-stuck", "Midnight export"]] as const) {
  writeFileSync(join(appDir, `local_run${n}.json`), JSON.stringify({
    cliSessionId: id(n), scheduledTaskId: task, title: name, originCwd: "/tmp/demo",
    createdAt: dueAt - DAY + 6 * 60_000, lastActivityAt: dueAt - DAY + 7 * 60_000,
  }));
  ev(id(n), { ev: "UserPromptSubmit", prompt: name, t: dueAt - DAY + 6 * 60_000 });
}
ev(id(37), { ev: "PreToolUse", tool: "Bash", d: "Sync the files", t: Date.now() - 60_000 });
ev(id(38), { ev: "PreToolUse", tool: "Bash", d: "Export the data", t: dueAt - DAY + 7 * 60_000 });
// 39–41. The Claude app's own summary of the last turn. 39: it names something you need to
// do, though the closing has no question. 40: the same, but about an earlier turn. 41: done.
// 54: what it names is to be done in another session, named in brackets. 56: it only
// invites the next piece of work. 61: it says to answer in another session, by name.
// 62–63: they mention more or another, but ask you here.
for (const [n, cat, action, about] of [
  [39, "blocked", "In Settings, turn on the shared folder for the two tasks", "u-last"],
  [40, "blocked", "Approve the old plan", "u-older"],
  [41, "completed", "", "u-last"],
  [42, "completed", "", "u-last"],
  [54, "blocked", "Give the OK to [Routines 39] in its own session so it sends the report", "u-last"],
  [56, "blocked", "Send the next part when it's ready", "u-last"],
  [61, "blocked", "Answer in the weekday digest session: which day works best", "u-last"],
  [62, "blocked", "Give the OK to push, or ask for more changes", "u-last"],
  [63, "blocked", "Tell it which option you want, or pick another", "u-last"],
] as const) {
  // 42: a request with no question mark ("dime cuál") that the app read as done.
  const close = n === 42 ? "Revisé las notas. Dime cuál lista ordeno primero." : "Listo, quedó arreglado.";
  const tp = transcript(`t${n}.jsonl`, [{ type: "user", message: { content: "Fix the routines" } }, said(close)]);
  const stop = Date.now() - 30_000 + n;
  ev(id(n), { ev: "UserPromptSubmit", prompt: "Fix the routines", tp, t: stop - 60_000 });
  ev(id(n), { ev: "Stop", tp, t: stop });
  writeFileSync(join(appDir, `local_sum${n}.json`), JSON.stringify({
    cliSessionId: id(n), title: `Routines ${n}`, originCwd: "/tmp/demo", createdAt: stop - 60_000, lastActivityAt: stop,
    lastTurnEdgeAt: stop, lastAssistantUuid: "u-last",
    postTurnSummary: { status_category: cat, status_detail: "Some detail", needs_action: action, summarizes_uuid: about },
  }));
}
// 57. A closing message that asks you on behalf of a session it links to; that session
// gets a message afterwards (you answered there), so 57 no longer needs you. 59 links one
// that got nothing since, so it still asks. 68: the questions are in a list whose lead-in
// says they're the linked session's. 66 and 70 link a session that then gets a message,
// but their question is their own: they still ask.
const link = (n: number) => `[Draft review ${n}](#local_${id(n)})`;
for (const [n, other, answered, close] of [
  [57, 58, true, `The ${link(58)} session can't start until you answer: which cover goes first?`],
  [59, 60, false, `The ${link(60)} session can't start until you answer: which cover goes first?`],
  [66, 67, true, `I started ${link(67)} for the icons. Should I also push the branch?`],
  [68, 69, true, `La sesión ${link(69)} te hace dos preguntas; contéstalas en esa sesión:\n\n1. ¿Quién la va a ver?\n2. ¿Qué tamaños?`],
  [70, 71, true, `Aparte, ${link(71)} te espera en esa sesión.\n\n¿Subo los cambios?`],
] as const) {
  const tp = transcript(`t${n}.jsonl`, [said(close)]);
  const at = Date.now() - 5 * 60_000;
  ev(id(n), { ev: "UserPromptSubmit", prompt: "Where are we?", tp, t: at });
  ev(id(n), { ev: "Stop", tp, t: at + 1000 });
  ev(id(other), { ev: "UserPromptSubmit", prompt: "Draft review", t: at - 60_000 });
  ev(id(other), { ev: "Stop", t: at - 30_000 });
  if (answered) ev(id(other), { ev: "UserPromptSubmit", prompt: "The blue one", t: at + 60_000 });
  const local = `local_${id(other)}`;
  writeFileSync(join(appDir, `${local}.json`), JSON.stringify({
    sessionId: local, cliSessionId: id(other), title: `Draft review ${other}`, originCwd: "/tmp/demo", createdAt: at - 60_000, lastActivityAt: at + 60_000,
  }));
}

// 87. It passes on 88's question, and 88 shows that question itself: it shows once, in 88.
{
  const at = Date.now() - 5 * 60_000;
  const tp88 = transcript("t88.jsonl", [said("Two ways to start. Which one do you want first?")]);
  ev(id(88), { ev: "UserPromptSubmit", prompt: "Plan the design", tp: tp88, t: at - 60_000 });
  ev(id(88), { ev: "Stop", tp: tp88, t: at - 30_000 });
  writeFileSync(join(appDir, `local_${id(88)}.json`), JSON.stringify({
    sessionId: `local_${id(88)}`, cliSessionId: id(88), title: "Draft review 88", originCwd: "/tmp/demo", createdAt: at - 60_000, lastActivityAt: at - 30_000,
  }));
  const tp87 = transcript("t87.jsonl", [said(`The design session is waiting for you to pick where to start: ${link(88)}.`)]);
  ev(id(87), { ev: "UserPromptSubmit", prompt: "Where are we?", tp: tp87, t: at });
  ev(id(87), { ev: "Stop", tp: tp87, t: at + 1000 });
  // 89: the same in Spanish, with the closing asking nothing itself and the app's note
  // asking for the other session's pick.
  const tp89 = transcript("t89.jsonl", [said(`La sesión del borrador espera que escojas una de las dos portadas: ${link(88)}.\n\nAparte, las pruebas pasan.`)]);
  ev(id(89), { ev: "UserPromptSubmit", prompt: "¿Cómo vamos?", tp: tp89, t: at });
  ev(id(89), { ev: "Stop", tp: tp89, t: at + 1000 });
  writeFileSync(join(appDir, `local_${id(89)}.json`), JSON.stringify({
    sessionId: `local_${id(89)}`, cliSessionId: id(89), title: "Notes 89", originCwd: "/tmp/demo", createdAt: at - 60_000, lastActivityAt: at + 1000,
    lastTurnEdgeAt: at + 1000, lastAssistantUuid: "u-last",
    postTurnSummary: { status_category: "blocked", needs_action: "choose which to start with", summarizes_uuid: "u-last" },
  }));
}

// 120. Like 89, but 121 asked, then got your answer and finished: 120 is answered, and stays
// so after a restart, though the app's note on its turn still asks for the pick.
{
  const at = Date.now() - 5 * 60_000;
  // Its transcript as it ends: the question, your answer, and its turn on it.
  const tp121 = transcript("t121.jsonl", [said("Two ways to start. Which one do you want first?"),
    { type: "user", message: { content: "The second one" } }, said("Started with the second one.")]);
  ev(id(121), { ev: "UserPromptSubmit", prompt: "Plan the design", tp: tp121, t: at - 60_000 });
  ev(id(121), { ev: "Stop", tp: tp121, t: at - 30_000 });
  writeFileSync(join(appDir, `local_${id(121)}.json`), JSON.stringify({
    sessionId: `local_${id(121)}`, cliSessionId: id(121), title: "Draft review 121", originCwd: "/tmp/demo", createdAt: at - 60_000, lastActivityAt: at + 90_000,
  }));
  const tp120 = transcript("t120.jsonl", [said(`La sesión del borrador espera que escojas una de las dos portadas: ${link(121)}.\n\nAparte, las pruebas pasan.`)]);
  ev(id(120), { ev: "UserPromptSubmit", prompt: "¿Cómo vamos?", tp: tp120, t: at });
  ev(id(120), { ev: "Stop", tp: tp120, t: at + 1000 });
  writeFileSync(join(appDir, `local_${id(120)}.json`), JSON.stringify({
    sessionId: `local_${id(120)}`, cliSessionId: id(120), title: "Notes 120", originCwd: "/tmp/demo", createdAt: at - 60_000, lastActivityAt: at + 1000,
    lastTurnEdgeAt: at + 1000, lastAssistantUuid: "u-last",
    postTurnSummary: { status_category: "blocked", needs_action: "choose which to start with", summarizes_uuid: "u-last" },
  }));
  ev(id(121), { ev: "UserPromptSubmit", prompt: "The second one", tp: tp121, t: at + 60_000 });
  ev(id(121), { ev: "Stop", tp: tp121, t: at + 90_000 });
}

// 142. A turn that closed with its next-step box and no question in it (the next step is
// another session's), though the app's note asks you to check the draft: done.
{
  const at = Date.now() - 3 * 60_000;
  ev(id(142), { ev: "UserPromptSubmit", prompt: "Add the line to the draft", t: at });
  ev(id(142), { ev: "PreToolUse", tool: "mcp__ccd_turn__wrap_up", x: { recap: "Added the line to the draft and passed it to the planning session, which sends it." }, t: at + 20_000 });
  ev(id(142), { ev: "Stop", t: at + 21_000 });
  writeFileSync(join(appDir, `local_${id(142)}.json`), JSON.stringify({
    sessionId: `local_${id(142)}`, cliSessionId: id(142), title: "Draft note 142", originCwd: "/tmp/demo", createdAt: at, lastActivityAt: at + 21_000,
    lastTurnEdgeAt: at + 21_000, lastAssistantUuid: "u-last",
    postTurnSummary: { status_category: "blocked", needs_action: "Review the new draft and confirm it goes out", summarizes_uuid: "u-last" },
  }));
}

// 139–141. A closing that says the session it's about to start will ask you, naming none;
// the app's note asks the questions here. 140 is the side session you then started from
// 139, so 139 no longer needs you; 141 said the same and started nothing yet, so it still does.
for (const [n, side] of [[139, 140], [141, 0]] as const) {
  const at = Date.now() - 4 * 60_000 + n;
  const tp = transcript(`t${n}.jsonl`, [said("Abrí una tarjeta para la sesión del póster. Antes de dibujar, esa sesión te va a hacer dos preguntas: el color y la portada.")]);
  ev(id(n), { ev: "UserPromptSubmit", prompt: `Plan the poster ${n}`, tp, t: at });
  ev(id(n), { ev: "Stop", tp, t: at + 1000 });
  writeFileSync(join(appDir, `local_${id(n)}.json`), JSON.stringify({
    sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `Poster ${n}`, originCwd: "/tmp/demo", createdAt: at, lastActivityAt: at + 1000,
    lastTurnEdgeAt: at + 1000, lastAssistantUuid: "u-last",
    postTurnSummary: { status_category: "blocked", needs_action: "¿Va en azul o en verde? ¿Lleva portada?", summarizes_uuid: "u-last" },
  }));
  if (!side) continue;
  ev(id(side), { ev: "UserPromptSubmit", prompt: "Design the poster", t: at + 30_000 });
  writeFileSync(join(appDir, `local_${id(side)}.json`), JSON.stringify({
    sessionId: `local_${id(side)}`, cliSessionId: id(side), title: `Poster design ${side}`, originCwd: "/tmp/demo", createdAt: at + 30_000,
    lastActivityAt: at + 30_000, spawnedFrom: { sessionId: `local_${id(n)}` },
  }));
}

// 145–146. Like 139, but the side session 146 started during 145's turn and then asked you
// itself: the question shows once, in 146, and still so after a restart.
{
  const at = Date.now() - 4 * 60_000 + 145;
  const tp = transcript("t145.jsonl", [said("Abrí una tarjeta para la sesión del póster. Antes de dibujar, esa sesión te va a hacer dos preguntas: el color y la portada.")]);
  const tp146 = transcript("t146.jsonl", [said("Tengo dos opciones listas. ¿Va en azul o en verde?")]);
  ev(id(145), { ev: "UserPromptSubmit", prompt: "Plan the poster 145", tp, t: at });
  ev(id(146), { ev: "UserPromptSubmit", prompt: "Design the poster", tp: tp146, t: at + 10_000 });
  ev(id(145), { ev: "Stop", tp, t: at + 20_000 });
  ev(id(146), { ev: "Stop", tp: tp146, t: at + 40_000 });
  writeFileSync(join(appDir, `local_${id(145)}.json`), JSON.stringify({
    sessionId: `local_${id(145)}`, cliSessionId: id(145), title: "Poster 145", originCwd: "/tmp/demo", createdAt: at, lastActivityAt: at + 20_000,
    lastTurnEdgeAt: at + 20_000, lastAssistantUuid: "u-last",
    postTurnSummary: { status_category: "blocked", needs_action: "¿Va en azul o en verde? ¿Lleva portada?", summarizes_uuid: "u-last" },
  }));
  writeFileSync(join(appDir, `local_${id(146)}.json`), JSON.stringify({
    sessionId: `local_${id(146)}`, cliSessionId: id(146), title: "Poster design 146", originCwd: "/tmp/demo", createdAt: at + 10_000,
    lastActivityAt: at + 40_000, spawnedFrom: { sessionId: `local_${id(145)}` },
  }));
}

// 43–45. Side sessions: 44 was started from 43 (the app names 43 by its own ID, here only
// in the file name); 45 names a session the app no longer has.
for (const [n, file, extra] of [
  // 55: the app's note on 43 sends you to its side session 44, named in words.
  [43, "local_par43", { lastAssistantUuid: "u-last", lastTurnEdgeAt: Date.now() - 20 * 60_000 + 43 + 60_000,
    postTurnSummary: { status_category: "blocked", needs_action: "In the Pricing page 44 session, choose one of the two prices", summarizes_uuid: "u-last" } }],
  [44, "local_kid44", { sessionId: "local_kid44", spawnedFrom: { sessionId: "local_par43", title: "Side work", name: "side-work" } }],
  [45, "local_kid45", { spawnedFrom: { sessionId: "local_gone" } }],
  // 64: its note starts with the same words as its side session 65's title, but asks you here.
  [64, "local_par64", { title: "Login fixes 64", lastAssistantUuid: "u-last", lastTurnEdgeAt: Date.now() - 20 * 60_000 + 64 + 60_000,
    postTurnSummary: { status_category: "blocked", needs_action: "Review the diff and approve the push", summarizes_uuid: "u-last" } }],
  [65, "local_kid65", { title: "Review the login 65", sessionId: "local_kid65", spawnedFrom: { sessionId: "local_par64" } }],
] as const) {
  const at = Date.now() - 20 * 60_000 + n;
  ev(id(n), { ev: "UserPromptSubmit", prompt: `Pricing page ${n}`, t: at });
  ev(id(n), { ev: "Stop", t: at + 60_000 });
  writeFileSync(join(appDir, `${file}.json`), JSON.stringify({
    cliSessionId: id(n), title: `Pricing page ${n}`, originCwd: "/tmp/demo", createdAt: at, lastActivityAt: at + 60_000, ...extra,
  }));
}
ev(id(35), { ev: "UserPromptSubmit", prompt: "Midnight backup", t: dueAt + 2 * 60_000 });
ev(id(35), { ev: "Stop", t: dueAt + 4 * 60_000 });
writeFileSync(join(appDir, "local_run19.json"), JSON.stringify({
  cliSessionId: id(19), scheduledTaskId: "t-digest", title: "Weekday digest", originCwd: "/tmp/demo",
  createdAt: Date.now() - 60_000, lastActivityAt: Date.now(),
}));
// 86. A session that asked you something today, then archived in the app: it never needs you.
const tp86 = transcript("t86.jsonl", [said("¿Lo mando así?")]);
ev(id(86), { ev: "UserPromptSubmit", prompt: "Archived question", tp: tp86 });
ev(id(86), { ev: "Stop", tp: tp86 });
writeFileSync(join(appDir, "local_arch86.json"), JSON.stringify({
  cliSessionId: id(86), title: "Archived question", originCwd: "/tmp/demo", createdAt: Date.now() - 60_000, lastActivityAt: Date.now(), isArchived: true,
}));

// 20. A workflow agent asks for permission while the main agent is quiet; once that agent
// runs its tool, the session no longer needs you.
ev(id(20), { ev: "UserPromptSubmit", prompt: "Run the audit workflow" });
ev(id(20), { ev: "Stop" });
ev(id(20), { ev: "PreToolUse", agent: "wf20a", tool: "Bash", d: "Build two trees" });
ev(id(20), { ev: "PermissionRequest", agent: "wf20a", tool: "Bash", d: "Build two trees" });
ev(id(20), { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash" });
ev(id(20), { ev: "PostToolUse", agent: "wf20a", tool: "Bash", d: "Build two trees" });
// 21. The same, still unanswered: it needs you.
ev(id(21), { ev: "UserPromptSubmit", prompt: "Run the other workflow" });
ev(id(21), { ev: "Stop" });
ev(id(21), { ev: "PreToolUse", agent: "wf21a", tool: "Bash", d: "Delete the old builds" });
ev(id(21), { ev: "PermissionRequest", agent: "wf21a", tool: "Bash", d: "Delete the old builds" });
ev(id(21), { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash" });
ev(id(21), { ev: "PreToolUse", agent: "wf21b", tool: "Read", d: "notes.md" }); // another agent keeps going

// 22. A finished plan doesn't carry over into the next request.
ev(id(22), { ev: "UserPromptSubmit", prompt: "Ship it" });
ev(id(22), { ev: "PreToolUse", tool: "mcp__ccd_turn__update_plan", x: { items: [{ c: "Build", s: "completed" }, { c: "Ship", s: "completed" }] } });
ev(id(22), { ev: "Stop" });
ev(id(22), { ev: "UserPromptSubmit", prompt: "And one more thing" });

// 23–27. An open offer for more is a courtesy closing, and so is a short "anything else?",
// in Spanish or English. An offer of one specific thing still asks you.
const closing = (n: number, text: string) => {
  const tp = transcript(`t${n}.jsonl`, [{ type: "user", message: { content: "Ship it" } }, said(text)]);
  ev(id(n), { ev: "UserPromptSubmit", prompt: "Ship it", tp });
  ev(id(n), { ev: "Stop", tp });
};
closing(23, "Ya está publicada la versión nueva. Si quieres seguir con otro ajuste, dime.");
closing(24, "El banner ya está arriba. ¿Algo más?");
closing(25, "Dejé el borrador listo. Si quieres que lo suba, dime.");
closing(26, "Done. Let me know if you want me to make any other changes.");
closing(27, "The draft is ready. Let me know if you want me to push it.");
// 72–76. A closing that ends on a list: a point that asks you, or waits for your OK, needs
// you even when it isn't in the last two sentences. A point that only adds an option, or a
// question a point answers itself, doesn't.
closing(72, "Quedó terminada la primera parte.\n\n**Lo que queda:**\n1. **La segunda parte, el menú.** Es grande: de 6 a 10 rondas. ¿La arranco?\n2. **Los textos de la portada** siguen siendo propuesta mía.\n3. **Los zips son de la versión 2.0.** Si vas a mandar algo, los saco con un comando.");
closing(73, "Here's where it stands:\n\n- The build passes.\n\n- The icons need your approval before I export them.\n\n- The zips are still on 2.0. Nothing else changed. No new commits.");
closing(74, "Listo el cambio.\n\nPendientes:\n- Los textos nuevos esperan tu visto bueno.\n- La versión es la 2.1. El zip sigue igual. No hay commits nuevos.");
closing(75, "**A tener en cuenta:**\n- **Colores:** en la portada el azul es más oscuro que en el menú. Si prefieres que coincidan, los igualo.\n- **Otras versiones:** siguen en la liga de antes.\n- **Sin commit:** no exporté nada. Estos cambios no están en commit.");
closing(76, "**Qué cambió:**\n1. **¿Por qué fallaba?** La regla estaba en otra hoja de estilos.\n2. **Pruebas:** 17 de 17, en desarrollo y en build.");
// 81–84. A closing that says something waits on your choice, without a question mark, asks
// you; one that says nothing waits, or only if it happens, doesn't.
closing(81, "Quedó anotado el cambio. El correo sigue esperando que elijas versión: tal cual, o con la línea nueva.");
closing(82, "The notes are filed. The invite is still waiting for you to pick a slot.");
closing(83, "Revisé las tres sesiones. Nada espera tu respuesta.");
closing(84, "Sigo vigilando. Solo te escribo si algo espera tu respuesta y no lo has visto.");

// 85. An agent that stopped and then got another message from its session works again,
// after the session's turn ended: the session shows it in the background.
ev(id(85), { ev: "UserPromptSubmit", prompt: "Check the build" });
ev(id(85), { ev: "SubagentStart", agent: "a85" });
ev(id(85), { ev: "PreToolUse", tool: "Bash", d: "Build it", agent: "a85" });
ev(id(85), { ev: "SubagentStop", agent: "a85" });
ev(id(85), { ev: "Stop" });
ev(id(85), { ev: "SubagentStart", agent: "a85" });
ev(id(85), { ev: "PreToolUse", tool: "Bash", d: "Build it again", agent: "a85" });

// 77–80. A turn that ends with a command still running in the background stays active until
// Claude Code's notice that it ended, a TaskStop, or two hours. 77 gets its notice later on.
const background = (n: number, extra: object[] = [], ago = 60_000) => {
  const tp = transcript(`t${n}.jsonl`, [
    { type: "user", message: { content: "Compare the frames" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: "python3 compare.py", description: "Compare the frames one by one" } }] } },
    { type: "user", timestamp: new Date(Date.now() - ago).toISOString(), toolUseResult: { backgroundTaskId: `bg${n}`, timedOutAfterMs: 180000 },
      message: { content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "Command did not complete within its 180s timeout and was moved to the background." }] } },
    said("The comparison is still running. I'll tell you what it finds when it ends."),
    { type: "system", subtype: "stop_hook_summary" },
    ...extra,
  ]);
  ev(id(n), { ev: "UserPromptSubmit", prompt: "Compare the frames", tp });
  ev(id(n), { ev: "Stop", tp });
  return tp;
};
const notice = (n: number) => ({ type: "queue-operation", operation: "enqueue", content: `<task-notification>\n<task-id>bg${n}</task-id>\n<status>completed</status>\n</task-notification>` });
const tp77 = background(77);
background(78, [notice(78)]);
background(79, [{ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_s79", name: "TaskStop", input: { task_id: "bg79" } }] } }]);
background(80, [], 3 * 60 * 60_000);

// 28–33. Reminders a session sets for itself, and scheduled tasks it sets up.
const later = Date.now() + 2 * HOUR;
// 28. A wakeup: the session shows when it picks up again.
ev(id(28), { ev: "UserPromptSubmit", prompt: "Watch the deploy" });
ev(id(28), { ev: "PostToolUse", tool: "ScheduleWakeup", x: { at: later, delay: 1800 } });
ev(id(28), { ev: "Stop" });
// 29. A repeating cron job: how often, the next run, and when it stops.
ev(id(29), { ev: "UserPromptSubmit", prompt: "Check the queue" });
ev(id(29), { ev: "PostToolUse", tool: "CronCreate", x: { id: "c29", at: Date.now() + 5 * 60_000, cron: "*/5 * * * *", rec: true } });
ev(id(29), { ev: "Stop" });
// 30. A reminder it deleted again is gone.
ev(id(30), { ev: "UserPromptSubmit", prompt: "Remind me at noon" });
ev(id(30), { ev: "PostToolUse", tool: "CronCreate", x: { id: "c30", at: later, cron: "0 12 * * *", rec: false } });
ev(id(30), { ev: "PostToolUse", tool: "CronDelete", x: { id: "c30" } });
ev(id(30), { ev: "Stop" });
// 31. One that already fired is gone, and so is a wakeup loop it stopped.
ev(id(31), { ev: "UserPromptSubmit", prompt: "Ping me", t: Date.now() - 2 * HOUR });
ev(id(31), { ev: "PostToolUse", tool: "CronCreate", x: { id: "c31", at: Date.now() - HOUR, cron: "0 9 * * *", rec: false }, t: Date.now() - 2 * HOUR + 1 });
ev(id(31), { ev: "PostToolUse", tool: "ScheduleWakeup", x: { at: later, delay: 600 } });
ev(id(31), { ev: "PostToolUse", tool: "ScheduleWakeup", x: { delay: 600, stop: true } });
ev(id(31), { ev: "Stop" });
// 32. A session that closes takes its reminders with it.
ev(id(32), { ev: "UserPromptSubmit", prompt: "Every hour, check the build" });
ev(id(32), { ev: "PostToolUse", tool: "CronCreate", x: { id: "c32", at: later, cron: "7 * * * *", rec: true } });
ev(id(32), { ev: "SessionEnd" });
// 33. Scheduled tasks it set up: one under the ID it asked for, one the app renamed, and
// one it asked for that was never made.
ev(id(33), { ev: "UserPromptSubmit", prompt: "Schedule the digest and a noon check" });
ev(id(33), { ev: "PostToolUse", tool: "mcp__scheduled-tasks__create_scheduled_task", x: { task: "t-digest" } });
ev(id(33), { ev: "PostToolUse", tool: "mcp__scheduled-tasks__create_scheduled_task", x: { task: "noon-check" } });
ev(id(33), { ev: "PostToolUse", tool: "mcp__scheduled-tasks__create_scheduled_task", x: { task: "never-made" } });
ev(id(33), { ev: "Stop" });

// The plan's usage from the status line: a week that resets later, 5 hours that already reset
writeFileSync(join(dir, "usage.json"), JSON.stringify({
  at: Date.now() / 1000 - 60,
  week: { used_percentage: 42.6, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 },
  five_hour: { used_percentage: 90, resets_at: Math.floor(Date.now() / 1000) - 60 },
}));
// The week's readings kept so far: one from last week, which doesn't count, and one from this week.
const weekResets = (Math.floor(Date.now() / 1000) + 3 * 86400) * 1000;
writeFileSync(join(dir, "usage-history.jsonl"), [
  { at: Date.now() - 2 * 86400_000, pct: 95, resets: Date.now() - 86400_000 },
  { at: Date.now() - 86400_000, pct: 30, resets: weekResets },
].map((r) => JSON.stringify(r)).join("\n") + "\n");

// 130–136. Questions with answer buttons, answered from the card. 130 has no way back, 131 sent to a
// mod that asks by hand, 132 never picked up, 133 has no mod, 134 offers an app action, 136
// is answered through the helper that plays the mod, and 135's buttons come back from its
// transcript after a restart.
const wrap = (n: number, ask: string, acts: object[], extra: object = {}) => {
  ev(id(n), { ev: "UserPromptSubmit", prompt: `Draft the release note ${n}`, ...extra });
  ev(id(n), { ev: "PreToolUse", tool: "mcp__ccd_turn__wrap_up", x: { recap: "The note is drafted.", ask, acts }, ...extra });
  ev(id(n), { ev: "Stop", ...extra });
};
// 143–144: answered while their mod isn't asking, then the session moves on before it asks
// again, with no prompt: 143 starts working (a background task woke it), 144 asks for a
// permission. The answer is dropped, never handed to the mod.
for (const n of [130, 131, 132, 133, 136, 137, 138, 143, 144]) wrap(n, "Should I post the note?", [{ l: "Yes, post it" }, { l: "Not yet" }]);
// 160–166. Words you dictated on a card and sent. 160 is done and its mod (the helper) takes them;
// 161 is done with a mod asking by hand; 162 works, 163 waits on a permission, 164 ended and
// 165 has no mod, so none of them takes words; 166's mod asked once and went, and the session
// starts working before it asks again, so the words are dropped.
for (const n of [160, 161, 165, 166]) {
  ev(id(n), { ev: "UserPromptSubmit", prompt: `Sort the seed packets ${n}` });
  ev(id(n), { ev: "Stop" });
}
ev(id(162), { ev: "UserPromptSubmit", prompt: "Sort the seed packets 162" });
ev(id(162), { ev: "PreToolUse", tool: "Read", d: "/tmp/demo/seeds.md" });
ev(id(163), { ev: "UserPromptSubmit", prompt: "Sort the seed packets 163" });
ev(id(163), { ev: "PreToolUse", tool: "Bash", d: "Move the files" });
ev(id(163), { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash" });
ev(id(164), { ev: "UserPromptSubmit", prompt: "Sort the seed packets 164" });
ev(id(164), { ev: "Stop" });
ev(id(164), { ev: "SessionEnd" });
wrap(134, "Ready to commit the note?", [{ l: "ignored", a: "commit" }, { l: "Keep editing" }]);
{
  const tp = transcript("t135.jsonl", [
    { type: "user", message: { content: "Draft the release note 135" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_w135", name: "mcp__ccd_turn__wrap_up",
      input: { recap: "The note is drafted.", ask: "Should I post the note?", actions: [{ label: "Yes,   post it" }, { action: "verify", label: "x" }, { label: "Third" }] } }] } },
  ]);
  wrap(135, "Should I post the note?", [{ l: "Yes, post it" }, { l: "x", a: "verify" }], { tp });
}
// 147: its next-step box asks, its closing ends on a longer question, and the app's note
// repeats the closing's. After a restart it still asks: the box's question isn't lost.
{
  const closing = "The draft is ready. Should I post it now, or do you want to read it first?";
  const tp = transcript("t147.jsonl", [
    { type: "user", message: { content: "Draft the release note 147" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_w147", name: "mcp__ccd_turn__wrap_up",
      input: { recap: "The note is drafted.", ask: "Should I post it?", actions: [{ label: "Post it" }, { label: "I'll read it" }] } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_w147", content: "ok" }] } },
    said(closing),
  ]);
  wrap(147, "Should I post it?", [{ l: "Post it" }, { l: "I'll read it" }], { tp });
  const at = Date.now();
  writeFileSync(join(appDir, `local_${id(147)}.json`), JSON.stringify({
    sessionId: `local_${id(147)}`, cliSessionId: id(147), title: "Release note 147", originCwd: "/tmp/demo", createdAt: at - 60_000, lastActivityAt: at,
    lastTurnEdgeAt: at, lastAssistantUuid: "u-last",
    postTurnSummary: { status_category: "blocked", needs_action: closing, summarizes_uuid: "u-last" },
  }));
}

// Never read the real desktop app's sessions or transcripts in a test.
// 148. The app's file says the model, its effort and that ultracode is on; they reach the
// card, and change when the file does. 149: a session in a terminal has no such file, so its
// model is the one of its last reply (an error line's "<synthetic>" is no model).
const appFile148 = (effort: string, ultracode: boolean) => writeFileSync(join(appDir, `local_${id(148)}.json`), JSON.stringify({
  sessionId: `local_${id(148)}`, cliSessionId: id(148), title: "Sketch the garden plan", originCwd: "/tmp/demo",
  createdAt: Date.now() - 120_000, lastActivityAt: Date.now() - 60_000, model: "claude-opus-5-5", effort, sessionSettings: { ultracode },
}));
appFile148("xhigh", true);
ev(id(148), { ev: "UserPromptSubmit", prompt: "Sketch the garden plan", t: Date.now() - 120_000 });
ev(id(148), { ev: "Stop", t: Date.now() - 60_000 });
{
  const tp = transcript("t149.jsonl", [{ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Looking at the beds." }] } },
    { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "The list of plants is sorted." }] } }]);
  ev(id(149), { ev: "UserPromptSubmit", prompt: "Sort the plant list", tp, t: Date.now() - 90_000 });
  ev(id(149), { ev: "Stop", tp, t: Date.now() - 80_000 });
}

// 190–202. The model that advises a session while one is turned on, from its transcript: the
// row turning it on or off (an advisor_tool attachment) or a call to it (a server tool, no hook
// event) and its answer; the latest of these decides. advisorModel on every assistant row alone
// means nothing. 190 has only that, a subagent's call and declaration, a tool result that quotes
// a call and a request's list of tools that names the advisor; 191 asked the advisor, its model
// from the call's row and then from the answer's usage; 192, 193, 194 and 196 have a call row;
// 195 asked earlier, then its call scrolls out of the tail and its transcript goes before a
// restart. 197 turned it on and never asked it; 198 turned it on, then off; 199 turned Opus on,
// then a Fable advisor answered; 200 turned it on more than 8 MB before its transcript's end,
// with a line longer than a read between; 201's transcript is written anew, shorter; 202 turns
// it off while the server runs. Claude Code writes a call's row when its answer arrives, so none
// of them is ever "asking".
const SECRET_ADVICE = "compare the cart totals before the retry-QK83";
const advCall = (cid: string, model = "claude-fable-5-2") => ({ type: "assistant", advisorModel: model,
  message: { content: [{ type: "server_tool_use", id: cid, name: "advisor", input: { note: SECRET_ADVICE } }] } });
const advAnswer = (cid: string, model?: string) => ({ type: "assistant", advisorModel: "claude-fable-5-2",
  message: { content: [{ type: "advisor_tool_result", tool_use_id: cid, content: SECRET_ADVICE }], ...(model ? { usage: { iterations: [{ type: "message" }, { type: "advisor_message", model }] } } : {}) } });
const advised = (text: string) => ({ type: "assistant", advisorModel: "claude-fable-5-2", message: { content: [{ type: "text", text }] } });
const stopped = { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } };
const tpAdv = (n: number, rows: object[]) => transcript(`t${n}.jsonl`, rows);
// The row Claude Code writes when the advisor is turned on (/advisor, or at a session's start), or off.
const declare = (model = "claude-fable-5-2", on = true) => ({ type: "attachment", isSidechain: false,
  attachment: { type: "advisor_tool", available: on, model, toolChange: on ? "add" : "remove" } });
const filler = (n: number, len: number) => advised(`Row ${n} ${"y".repeat(len)}`);
{
  const tp = tpAdv(190, [advised("Looking at the list."), { ...advCall("srvtoolu_side190"), isSidechain: true }, { ...declare(), isSidechain: true },
    { type: "api-request-shape", shape: { tools: [{ name: "Read" }, { name: "advisor", type: "advisor_20260301", model: "claude-opus-5-5", defer_loading: true }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_190", content: '{"type":"server_tool_use","id":"srvtoolu_q190","name":"advisor","input":{}}' }] } },
    advised("The list is sorted.")]);
  ev(id(190), { ev: "UserPromptSubmit", prompt: "Sort the seed list", tp });
  ev(id(190), { ev: "Stop", tp });
}
for (const [n, rows] of [[191, [advised("Reading the tests."), advCall("srvtoolu_191", "claude-opus-5-5")]], [192, [advCall("srvtoolu_192")]],
  [193, [advCall("srvtoolu_193"), stopped]], [194, [advCall("srvtoolu_194")]], [196, [advCall("srvtoolu_196")]]] as const) {
  ev(id(n), { ev: "UserPromptSubmit", prompt: `Plan the beds ${n}`, tp: tpAdv(n, rows as unknown as object[]) });
}
const tp195 = tpAdv(195, [advCall("srvtoolu_195"), advAnswer("srvtoolu_195"), advised("The beds are planned.")]);
ev(id(195), { ev: "UserPromptSubmit", prompt: "Plan the beds", tp: tp195 });
ev(id(195), { ev: "Stop", tp: tp195 });
for (const [n, rows] of [[197, [advised("Reading the beds."), declare(), advised("The beds are read.")]],
  [198, [declare(), advised("Reading the beds."), declare("claude-fable-5-2", false), advised("The beds are read.")]],
  [199, [declare("claude-opus-5-5"), advised("Reading the beds."), advCall("srvtoolu_199", "claude-opus-5-5"), advAnswer("srvtoolu_199", "claude-fable-5-2")]],
  [201, [declare(), ...Array.from({ length: 40 }, (_, i) => filler(i, 2000))]],
  [202, [declare(), advised("Reading the beds.")]]] as const) {
  const tp = tpAdv(n, rows as unknown as object[]);
  ev(id(n), { ev: "UserPromptSubmit", prompt: `Plan the beds ${n}`, tp });
  ev(id(n), { ev: "Stop", tp });
}
// 200: the row turning it on, then a line of 5 MB (longer than one read), then about 10 MB of
// lines of uneven lengths.
const tp200 = join(dir, "t200.jsonl");
const declared200 = JSON.stringify(declare());
writeFileSync(tp200, [advised("Reading the beds."), declare(), filler(-1, 5 << 20)].map((r) => JSON.stringify(r)).join("\n") + "\n" +
  Array.from({ length: 4000 }, (_, i) => JSON.stringify(filler(i, 300 + ((i * 7919) % 4700)))).join("\n") + "\n");
ev(id(200), { ev: "UserPromptSubmit", prompt: "Plan the beds 200", tp: tp200 });
ev(id(200), { ev: "Stop", tp: tp200 });

const bad = mkdtempSync(join(tmpdir(), "csm-test-bad-")); // a folder with a broken database
// What the server prints, as the app's server.log would hold it; its errors still show here.
let serverOutput = "";
const keep = async (stream: ReadableStream<Uint8Array>, echo: boolean) => {
  const text = new TextDecoder();
  for await (const chunk of stream) {
    serverOutput += text.decode(chunk, { stream: true });
    if (echo) process.stderr.write(chunk);
  }
};
const start = (d = dir) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
    env: {
      ...process.env, CSM_PORT: String(PORT), CSM_DIR: d, CSM_ANSWER_GIVE_UP_MS: "3000", CSM_ANSWER_ARRIVE_MS: "15000",
      // A permission's timers, shortened: held 1.5 s a round, its mod gone after 3 s of silence, dropped
      // when its session shows no wait in 3 s, a decision no mod picked up fails after 2 s, and
      // one handed over whose session still waits fails after 3 s.
      CSM_PERMIT_HOLD_MS: "1500", CSM_PERMIT_HEARD_MS: "3000", CSM_PERMIT_SHOW_MS: "3000", CSM_PERMIT_GIVE_UP_MS: "2000",
      CSM_APP_SESSIONS: join(d, "app"), CSM_PROJECTS: join(d, "no-projects"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void keep(p.stdout, false).catch(() => {});
  void keep(p.stderr, true).catch(() => {});
  return p;
};
let server = start();

async function history(q = ""): Promise<any> {
  return (await fetch(`http://127.0.0.1:${PORT}/api/history?limit=200&q=${encodeURIComponent(q)}`)).json();
}

let snap: any = null; // the whole last answer, for its counts
async function state(): Promise<any[]> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/state`);
      if (r.ok) return (snap = await r.json()).sessions;
    } catch {}
    await Bun.sleep(150);
  }
  throw new Error("server did not start");
}

let failed = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  → ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
}
const find = (list: any[], n: number) => list.find((s) => s.sid === id(n));

try {
  let s = await state();
  check("1 late PostToolUse after Stop stays done", find(s, 1)?.status === "done", find(s, 1));
  {
    const a = find(s, 148), b = find(s, 149);
    check("148 the app file's model, effort and ultracode reach the card", a?.model === "claude-opus-5-5" && a?.effort === "xhigh" && a?.ultra === true, a);
    check("149 a terminal session's model is its last reply's, with no effort or ultracode", b?.model === "claude-sonnet-5-5" && !b?.effort && !b?.ultra, b);
    // The file changes: effort to medium, ultracode off. A new session makes the server look soon.
    appFile148("medium", false);
    ev(id(150), { ev: "SessionStart", t: Date.now() });
    let c: any;
    for (let i = 0; i < 30; i++) {
      c = find(await state(), 148);
      if (c?.effort === "medium") break;
      await Bun.sleep(200);
    }
    check("148 a change in the app's file changes the card's effort and ultracode", c?.effort === "medium" && !c?.ultra && c?.model === "claude-opus-5-5", c);
  }
  check("50 an idle session compacted by the app stays done", find(s, 50)?.status === "done" && find(s, 50)?.tool == null, find(s, 50));
  check("51 a compaction mid-turn shows as working", find(s, 51)?.status === "working" && find(s, 51)?.tool === "Compact", find(s, 51));
  check("usage: the week's share and reset, from the status line", snap.usage?.week?.pct === 42.6 && snap.usage.week.resets > Date.now(), snap.usage);
  check("usage: a window past its reset is dropped", snap.usage?.five === null, snap.usage);
  const samples = snap.usage?.week?.samples ?? [];
  check("usage: this week's readings, not last week's, with the latest one", samples.length === 2 && samples[0][1] === 30 && samples[1][1] === 42.6, samples);
  // A new reading adds a line; the same share again doesn't.
  writeFileSync(join(dir, "usage.json"), JSON.stringify({ at: Date.now() / 1000, week: { used_percentage: 45, resets_at: weekResets / 1000 }, five_hour: null }));
  check("2 subagents leave status working", find(s, 2)?.status === "working", find(s, 2));
  check("2 only the agent without SubagentStop counts", find(s, 2)?.agentCount === 1, find(s, 2)?.agents);
  check("85 an agent that works again after its SubagentStop keeps the session working", find(s, 85)?.status === "working" && find(s, 85)?.background === true && find(s, 85)?.agentCount === 1, find(s, 85));
  const s9 = find(s, 9);
  check("9 workflow keeps a finished session busy", s9?.status === "working" && s9?.background === true, s9);
  check("9 workflow named after its script file", s9?.workflows?.[0]?.name === "w9-test", s9?.workflows);
  check("9 workflow phase and agent label", s9?.workflows?.[0]?.phase === "Design" && s9?.agents?.[0]?.label === "design:x · high", s9?.agents);
  check("9 agent tokens from its transcript", s9?.agents?.[0]?.tokens === 120510, s9?.agents?.[0]?.tokens);
  const s0 = find(s, 0);
  check("0 background agent keeps the session busy", s0?.status === "working" && s0?.agents?.[0]?.label === "Review files", s0);
  check("2 detail stays the main agent's", find(s, 2)?.detail === "Review files", find(s, 2)?.detail);
  check("3 question waits on you", find(s, 3)?.status === "waiting" && find(s, 3)?.wait === "Which one do you prefer?", find(s, 3));
  check("4 permission waits on you", find(s, 4)?.status === "waiting" && find(s, 4)?.waitKind === "permission", find(s, 4));
  check("5 the app's next-step question makes it ask you", find(s, 5)?.status === "asks" && find(s, 5)?.ask === "Should I publish it?" && find(s, 5)?.recap === "Plan is ready.", find(s, 5));
  check("11 a closing question asks you", find(s, 11)?.status === "asks" && find(s, 11)?.ask === "¿Lo publico en el blog?", find(s, 11));
  check("12 a question mid-text is not the ending: done", find(s, 12)?.status === "done", find(s, 12));
  check("13 an API error is an error", find(s, 13)?.status === "error" && find(s, 13)?.error === "You've hit your session limit", find(s, 13));
  const s77 = find(s, 77);
  check("77 a command left running in the background keeps the session working", s77?.status === "working" && s77?.background === true && s77?.commandCount === 1 && s77?.commands?.[0]?.detail === "Compare the frames one by one", s77);
  check("78 once Claude Code says the command ended, it's done", find(s, 78)?.status === "done" && find(s, 78)?.commandCount === 0, find(s, 78));
  check("79 a command it stopped doesn't count", find(s, 79)?.status === "done", find(s, 79));
  check("80 a command started over two hours ago doesn't count", find(s, 80)?.status === "done", find(s, 80));
  appendFileSync(tp77, JSON.stringify(notice(77)) + "\n"); // its notice arrives; checked after the wait below
  check("asks and errors come right after waiting", s.findIndex((x) => x.status === "asks") < s.findIndex((x) => x.status === "working"), s.map((x) => x.status));
  check("5 plan fully checked off", find(s, 5)?.plan?.done === 2, find(s, 5)?.plan);
  check("6 dead process is closed", !find(s, 6) || find(s, 6).status === "ended", find(s, 6));
  check("8 events after a broken line still count", find(s, 8)?.status === "working", find(s, 8));
  check("waiting sessions come first", s[0]?.status === "waiting", s.map((x) => x.status));
  check("18 an old question is still a question", find(s, 18)?.status === "asks", find(s, 18));
  check("18 but it no longer needs you", find(s, 18)?.needsYou === false && find(s, 11)?.needsYou === true, [find(s, 18), find(s, 11)?.needsYou]);
  // Scheduled tasks
  const task = (tid: string) => snap.tasks?.find((x: any) => x.id === tid);
  const digest = task("t-digest");
  const next = digest && new Date(digest.next);
  check("tasks are read from the app's file, one-time ones too", snap.tasks?.length === 11, snap.tasks?.map((x: any) => x.id));
  const q = task("t-queued"), st = task("t-stuck");
  check("37 held up by a run that's busy and moving, it just waits: it doesn't need you", q?.blocked?.queued === true && q?.blocked?.run?.sid === id(37) && q?.rank === 1, q?.blocked);
  check("38 held up by a run with no activity since yesterday, it needs you", st?.blocked?.queued === false && st?.blocked?.run?.sid === id(38) && st?.rank === 0, st?.blocked);
  const blk = task("t-blocked");
  check("34 a task the app keeps skipping is blocked, not missed, with the run that holds it up",
    blk?.blocked?.reason === "per_task_limit" && blk?.blocked?.tries === 3 && blk?.blocked?.run?.sid === id(34) && blk?.missed === null && blk?.rank === 0, blk);
  check("35 a task that started after a skip isn't blocked", task("t-unblocked")?.blocked === null, task("t-unblocked")?.blocked);
  check("36 once the app stops trying, it isn't blocked anymore", task("t-stale")?.blocked === null, task("t-stale")?.blocked);
  check("34 blocked since the first skip after its last run", blk?.blocked?.since === dueAt + 53_000, blk?.blocked?.since);
  check("a task's schedule in words", digest?.schedule === "Weekdays at 9:30 AM", digest?.schedule);
  check("its next run is the next weekday at 9:30", Boolean(next && digest.next > Date.now() && next.getHours() === 9 && next.getMinutes() === 30 && next.getDay() >= 1 && next.getDay() <= 5), digest?.next);
  check("19 its last run is linked, asks you, and nothing was missed", digest?.lastRun?.sid === id(19) && digest?.lastRun?.status === "asks" && digest?.missed === null, digest);
  check("19 the run knows its task", find(s, 19)?.task === "t-digest" && find(s, 19)?.taskName === "Weekday digest", find(s, 19));
  check("what needs you comes first: a task whose last run asks you, and one that can't run",
    ["t-digest", "t-blocked", "t-stuck"].every((id) => snap.tasks?.slice(0, 3).some((x: any) => x.id === id)), snap.tasks?.map((x: any) => x.id));
  check("a paused task has no next run and comes after the ones that run", task("t-paused")?.enabled === false && task("t-paused")?.next === null && snap.tasks?.at(-3)?.id === "t-paused", snap.tasks?.map((x: any) => x.id));
  const on = task("t-once-on");
  check("a one-time task that ran is done even if the app left it on", on?.ran === true && on?.next === null && on?.missed === null, on);
  const noon = task("noon-check-2");
  check("a one-time task runs once, at its time", noon?.once != null && noon?.next === noon?.once && /^Once, /.test(noon?.schedule ?? "") && !noon?.ran && noon?.missed === null, noon);
  const ran = task("t-once-ran");
  check("a one-time task that ran is done, not paused or missed, and comes last", ran?.ran === true && ran?.next === null && ran?.missed === null && snap.tasks?.at(-1)?.id === "t-once-ran", ran);
  check("a run that didn't happen counts as missed", typeof task("t-hourly")?.missed === "number" && task("t-hourly")?.lastRun === null, task("t-hourly"));
  check("20 an agent's permission, once its tool ran, no longer needs you", find(s, 20)?.status !== "waiting" && find(s, 20)?.needsYou === false, find(s, 20));
  check("21 an agent's unanswered permission needs you, whatever other agents do", find(s, 21)?.status === "waiting" && find(s, 21)?.needsYou === true, find(s, 21));
  check("22 a finished plan is dropped when the next request comes", find(s, 22)?.status === "working" && find(s, 22)?.plan === null, find(s, 22)?.plan);
  // What needs you: one list the header, the Dock and the menu bar count.
  const att: any[] = snap.attention ?? [];
  check("the needs count is the length of what needs you", snap.needs === att.length && snap.needs > 0, [snap.needs, att.length]);
  check("every session that needs you is in it once, by its ID",
    s.filter((x) => x.needsYou).every((x) => att.filter((a) => a.sid === x.sid).length === 1) && att.filter((a) => a.sid).length === s.filter((x) => x.needsYou).length,
    att.map((a) => [a.kind, a.sid]));
  const ab = att.find((a) => a.id === "t-blocked");
  check("34 a task that can't run is in it as blocked, with the run that holds it up",
    ab?.kind === "blocked" && /^Didn.t run /.test(ab?.words ?? "") && ab?.run === id(34) && !ab?.sid, ab);
  check("37 a task that only waits its turn isn't in it", !att.some((a) => a.id === "t-queued"), att.map((a) => a.id));
  const rank = { session: 0, blocked: 1, error: 2 } as Record<string, number>;
  check("in order: sessions waiting or asking, then blocked tasks, then errors",
    att.every((a, i) => i === 0 || rank[att[i - 1].kind] <= rank[a.kind]) && att.some((a) => a.kind === "error"), att.map((a) => a.kind));
  check("86 an archived session isn't on the main view", !find(s, 86), find(s, 86));

  // Answering from the card. The mod is there for 130 and 136 (the helper), and for 131 and 132
  // (one ask each by hand; 132's goes away at once).
  const api = (path: string, init: RequestInit = {}, header = true) =>
    fetch(`http://127.0.0.1:${PORT}/api/answer/${path}`, { ...init, headers: header ? { "x-csm": "1" } : {} });
  const send = (n: number, i: number, header = true) => api(id(n), { method: "POST", body: JSON.stringify({ i }) }, header);
  const mod = playMod({ port: PORT, log, sids: [id(130), id(136)] });
  const sayMod = playMod({ port: PORT, log, sids: [id(160)] });
  const say = (n: number, text: string) => api(id(n), { method: "POST", body: JSON.stringify({ text }) });
  for (const n of [161, 162, 163, 164]) api(`${id(n)}/next`).catch(() => {});
  const ask131 = api(`${id(131)}/next`);
  api(`${id(137)}/next`).catch(() => {});
  api(`${id(138)}/next`).catch(() => {});
  const got: Record<number, number> = {}; // what the mod's ask got, by session
  // 132, 143 and 144 ask once and go away: their mod was there, and isn't asking at the click.
  const gone = new AbortController();
  for (const n of [132, 143, 144, 166]) api(`${id(n)}/next`, { signal: gone.signal }).catch(() => {});
  await Bun.sleep(300);
  gone.abort();
  s = await state();
  const a130 = find(s, 130);
  check("130 the card gets the question's buttons, and the mod is there", a130?.status === "asks" && a130?.answers?.length === 2 &&
    a130.answers[0].label === "Yes, post it" && !a130.answers[0].app && a130.canAnswer === true && !a130.reply, a130);
  check("133 with no mod asking, it can't send", find(s, 133)?.canAnswer === false && find(s, 133)?.answers?.length === 2, find(s, 133));
  check("134 an app action carries its name and the app's words", find(s, 134)?.answers?.[0]?.app === "commit" && find(s, 134)?.answers?.[0]?.label === "Commit" && !find(s, 134)?.answers?.[1]?.app, find(s, 134)?.answers);
  check("answer: with no mod asking, 409 (the page opens the session)", (await send(133, 0)).status === 409);
  check("answer: an app action, a button it didn't offer and a session that doesn't ask are refused",
    (await send(134, 0)).status === 404 && (await send(130, 5)).status === 404 && (await send(1, 0)).status === 404);
  check("answer: without the header, refused", (await send(130, 0, false)).status === 403 && (await api(`${id(130)}/next`, {}, false)).status === 403);
  check("answer: there's no taking one back", (await api(`${id(130)}/undo`, { method: "POST" })).status === 404);
  check("answer: 131, 132 and 136 sent", (await send(131, 0)).status === 204 && (await send(132, 1)).status === 204 && (await send(136, 0)).status === 204 &&
    (await send(137, 0)).status === 204 && (await send(138, 0)).status === 204);
  s = await state();
  check("132 with its mod not asking, the answer waits for it: you answered, so it doesn't need you", find(s, 132)?.reply?.state === "pending" && find(s, 132)?.reply?.text === "Not yet" &&
    find(s, 132)?.needsYou === false, find(s, 132));
  check("131 with its mod asking, the answer goes at once", find(s, 131)?.reply?.state === "sent", find(s, 131));
  check("answer: 143 and 144 sent", (await send(143, 0)).status === 204 && (await send(144, 0)).status === 204);

  // Your words, from the mic.
  check("canSay: a done session with its mod listening takes words, and a question too",
    find(s, 160)?.canSay === true && find(s, 161)?.canSay === true && find(s, 130)?.canSay === true, [find(s, 160)?.canSay, find(s, 161)?.canSay, find(s, 130)?.canSay]);
  check("canSay: not while it works, waits on a permission, ended, or with no mod",
    [162, 163, 164, 165].every((n) => find(s, n)?.canSay === false), [162, 163, 164, 165].map((n) => [find(s, n)?.status, find(s, n)?.canSay]));
  check("say: empty, blank or over 1,000 characters is refused (400)",
    (await say(161, "")).status === 400 && (await say(161, "  \n ")).status === 400 && (await say(161, "a".repeat(1001))).status === 400);
  check("say: 1,000 characters after the spaces are folded is fine",
    (await say(161, "  " + "a ".repeat(500))).status === 204 && find(await state(), 161)?.reply?.text.length === 999, find(await state(), 161)?.reply);
  check("say: refused while it works, waits on a permission, ended, or with no mod (409)",
    (await say(162, "Go on")).status === 409 && (await say(163, "Go on")).status === 409 && (await say(164, "Go on")).status === 409 && (await say(165, "Go on")).status === 409);
  check("say: an unknown session is 404, and the header is needed",
    (await say(9999, "Go on")).status === 404 && (await api(id(160), { method: "POST", body: JSON.stringify({ text: "Go on" }) }, false)).status === 403);
  const since160 = find(await state(), 160)?.since;
  const sayAt = (n: number, since: number) => api(id(n), { method: "POST", body: JSON.stringify({ text: "Go on", since }) });
  check("say: words for an earlier turn (a different since) get 409 and send nothing", (await sayAt(160, since160 - 1)).status === 409 && !find(await state(), 160)?.reply, find(await state(), 160)?.reply);
  check("say: 160 and 166 sent, trimmed and folded", (await say(160, "  Yes,   plant the\n tomatoes first  ")).status === 204 && (await say(166, "Label them too")).status === 204);
  s = await state();
  check("166 with its mod not asking, the words wait for it, on its done card", find(s, 166)?.reply?.state === "pending" && find(s, 166)?.reply?.text === "Label them too" &&
    find(s, 166)?.reply?.said === true && find(s, 166)?.status === "done", find(s, 166));
  ev(id(166), { ev: "PreToolUse", tool: "Read", d: "/tmp/demo/labels.md", t: Date.now() });
  ev(id(143), { ev: "PreToolUse", tool: "Bash", d: "Check the build", t: Date.now() });
  ev(id(144), { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash", t: Date.now() });
  await Bun.sleep(400);
  for (const n of [143, 144, 166]) api(`${id(n)}/next`).then((r) => (got[n] = r.status)).catch(() => {}); // their mod asks again

  // Answer the question and approve the permission
  ev(id(3), { ev: "PostToolUse", tool: "AskUserQuestion", t: Date.now() });
  ev(id(4), { ev: "PostToolUse", tool: "Bash", t: Date.now() });
  // New prompt clears the old recap
  ev(id(5), { ev: "UserPromptSubmit", prompt: "Something else", t: Date.now() });
  // The workflow agent reports its result; the background agent stops
  appendFileSync(join(runDir, "journal.jsonl"), JSON.stringify({ type: "result", agentId: "aaa1", result: "ok" }) + "\n");
  ev(id(0), { ev: "SubagentStop", agent: "bbb2", tp: tp0, t: Date.now() });
  await Bun.sleep(1500);
  s = await state();
  check("3 answering resumes work", find(s, 3)?.status === "working", find(s, 3));
  check("4 approving resumes work", find(s, 4)?.status === "working", find(s, 4));
  check("5 new prompt clears recap and ask", find(s, 5)?.status === "working" && !find(s, 5)?.ask && !find(s, 5)?.recap, find(s, 5));

  // The interrupt check needs 8 s of quiet
  await Bun.sleep(10_000);
  s = await state();
  check("7 interrupt marks the session stopped", find(s, 7)?.status === "done" && find(s, 7)?.note === "You stopped it", find(s, 7));
  check("14 an API error with no Stop is caught once it goes quiet", find(s, 14)?.status === "error" && /API Error/.test(find(s, 14)?.error ?? ""), find(s, 14));
  check("9 journal result ends the agent, session back to done", find(s, 9)?.status === "done" && find(s, 9)?.agentCount === 0, find(s, 9));
  check("0 SubagentStop ends the agent, session back to done", find(s, 0)?.status === "done" && find(s, 0)?.agentCount === 0, find(s, 0));
  // The answers went out at the click; 132's, with no mod to take it, gave up 3 s later.
  const got131 = await ask131;
  check("131 the mod's ask gets the button's words", got131.status === 200 && (await got131.json()).text === "Yes, post it");
  check("131 sent: the card says so and doesn't need you", find(s, 131)?.reply?.state === "sent" && find(s, 131)?.needsYou === false, find(s, 131));
  check("132 an answer no mod took couldn't be sent: it needs you again", find(s, 132)?.reply?.state === "failed" && find(s, 132)?.needsYou === true &&
    snap.attention.some((x: any) => x.sid === id(132) && x.words === "Couldn't send your answer"), [find(s, 132), snap.attention.find((x: any) => x.sid === id(132))]);
  check("136 the mod submitted it and the session works on it", mod.answered.length === 1 && mod.answered[0].text === "Yes, post it" &&
    find(s, 136)?.status === "working" && find(s, 136)?.title === "Yes, post it" && !find(s, 136)?.answers && !find(s, 136)?.reply, [mod.answered, find(s, 136)]);
  mod.stop();
  check("160 the mod submitted your words, folded to one line, and the session works on them",
    sayMod.answered.length === 1 && sayMod.answered[0].text === "Yes, plant the tomatoes first" && find(s, 160)?.status === "working" && !find(s, 160)?.reply, [sayMod.answered, find(s, 160)]);
  sayMod.stop();
  check("166 a session that started working before your words went out never gets them",
    got[166] !== 200 && find(s, 166)?.status === "working" && !find(s, 166)?.reply, [got[166], find(s, 166)]);
  check("143 a session that started working before its answer went out never gets it, and its buttons go",
    got[143] !== 200 && find(s, 143)?.status === "working" && !find(s, 143)?.reply && !find(s, 143)?.answers, [got[143], find(s, 143)]);
  check("144 a session that asks for a permission before its answer went out never gets it",
    got[144] !== 200 && find(s, 144)?.status === "waiting" && !find(s, 144)?.reply, [got[144], find(s, 144)]);
  check("138 handed over, it's marked sent", find(s, 138)?.reply?.state === "sent", find(s, 138));
  // a new closing, before any prompt came
  ev(id(138), { ev: "PreToolUse", tool: "mcp__ccd_turn__wrap_up", x: { recap: "Posted.", ask: "Should I also tag it?", acts: [{ l: "Yes, tag it" }, { l: "No" }] } });
  ev(id(138), { ev: "Stop" });
  ev(id(131), { ev: "UserPromptSubmit", prompt: "Yes, post it", t: Date.now() }); // its prompt arrives
  await Bun.sleep(400);
  s = await state();
  check("138 a new closing removes the old reply and shows its own buttons", !find(s, 138)?.reply && find(s, 138)?.answers?.[0]?.label === "Yes, tag it" && find(s, 138)?.needsYou === true, find(s, 138));
  await Bun.sleep(6000); // 137's answer was handed over about 18 s ago and no prompt came
  s = await state();
  check("137 an answer handed over that never became a prompt fails, and it needs you again", find(s, 137)?.reply?.state === "failed" && find(s, 137)?.needsYou === true, find(s, 137));
  check("131 its prompt ends the question and the answer", find(s, 131)?.status === "working" && !find(s, 131)?.answers && !find(s, 131)?.reply, find(s, 131));
  check("77 the notice that its command ended brings it back to done", find(s, 77)?.status === "done" && find(s, 77)?.commandCount === 0, find(s, 77));
  // Checked after the long wait: the server also reads the usage every 5 s, in case a file event is missed.
  const kept = readFileSync(join(dir, "usage-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("usage: a new share is kept as one more reading", snap.usage?.week?.samples?.at(-1)?.[1] === 45 && kept.at(-1).pct === 45 && kept.filter((r) => r.pct === 42.6).length === 1, kept);
  // A session that starts again hands over the last share it saw, hours old: lower than this week's.
  writeFileSync(join(dir, "usage.json"), JSON.stringify({ at: Date.now() / 1000, week: { used_percentage: 12, resets_at: weekResets / 1000 }, five_hour: null }));
  check("15 a request with no question mark asks you", find(s, 15)?.status === "asks" && /me falta saber/.test(find(s, 15)?.ask ?? ""), find(s, 15));
  check("52 a quiet turn whose transcript ended is done", find(s, 52)?.status === "done", find(s, 52));
  check("53 a question quoted in the closing message doesn't ask you", find(s, 53)?.status === "done", find(s, 53));
  check("54 when the app's note sends you to another session, this one doesn't need you", find(s, 54)?.status === "done" && find(s, 54)?.needsYou === false, find(s, 54));
  check("55 when the app's note names a related session in words, this one doesn't need you", find(s, 43)?.status === "done" && find(s, 43)?.needsYou === false, find(s, 43));
  check("56 an app note that only invites the next text is an open offer: done", find(s, 56)?.status === "done", find(s, 56));
  check("57 a question relayed from a linked session that got a message since is answered", find(s, 57)?.status === "done", find(s, 57));
  check("139 questions a side session it started will ask are that one's: done here", find(s, 139)?.status === "done", find(s, 139));
  check("141 the same words with no side session started yet still ask", find(s, 141)?.status === "asks", find(s, 141));
  check("145 a question its side session asks you itself shows only there", find(s, 145)?.status === "done" && find(s, 145)?.needsYou === false && find(s, 146)?.status === "asks", [find(s, 145), find(s, 146)]);
  check("142 a next-step box with no question is done, whatever the app's note asks", find(s, 142)?.status === "done", find(s, 142));
  check("59 one whose linked session got nothing since still asks", find(s, 59)?.status === "asks", find(s, 59));
  check("87 a question it passes on, which the other session shows itself, shows only there", find(s, 87)?.status === "done" && find(s, 87)?.needsYou === false && find(s, 88)?.status === "asks", [find(s, 87), find(s, 88)]);
  check("120 a passed-on pick that was answered in its session is done", find(s, 120)?.status === "done" && find(s, 120)?.needsYou === false, find(s, 120));
  check("89 the app's note on a closing that passes on another session's pick shows only there", find(s, 89)?.status === "done" && find(s, 89)?.needsYou === false, find(s, 89));
  check("61 an app note that says to answer in another session, named in words, is that session's", find(s, 61)?.status === "done", find(s, 61));
  check("62 an app note that asks for the OK, or for more changes, still asks", find(s, 62)?.status === "asks", find(s, 62));
  check("63 an app note that asks which option, or another, still asks", find(s, 63)?.status === "asks", find(s, 63));
  check("64 an app note that starts like a side session's title still asks here", find(s, 64)?.status === "asks", find(s, 64));
  check("66 its own question, beside a link to a session you answered, still asks", find(s, 66)?.status === "asks", find(s, 66));
  check("68 questions listed under a lead-in that relays them are answered there", find(s, 68)?.status === "done", find(s, 68));
  check("70 its own question after a relayed one still asks", find(s, 70)?.status === "asks", find(s, 70));
  check("16 a courtesy closing is done", find(s, 16)?.status === "done", find(s, 16));
  check("23 an open offer for more is done", find(s, 23)?.status === "done", find(s, 23));
  check("39 when the Claude app says the turn needs you, it asks you, in the app's words",
    find(s, 39)?.status === "asks" && find(s, 39)?.ask === "In Settings, turn on the shared folder for the two tasks" && find(s, 39)?.needsYou === true, find(s, 39));
  check("40 a summary of an earlier turn doesn't count", find(s, 40)?.status === "done", find(s, 40));
  check("41 a completed turn stays done", find(s, 41)?.status === "done", find(s, 41));
  check("42 a request without a question mark the app read as done is done", find(s, 42)?.status === "done", find(s, 42));
  check("44 a side session names the session it came from", find(s, 44)?.from?.sid === id(43) && find(s, 44)?.from?.title === "Pricing page 43", find(s, 44)?.from);
  check("43 the session it came from lists its side session", find(s, 43)?.sides?.length === 1 && find(s, 43)?.sides?.[0]?.sid === id(44), find(s, 43)?.sides);
  check("45 a side session of a session the app no longer has shows no link", !find(s, 45)?.from && !find(s, 45)?.sides, find(s, 45));
  const h44 = (await history("Pricing page 44")).sessions?.find((x: any) => x.sid === id(44));
  check("44 All Sessions knows where it came from too", h44?.from?.sid === id(43), h44);
  check("24 a short \"anything else?\" is done", find(s, 24)?.status === "done", find(s, 24));
  check("25 an offer of one thing asks you", find(s, 25)?.status === "asks" && /lo suba/.test(find(s, 25)?.ask ?? ""), find(s, 25));
  check("26 an open offer in English is done", find(s, 26)?.status === "done", find(s, 26));
  check("28 a wakeup shows when it picks up again", find(s, 28)?.status === "done" && find(s, 28)?.reminder?.at === later && !find(s, 28)?.reminder?.every, find(s, 28)?.reminder);
  const r29 = find(s, 29)?.reminder;
  check("29 a repeating reminder says how often, its next run and when it stops",
    r29?.every === "Every 5 minutes" && r29?.at > Date.now() && r29?.at <= Date.now() + 5 * 60_000 + 1000 && Math.abs(r29?.until - (Date.now() + 7 * 24 * HOUR)) < 5 * 60_000, r29);
  check("30 a deleted reminder is gone", find(s, 30)?.reminder === null, find(s, 30)?.reminder);
  check("31 a fired reminder and a stopped wakeup are gone", find(s, 31)?.reminder === null, find(s, 31)?.reminder);
  check("32 closing the session ends its reminders", find(s, 32)?.status === "ended" && find(s, 32)?.reminder === null, find(s, 32));
  const made33 = find(s, 33)?.made ?? [];
  check("33 the tasks it set up, by the app's IDs, and not one that was never made",
    made33.length === 2 && made33[0]?.name === "Weekday digest" && made33[1]?.id === "noon-check-2" && made33[1]?.next != null, made33);
  check("72 a question in a point of the closing list asks you, with the point's lead", find(s, 72)?.status === "asks" && find(s, 72)?.ask === "La segunda parte, el menú. ¿La arranco?", find(s, 72));
  check("73 a point that needs your approval, in a list with blank lines, asks you", find(s, 73)?.status === "asks" && /need your approval/.test(find(s, 73)?.ask ?? ""), find(s, 73));
  check("74 a point that waits for your OK asks you", find(s, 74)?.status === "asks" && /visto bueno/.test(find(s, 74)?.ask ?? ""), find(s, 74));
  check("75 a point that only adds an option is done", find(s, 75)?.status === "done", find(s, 75));
  check("76 a question a point answers itself is done", find(s, 76)?.status === "done", find(s, 76));
  check("81 waiting for you to choose, without a question mark, asks you", find(s, 81)?.status === "asks" && /elijas/.test(find(s, 81)?.ask ?? ""), find(s, 81));
  check("82 waiting for you to pick, in English, asks you", find(s, 82)?.status === "asks", find(s, 82));
  check("83 nothing waits on you: done", find(s, 83)?.status === "done", find(s, 83));
  check("84 only if something waits: done", find(s, 84)?.status === "done", find(s, 84));
  check("27 an offer of one thing in English asks you", find(s, 27)?.status === "asks" && /push it/.test(find(s, 27)?.ask ?? ""), find(s, 27));

  // Last 7 Days and All Sessions
  check("17 a session from 8 days ago is not in Last 7 Days", !find(s, 17), find(s, 17));
  let h = await history();
  check("17 but it is in All Sessions", h.sessions.some((x: any) => x.sid === id(17)), h.total);
  h = await history("billing");
  check("All Sessions search finds it by its prompt", h.total === 1 && h.sessions[0]?.sid === id(17), h);
  h = await history("nothing like this");
  check("All Sessions search with no match is empty", h.total === 0, h.total);
  // All Sessions marks the rows that need you by the same rule.
  h = await history();
  const row = (n: number) => h.sessions.find((x: any) => x.sid === id(n));
  check("11 a question from today needs you in All Sessions", row(11)?.status === "asks" && row(11)?.needsYou === true, row(11));
  check("18 a question over a day old doesn't", row(18)?.status === "asks" && row(18)?.needsYou === false, row(18));
  check("86 an archived one doesn't either", row(86)?.archived === true && row(86)?.needsYou === false, row(86));

  // Allowing or denying a permission from the card. The tests play the plugin's hook: it sends
  // the ask and holds, asks again on each 204, and stops on anything else.
  const SECRET_WHAT = "rsync --delete ./garden-notes/ backup-box:/srv/plots-ZQX41";
  {
    const at = (n: number, e: Record<string, unknown>) => ev(id(n), { ...e, t: Date.now() });
    const papi = (path: string, body?: unknown, o: { header?: boolean; method?: string; signal?: AbortSignal } = {}) =>
      fetch(`http://127.0.0.1:${PORT}/api/permission/${path}`, {
        method: o.method ?? "POST", headers: o.header === false ? {} : { "x-csm": "1" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), signal: o.signal,
      });
    const decide = (n: number, pid: string, allow: boolean) => papi(`${id(n)}/decide`, { id: pid, allow });
    type Held = { rounds: number; status: number; decision?: string; endedAt: number; done: Promise<unknown> };
    const quit = new AbortController(); // ends the mods still asking at the end
    const holdPermit = (n: number, ask: Record<string, unknown>): Held => {
      const h: Held = { rounds: 0, status: 0, endedAt: 0, done: Promise.resolve() };
      h.done = (async () => {
        try {
          for (;;) {
            h.rounds++;
            const r = await papi(id(n), ask, { signal: quit.signal });
            if (r.status === 204) continue;
            h.status = r.status;
            h.endedAt = Date.now();
            if (r.status === 200) h.decision = (await r.json()).decision;
            return;
          }
        } catch {
          h.status = -1;
        }
      })();
      return h;
    };
    const until = async (ok: (s: any[]) => boolean, ms = 6000) => {
      const end = Date.now() + ms;
      let list = await state();
      while (!ok(list) && Date.now() < end) {
        await Bun.sleep(100);
        list = await state();
      }
      return list;
    };
    const waitOn = (n: number, tool: string, x: Record<string, unknown> = {}) => {
      at(n, { ev: "UserPromptSubmit", prompt: `Task ${n}` });
      at(n, { ev: "PreToolUse", tool, d: `Step ${n}` });
      at(n, { ev: "PermissionRequest", tool, ...x });
    };
    const settled = (h: Held, ms = 6000) => Promise.race([h.done, Bun.sleep(ms)]);

    // 170 allowed after a few rounds; 171 denied; 172 answered in the dialog; 173 a long command
    // on several lines; 174 waits with no mod; 175's mod stops asking; 176's mod is between
    // rounds at the click and never comes back; 177's decision is handed over but its session
    // still waits; 178's ask comes before its session is known; 179's session never shows the
    // wait; 180 has two asks at once (parallel subagents); 181's ask is asked twice.
    for (const n of [170, 171, 172, 173, 174, 175, 176, 177, 180, 181]) waitOn(n, n === 180 ? "Write" : "Bash");
    at(179, { ev: "UserPromptSubmit", prompt: "Task 179" });
    at(179, { ev: "PreToolUse", tool: "Read", d: "Step 179" });
    let list = await until((l) => [170, 171, 172, 173, 174, 175, 176, 177, 180, 181].every((n) => find(l, n)?.status === "waiting"));
    check("permit: with no mod asking, a permission wait has no permit and needs you", !find(list, 174)?.permit && find(list, 174)?.needsYou === true && !find(list, 4)?.permit, find(list, 174));

    const h170 = holdPermit(170, { id: "p170", tool: "Bash", what: SECRET_WHAT });
    const h171 = holdPermit(171, { id: "p171", tool: "Bash", what: "make lint", agent: "agent-171" });
    const h172 = holdPermit(172, { id: "p172", tool: "Bash", what: "make test" });
    const long = "printf 'first line'\n\n   && echo \tsecond " + "x".repeat(600);
    const h173 = holdPermit(173, { id: "p173", tool: "Bash", what: long });
    const h177 = holdPermit(177, { id: "p177", tool: "Bash", what: "make deploy-preview" });
    const h179 = holdPermit(179, { id: "p179", tool: "Read", what: "/work/plots/beds.md" });
    const h180a = holdPermit(180, { id: "p180a", tool: "Write", what: "/work/plots/a.md", agent: "agent-a" });
    const h180b = holdPermit(180, { id: "p180b", tool: "Write", what: "/work/plots/b.md", agent: "agent-b" });
    // 175 and 176: one request each, which goes away at once.
    for (const n of [175, 176]) {
      const gone = new AbortController();
      papi(id(n), { id: `p${n}`, tool: "Bash", what: `make step-${n}` }, { signal: gone.signal }).catch(() => {});
      setTimeout(() => gone.abort(), 200);
    }
    // 181: a newer request for the same ask ends the older one with 204.
    const first181 = papi(id(181), { id: "p181", tool: "Bash", what: "make tidy" });
    await Bun.sleep(150);
    const second181 = papi(id(181), { id: "p181", tool: "Bash", what: "make tidy" }, { signal: AbortSignal.timeout(500) }).catch(() => null);
    check("permit: a newer request for the same ask ends the older one with 204", (await first181).status === 204);
    await second181;

    list = await until((l) => !!find(l, 170)?.permit && !!find(l, 173)?.permit && !!find(l, 176)?.permit);
    const p170 = find(list, 170)?.permit;
    check("permit: a mod holding the ask gives the card what it asks, held", p170?.id === "p170" && p170?.tool === "Bash" && p170?.what === SECRET_WHAT &&
      p170?.state === "held" && p170?.allow === undefined && find(list, 170)?.needsYou === true, find(list, 170));
    const w173 = find(list, 173)?.permit?.what ?? "";
    check("permit: a long ask on several lines is one line, cut to 300", w173.length === 300 && w173.startsWith("printf 'first line' && echo second xxx") && !/\s\s|\n|\t/.test(w173), w173);
    check("permit: two asks in one session, the card shows the oldest", find(list, 180)?.permit?.id === "p180a", find(list, 180)?.permit);

    // The routes' checks.
    check("permit: without the header, refused", (await papi(id(170), { id: "p170", tool: "Bash", what: "x" }, { header: false })).status === 403 &&
      (await papi(`${id(170)}/decide`, { id: "p170", allow: true }, { header: false })).status === 403);
    check("permit: a session ID that isn't one, 404", (await papi("not-a-session", { id: "x", tool: "Bash", what: "x" })).status === 404 &&
      (await papi("not-a-session/decide", { id: "x", allow: true })).status === 404);
    check("permit: only POST", (await papi(id(170), undefined, { method: "GET" })).status === 405);
    check("permit: a body it doesn't take, 400", (await papi(id(170), "not json")).status === 400 &&
      (await papi(id(170), { id: "", tool: "Bash", what: "x" })).status === 400 && (await papi(id(170), { id: "p", tool: "Bash" })).status === 400 &&
      (await papi(id(170), { id: "p", tool: "x".repeat(101), what: "x" })).status === 400 && (await papi(`${id(170)}/decide`, { id: "p170", allow: "yes" })).status === 400);
    check("permit: a decision for an ask it doesn't have, 404", (await decide(170, "p999", true)).status === 404);
    check("permit: a decision for a session that isn't waiting, 409", (await decide(179, "p179", true)).status === 409);

    // 176: decided while its mod is between rounds: on its way, so it doesn't need you; no mod comes back for it.
    check("permit: 176 decided between rounds is taken", (await decide(176, "p176", true)).status === 204);
    list = await state();
    check("permit: 176 decided and on its way: it doesn't need you", find(list, 176)?.permit?.state === "sending" && find(list, 176)?.permit?.allow === true &&
      find(list, 176)?.needsYou === false && !snap.attention.some((a: any) => a.id === id(176)), find(list, 176));

    // 170 allowed after a few rounds; 171 denied; 177 allowed, then its session keeps waiting.
    while (h170.rounds < 3) await Bun.sleep(100);
    list = await state();
    check("permit: 204 rounds keep the ask", find(list, 170)?.permit?.id === "p170" && find(list, 170)?.permit?.state === "held" && h170.status === 0, [h170, find(list, 170)?.permit]);
    check("permit: 170 allowed", (await decide(170, "p170", true)).status === 204);
    check("permit: 171 denied", (await decide(171, "p171", false)).status === 204);
    check("permit: 177 allowed", (await decide(177, "p177", true)).status === 204);
    await Promise.all([settled(h170), settled(h171), settled(h177)]);
    check("permit: the held request gets the allow", h170.status === 200 && h170.decision === "allow", h170);
    check("permit: the held request gets the deny", h171.status === 200 && h171.decision === "deny", h171);
    list = await state();
    check("permit: allowed and handed over, it doesn't need you", find(list, 170)?.permit?.state === "sent" && find(list, 170)?.permit?.allow === true && find(list, 170)?.needsYou === false, find(list, 170));
    check("permit: denied and handed over, the card knows it was a deny", find(list, 171)?.permit?.state === "sent" && find(list, 171)?.permit?.allow === false, find(list, 171)?.permit);
    check("permit: a second decision for the same ask, 409", (await decide(170, "p170", false)).status === 409);
    at(170, { ev: "PostToolUse", tool: "Bash" }); // the tool ran
    at(171, { ev: "PostToolUseFailure", tool: "Bash" }); // refused
    // 172 answered in the app's dialog: its held request ends with 410 as soon as the line is read.
    const wrote172 = Date.now();
    at(172, { ev: "PostToolUse", tool: "Bash" });
    // 178's hook line comes after its ask, which comes before its session is known.
    const h178 = holdPermit(178, { id: "p178", tool: "Bash", what: "make docs" });
    await Bun.sleep(300);
    at(178, { ev: "UserPromptSubmit", prompt: "Task 178" });
    at(178, { ev: "PermissionRequest", tool: "Bash" });
    await settled(h172, 3000);
    check("permit: answered in the dialog, the held request ends with 410 at once", h172.status === 410 && h172.endedAt - wrote172 < 1500, [h172, h172.endedAt - wrote172]);
    list = await until((l) => !!find(l, 178)?.permit && !find(l, 170)?.permit);
    check("permit: once the session moves on, the permit goes", find(list, 170)?.status === "working" && !find(list, 170)?.permit && !find(list, 171)?.permit && !find(list, 172)?.permit, [find(list, 170), find(list, 171)?.permit]);
    check("permit: a settled ask can't be decided, 409", (await decide(170, "p170", true)).status === 409);
    check("permit: an ask that came before its hook line shows once the session waits", find(list, 178)?.permit?.id === "p178" && find(list, 178)?.permit?.state === "held", find(list, 178));
    check("permit: 178 allowed", (await decide(178, "p178", true)).status === 204);
    await settled(h178);
    check("permit: 178's held request gets the allow", h178.decision === "allow", h178);

    // 180: one agent's wait clears, and the other ask falls back to its dialog.
    at(180, { ev: "PostToolUse", tool: "Write" });
    await Promise.all([settled(h180a, 3000), settled(h180b, 3000)]);
    check("permit: when the session moves on, every ask it held ends with 410", h180a.status === 410 && h180b.status === 410, [h180a, h180b]);

    // After the timers: 175's mod stopped asking; 176's decision was never picked up; 177's
    // session keeps waiting after its allow (and stays sent); 179's session never showed the wait.
    await settled(h179, 5000);
    list = await until((l) => !find(l, 175)?.permit && find(l, 176)?.permit?.state === "failed", 6000);
    check("permit: a mod that stops asking takes the permit with it", find(list, 175)?.status === "waiting" && !find(list, 175)?.permit && find(list, 175)?.needsYou === true, find(list, 175));
    check("permit: a decision no mod picked up fails, and it needs you again", find(list, 176)?.permit?.state === "failed" && find(list, 176)?.needsYou === true &&
      snap.attention.find((a: any) => a.id === id(176))?.words === "Couldn't send your answer", [find(list, 176), snap.attention.find((a: any) => a.id === id(176))]);
    await Bun.sleep(4000); // well past the old 3 s window
    list = await state();
    check("permit: handed over while the session keeps waiting, it stays sent and doesn't need you", find(list, 177)?.permit?.state === "sent" && find(list, 177)?.needsYou === false, find(list, 177));
    check("permit: an ask whose session never shows the wait ends with 410", h179.status === 410, h179);
    check("permit: a dropped ask asked again gets 410", (await papi(id(179), { id: "p179", tool: "Read", what: "/work/plots/beds.md" })).status === 410);
    at(176, { ev: "PostToolUse", tool: "Bash" });
    list = await until((l) => !find(l, 176)?.permit);
    check("permit: a failed one goes once the session moves on", find(list, 176)?.status === "working" && !find(list, 176)?.permit, find(list, 176));
    at(177, { ev: "PostToolUse", tool: "Bash" });
    list = await until((l) => !find(l, 177)?.permit);
    check("permit: a sent one goes once the session moves on", find(list, 177)?.status === "working" && !find(list, 177)?.permit, find(list, 177));
    quit.abort();
  }

  // 190–202. The advisor, from the transcript (scanned at startup, then the 3 s tick reads it).
  {
    const adv = async (ok: (l: any[]) => boolean, ms = 8000) => {
      const end = Date.now() + ms;
      let list = await state();
      while (!ok(list) && Date.now() < end) {
        await Bun.sleep(150);
        list = await state();
      }
      return list;
    };
    const a = (l: any[], n: number) => find(l, n)?.advisor;
    let list = await adv((l) => [191, 192, 193, 194, 196, 197, 199, 200, 201, 202].every((n) => a(l, n)?.model));
    check("190 advisorModel on every row, a subagent's call or declaration, a quoted call or a request's tools: no advisor", find(list, 190) && !a(list, 190), find(list, 190));
    check("197 turned on and never asked: the chip, with the declared model", a(list, 197)?.model === "claude-fable-5-2", a(list, 197));
    check("198 turned on, then off: no chip", find(list, 198) && !a(list, 198), find(list, 198));
    check("199 Opus turned on, then a Fable advisor answered: Fable", a(list, 199)?.model === "claude-fable-5-2", a(list, 199));
    check("200 turned on more than 8 MB before the end, a 5 MB line between: found", a(list, 200)?.model === "claude-fable-5-2" && statSync(tp200).size > (13 << 20), a(list, 200));
    check("191 after a call: the model from the call's row, and nothing else in the chip", a(list, 191)?.model === "claude-opus-5-5" && JSON.stringify(a(list, 191)) === '{"model":"claude-opus-5-5"}', a(list, 191));
    check("192, 193, 194 and 196 after a call: the chip, with no asking", [192, 193, 194, 196].every((n) => a(list, n)?.model === "claude-fable-5-2" && !("asking" in a(list, n))), [192, 193, 194, 196].map((n) => a(list, n)));
    check("195 asked earlier: the advisor", a(list, 195)?.model === "claude-fable-5-2", a(list, 195));
    appendFileSync(join(dir, "t191.jsonl"), JSON.stringify(advAnswer("srvtoolu_191", "claude-fable-5-2")) + "\n");
    // Its call scrolls out of the tail: more than 256 KB after it.
    appendFileSync(tp195, Array.from({ length: 300 }, (_, i) => JSON.stringify(advised(`Row ${i} ${"x".repeat(1000)}`))).join("\n") + "\n");
    list = await adv((l) => a(l, 191)?.model === "claude-fable-5-2");
    check("191 the answer came: the model from its usage wins over the configured one", a(list, 191)?.model === "claude-fable-5-2", find(list, 191));
    await Bun.sleep(3500); // the tail read has had its ticks
    list = await state();
    check("195 its call scrolled out of the tail: the advisor stays", a(list, 195)?.model === "claude-fable-5-2", a(list, 195));
    // 201's transcript written anew, shorter than what was read of it, turning Opus on: read from scratch.
    writeFileSync(join(dir, "t201.jsonl"), [advised("Starting over."), declare("claude-opus-5-5")].map((r) => JSON.stringify(r)).join("\n") + "\n");
    // 202 turned off while the server runs (its chip is in sessions.db by now).
    appendFileSync(join(dir, "t202.jsonl"), JSON.stringify(declare("claude-fable-5-2", false)) + "\n");
    list = await adv((l) => a(l, 201)?.model === "claude-opus-5-5" && !a(l, 202));
    check("201 its transcript written anew and shorter: read again from the start", a(list, 201)?.model === "claude-opus-5-5", a(list, 201));
    check("202 turned off while running: the chip goes", find(list, 202) && !a(list, 202), find(list, 202));
    check("advisor: /api/state carries only the model", [191, 197, 199, 200, 201].every((n) => Object.keys(a(list, n) ?? {}).join() === "model"), [191, 197, 199, 200, 201].map((n) => a(list, n)));
    const shown = JSON.stringify(snap);
    check("advisor: what the session asks and the answer reach neither the page nor the log", !shown.includes(SECRET_ADVICE) && !serverOutput.includes(SECRET_ADVICE));
  }

  // A restart loses nothing: the week comes back from the database.
  server.kill();
  await server.exited;
  {
    // What a permission asks lives in memory only: in no file of the server's folder, and in nothing it printed.
    const files = readdirSync(dir).filter((f) => f.startsWith("sessions.db") || f.endsWith(".log") || f.endsWith(".jsonl"));
    const holding = files.filter((f) => readFileSync(join(dir, f), "latin1").includes(SECRET_WHAT));
    check("permit: what it asks reaches neither sessions.db nor the log", files.some((f) => f === "sessions.db") && holding.length === 0 && !serverOutput.includes(SECRET_WHAT), holding);
    const advice = files.filter((f) => !/^t\d+\.jsonl$/.test(f) && readFileSync(join(dir, f), "latin1").includes(SECRET_ADVICE));
    check("advisor: what the session asks and the answer reach no file of the server's", advice.length === 0 && files.includes("sessions.db"), advice);
    // How far each transcript was read is kept with the model.
    const db = new Database(join(dir, "sessions.db"), { readonly: true });
    const row = (n: number) => db.query("SELECT advisor, advisor_read FROM sessions WHERE sid = ?").get(id(n)) as { advisor: string | null; advisor_read: number | null } | null;
    const kept = { 200: row(200), 198: row(198), 202: row(202), 197: row(197) };
    db.close();
    check("200 sessions.db keeps the model and how far its transcript was read: all of it", kept[200]?.advisor === "claude-fable-5-2" && kept[200]?.advisor_read === statSync(tp200).size, kept[200]);
    check("198 and 202 turned off: sessions.db keeps no model, with how far it read", kept[198]?.advisor === null && kept[198]?.advisor_read === statSync(join(dir, "t198.jsonl")).size &&
      kept[202]?.advisor === null && kept[202]?.advisor_read === statSync(join(dir, "t202.jsonl")).size, [kept[198], kept[202]]);
    check("advisor: sessions.db keeps only a model name and a number", Object.values(kept).every((r) => r && (r.advisor === null || /^claude-[a-z0-9.-]+$/.test(r.advisor)) && Number.isInteger(r.advisor_read)), kept);
  }
  // 200's row turning the advisor on becomes a line of the same length that says nothing: a
  // restart that read the transcript from the start again would lose the chip.
  {
    const text = readFileSync(tp200, "latin1");
    const at = text.indexOf(declared200);
    const blank = JSON.stringify({ type: "x", pad: "" });
    const same = blank.slice(0, -2) + "z".repeat(declared200.length - blank.length) + '"}';
    check("200 the row turning it on is overwritten in place", at > 0 && same.length === declared200.length);
    const fd = openSync(tp200, "r+");
    writeSync(fd, Buffer.from(same), 0, same.length, at);
    closeSync(fd);
  }
  rmSync(tp195); // so after the restart, 195's advisor can only come from sessions.db
  server = start();
  s = await state();
  // The Claude app writes 147's file again after the restart (its last activity moves on):
  // the note is read again, and must not undo the box's question.
  {
    const f = join(appDir, `local_${id(147)}.json`);
    const j = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...j, lastActivityAt: j.lastActivityAt + 1000, lastTurnEdgeAt: j.lastTurnEdgeAt + 1000 }));
    await Bun.sleep(4000);
    s = await state();
  }
  check("after a restart, the question is still there", find(s, 15)?.status === "asks" && /me falta saber/.test(find(s, 15)?.ask ?? ""), find(s, 15));
  check("19 after a restart, the run still knows its task", (await history("Weekday digest")).sessions.find((x: any) => x.sid === id(19))?.task === "t-digest");
  check("28 after a restart, the wakeup is still there", find(s, 28)?.reminder?.at === later, find(s, 28)?.reminder);
  check("33 after a restart, All Sessions still knows the tasks it set up",
    (await history("noon check")).sessions.find((x: any) => x.sid === id(33))?.made?.length === 2);
  check("usage: an older, lower share for the same week doesn't take the week back", snap.usage?.week?.pct === 45 && !snap.usage.week.samples.some((x: number[]) => x[1] === 12), snap.usage?.week);
  check("145 after a restart, its side session's question still shows only there", find(s, 145)?.status === "done" && find(s, 145)?.needsYou === false && find(s, 146)?.status === "asks", [find(s, 145), find(s, 146)]);
  check("87 after a restart, a question it passes on still shows only in its session", find(s, 87)?.status === "done" && find(s, 88)?.status === "asks", [find(s, 87), find(s, 88)]);
  check("120 after a restart, the answered pick stays answered", find(s, 120)?.status === "done" && find(s, 120)?.needsYou === false, find(s, 120));
  check("147 after a restart, a next-step box that asks still asks, whatever the app's note says", find(s, 147)?.status === "asks" && find(s, 147)?.needsYou === true, find(s, 147));
  check("135 after a restart, the buttons come back from the transcript", JSON.stringify(find(s, 135)?.answers) === JSON.stringify([{ label: "Yes, post it" }, { label: "Verify", app: "verify" }]) &&
    find(s, 135)?.canAnswer === false && find(s, 135)?.status === "asks", find(s, 135));
  check("195 after a restart, the advisor comes back from sessions.db", find(s, 195)?.advisor?.model === "claude-fable-5-2", find(s, 195));
  {
    await Bun.sleep(1500); // the first passes have had their time
    const again = await state();
    check("200 after a restart, its transcript isn't read from the start again: the chip stays", find(again, 200)?.advisor?.model === "claude-fable-5-2", find(again, 200));
    check("197 and 201 after a restart, the chips stay", find(again, 197)?.advisor?.model === "claude-fable-5-2" && find(again, 201)?.advisor?.model === "claude-opus-5-5", [find(again, 197), find(again, 201)]);
    check("198 and 202 after a restart, turned off stays off", find(again, 198) && !find(again, 198)?.advisor && find(again, 202) && !find(again, 202)?.advisor, [find(again, 198), find(again, 202)]);
  }
  check("after a restart, the recap is still there", find(s, 5)?.title !== undefined && find(s, 13)?.status === "error", [find(s, 5), find(s, 13)]);

  // A sessions.db that isn't a database is moved aside as sessions.db.bad, and the server starts fresh.
  server.kill();
  await server.exited;
  writeFileSync(join(bad, "sessions.db"), "not a database, ".repeat(400));
  writeFileSync(join(bad, "events.jsonl"), JSON.stringify({ t: Date.now(), sid: id(147), cwd: "/tmp/demo", ev: "UserPromptSubmit", prompt: "Fresh start" }) + "\n");
  server = start(bad);
  const up = await state().catch(() => null);
  check("a garbage sessions.db: the server starts fresh and keeps it aside", find(up ?? [], 147)?.status === "working" &&
    existsSync(join(bad, "sessions.db.bad")) && (await history()).sessions?.some((x: any) => x.sid === id(147)), up && find(up, 147));
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(bad, { recursive: true, force: true });
}

// The schedule reader on its own, from a fixed Thursday noon.
const thursday = new Date(2026, 9, 22, 12).getTime();
check("cron in words", describeCron("*/15 * * * *") === "Every 15 minutes" && describeCron("0 9,17 * * *") === "Every day at 9:00 AM and 5:00 PM"
  && describeCron("0 9 1 * *") === "Monthly on the 1st at 9:00 AM" && describeCron("30 * * * 1-5") === "Every hour at :30 on weekdays",
  ["*/15 * * * *", "0 9,17 * * *", "0 9 1 * *", "30 * * * 1-5"].map(describeCron));
check("cron too unusual for words gives null", describeCron("0 */3 1-7 * *") === null && describeCron("0 * 1 * *") === null,
  [describeCron("0 */3 1-7 * *"), describeCron("0 * 1 * *")]);
// Vixie cron: a day field starting with * makes both day fields required (Dec 21 is the first Monday on 1, 11, 21 or 31).
check("cron: */n in the day of the month still needs the weekday too", (() => { const d = new Date(nextRun(parseCron("0 0 */10 * 1")!, thursday)!); return d.getMonth() === 11 && d.getDate() === 21; })());
check("cron: day of month or day of week, either one", new Date(nextRun(parseCron("0 0 13 * 5")!, thursday)!).getDate() === 23);
check("cron: 7 is Sunday", new Date(nextRun(parseCron("0 9 * * 7")!, thursday)!).getDay() === 0);
check("cron: the run before", prevRun(parseCron("0 9 * * 1-5")!, thursday) === new Date(2026, 9, 22, 9).getTime());
check("cron: a bad expression is null", parseCron("61 * * * *") === null && parseCron("bad") === null && parseCron("* * * *") === null);

// The hook keeps when a reminder fires and its ID, never what it will do. Needs jq.
{
  const hdir = mkdtempSync(join(tmpdir(), "csm-hook-"));
  const hook = (payload: object) => Bun.spawnSync(["sh", join(import.meta.dir, "..", "hooks", "session-hook.sh")],
    { stdin: new TextEncoder().encode(JSON.stringify(payload)), env: { ...process.env, CSM_DIR: hdir } });
  const secret = "SECRET-PROMPT";
  hook({ hook_event_name: "PostToolUse", session_id: "h", tool_name: "ScheduleWakeup",
    tool_input: { delaySeconds: 1800, prompt: secret, reason: secret }, tool_response: { scheduledFor: 1_800_000_000_000 } });
  hook({ hook_event_name: "PostToolUse", session_id: "h", tool_name: "CronCreate",
    tool_input: { cron: "17 8 23 10 *", recurring: false, prompt: secret }, tool_response: { id: "1386eca0", nextFireAt: 1_800_000_000_000 } });
  hook({ hook_event_name: "PostToolUse", session_id: "h", tool_name: "CronCreate",
    tool_input: { cron: "*/5 * * * *", prompt: secret }, tool_response: "Scheduled recurring task ab12cd34 (*/5 * * * *)." });
  hook({ hook_event_name: "PostToolUse", session_id: "h", tool_name: "CronDelete", tool_input: { id: "1386eca0" }, tool_response: [{ type: "text", text: "ok" }] });
  hook({ hook_event_name: "PreToolUse", session_id: "h", tool_name: "mcp__scheduled-tasks__create_scheduled_task",
    tool_input: { taskId: "noon-check", title: "Noon check", description: secret, prompt: secret } });
  hook({ hook_event_name: "PostToolUse", session_id: "h", tool_name: "mcp__scheduled-tasks__create_scheduled_task",
    tool_input: { taskId: "noon-check", description: secret, prompt: secret }, tool_response: [{ type: "text", text: "Created" }] });
  hook({ hook_event_name: "PostToolUse", session_id: "h", tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: "a string" });
  hook({ hook_event_name: "PostToolUse", session_id: "h", tool_name: "CronCreate",
    tool_input: { cron: "0 9 * * *", prompt: secret }, tool_response: [{ type: "text", text: "Scheduled recurring task abcdef12 (0 9 * * *)." }] });
  hook({ hook_event_name: "PreToolUse", session_id: "h", tool_name: 7, tool_input: "a string" });
  hook({ hook_event_name: "PreToolUse", session_id: "h", tool_name: "mcp__ccd_turn__wrap_up",
    tool_input: { recap: "Done.", ask: "Post it?", blocked: true, actions: [{ label: `Yes,\n post it ${"x".repeat(60)}`, extra: secret }, { action: "create_pr", label: "Open" }, { label: "Third" }] } });
  hook({ hook_event_name: "PreToolUse", session_id: "h", tool_name: "mcp__ccd_turn__wrap_up", tool_input: { recap: "Done.", actions: "not a list" } });
  const text = await Bun.file(join(hdir, "events.jsonl")).text().catch(() => "");
  const lines = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("hook: one line per event, whatever shape the tool's input or reply has", lines.length === 11, lines.length);
  check("hook: never a reminder's prompt or a task's description", !text.includes(secret));
  check("hook: a wakeup's time", lines[0]?.x?.at === 1_800_000_000_000, lines[0]);
  check("hook: a cron job's ID, time and that it runs once", lines[1]?.x?.id === "1386eca0" && lines[1]?.x?.at === 1_800_000_000_000 && lines[1]?.x?.rec === false, lines[1]);
  check("hook: the ID from a text reply, and repeating by default", lines[2]?.x?.id === "ab12cd34" && lines[2]?.x?.rec === true, lines[2]);
  check("hook: a deleted cron job's ID", lines[3]?.x?.id === "1386eca0", lines[3]);
  check("hook: a scheduled task by its title and ID", lines[4]?.d === "Noon check" && lines[5]?.x?.task === "noon-check", [lines[4], lines[5]]);
  check("hook: a cron job's ID from a reply in text blocks", lines[7]?.x?.id === "abcdef12", lines[7]);
  check("hook: the first two answer buttons, cut to 40 characters, and an app action's name",
    JSON.stringify(lines[9]?.x?.acts) === JSON.stringify([{ l: `Yes, post it ${"x".repeat(27)}` }, { l: "Open", a: "create_pr" }]), lines[9]?.x);
  check("hook: buttons that aren't a list are left out", lines[10]?.x?.acts === null, lines[10]?.x);
  rmSync(hdir, { recursive: true, force: true });
}

// The status line keeps two percentages and their resets, nothing else, and prints them.
{
  const udir = mkdtempSync(join(tmpdir(), "csm-usage-"));
  const run = (payload: object) => Bun.spawnSync(["sh", join(import.meta.dir, "..", "hooks", "statusline.sh")],
    { stdin: new TextEncoder().encode(JSON.stringify(payload)), env: { ...process.env, CSM_DIR: udir } });
  const out = run({ session_id: "SECRET", cwd: "/secret", model: { id: "m" },
    rate_limits: { five_hour: { used_percentage: 18.4, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 42.7, resets_at: 1_800_100_000 } } });
  const saved = readFileSync(join(udir, "usage.json"), "utf8");
  check("status line: prints the week and 5 hours", out.stdout.toString().trim() === "Week 42% · 5h 18%", out.stdout.toString());
  check("status line: saves only the percentages and resets", JSON.parse(saved).week?.used_percentage === 42.7 && !saved.includes("SECRET") && !saved.includes("/secret"), saved);
  run({ session_id: "x" });
  check("status line: a reply without limits keeps the last numbers", readFileSync(join(udir, "usage.json"), "utf8") === saved);
  rmSync(udir, { recursive: true, force: true });
}

// The design system's files are as they were vendored: shared pieces change in mac-app-design.
{
  const pub = join(import.meta.dir, "..", "public");
  const manifest = JSON.parse(readFileSync(join(pub, "design.json"), "utf8"));
  const edited = Object.entries(manifest.files as Record<string, string>)
    .filter(([file, hash]) => new Bun.CryptoHasher("sha256").update(readFileSync(join(pub, file), "utf8")).digest("hex") !== hash).map(([f]) => f);
  check("design system: the vendored files weren't edited", edited.length === 0, edited);
  const kit = JSON.parse(readFileSync(join(import.meta.dir, "..", "kit.json"), "utf8"));
  const kitEdited = Object.entries(kit.files as Record<string, string>)
    .filter(([file, hash]) => new Bun.CryptoHasher("sha256").update(readFileSync(join(import.meta.dir, "..", file), "utf8")).digest("hex") !== hash).map(([f]) => f);
  check("app kit: the vendored server kit wasn't edited", kitEdited.length === 0, kitEdited);
}

console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
