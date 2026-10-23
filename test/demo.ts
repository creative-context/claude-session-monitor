// Starts the server with made-up sessions, for screenshots and for trying the UI
// without your own data. Nothing here reads ~/.claude or the Claude app.
//
//   bun test/demo.ts          → http://127.0.0.1:4748
//   bun test/demo.ts 4747     → on the app's port (quit the app first)
//   bun test/demo.ts --edge   → adds the edge cases: long text, a usage limit, a stopped
//                               session, one closed mid-turn, many agents, an idle one

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCron, prevRun } from "../cron.ts";

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 4748);
const EDGE = args.includes("--edge");
const dir = mkdtempSync(join(tmpdir(), "csm-demo-"));
const log = join(dir, "events.jsonl");
writeFileSync(log, "");

const MIN = 60_000;
const now = Date.now();
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const ev = (sid: string, t: number, e: Record<string, unknown>) =>
  appendFileSync(log, JSON.stringify({ t, sid, ...e }) + "\n");
const project = (name: string) => `/Users/demo/code/${name}`;

// A finished turn: the prompt, an optional recap or question, then Stop.
function finished(prompt: string, cwd: string, at: number, recap?: string, ask?: string) {
  const sid = id();
  ev(sid, at - 6 * MIN, { ev: "UserPromptSubmit", prompt, cwd });
  if (recap || ask) ev(sid, at - 1000, { ev: "PreToolUse", tool: "mcp__ccd_turn__wrap_up", x: { recap, ask }, cwd });
  ev(sid, at, { ev: "Stop", cwd });
  return sid;
}

// Active, last two hours
let s = id();
ev(s, now - 3 * MIN, { ev: "UserPromptSubmit", prompt: "Upgrade the payments SDK", cwd: project("billing-api") });
ev(s, now - 2 * MIN, { ev: "PreToolUse", tool: "Bash", d: "Install the new SDK version", cwd: project("billing-api") });
ev(s, now - 1 * MIN, { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash", cwd: project("billing-api") });

const releaseRun = finished("Release notes for 2.4", project("docs"), now - 9 * MIN,
  "Drafted the release notes from the merged pull requests, grouped by feature.",
  "Should I publish them to the changelog now?");

s = id();
ev(s, now - 14 * MIN, { ev: "UserPromptSubmit", prompt: "Fix the flaky checkout test", cwd: project("web-app") });
ev(s, now - 13 * MIN, {
  ev: "PreToolUse", tool: "mcp__ccd_turn__update_plan", cwd: project("web-app"),
  x: { items: [
    { c: "Reproduce the failure", s: "completed" }, { c: "Find the race in the cart state", s: "completed" },
    { c: "Fix and add a regression test", s: "in_progress" }, { c: "Run the full checkout suite", s: "pending" },
    { c: "Write up the cause", s: "pending" },
  ] },
});
ev(s, now - 20_000, { ev: "PreToolUse", tool: "Bash", d: "Run the checkout tests", cwd: project("web-app") });

// A workflow keeps this one busy after its own turn ended.
s = id();
const tp = join(dir, `${s}.jsonl`);
const run = "wf_demo0001-abc";
writeFileSync(tp, [
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_demo", name: "Workflow", input: { scriptPath: "/tmp/nightly-audit.js" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_demo", content: `Started ${run}` }] } },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
const runDir = join(dir, s, "subagents", "workflows", run);
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "journal.jsonl"), [
  { type: "launched" },
  { type: "started", agentId: "demo1", label: "review:tables · high", phase: "Review" },
  { type: "started", agentId: "demo2", label: "review:jobs · high", phase: "Review" },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
for (const [agent, label, tool, file] of [
  ["demo1", "review:tables · high", "Read", "/srv/warehouse/orders.sql"],
  ["demo2", "review:jobs · high", "Grep", "late_rows"],
]) {
  writeFileSync(join(runDir, `agent-${agent}.meta.json`), JSON.stringify({ description: label, workflowPhase: "Review", model: "opus" }));
  writeFileSync(join(runDir, `agent-${agent}.jsonl`), JSON.stringify({
    type: "assistant",
    message: {
      stop_reason: "tool_use", usage: { input_tokens: 12, cache_read_input_tokens: 84000, output_tokens: 900 },
      content: [{ type: "tool_use", name: tool, input: { file_path: file, pattern: file } }],
    },
  }) + "\n");
}
ev(s, now - 22 * MIN, { ev: "UserPromptSubmit", prompt: "Nightly data audit", cwd: project("analytics"), tp });
ev(s, now - 21 * MIN, { ev: "Stop", cwd: project("analytics"), tp });
const auditRun = s;

finished("Onboarding email copy", project("marketing-site"), now - 26 * MIN,
  "Wrote three subject lines and a short body. The draft is in emails/onboarding.md.");

// Done, and set to look again on its own later: it stays in Active until then.
s = finished("Check the staging deploy", project("web-app"), now - 35 * MIN,
  "The deploy is rolling out to staging. I'll look at the error rate again in an hour.");
ev(s, now - 35 * MIN - 2000, { ev: "PostToolUse", tool: "CronCreate", cwd: project("web-app"),
  x: { id: "a1b2c3d4", at: now + 55 * MIN, cron: "0 12 * * *", rec: false } });

s = id();
const tpErr = join(dir, `${s}.jsonl`);
writeFileSync(tpErr, [
  { type: "user", message: { content: "Rebuild the search index" } },
  { type: "assistant", isApiErrorMessage: true, error: "server_error", message: { content: [{ type: "text", text: "API Error: the server is overloaded. Try again in a moment." }] } },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
ev(s, now - 45 * MIN, { ev: "UserPromptSubmit", prompt: "Rebuild the search index", cwd: project("search"), tp: tpErr });
ev(s, now - 41 * MIN, { ev: "Stop", cwd: project("search"), tp: tpErr });

// Earlier today, yesterday, earlier this week
const H = 60 * MIN;
finished("Accessibility pass on settings", project("web-app"), now - 3 * H,
  "Labels, focus order and contrast fixed on all six settings screens.");
s = id();
ev(s, now - 4 * H, { ev: "SessionStart", cwd: project("billing-api") });
ev(s, now - 4 * H, { ev: "UserPromptSubmit", prompt: "Explore caching options", cwd: project("billing-api") });
ev(s, now - 4 * H + 5 * MIN, { ev: "SessionEnd", cwd: project("billing-api") });
finished("Changelog cleanup", project("docs"), now - 5 * H, "Merged duplicate entries and fixed the version links.");
finished("Dependency updates", project("mobile-app"), now - 26 * H, "Updated 14 packages. Two needed small code changes, both covered by tests.");
finished("Prototype the map view", project("mobile-app"), now - 30 * H, "The prototype is on the map-view branch, behind a feature flag.");
finished("Quarterly metrics deck", project("analytics"), now - 3 * 24 * H, "The deck has the four charts we agreed on, with sources in the notes.");
finished("Rename environment variables", project("infra"), now - 5 * 24 * H, "Renamed 9 variables in the deploy config and the docs.");
// Older than a week: only in History.
finished("Set up the staging database", project("infra"), now - 9 * 24 * H, "Staging runs on its own database now, refreshed nightly.");


// Scheduled tasks, the way the Claude app keeps them: scheduled-tasks.json, plus one
// session file per run that names its task.
const appDir = join(dir, "app", "account", "org");
mkdirSync(appDir, { recursive: true });
const taskFile: any[] = [];
let runFiles = 0;
const prev = (cron: string, before = now) => prevRun(parseCron(cron)!, before)!;
function task(id: string, name: string, cron: string, cwd: string, o: { enabled?: boolean; lastFor?: number; created?: number } = {}) {
  taskFile.push({
    id, displayName: name, cronExpression: cron, enabled: o.enabled ?? true, cwd,
    filePath: `/Users/demo/.claude/scheduled-tasks/${id}/SKILL.md`,
    createdAt: o.created ?? now - 30 * 24 * 60 * MIN,
    ...(o.lastFor ? { lastScheduledFor: new Date(o.lastFor).toISOString(), lastRunAt: new Date(o.lastFor + MIN).toISOString() } : {}),
  });
}
function runOf(sid: string, taskId: string, title: string, cwd: string, at: number) {
  writeFileSync(join(appDir, `local_${++runFiles}.json`), JSON.stringify({
    cliSessionId: sid, scheduledTaskId: taskId, title, originCwd: cwd, createdAt: at, lastActivityAt: at + 5 * MIN,
  }));
}

// Its last run asks you something (the release notes card above).
task("release-notes", "Weekly release notes", "0 16 * * 5", project("docs"), { lastFor: prev("0 16 * * 5") });
runOf(releaseRun, "release-notes", "Release notes for 2.4", project("docs"), now - 15 * MIN);
// Running right now (the workflow above).
task("data-audit", "Nightly data audit", "0 2 * * *", project("analytics"), { lastFor: prev("0 2 * * *") });
runOf(auditRun, "data-audit", "Nightly data audit", project("analytics"), now - 22 * MIN);
// Ran fine, three times.
const inbox = "0 8 * * 1-5";
let at = prev(inbox);
task("inbox-summary", "Morning inbox summary", inbox, project("inbox"), { lastFor: at });
for (let i = 0; i < 3; i++) {
  const sid = finished("Morning inbox summary", project("inbox"), at + 8 * MIN, "Eleven new threads. Two need a reply today; both are flagged.");
  runOf(sid, "inbox-summary", "Morning inbox summary", project("inbox"), at);
  at = prev(inbox, at - MIN);
}
// Missed its latest run: the one before it is the last that happened.
const daily = "0 7 * * *";
const ranAt = prev(daily, prev(daily, now - 10 * MIN) - MIN);
task("metrics-email", "Daily metrics email", daily, project("analytics"), { lastFor: ranAt });
runOf(finished("Daily metrics email", project("analytics"), ranAt + 8 * MIN, "Sent the metrics summary to the team channel."),
  "metrics-email", "Daily metrics email", project("analytics"), ranAt);
// New, hasn't run yet, set up by a session earlier today.
task("monthly-report", "Monthly usage report", "0 9 1 * *", project("analytics"), { created: now - 4 * 60 * MIN });
s = finished("Set up the monthly usage report", project("analytics"), now - 4 * 60 * MIN + 2 * MIN,
  "The report runs on the 1st of each month at 9 AM and posts to the team channel.");
ev(s, now - 4 * 60 * MIN, { ev: "PostToolUse", tool: "mcp__scheduled-tasks__create_scheduled_task", x: { task: "monthly-report" }, cwd: project("analytics") });
// Can't run: yesterday's run is still open, so the app skips today's every minute.
const vendor = "0 9 * * *";
const vendorDue = prev(vendor);
const vendorRan = prev(vendor, vendorDue - MIN);
task("vendor-digest", "Vendor invoice digest", vendor, project("finance"), { lastFor: vendorRan });
runOf(finished("Vendor invoice digest", project("finance"), vendorRan + 9 * MIN, "Four invoices are waiting for approval."),
  "vendor-digest", "Vendor invoice digest", project("finance"), vendorRan + 6 * MIN);
const skips: Record<string, { at: number; reason: string }[]> = { "vendor-digest": [] };
// Into the next few hours too, so it stays blocked while the demo runs.
for (let at = vendorDue + 53_000; at < now + 6 * 60 * MIN; at += MIN) skips["vendor-digest"].push({ at, reason: "per_task_limit" });
// Paused.
const backup = "0 3 * * 0";
const backupAt = prev(backup);
task("backup-check", "Sunday backup check", backup, project("infra"), { enabled: false, lastFor: backupAt });
runOf(finished("Sunday backup check", project("infra"), backupAt + 9 * MIN, "All three backups restored cleanly in the test environment."),
  "backup-check", "Sunday backup check", project("infra"), backupAt);

if (EDGE) {
  // A usage limit ends the turn with an API error, like a server error does.
  s = id();
  const tpLimit = join(dir, `${s}.jsonl`);
  writeFileSync(tpLimit, [
    { type: "user", message: { content: "Translate the help center into Spanish" } },
    { type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { content: [{ type: "text", text: "Claude usage limit reached. Your limit resets at 5 PM." }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  ev(s, now - 52 * MIN, { ev: "UserPromptSubmit", prompt: "Translate the help center into Spanish", cwd: project("help-center"), tp: tpLimit });
  ev(s, now - 50 * MIN, { ev: "Stop", cwd: project("help-center"), tp: tpLimit });

  // You stopped it: no Stop event, only the marker in the transcript.
  s = id();
  const tpStop = join(dir, `${s}.jsonl`);
  writeFileSync(tpStop, [
    { type: "user", message: { content: "Refactor the auth middleware" } },
    { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  ev(s, now - 34 * MIN, { ev: "UserPromptSubmit", prompt: "Refactor the auth middleware", cwd: project("web-app"), tp: tpStop });
  ev(s, now - 33 * MIN, { ev: "PreToolUse", tool: "Edit", d: "/Users/demo/code/web-app/src/auth.ts", cwd: project("web-app"), tp: tpStop });
  ev(s, now - 33 * MIN, { ev: "PostToolUse", tool: "Edit", cwd: project("web-app"), tp: tpStop });

  // Its process went away mid-turn (a closed terminal): the PID no longer exists.
  s = id();
  ev(s, now - 70 * MIN, { ev: "UserPromptSubmit", prompt: "Profile the image pipeline", cwd: project("media"), pid: 999_999 });
  ev(s, now - 69 * MIN, { ev: "PreToolUse", tool: "Bash", d: "Run the profiler on 500 images", cwd: project("media"), pid: 999_999 });

  // Long everything: title, folder name, question, permission text.
  finished(
    "Go through every open issue labeled bug in the tracker, group them by the component they touch, find the ones that are probably duplicates of each other and draft a short note for each group",
    project("customer-onboarding-experience-platform-monorepo"), now - 48 * MIN,
    undefined,
    "I found 41 open bugs in 9 groups, and 6 of them look like duplicates of older issues that were closed last month without a fix. Do you want me to reopen the old ones and close the new ones as duplicates, or the other way around?");
  s = id();
  ev(s, now - 8 * MIN, { ev: "UserPromptSubmit", prompt: "Clean up the downloads folder", cwd: project("scripts") });
  ev(s, now - 7 * MIN, {
    ev: "Notification", nt: "permission_prompt", cwd: project("scripts"),
    msg: "Claude needs your permission to use Bash: move 1,284 files older than 90 days from Downloads to an archive folder and delete the empty folders left behind",
  });

  // A workflow with many agents and a lot of tokens.
  s = id();
  const tpBig = join(dir, `${s}.jsonl`);
  const bigRun = "wf_demo0002-def";
  writeFileSync(tpBig, [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_big", name: "Workflow", input: { scriptPath: "/tmp/release-readiness.js" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_big", content: `Started ${bigRun}` }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const bigDir = join(dir, s, "subagents", "workflows", bigRun);
  mkdirSync(bigDir, { recursive: true });
  const areas = ["api", "web", "ios", "android", "billing", "search", "docs", "infra"];
  writeFileSync(join(bigDir, "journal.jsonl"), [{ type: "launched" },
    ...areas.map((a, i) => ({ type: "started", agentId: `big${i}`, label: `check:${a} · high`, phase: "Verify" }))].map((r) => JSON.stringify(r)).join("\n") + "\n");
  areas.forEach((a, i) => {
    writeFileSync(join(bigDir, `agent-big${i}.meta.json`), JSON.stringify({ description: `check:${a} · high`, workflowPhase: "Verify", model: "opus" }));
    writeFileSync(join(bigDir, `agent-big${i}.jsonl`), JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: "tool_use", usage: { input_tokens: 20, cache_read_input_tokens: 150_000 + i * 9000, output_tokens: 2400 },
        content: [{ type: "tool_use", name: "Read", input: { file_path: `/srv/${a}/CHANGELOG.md` } }],
      },
    }) + "\n");
  });
  ev(s, now - 61 * MIN, { ev: "UserPromptSubmit", prompt: "Release readiness check", cwd: project("platform"), tp: tpBig });
  ev(s, now - 60 * MIN, { ev: "Stop", cwd: project("platform"), tp: tpBig });

  // A question from two days ago: still a question, but it no longer needs you.
  finished("Pick a name for the CLI", project("cli"), now - 2 * 24 * 60 * MIN,
    "Three options are in names.md, with what each one is taken for on npm.",
    "Which one do you like best?");

  // A schedule too unusual to put in words, and a very long name.
  task("preview-cleanup", "Clean up stale preview deployments across every environment and region", "0 */3 1-7 * *", project("infra"));

  // Open, with no turn yet.
  s = id();
  ev(s, now - 18 * MIN, { ev: "SessionStart", cwd: project("notes") });

  // A loop that wakes every 10 minutes, a cron job after it, and two tasks it set up,
  // one of them one-time; plus a one-time task that already ran.
  s = finished("Babysit the nightly migration", project("infra"), now - 8 * MIN,
    "Rows are copying at the expected rate. I'll keep checking every ten minutes.");
  ev(s, now - 8 * MIN - 3000, { ev: "PostToolUse", tool: "ScheduleWakeup", x: { at: now + 2 * MIN, delay: 600 }, cwd: project("infra") });
  ev(s, now - 8 * MIN - 2000, { ev: "PostToolUse", tool: "CronCreate", x: { id: "e5f6a7b8", at: now + 52 * MIN, cron: "*/10 * * * *", rec: true }, cwd: project("infra") });
  ev(s, now - 8 * MIN - 1000, { ev: "PostToolUse", tool: "mcp__scheduled-tasks__create_scheduled_task", x: { task: "migration-report" }, cwd: project("infra") });
  ev(s, now - 8 * MIN - 500, { ev: "PostToolUse", tool: "mcp__scheduled-tasks__create_scheduled_task", x: { task: "migration-cleanup" }, cwd: project("infra") });
  task("migration-report", "Migration status report with a much longer name than usual", "30 7 * * *", project("infra"), { created: now - 8 * MIN - 1000 });
  taskFile.push({ id: "migration-cleanup", displayName: "Drop the old tables", fireAt: new Date(now + 26 * 60 * MIN).toISOString(),
    enabled: true, cwd: project("infra"), createdAt: now - 8 * MIN - 500 });
  taskFile.push({ id: "send-recap", displayName: "Send the launch recap", fireAt: new Date(now - 30 * 60 * MIN).toISOString(),
    enabled: false, cwd: project("docs"), createdAt: now - 3 * 24 * 60 * MIN, lastRunAt: new Date(now - 30 * 60 * MIN + MIN).toISOString() });
}

writeFileSync(join(appDir, "scheduled-tasks.json"), JSON.stringify({ scheduledTasks: taskFile, recordedSkips: skips }));

const server = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
  env: {
    ...process.env, CSM_PORT: String(PORT), CSM_DIR: dir,
    CSM_APP_SESSIONS: join(dir, "app"), CSM_PROJECTS: join(dir, "none"),
  },
  stdout: "inherit",
  stderr: "inherit",
});
const stop = () => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`Demo data in ${dir}. Open http://127.0.0.1:${PORT}  (Ctrl-C to stop)`);
await server.exited;
rmSync(dir, { recursive: true, force: true });
