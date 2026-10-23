// End-to-end checks of the state machine against the cases that broke other tools.
// Starts a second server on port 4749 with its own temp folder, writes hook lines,
// and reads /api/state. Never touches ~/.claude-session-monitor.
//
//   bun test/scenarios.ts

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCron, nextRun, parseCron, prevRun } from "../cron.ts";

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
const iso = (ms: number) => new Date(ms).toISOString();
writeFileSync(join(appDir, "scheduled-tasks.json"), JSON.stringify({ scheduledTasks: [
  { id: "t-digest", displayName: "Weekday digest", cronExpression: "0 7 * * 1-5", enabled: true, cwd: "/tmp/demo",
    createdAt: Date.now() - 30 * 24 * HOUR, lastScheduledFor: iso(prevRun(parseCron("0 7 * * 1-5")!, Date.now() - 11 * 60_000)!) },
  { id: "t-paused", displayName: "Paused report", cronExpression: "0 9 * * *", enabled: false, createdAt: Date.now() - 30 * 24 * HOUR },
  // Ran three hours ago, and not since: its last hourly run is missing.
  { id: "t-hourly", displayName: "Hourly check", cronExpression: "0 * * * *", enabled: true,
    createdAt: Date.now() - 2 * 24 * HOUR, lastScheduledFor: iso(Date.now() - 3 * HOUR) },
] }));
writeFileSync(join(appDir, "local_run19.json"), JSON.stringify({
  cliSessionId: id(19), scheduledTaskId: "t-digest", title: "Weekday digest", originCwd: "/tmp/demo",
  createdAt: Date.now() - 60_000, lastActivityAt: Date.now(),
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

// 23–25. An open offer for more is a courtesy closing, and so is a short "anything else?".
// An offer of one specific thing still asks you.
const closing = (n: number, text: string) => {
  const tp = transcript(`t${n}.jsonl`, [{ type: "user", message: { content: "Ship it" } }, said(text)]);
  ev(id(n), { ev: "UserPromptSubmit", prompt: "Ship it", tp });
  ev(id(n), { ev: "Stop", tp });
};
closing(23, "Ya está publicada la versión nueva. Si quieres seguir con otro ajuste, dime.");
closing(24, "El banner ya está arriba. ¿Algo más?");
closing(25, "Dejé el borrador listo. Si quieres que lo suba, dime.");

// Never read the real desktop app's sessions or transcripts in a test.
const start = () => Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
  env: {
    ...process.env, CSM_PORT: String(PORT), CSM_DIR: dir,
    CSM_APP_SESSIONS: join(dir, "app"), CSM_PROJECTS: join(dir, "no-projects"),
  },
  stdout: "ignore",
  stderr: "inherit",
});
let server = start();

async function history(q = ""): Promise<any> {
  return (await fetch(`http://127.0.0.1:${PORT}/api/history?q=${encodeURIComponent(q)}`)).json();
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
  check("2 subagents leave status working", find(s, 2)?.status === "working", find(s, 2));
  check("2 only the agent without SubagentStop counts", find(s, 2)?.agentCount === 1, find(s, 2)?.agents);
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
  check("tasks are read from the app's file", snap.tasks?.length === 3, snap.tasks?.map((x: any) => x.id));
  check("a task's schedule in words", digest?.schedule === "Weekdays at 7:00 AM", digest?.schedule);
  check("its next run is the next weekday at 7:00", Boolean(next && digest.next > Date.now() && next.getHours() === 7 && next.getMinutes() === 0 && next.getDay() >= 1 && next.getDay() <= 5), digest?.next);
  check("19 its last run is linked, asks you, and nothing was missed", digest?.lastRun?.sid === id(19) && digest?.lastRun?.status === "asks" && digest?.missed === null, digest);
  check("19 the run knows its task", find(s, 19)?.task === "t-digest" && find(s, 19)?.taskName === "Weekday digest", find(s, 19));
  check("a task whose last run needs you comes first", snap.tasks?.[0]?.id === "t-digest", snap.tasks?.map((x: any) => x.id));
  check("a paused task has no next run and comes last", task("t-paused")?.enabled === false && task("t-paused")?.next === null && snap.tasks?.at(-1)?.id === "t-paused", task("t-paused"));
  check("a run that didn't happen counts as missed", typeof task("t-hourly")?.missed === "number" && task("t-hourly")?.lastRun === null, task("t-hourly"));
  check("20 an agent's permission, once its tool ran, no longer needs you", find(s, 20)?.status !== "waiting" && find(s, 20)?.needsYou === false, find(s, 20));
  check("21 an agent's unanswered permission needs you, whatever other agents do", find(s, 21)?.status === "waiting" && find(s, 21)?.needsYou === true, find(s, 21));
  check("22 a finished plan is dropped when the next request comes", find(s, 22)?.status === "working" && find(s, 22)?.plan === null, find(s, 22)?.plan);
  check("the needs count matches the cards that need you", snap.needs === s.filter((x) => x.needsYou).length && snap.needs > 0, [snap.needs, s.filter((x) => x.needsYou).length]);

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
  check("15 a request with no question mark asks you", find(s, 15)?.status === "asks" && /me falta saber/.test(find(s, 15)?.ask ?? ""), find(s, 15));
  check("16 a courtesy closing is done", find(s, 16)?.status === "done", find(s, 16));
  check("23 an open offer for more is done", find(s, 23)?.status === "done", find(s, 23));
  check("24 a short \"anything else?\" is done", find(s, 24)?.status === "done", find(s, 24));
  check("25 an offer of one thing asks you", find(s, 25)?.status === "asks" && /lo suba/.test(find(s, 25)?.ask ?? ""), find(s, 25));

  // Last 7 Days and All Sessions
  check("17 a session from 8 days ago is not in Last 7 Days", !find(s, 17), find(s, 17));
  let h = await history();
  check("17 but it is in All Sessions", h.sessions.some((x: any) => x.sid === id(17)), h.total);
  h = await history("billing");
  check("All Sessions search finds it by its prompt", h.total === 1 && h.sessions[0]?.sid === id(17), h);
  h = await history("nothing like this");
  check("All Sessions search with no match is empty", h.total === 0, h.total);

  // A restart loses nothing: the week comes back from the database.
  server.kill();
  await server.exited;
  server = start();
  s = await state();
  check("after a restart, the question is still there", find(s, 15)?.status === "asks" && /me falta saber/.test(find(s, 15)?.ask ?? ""), find(s, 15));
  check("19 after a restart, the run still knows its task", (await history("Weekday digest")).sessions.find((x: any) => x.sid === id(19))?.task === "t-digest");
  check("after a restart, the recap is still there", find(s, 5)?.title !== undefined && find(s, 13)?.status === "error", [find(s, 5), find(s, 13)]);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
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
check("cron: 7 is Sunday", new Date(nextRun(parseCron("0 7 * * 7")!, thursday)!).getDay() === 0);
check("cron: the run before", prevRun(parseCron("0 7 * * 1-5")!, thursday) === new Date(2026, 9, 22, 7).getTime());
check("cron: a bad expression is null", parseCron("61 * * * *") === null && parseCron("bad") === null && parseCron("* * * *") === null);

console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
