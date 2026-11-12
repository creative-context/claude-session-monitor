// End-to-end checks of how the server starts, stays up, stops and reads: a port that's
// taken, the app going away, a part that throws, restarts, logs replaced or past their
// limit, and the readers that run on their own timers. Each group starts its own servers
// on ports 4802–4807 with a temp folder of its own, all at once. Never touches
// ~/.claude-session-monitor.
//
//   bun test/lifecycle.ts

import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const SERVER = join(import.meta.dir, "..", "server.ts");
const MB = 1024 * 1024;
const temps: string[] = [];
const procs: Subprocess[] = [];

// A temp folder with room for the app's session files and transcripts.
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "csm-life-"));
  temps.push(dir);
  mkdirSync(join(dir, "app", "account", "org"), { recursive: true });
  mkdirSync(join(dir, "projects"));
  return dir;
}

// A server as the app starts it: everything it prints appended to server.log.
function serve(port: number, dir: string, env: Record<string, string> = {}) {
  const base = { ...process.env };
  delete base.CSM_PARENT_PID;
  delete base.CSM_VERSION;
  const fd = openSync(join(dir, "server.log"), "a");
  const p = Bun.spawn(["bun", SERVER], {
    env: { ...base, CSM_PORT: String(port), CSM_DIR: dir, CSM_APP_SESSIONS: join(dir, "app"), CSM_PROJECTS: join(dir, "projects"), ...env },
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  procs.push(p);
  return p;
}

// Polls until fn gives something truthy, or the deadline passes.
async function until<T>(fn: () => T | Promise<T>, ms: number, every = 50): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() >= end) return undefined;
    await Bun.sleep(every);
  }
}
const exitWithin = (p: Subprocess, ms: number) => Promise.race([p.exited, Bun.sleep(ms).then(() => undefined)]);

const state = async (port: number) => (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as Promise<any>;
const ready = (port: number) => until(() => state(port), 8000, 100);
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const line = (n: number, e: object) => JSON.stringify({ t: Date.now(), sid: id(n), cwd: "/tmp/demo", ...e }) + "\n";
const ev = (dir: string, n: number, e: object) => appendFileSync(join(dir, "events.jsonl"), line(n, e));
const find = (snap: any, n: number) => snap?.sessions?.find((s: any) => s.sid === id(n));
const serverLog = (dir: string) => readFileSync(join(dir, "server.log"), "utf8");
const said = (text: string, uuid?: string) => JSON.stringify({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });
const asked = (text: string) => JSON.stringify({ type: "user", message: { content: text } });

// Each group keeps its own results, printed in order at the end.
type Result = [string, boolean, unknown];
function group() {
  const results: Result[] = [];
  const check = (name: string, ok: boolean, got?: unknown) => {
    results.push([name, ok, got]);
  };
  return { results, check };
}

// ---------------------------------------------------------------- staying up (4802)

async function stayingUp() {
  const { results, check } = group();
  const dir = folder();
  // 3. A working session whose transcript path is a folder: reading it throws.
  const tp3 = join(dir, "s3.jsonl");
  mkdirSync(tp3);
  appendFileSync(join(dir, "events.jsonl"), line(3, { ev: "UserPromptSubmit", prompt: "Look at the folder", tp: tp3, t: Date.now() - 10_000 }));
  const p = serve(4802, dir);
  const snap = await ready(4802);
  check("4 without CSM_VERSION the server says it's dev, with its pid", snap?.server?.version === "dev" && snap?.server?.pid === p.pid, snap?.server);

  // 1. A second server on the same port exits 3, which tells the app to use the first one.
  const second = serve(4802, folder());
  const code = await exitWithin(second, 8000);
  check("1 a second server on a taken port exits with code 3", code === 3, code);

  // 7. An event the hook appends shows in /api/state within 300 ms (median of three).
  const took: number[] = [];
  for (const n of [71, 72, 73]) {
    const t0 = Date.now();
    ev(dir, n, { ev: "UserPromptSubmit", prompt: `Quick ${n}` });
    await until(async () => find(await state(4802), n), 2000, 10);
    took.push(Date.now() - t0);
  }
  const median = [...took].sort((a, b) => a - b)[1];
  check("7 an appended event shows within 300 ms", median <= 300, took);

  // 3. The quiet check throws on that session every pass, and the server carries on.
  const logged = await until(() => /checkQuietTurns failed, still running/.test(serverLog(dir)), 9000, 200);
  check("3 a part that throws is logged as failed, still running", Boolean(logged), serverLog(dir).slice(-400));
  const after = await state(4802).catch(() => null);
  check("3 and /api/state still answers", Boolean(after?.sessions) && Boolean(find(after, 3)), after?.sessions?.length);
  check("2 without CSM_PARENT_PID it keeps running", p.exitCode === null, p.exitCode);
  return results;
}

// ---------------------------------------------------------------- parent gone (4803)

async function parentGone() {
  const { results, check } = group();
  const dir = folder();
  const parent = Bun.spawn(["sleep", "60"]);
  procs.push(parent);
  const p = serve(4803, dir, { CSM_PARENT_PID: String(parent.pid) });
  await ready(4803);
  await Bun.sleep(3500); // past one 3 s pass with the parent alive
  check("2 with its parent alive the server keeps running", p.exitCode === null, p.exitCode);
  parent.kill();
  await parent.exited;
  const t0 = Date.now();
  const code = await exitWithin(p, 6000);
  const took = Date.now() - t0;
  check("2 once its parent is gone the server exits 0 within about 4 s", code === 0 && took <= 4500, { code, took });
  return results;
}

// ---------------------------------------------------------------- server field (4804)

async function serverField() {
  const { results, check } = group();
  const dir = folder();
  const p = serve(4804, dir, { CSM_VERSION: "9.9.9" });
  const snap = await ready(4804);
  check("4 state.server has the version and the pid", JSON.stringify(snap?.server) === JSON.stringify({ version: "9.9.9", pid: p.pid }), snap?.server);
  // The stream's first message carries it too.
  const res = await fetch("http://127.0.0.1:4804/api/stream");
  const reader = res.body!.getReader();
  let text = "";
  const end = Date.now() + 3000;
  while (!text.includes("\n\n") && Date.now() < end) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel().catch(() => {});
  let first: any = null;
  try {
    first = JSON.parse(text.slice(text.indexOf("data: ") + 6, text.indexOf("\n\n")));
  } catch {}
  check("4 the stream's first message has it too", first?.server?.version === "9.9.9" && first?.server?.pid === p.pid, first?.server);
  return results;
}

// ---------------------------------------------------------------- restarts (4805)

async function restarts() {
  const { results, check } = group();
  const dir = folder();
  // 8. Session A, then a stop, session B while it's off, and a start: both there, A as it was.
  ev(dir, 81, { ev: "UserPromptSubmit", prompt: "Resume check A" });
  ev(dir, 81, { ev: "Stop" });
  // 17. A workflow agent's permission request, from a live process named claude, so a restart
  // keeps the session waiting rather than counting it gone. On macOS a link to sleep runs
  // under the link's name (a copied sleep won't run there); Linux names a process after the
  // file it runs, so there it is a copy.
  const claude = join(dir, "claude");
  if (process.platform === "darwin") symlinkSync(Bun.which("sleep")!, claude);
  else copyFileSync(realpathSync(Bun.which("sleep")!), claude), chmodSync(claude, 0o755);
  const proc = Bun.spawn([claude, "60"]);
  procs.push(proc);
  ev(dir, 17, { ev: "UserPromptSubmit", prompt: "Run the audit", pid: proc.pid });
  ev(dir, 17, { ev: "Stop", pid: proc.pid });
  ev(dir, 17, { ev: "PreToolUse", agent: "w1", tool: "Bash", d: "Build two trees", pid: proc.pid });
  ev(dir, 17, { ev: "PermissionRequest", agent: "w1", tool: "Bash", d: "Build two trees", pid: proc.pid });
  let p = serve(4805, dir);
  const pick = (s: any) => s && JSON.stringify([s.status, s.title, s.first, s.last, s.since, s.needsYou]);
  const a1 = pick(await until(async () => {
    const s = find(await state(4805), 81);
    return s?.status === "done" ? s : undefined;
  }, 5000));
  await Bun.sleep(1200); // past the turn's look, so A is settled
  const before = await state(4805);
  const a2 = pick(find(before, 81));
  check("17 an agent's permission request makes its session wait on you", find(before, 17)?.status === "waiting" && find(before, 17)?.needsYou === true, find(before, 17));
  p.kill("SIGTERM");
  const code = await exitWithin(p, 5000);
  check("8 SIGTERM stops the server with code 0", code === 0, code);
  ev(dir, 82, { ev: "UserPromptSubmit", prompt: "Resume check B" });
  ev(dir, 82, { ev: "Stop" });
  p = serve(4805, dir);
  let snap = await ready(4805);
  snap = (await until(async () => {
    const s = await state(4805);
    return find(s, 82) ? s : undefined;
  }, 3000)) ?? snap;
  check("8 after a restart, the session from before and the one written while off are there", Boolean(find(snap, 81)) && Boolean(find(snap, 82)), snap?.sessions?.map((s: any) => s.sid));
  check("8 and the one from before is unchanged", Boolean(a1) && pick(find(snap, 81)) === a2, [a2, pick(find(snap, 81))]);
  // 17. The agent runs its tool after the restart: the log resumes past the request, so
  // only the saved wait knows which agent it was.
  check("17 after a restart it still waits on you", find(snap, 17)?.status === "waiting" && find(snap, 17)?.needsYou === true, find(snap, 17));
  ev(dir, 17, { ev: "PostToolUse", agent: "w1", tool: "Bash", d: "Build two trees", pid: proc.pid });
  const s17 = await until(async () => {
    const s = find(await state(4805), 17);
    return s && s.status !== "waiting" && s.needsYou === false ? s : undefined;
  }, 3000);
  check("17 once the agent runs its tool after the restart, it no longer waits on you", Boolean(s17), find(await state(4805), 17));

  // 9. The log replaced by another file while the server was off, holding session C.
  p.kill("SIGTERM");
  await exitWithin(p, 5000);
  const log = join(dir, "events.jsonl");
  writeFileSync(`${log}.new`, line(83, { ev: "UserPromptSubmit", prompt: "Resume check C" }));
  renameSync(`${log}.new`, log);
  p = serve(4805, dir);
  await ready(4805);
  snap = await until(async () => {
    const s = await state(4805);
    return find(s, 83) ? s : undefined;
  }, 3000);
  check("9 a log replaced while off is read from its tail", Boolean(find(snap, 83)) && Boolean(find(snap, 81)) && Boolean(find(snap, 82)), snap?.sessions?.map((s: any) => s.sid));
  return results;
}

// ---------------------------------------------------------------- logs past 8 MB (4806)

async function rotation() {
  const { results, check } = group();
  const dir = folder();
  // 10. events.jsonl past 8 MB with session D's line last. 11. server.log past 8 MB.
  const filler = ("x".repeat(1023) + "\n").repeat(Math.ceil(8.5 * 1024));
  writeFileSync(join(dir, "events.jsonl"), filler + line(10, { ev: "UserPromptSubmit", prompt: "After the rotation" }));
  writeFileSync(join(dir, "server.log"), filler);
  serve(4806, dir);
  const snap = await ready(4806);
  check("10 the last line of a log past 8 MB is read at startup", Boolean(find(snap, 10)), snap?.sessions?.map((s: any) => s.sid));
  const size = (f: string) => (existsSync(join(dir, f)) ? statSync(join(dir, f)).size : -1);
  check("10 it moved to events.1.jsonl, and events.jsonl is new or gone", size("events.1.jsonl") > 8 * MB && size("events.jsonl") < MB, [size("events.1.jsonl"), size("events.jsonl")]);
  const started = await until(() => serverLog(dir).includes("Claude Session Monitor server on"), 3000);
  const lines = serverLog(dir).trim().split("\n");
  check("11 server.log past 8 MB moved to server.1.log", size("server.1.log") > 8 * MB, size("server.1.log"));
  check("11 and server.log holds only the new start line", Boolean(started) && lines.length === 1 && lines[0].startsWith("Claude Session Monitor server on"), lines.slice(0, 3).map((l) => l.slice(0, 80)));
  return results;
}

// ---------------------------------------------------------------- readers (4807)

async function readers() {
  const { results, check } = group();
  const dir = folder();
  const app = join(dir, "app", "account", "org");
  const now = Date.now();
  const appFile = (n: number, extra: object = {}) => writeFileSync(join(app, `local_life${n}.json`), JSON.stringify({
    cliSessionId: id(n), title: `Draft pick ${n}`, originCwd: "/tmp/demo", createdAt: now - 60_000, lastActivityAt: Date.now(),
    lastAssistantUuid: `u-${n}`, ...extra,
  }));
  // 12–13. A closing request without a question mark: a guess the app's summary can overrule.
  // 12 and 13 are desktop sessions (12 gets the summary, 13 never does); 113 is a terminal one.
  for (const n of [12, 13, 113]) {
    const tp = join(dir, `t${n}.jsonl`);
    writeFileSync(tp, [asked("Draft two versions"), said("Two drafts are ready. Tell me which one to keep.", `u-${n}`)].join("\n") + "\n");
    ev(dir, n, { ev: "UserPromptSubmit", prompt: "Draft two versions", tp, t: now - 5000 });
    if (n !== 113) appFile(n);
  }

  // 14. A workflow whose script file isn't there: named after the file all the same.
  const tp14 = join(dir, "s14.jsonl");
  const run14 = "wf_life0014-abc";
  writeFileSync(tp14, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_wf14", name: "Workflow", input: { scriptPath: "/tmp/nowhere-14/night-sweep.js" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wf14", content: `Workflow started. Run ${run14}` }] } }),
  ].join("\n") + "\n");
  const runDir = join(dir, "s14", "subagents", "workflows", run14);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "agent-aaa14.jsonl"), JSON.stringify({ type: "assistant",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } }] } }) + "\n");
  ev(dir, 14, { ev: "UserPromptSubmit", prompt: "Run the sweep", tp: tp14 });
  ev(dir, 14, { ev: "Stop", tp: tp14 });

  // 15. An agent whose last call runs a long command over several lines.
  const tp15 = join(dir, "s15.jsonl");
  writeFileSync(tp15, "");
  const sub15 = join(dir, "s15", "subagents");
  mkdirSync(sub15, { recursive: true });
  writeFileSync(join(sub15, "agent-ccc15.meta.json"), JSON.stringify({ description: "Build it", requestShape: "background" }));
  const command = Array.from({ length: 8 }, (_, i) => `echo step ${i} && ${"run --flag ".repeat(4)}`).join("\n").padEnd(400, "x");
  writeFileSync(join(sub15, "agent-ccc15.jsonl"), JSON.stringify({ type: "assistant",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: { command } }] } }) + "\n");
  ev(dir, 15, { ev: "UserPromptSubmit", prompt: "Build in the background", tp: tp15 });
  ev(dir, 15, { ev: "Stop", tp: tp15 });

  // 16. A quiet session whose agents finished.
  const tp16 = join(dir, "s16.jsonl");
  writeFileSync(tp16, "");
  const sub16 = join(dir, "s16", "subagents");
  mkdirSync(sub16, { recursive: true });
  writeFileSync(join(sub16, "agent-ddd16.jsonl"), JSON.stringify({ type: "assistant",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "All checked." }] } }) + "\n");
  ev(dir, 16, { ev: "UserPromptSubmit", prompt: "Check the files", tp: tp16 });
  ev(dir, 16, { ev: "Stop", tp: tp16 });

  serve(4807, dir);
  let snap = await ready(4807);

  const s14 = find(snap, 14);
  check("14 a workflow whose script file is missing is named after the file", s14?.workflows?.[0]?.name === "night-sweep", s14?.workflows);
  const a15 = find(snap, 15)?.agents?.[0];
  check("15 a long command over several lines is one line of 160 characters at most",
    typeof a15?.detail === "string" && a15.detail.length > 0 && a15.detail.length <= 160 && !a15.detail.includes("\n"), a15?.detail);

  // 12–13. All three turns end now; 12's summary comes a second later.
  const stop = Date.now();
  for (const n of [12, 13, 113]) ev(dir, n, { ev: "Stop", tp: join(dir, `t${n}.jsonl`), t: stop });
  setTimeout(() => appFile(12, {
    lastTurnEdgeAt: Date.now(), postTurnSummary: { status_category: "completed", status_detail: "Two drafts", summarizes_uuid: "u-12" },
  }), 1000);
  const asksAt = new Map<number, number>();
  let s12: any;
  while (Date.now() - stop < 6800) {
    snap = await state(4807).catch(() => snap);
    for (const n of [12, 13, 113]) {
      const s = find(snap, n);
      if (!asksAt.has(n) && (s?.status === "asks" || s?.needsYou)) asksAt.set(n, Date.now() - stop);
    }
    s12 = find(snap, 12);
    await Bun.sleep(100);
  }
  check("12 the app's summary clears a guessed ask before it ever shows", !asksAt.has(12) && s12?.status === "done", { asks: asksAt.get(12), status: s12?.status });
  const d13 = asksAt.get(13);
  check("13 with no summary, a desktop session asks 4 to 6.5 s after its Stop", d13 != null && d13 >= 4000 && d13 <= 6500, d13);
  const t13 = asksAt.get(113);
  check("13 a terminal session with the same words asks at about 1 s", t13 != null && t13 <= 2000, t13);

  // 16. A new agent in the quiet session shows within one 3 s pass.
  check("16 the quiet session's finished agents don't show", find(snap, 16)?.status === "done" && find(snap, 16)?.agentCount === 0, find(snap, 16));
  writeFileSync(join(sub16, "agent-eee16.jsonl"), JSON.stringify({ type: "assistant",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] } }) + "\n");
  const t0 = Date.now();
  const seen = await until(async () => find(await state(4807), 16)?.agentCount === 1, 3600, 100);
  check("16 a new agent in a quiet session shows within one 3 s pass", Boolean(seen), Date.now() - t0);

  check("14 nothing failed along the way", !/failed, still running/.test(serverLog(dir)), serverLog(dir).slice(-400));
  return results;
}

// ---------------------------------------------------------------- run

let failed = 0;
const t0 = Date.now();
try {
  const groups = await Promise.all([stayingUp(), parentGone(), serverField(), restarts(), rotation(), readers()]);
  for (const [name, ok, got] of groups.flat()) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  → ${JSON.stringify(got)}`}`);
    if (!ok) failed++;
  }
} catch (e) {
  console.log(`FAIL  ${e}`);
  failed++;
} finally {
  for (const p of procs) if (p.exitCode === null) p.kill();
  await Promise.all(procs.map((p) => exitWithin(p, 3000)));
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : `\nAll passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
