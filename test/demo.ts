// Starts the server with made-up sessions, for screenshots and for trying the UI
// without your own data. Nothing here reads ~/.claude or the Claude app.
//
//   bun test/demo.ts          → http://127.0.0.1:4748
//   bun test/demo.ts 4747     → on the app's port (quit the app first)
//   bun test/demo.ts --edge   → adds the edge cases: long text, a usage limit, a stopped
//                               session, one closed mid-turn, many agents, an idle one
//   bun test/demo.ts --hot    → a week running hot: the forecast and its card; --limit, a week used up
//   bun test/demo.ts --gif    → only four sessions, for docs/demo.gif: a line on stdin plays its story
//   bun test/demo.ts --anatomy → only three cards, for docs/card-anatomy.png: one needs you,
//                               one works, one is done with a folder, a relative and a task
//
// Answering and allowing from a card need the app's page key (src/keys.ts). The server here takes
// the hash of a made-up key, DEMO_PAGE_KEY in test/keys.ts, or CSM_PAGE_KEY_SHA256 if it's set. A
// page in a plain browser has no key and only looks; to answer from one, set it in the page's
// console (window.__csmKey = "<the key>", printed below) and reload the page's state. The scripts
// that draw the page (docs/*.swift, test/page.ts) put the key in the page the way the app does.
// The plugin side played here reads plugin.key from the demo's folder, as the plugin does.
//
// Sessions waiting on a permission have the plugin's permission side, played here: their card
// shows what they ask with Allow and Deny. A click runs or refuses the tool a moment later
// (CSM_DEMO_PERMIT_MS, 1.5 s), and a few seconds after (CSM_DEMO_TURN_MS) it asks again.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCron, prevRun } from "../cron.ts";
import { playMod } from "./answer-mod.ts";
import { DEMO_PAGE_KEY, demoKeyHash, pluginFetch } from "./keys.ts";

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 4748);
const EDGE = args.includes("--edge");
const GIF = args.includes("--gif");
const ANATOMY = args.includes("--anatomy");
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

// A finished turn: the prompt, an optional recap or question with its answer buttons
// (acts: a label, and the app's action when only the app can do it), then Stop.
type Act = { l: string; a?: string };
function finished(prompt: string, cwd: string, at: number, recap?: string, ask?: string, acts?: Act[]) {
  const sid = id();
  ev(sid, at - 6 * MIN, { ev: "UserPromptSubmit", prompt, cwd });
  closeTurn(sid, cwd, at, recap, ask, acts);
  return sid;
}
function closeTurn(sid: string, cwd: string, at: number, recap?: string, ask?: string, acts?: Act[]) {
  if (recap || ask) ev(sid, at - 1000, { ev: "PreToolUse", tool: "mcp__ccd_turn__wrap_up", x: { recap, ask, ...(acts ? { acts } : {}) }, cwd });
  ev(sid, at, { ev: "Stop", cwd });
}

// Sessions you can answer from their card. The ones in `listening` have the answers mod
// (played by test/answer-mod.ts): your answer reaches them, they work on it for a few
// seconds and ask the same again, so the demo can be tried more than once.
const answering = new Map<string, { cwd: string; recap?: string; ask: string; acts: Act[] }>();
const listening: string[] = [];
function asksWithAnswers(prompt: string, name: string, at: number, recap: string | undefined, ask: string, acts: Act[], mod: boolean) {
  const sid = finished(prompt, project(name), at, recap, ask, acts);
  answering.set(sid, { cwd: project(name), recap, ask, acts });
  if (mod) listening.push(sid);
  return sid;
}

// Sessions waiting on a permission whose plugin holds the ask (played below): the tool, and
// what it asks for, made up.
type Permit = { sid: string; cwd: string; tool: string; what: string; msg: string };
const permits: Permit[] = [];
function waitsOn(sid: string, cwd: string, at: number, tool: string, what: string, mod = true) {
  const msg = `Claude needs your permission to use ${tool}`;
  ev(sid, at, { ev: "Notification", nt: "permission_prompt", msg, cwd });
  if (mod) permits.push({ sid, cwd, tool, what, msg });
}

// Active, last two hours
let s = id();
ev(s, now - 3 * MIN, { ev: "UserPromptSubmit", prompt: "Upgrade the payments SDK", cwd: project("billing-api") });
ev(s, now - 2 * MIN, { ev: "PreToolUse", tool: "Bash", d: "Install the new SDK version", cwd: project("billing-api") });
waitsOn(s, project("billing-api"), now - 1 * MIN, "Bash", "npm install payments-sdk --save-exact");

const releaseRun = asksWithAnswers("Release notes for 2.4", "docs", now - 9 * MIN,
  "Drafted the release notes from the merged pull requests, grouped by feature.",
  "Should I publish them to the changelog now?", [{ l: "Publish now" }, { l: "Wait for review" }], true);
// Its first answer is one only the app can do (a commit); the second can go from the card.
const loginFix = asksWithAnswers("Fix the login redirect loop", "web-app", now - 4 * MIN,
  "The redirect now keeps the original page, with a test for each sign-in path.",
  "The fix is ready on its branch. Commit it?", [{ l: "Commit", a: "commit" }, { l: "Not now" }], true);
// No mod in this one: its answers open the session.
asksWithAnswers("Rename the image folders", "media", now - 12 * MIN,
  "Renamed 38 folders to the new pattern. Nothing links to them by path any more.",
  "Should I keep the old folder names as redirects?", [{ l: "Keep redirects" }, { l: "Drop them" }], false);

s = id();
// Not in the GIF: there its transcript has no advisor (see advisorOn() below).
const tpCheckout = join(dir, `${s}.jsonl`);
ev(s, now - 14 * MIN, { ev: "UserPromptSubmit", prompt: "Fix the flaky checkout test", cwd: project("web-app"), ...(GIF ? {} : { tp: tpCheckout }) });
ev(s, now - 13 * MIN, {
  ev: "PreToolUse", tool: "mcp__ccd_turn__update_plan", cwd: project("web-app"),
  x: { items: [
    { c: "Reproduce the failure", s: "completed" }, { c: "Find the race in the cart state", s: "completed" },
    { c: "Fix and add a regression test", s: "in_progress" }, { c: "Run the full checkout suite", s: "pending" },
    { c: "Write up the cause", s: "pending" },
  ] },
});
ev(s, now - 20_000, { ev: "PreToolUse", tool: "Bash", d: "Run the checkout tests", cwd: project("web-app") });
const checkout = s;

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
  { type: "started", agentId: "demo2", label: "review:rows · high", phase: "Review" },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
for (const [agent, label, tool, file] of [
  ["demo1", "review:tables · high", "Read", "/srv/warehouse/orders.sql"],
  ["demo2", "review:rows · high", "Grep", "late_rows"],
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

// A session in a terminal: no app file, so its model is the one of its last reply.
const onboarding = id();
const tpMail = join(dir, `${onboarding}.jsonl`);
writeFileSync(tpMail, JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "The draft is ready." }] } }) + "\n");
ev(onboarding, now - 32 * MIN, { ev: "UserPromptSubmit", prompt: "Onboarding email copy", cwd: project("marketing-site"), tp: tpMail });
closeTurn(onboarding, project("marketing-site"), now - 26 * MIN,
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


// Sessions with an advisor turned on (/advisor): their transcripts say so, with the row Claude
// Code writes when it's turned on, and some with a call to it (a server tool, no hook event)
// and its answer. Every assistant row names the advisor's model, which alone means nothing.
// Only IDs and the model are read; the made-up rows hold no question or answer. Not in the
// GIF: its story's cards stay as they were.
const ADVISOR = "claude-fable-5-2";
const advisorOn = (model = ADVISOR) => ({ type: "attachment", isSidechain: false, attachment: { type: "advisor_tool", available: true, model, toolChange: "add" } });
const advisorCall = (n: string) => ({ type: "assistant", advisorModel: ADVISOR, message: { content: [{ type: "server_tool_use", id: `srvtoolu_demo_${n}`, name: "advisor", input: {} }] } });
const advisorAnswer = (n: string) => ({ type: "assistant", advisorModel: ADVISOR, message: {
  content: [{ type: "advisor_tool_result", tool_use_id: `srvtoolu_demo_${n}`, content: "" }],
  usage: { iterations: [{ type: "message" }, { type: "advisor_message", model: ADVISOR }] } } });
const toolRow = (n: string, name: string) => ({ type: "assistant", advisorModel: ADVISOR, message: { content: [{ type: "tool_use", id: `toolu_demo_${n}`, name, input: {} }] } });
const toolDone = (n: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_demo_${n}`, content: "ok" }] } });
const rows = (file: string, list: object[]) => appendFileSync(file, list.map((r) => JSON.stringify(r)).join("\n") + "\n");
// The checkout fix turned its advisor on, ran its tests and asked it, and it answered.
if (!GIF) {
  rows(tpCheckout, [{ type: "user", message: { content: "Fix the flaky checkout test" } }, advisorOn(),
    toolRow("ck1", "Bash"), toolDone("ck1"), advisorCall("ck1"), advisorAnswer("ck1")]);
  ev(checkout, now - 15_000, { ev: "PostToolUse", tool: "Bash", cwd: project("web-app"), tp: tpCheckout });
  // The release notes (ultracode on, so its card's tags are all there) turned theirs on and
  // asked it earlier in their turn; the login fix turned its on and hasn't asked it yet, so its
  // chip comes from that row alone. Rows with no text, so how their turns ended reads the same.
  for (const [sid, n, cwd, at] of [[releaseRun, "rn", project("docs"), now - 9 * MIN], [loginFix, "lf", project("web-app"), now - 4 * MIN]] as const) {
    const file = join(dir, `${sid}.jsonl`);
    rows(file, [advisorOn(), toolRow(`${n}1`, "Read"), toolDone(`${n}1`), ...(sid === loginFix ? [] : [advisorCall(n), advisorAnswer(n)])]);
    ev(sid, at - 2 * MIN, { ev: "PostToolUse", tool: "Read", cwd, tp: file });
  }
}

// Scheduled tasks, the way the Claude app keeps them: scheduled-tasks.json, plus one
// session file per run that names its task.
const appDir = join(dir, "app", "account", "org");
mkdirSync(appDir, { recursive: true });

// A side session the checkout fix started in the Claude app: the app's file for the side
// session says which session it came from.
const side = finished("Write the cart race regression test", project("web-app"), now - 6 * MIN,
  "The test reproduces the race in 3 of 10 runs before the fix and never after it.");
// Its answers mod listens too, so in the app its Done card has a mic for a spoken answer.
answering.set(side, { cwd: project("web-app"), recap: "The test reproduces the race in 3 of 10 runs before the fix and never after it.", ask: "", acts: [] });
listening.push(side);
writeFileSync(join(appDir, "local_checkout.json"), JSON.stringify({
  sessionId: "local_checkout", cliSessionId: checkout, title: "Fix the flaky checkout test", originCwd: project("web-app"),
  createdAt: now - 14 * MIN, lastActivityAt: now - 20_000, model: "claude-sonnet-5-5", effort: "medium",
}));
writeFileSync(join(appDir, "local_side.json"), JSON.stringify({
  sessionId: "local_side", cliSessionId: side, title: "Write the cart race regression test", originCwd: project("web-app"),
  createdAt: now - 12 * MIN, lastActivityAt: now - 6 * MIN, spawnedFrom: { sessionId: "local_checkout" },
  model: "claude-haiku-4-5", effort: "low",
}));
// The model and effort a session runs with, as the app's file keeps them.
writeFileSync(join(appDir, "local_login.json"), JSON.stringify({
  sessionId: "local_login", cliSessionId: loginFix, title: "Fix the login redirect loop", originCwd: project("web-app"),
  createdAt: now - 10 * MIN, lastActivityAt: now - 4 * MIN, model: "claude-opus-5-5", effort: "high",
}));
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
function runOf(sid: string, taskId: string, title: string, cwd: string, at: number, more: object = {}) {
  writeFileSync(join(appDir, `local_${++runFiles}.json`), JSON.stringify({
    cliSessionId: sid, scheduledTaskId: taskId, title, originCwd: cwd, createdAt: at, lastActivityAt: at + 5 * MIN, ...more,
  }));
}

// Its last run asks you something (the release notes card above).
task("release-notes", "Weekly release notes", "0 16 * * 5", project("docs"), { lastFor: prev("0 16 * * 5") });
runOf(releaseRun, "release-notes", "Release notes for 2.4", project("docs"), now - 15 * MIN,
  { model: "claude-opus-5-5", effort: "xhigh", sessionSettings: { ultracode: true } });
// Running right now (the workflow above).
task("data-audit", "Nightly data audit", "0 2 * * *", project("analytics"), { lastFor: prev("0 2 * * *") });
runOf(auditRun, "data-audit", "Nightly data audit", project("analytics"), now - 22 * MIN, { model: "claude-opus-5-5", effort: "high" });
// Ran fine, three times.
const builds = "30 10 * * 1-5";
let at = prev(builds);
task("build-summary", "Build health summary", builds, project("ci"), { lastFor: at });
for (let i = 0; i < 3; i++) {
  const sid = finished("Build health summary", project("ci"), at + 8 * MIN, "Eleven builds ran. Two failed; both are flagged.");
  runOf(sid, "build-summary", "Build health summary", project("ci"), at);
  at = prev(builds, at - MIN);
}
// Missed its latest run: the one before it is the last that happened.
const daily = "0 11 * * *";
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
  // A session in a terminal that asked another model for advice: only its model and the
  // advisor's chip on its card (O, a round letter). Rows with IDs and models only.
  s = id();
  const tpAdvised = join(dir, `${s}.jsonl`);
  rows(tpAdvised, [
    { type: "user", message: { content: "Sketch the pricing page FAQ" } }, advisorOn("claude-opus-5-5"),
    { type: "assistant", advisorModel: "claude-opus-5-5", message: { model: "claude-haiku-4-5", content: [{ type: "server_tool_use", id: "srvtoolu_demo_pf", name: "advisor", input: {} }] } },
    { type: "assistant", advisorModel: "claude-opus-5-5", message: { model: "claude-haiku-4-5", content: [{ type: "advisor_tool_result", tool_use_id: "srvtoolu_demo_pf", content: "" }],
      usage: { iterations: [{ type: "message" }, { type: "advisor_message", model: "claude-opus-5-5" }] } } },
    { type: "assistant", advisorModel: "claude-opus-5-5", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "The FAQ draft is ready." }] } },
  ]);
  ev(s, now - 80 * MIN, { ev: "UserPromptSubmit", prompt: "Sketch the pricing page FAQ", cwd: project("marketing-site"), tp: tpAdvised });
  closeTurn(s, project("marketing-site"), now - 78 * MIN, "Drafted eight questions with short answers in pricing/faq.md.");

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
  // Its plugin holds the ask: a very long command.
  permits.push({
    sid: s, cwd: project("scripts"), tool: "Bash",
    msg: "Claude needs your permission to use Bash: move 1,284 files older than 90 days from Downloads to an archive folder and delete the empty folders left behind",
    what: "find ~/Downloads -type f -mtime +90 -print0 | xargs -0 -I{} mv {} ~/Archive/downloads-before-2026/ && find ~/Downloads -mindepth 1 -type d -empty -delete && du -sh ~/Archive/downloads-before-2026",
  });
  // A long path to write, under a long folder name.
  s = id();
  ev(s, now - 11 * MIN, { ev: "UserPromptSubmit", prompt: "Add tests for the identity check step", cwd: project("customer-onboarding-experience-platform-monorepo") });
  waitsOn(s, project("customer-onboarding-experience-platform-monorepo"), now - 10 * MIN, "Write",
    `${project("customer-onboarding-experience-platform-monorepo")}/packages/onboarding-flows/src/steps/verify-identity/__tests__/verify-identity-document-upload.test.tsx`);
  // A permission with no plugin in its session: the card is as before, and a click opens it.
  s = id();
  ev(s, now - 13 * MIN, { ev: "UserPromptSubmit", prompt: "Tag the release candidate", cwd: project("cli") });
  ev(s, now - 12 * MIN, { ev: "PermissionRequest", tool: "Bash", cwd: project("cli") });

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

  // Answers as long as the hook keeps them (40 characters): the second gives way.
  asksWithAnswers("Migrate the billing exports to the new storage layout", "billing-exports-and-reports", now - 16 * MIN, undefined,
    "312 old exports have no date in their name. Should I rename them from their contents or leave them where they are?",
    [{ l: "Rename every file from what it contains" }, { l: "Leave them where they are for this round" }], true);

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
  task("migration-report", "Migration status report with a much longer name than usual", "30 16 * * *", project("infra"), { created: now - 8 * MIN - 1000 });
  taskFile.push({ id: "migration-cleanup", displayName: "Drop the old tables", fireAt: new Date(now + 26 * 60 * MIN).toISOString(),
    enabled: true, cwd: project("infra"), createdAt: now - 8 * MIN - 500 });
  taskFile.push({ id: "send-recap", displayName: "Send the launch recap", fireAt: new Date(now - 30 * 60 * MIN).toISOString(),
    enabled: false, cwd: project("docs"), createdAt: now - 3 * 24 * 60 * MIN, lastRunAt: new Date(now - 30 * 60 * MIN + MIN).toISOString() });
}

writeFileSync(join(appDir, "scheduled-tasks.json"), JSON.stringify({ scheduledTasks: taskFile, recordedSkips: skips }));

// The plan's usage, as the status line saves it: a week on pace (--hot: well
// past an even pace), and the last 5 hours.
const hot = process.argv.includes("--hot");
const limit = process.argv.includes("--limit"); // a week used up, 5 hours before it resets
const weekResets = Math.floor(now / 1000 + (limit ? 5 * 3600 : 3.25 * 86400));
const weekUsed = limit ? 100 : hot ? 74 : 50;
writeFileSync(join(dir, "usage.json"), JSON.stringify({
  at: now / 1000 - 4 * 60,
  week: { used_percentage: weekUsed, resets_at: weekResets },
  five_hour: { used_percentage: hot ? 61 : 22, resets_at: Math.floor(now / 1000 + 2.4 * 3600) },
}));
// The week so far, as the server keeps it from the status line's readings: a climb in
// working hours, flat at night, one line each time the share changes.
{
  const resets = weekResets * 1000, start = resets - 7 * 86400_000, end = now - 4 * 60_000, step = 15 * 60_000;
  const busy = (t: number) => { const h = new Date(t).getHours(); return h >= 9 && h < 21 ? 1 + 0.6 * Math.sin(t / 5e6) : 0; };
  let total = 0;
  for (let t = start; t < end; t += step) total += busy(t);
  const lines: string[] = [];
  let sum = 0, last = 0;
  for (let t = start; t < end; t += step) {
    sum += busy(t);
    const pct = Math.floor((weekUsed * sum) / total);
    if (pct !== last) lines.push(JSON.stringify({ at: t + step, pct, resets })), (last = pct);
  }
  writeFileSync(join(dir, "usage-history.jsonl"), lines.join("\n") + "\n");
}

// --gif: keep four sessions and their tasks, with the week's usage beside them, then wait for
// the cues, one line each on stdin. "play": the checkout fix stops on a permission. Then the
// release notes get their answer from the card (docs/demo-gif.swift clicks it), and its mod
// takes it at once and asks the same again a moment later (CSM_DEMO_TURN_MS). "resume": the
// checkout fix gets its permission and runs its tests again. Both start fresh, so the story
// ends as it began and the GIF loops without a seam.
if (GIF) {
  const keep = new Set([checkout, releaseRun, auditRun, onboarding]);
  const lines = readFileSync(log, "utf8").split("\n").filter((l) => l && keep.has(JSON.parse(l).sid));
  writeFileSync(log, lines.join("\n") + "\n");
  for (const f of readdirSync(appDir)) {
    if (f === "scheduled-tasks.json") continue;
    if (!keep.has(JSON.parse(readFileSync(join(appDir, f), "utf8")).cliSessionId)) rmSync(join(appDir, f));
  }
  writeFileSync(join(appDir, "scheduled-tasks.json"), JSON.stringify({ scheduledTasks: taskFile.filter((t) => t.id === "data-audit" || t.id === "release-notes") }));
  const fresh = Date.now();
  const rn = answering.get(releaseRun)!;
  closeTurn(releaseRun, rn.cwd, fresh, rn.recap, rn.ask, rn.acts);
  // As at the story's end: a permission just given, the tests running again.
  ev(checkout, fresh - 1500, { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash", cwd: project("web-app") });
  ev(checkout, fresh, { ev: "PreToolUse", tool: "Bash", d: "Run the checkout tests", cwd: project("web-app") });
  process.stdin.on("data", (b) => {
    for (const cue of String(b).split("\n")) {
      const at = Date.now();
      if (cue === "play") ev(checkout, at, { ev: "Notification", nt: "permission_prompt", msg: "Claude needs your permission to use Bash", cwd: project("web-app") });
      if (cue === "resume") ev(checkout, at, { ev: "PreToolUse", tool: "Bash", d: "Run the checkout tests", cwd: project("web-app") });
    }
  });
}

// --anatomy: keep three cards, each showing parts the others can't (answers take the foot's
// place, and so does a plan's bar): the release notes need you, with every chip and a pin; the
// checkout fix works through its plan; and a session of its own, done, that started a side
// session and set up a task, so its foot has a folder, the side session and the task.
if (ANATOMY) {
  const cwd = project("web-app");
  const plan = finished("Plan the checkout cleanup", cwd, now - 6 * MIN, "Split the cleanup into three steps. The first one runs tonight.");
  ev(plan, now - 7 * MIN, { ev: "PostToolUse", tool: "mcp__scheduled-tasks__create_scheduled_task", x: { task: "nightly-run" }, cwd });
  task("nightly-run", "Nightly run", "0 2 * * *", cwd, { created: now - 7 * MIN });
  const keep = new Set([releaseRun, checkout, plan]);
  const lines = readFileSync(log, "utf8").split("\n").filter((l) => l && keep.has(JSON.parse(l).sid));
  writeFileSync(log, lines.join("\n") + "\n");
  for (const f of readdirSync(appDir)) {
    if (f === "scheduled-tasks.json") continue;
    const j = JSON.parse(readFileSync(join(appDir, f), "utf8"));
    if (!keep.has(j.cliSessionId)) rmSync(join(appDir, f));
    // The release notes as a session of their own, not a task's run: their time stands alone.
    else if (j.cliSessionId === releaseRun) writeFileSync(join(appDir, f), JSON.stringify({ ...j, scheduledTaskId: undefined }));
  }
  writeFileSync(join(appDir, "local_plan.json"), JSON.stringify({
    sessionId: "local_plan", cliSessionId: plan, title: "Plan the checkout cleanup", originCwd: cwd,
    createdAt: now - 12 * MIN, lastActivityAt: now - 6 * MIN, model: "claude-haiku-4-5", effort: "low",
  }));
  // Its side session, archived: only the app's file says it came from this one.
  writeFileSync(join(appDir, "local_plan_side.json"), JSON.stringify({
    sessionId: "local_plan_side", cliSessionId: id(), title: "Draft the cleanup tickets", originCwd: cwd,
    createdAt: now - 10 * MIN, lastActivityAt: now - 8 * MIN, spawnedFrom: { sessionId: "local_plan" }, isArchived: true,
  }));
  writeFileSync(join(appDir, "scheduled-tasks.json"), JSON.stringify({ scheduledTasks: taskFile.filter((t) => t.id === "nightly-run") }));
}

// Made-up time working for the Most active filter: a spread from minutes to hours, on each
// session's last day, a few with none. Written before the server starts into sessions.db (its
// own schema, through src/db.ts) as rows the main view doesn't load (last_at 0): the server
// takes each one's count when it meets the session in the log, and counts only time after it.
{
  process.env.CSM_DIR = dir;
  process.env.CSM_APP_SESSIONS = join(dir, "app");
  process.env.CSM_PROJECTS = join(dir, "none");
  const m = await import("../src/db.ts");
  const { dayKey } = await import("../src/worked.ts");
  m.openDatabase();
  const lastAt = new Map<string, number>();
  for (const l of readFileSync(log, "utf8").split("\n")) if (l) { const e = JSON.parse(l); lastAt.set(e.sid, Math.max(lastAt.get(e.sid) ?? 0, e.t)); }
  const put = m.db.prepare("INSERT INTO sessions (sid, first_at, last_at, status, archived, worked) VALUES (?, 9e15, 0, 'idle', 0, ?)");
  const to = Date.now();
  for (const [sid, at] of lastAt) {
    let h = 2166136261;
    for (const c of sid) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    if (h % 6 === 0) continue;
    const x = (h % 1000) / 1000;
    const ms = (8 + Math.round(400 * x * x)) * MIN;
    put.run(sid, JSON.stringify({ to, d: { [dayKey(Math.min(at, to))]: ms } }));
  }
  m.db.close();
}

const server = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
  env: {
    ...process.env, CSM_PORT: String(PORT), CSM_DIR: dir,
    CSM_APP_SESSIONS: join(dir, "app"), CSM_PROJECTS: join(dir, "none"),
    CSM_PAGE_KEY_SHA256: process.env.CSM_PAGE_KEY_SHA256 || demoKeyHash(DEMO_PAGE_KEY),
  },
  stdout: "inherit",
  stderr: "inherit",
});
// The release notes are pinned (POST /api/pin, once the server knows them), so the
// screenshots and the animation show a pin.
void (async () => {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/pin/${releaseRun}`, { method: "POST", headers: { "x-csm": "1", "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) });
      if (r.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
})();
// The answers mod in the sessions that have it. An answer starts a turn a moment later; a few
// seconds after (CSM_DEMO_TURN_MS, 8 s by default) the session ends it and asks the same question again.
const TURN_MS = Number(process.env.CSM_DEMO_TURN_MS) || 8000;
const mods = (GIF || ANATOMY ? listening.filter((sid) => sid === releaseRun) : listening).map((sid) => {
  const a = answering.get(sid)!;
  return playMod({
    port: PORT, log, dir, sids: [sid], cwd: a.cwd, delay: 1500,
    onAnswer: () => setTimeout(() => closeTurn(sid, a.cwd, Date.now(), a.recap, a.ask || undefined, a.acts.length ? a.acts : undefined), TURN_MS),
  });
});
// The plugin's permission side, in the sessions that have it: it tells the server what the
// session asks and holds (each request up to 20 s, again on 204) until you click. Then the tool
// runs (or is refused) a moment later, and a few seconds after that the session asks again.
const PERMIT_MS = Number(process.env.CSM_DEMO_PERMIT_MS) || 1500;
const permitStop = new AbortController();
const playPermit = async (p: Permit) => {
  let k = 0;
  while (!permitStop.signal.aborted) {
    const ask = JSON.stringify({ id: `demo-${++k}`, tool: p.tool, what: p.what });
    let r: Response | null = null;
    let proven = false;
    try {
      do ({ res: r, proven } = await pluginFetch(`http://127.0.0.1:${PORT}/api/permission/${p.sid}`, dir, { method: "POST", body: ask, signal: permitStop.signal }));
      while (r.status === 204 && proven);
    } catch {
      if (!permitStop.signal.aborted) await Bun.sleep(500); // the server isn't up yet
      continue;
    }
    if (r.status !== 200 || !proven) { await Bun.sleep(1000); continue; } // settled some other way: ask again
    const { decision } = (await r.json()) as { decision: string };
    await Bun.sleep(PERMIT_MS);
    ev(p.sid, Date.now(), { ev: decision === "allow" ? "PostToolUse" : "PostToolUseFailure", tool: p.tool, cwd: p.cwd });
    await Bun.sleep(TURN_MS);
    if (!permitStop.signal.aborted) ev(p.sid, Date.now(), { ev: "Notification", nt: "permission_prompt", msg: p.msg, cwd: p.cwd });
  }
};
if (!GIF && !ANATOMY) for (const p of permits) void playPermit(p);
const stop = () => {
  permitStop.abort();
  for (const m of mods) m.stop();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`Demo data in ${dir}. Open http://127.0.0.1:${PORT}  (Ctrl-C to stop)`);
if (!process.env.CSM_PAGE_KEY_SHA256) console.log(`The page key (made up) is ${DEMO_PAGE_KEY}: the page answers only with window.__csmKey set to it.`);
await server.exited;
rmSync(dir, { recursive: true, force: true });
