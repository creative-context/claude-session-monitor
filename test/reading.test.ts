// What the server reads besides the log: the Claude app's session files (parsed again only when
// they change, written to the database only when they change, one file watched after a turn
// ends), the agent scan that skips quiet sessions, and the workflow name taken from the
// transcript alone. Everything happens in a temp folder. Run with `bun test test/reading.test.ts`.

import { beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The folders before any module reads them, and never the real ones.
process.env.CSM_DIR ??= mkdtempSync(join(tmpdir(), "csm-unit-"));
process.env.CSM_APP_SESSIONS ??= join(process.env.CSM_DIR, "app");
process.env.CSM_PROJECTS ??= join(process.env.CSM_DIR, "projects");

let D: typeof import("../src/desktop.ts");
let A: typeof import("../src/agents.ts");
let T: typeof import("../src/turns.ts");
let S: typeof import("../src/session.ts");
let state: typeof import("../src/state.ts");
let dbm: typeof import("../src/db.ts");
let APP = "", PROJECTS = "";
beforeAll(async () => {
  const config = await import("../src/config.ts");
  if (!config.DIR.startsWith(tmpdir())) throw new Error(`not a temp folder: ${config.DIR}`);
  APP = join(config.APP_SESSIONS, "acc", "org");
  PROJECTS = config.PROJECTS;
  mkdirSync(APP, { recursive: true });
  mkdirSync(PROJECTS, { recursive: true });
  D = await import("../src/desktop.ts");
  A = await import("../src/agents.ts");
  T = await import("../src/turns.ts");
  S = await import("../src/session.ts");
  state = await import("../src/state.ts");
  dbm = await import("../src/db.ts");
  dbm.openDatabase();
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const appFile = (n: number, extra: object = {}) =>
  writeFileSync(join(APP, `local_${n}.json`), JSON.stringify({ sessionId: `local_${n}`, cliSessionId: uuid(n), title: `Made-up ${n}`, ...extra }));
const changes = () => (dbm.db.query("SELECT total_changes() AS n").get() as any).n as number;
const newSession = (sid: string, over: Partial<import("../src/state.ts").Session> = {}) => {
  const now = Date.now();
  const s = { sid, status: "done" as const, since: now, first: now, last: now, lastMain: now, inFlight: 0,
    agents: new Map(), runs: new Map(), hydrated: true, ...over };
  state.sessions.set(sid, s);
  return s;
};

describe("app session files", () => {
  test("a file is parsed again only when it changes, and a gone one is dropped", () => {
    const old = Date.now() - 30 * 86_400_000; // older than a week: straight to the history
    appFile(1, { lastActivityAt: old, createdAt: old });
    appFile(2, { lastActivityAt: old, createdAt: old });
    D.readDesktopSessions();
    const after = D.parses;
    D.readDesktopSessions();
    expect(D.parses).toBe(after);
    appFile(2, { lastActivityAt: old, createdAt: old, title: "Made-up 2, renamed" });
    D.readDesktopSessions();
    expect(D.parses).toBe(after + 1);
    expect(state.appTitles.get(uuid(2))).toBe("Made-up 2, renamed");
    expect(state.localToCli.get("local_1")).toBe(uuid(1));
  });

  test("an older session is written to the database only when it changes", () => {
    const old = Date.now() - 40 * 86_400_000;
    appFile(3, { lastActivityAt: old, createdAt: old });
    D.readDesktopSessions();
    const c = changes();
    D.readDesktopSessions();
    D.readDesktopSessions();
    expect(changes()).toBe(c);
    appFile(3, { lastActivityAt: old, createdAt: old, isArchived: true });
    D.readDesktopSessions();
    expect(changes()).toBe(c + 1);
    const row = dbm.db.query("SELECT archived FROM sessions WHERE sid = ?").get(uuid(3)) as any;
    expect(row.archived).toBe(1);
  });

  test("after a turn ends, the session's own file is read again within a second or so", async () => {
    const sid = uuid(4);
    appFile(4, { lastActivityAt: Date.now() });
    D.readDesktopSessions();
    const s = newSession(sid, { classified: true, outcome: "asks", askText: "Tell me which one to keep." });
    D.readAppFileSoon(sid, 20, 2000);
    appFile(4, { lastActivityAt: Date.now(), lastAssistantUuid: "u9", lastTurnEdgeAt: Date.now(),
      postTurnSummary: { summarizes_uuid: "u9", status_category: "completed" } });
    await Bun.sleep(150);
    expect(s.appAsk).toEqual({ text: "", edge: expect.any(Number) });
    expect(s.outcome).toBe("done"); // the app read the turn as done
  });
});

describe("a guessed ask waits for the app's summary", () => {
  const transcript = (n: number) => {
    const tp = join(PROJECTS, `made-up-${n}.jsonl`);
    writeFileSync(tp, JSON.stringify({ type: "assistant", message: { role: "assistant",
      content: [{ type: "text", text: "Two drafts are ready. Tell me which one to keep." }] } }) + "\n");
    return tp;
  };

  test("a desktop session holds it, then asks once the wait is over", () => {
    appFile(5, { lastActivityAt: Date.now() });
    D.readDesktopSessions();
    const s = newSession(uuid(5), { since: Date.now() - 900, tp: transcript(5) });
    T.classifyTurn(s);
    expect(s.classified).toBeFalsy();
    s.since = Date.now() - 800 - D.APP_SUMMARY_WAIT_MS;
    T.classifyTurn(s);
    expect(s.classified).toBe(true);
    expect(s.outcome).toBe("asks");
  });

  test("with the summary in, it doesn't wait, and the summary decides", () => {
    appFile(6, { lastActivityAt: Date.now() });
    D.readDesktopSessions();
    const s = newSession(uuid(6), { since: Date.now() - 900, tp: transcript(6) });
    s.appAsk = { text: "", edge: Date.now() };
    T.classifyTurn(s);
    expect(s.classified).toBe(true);
    expect(s.outcome).toBe("done");
  });

  test("a terminal session asks right away", () => {
    const s = newSession("terminal-session", { since: Date.now() - 900, tp: transcript(7) });
    T.classifyTurn(s);
    expect(s.outcome).toBe("asks");
  });
});

describe("agent scan", () => {
  const assistant = (content: object[], stop = "end_turn") =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content, stop_reason: stop, usage: { input_tokens: 1 } } }) + "\n";
  const sessionWithAgents = (name: string) => {
    const tp = join(PROJECTS, `${name}.jsonl`);
    writeFileSync(tp, "");
    const sub = join(PROJECTS, name, "subagents");
    mkdirSync(sub, { recursive: true });
    return { s: newSession(name, { tp }), sub };
  };

  test("a session whose folders didn't change is skipped, until an agent is added", () => {
    const { s, sub } = sessionWithAgents("quiet");
    writeFileSync(join(sub, "agent-a1.jsonl"), assistant([{ type: "text", text: "done" }]));
    A.scanAllAgents();
    expect(s.agents.get("a1")?.finished).toBe(true);
    const w = A.walks;
    A.scanAllAgents();
    A.scanAllAgents();
    expect(A.walks).toBe(w);
    writeFileSync(join(sub, "agent-a2.jsonl"), assistant([{ type: "text", text: "done" }]));
    A.scanAllAgents();
    expect(A.walks).toBe(w + 1);
    expect(s.agents.has("a2")).toBe(true);
  });

  test("an agent that works again after it stopped is walked every pass", () => {
    const { s, sub } = sessionWithAgents("again");
    writeFileSync(join(sub, "agent-b1.jsonl"), assistant([{ type: "text", text: "done" }]));
    A.scanAllAgents();
    const t = Date.now();
    S.apply({ sid: "again", ev: "SubagentStop", agent: "b1", t } as any);
    S.apply({ sid: "again", ev: "PreToolUse", agent: "b1", tool: "Read", d: "notes.md", t: t + 1 } as any);
    expect(s.agents.get("b1")?.finished).toBe(false);
    // Its transcript grows; the folder's time doesn't change.
    appendFileSync(join(sub, "agent-b1.jsonl"), JSON.stringify({ type: "user", message: { content: "One more file" } }) + "\n" +
      assistant([{ type: "tool_use", name: "Read", input: { file_path: "notes.md" } }], "tool_use"));
    const w = A.walks;
    A.scanAllAgents();
    A.scanAllAgents();
    expect(A.walks).toBe(w + 2);
    expect(s.agents.get("b1")?.finished).toBe(false);
  });

  test("an agent's detail is one line of 160 characters at most", () => {
    const { s, sub } = sessionWithAgents("long");
    const command = "echo " + "x".repeat(400) + "\n  && echo done";
    writeFileSync(join(sub, "agent-c1.jsonl"), assistant([{ type: "tool_use", name: "Bash", input: { command } }], "tool_use"));
    A.scanAllAgents();
    const a = s.agents.get("c1")!;
    expect(a.tool).toBe("Bash");
    expect(a.detail!.length).toBe(160);
    expect(a.detail).not.toContain("\n");
  });

  test("an agent that ended its turn with its own command running works until the command's notice", () => {
    const { s, sub } = sessionWithAgents("bgwait");
    const side = (row: object) => JSON.stringify({ isSidechain: true, timestamp: new Date().toISOString(), ...row }) + "\n";
    const file = join(sub, "agent-d1.jsonl");
    writeFileSync(file,
      side({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 600", description: "Wait for the made-up suite" } }], stop_reason: "tool_use" } }) +
      side({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Command running in background with ID: bgd1. Output is being written to: /tmp/x" }] } }) +
      // A Read whose text quotes the same words starts nothing.
      side({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "notes.md" } }], stop_reason: "tool_use" } }) +
      side({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "Command running in background with ID: quoted1." }] } }) +
      side({ type: "assistant", message: { content: [{ type: "text", text: "Waiting." }], stop_reason: "end_turn" } }));
    S.apply({ sid: "bgwait", ev: "SubagentStop", agent: "d1", t: Date.now() } as any);
    A.scanAllAgents();
    const a = s.agents.get("d1")!;
    expect(a.finished).toBe(true);
    expect(a.commands?.map((c) => c.id)).toEqual(["bgd1"]);
    expect(A.activeAgents(s).map((x) => x.id)).toEqual(["d1"]);
    expect(a.detail).toBe("Wait for the made-up suite");
    const { shownStatus } = require("../src/snapshot.ts");
    expect(shownStatus(s, A.activeAgents(s))).toBe("working");
    // The command ends: Claude Code queues its notice in the agent's transcript.
    appendFileSync(file, side({ type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification> <task-id>bgd1</task-id> <status>completed</status>" } }));
    A.scanAllAgents();
    expect(A.activeAgents(s)).toEqual([]);
    expect(shownStatus(s, A.activeAgents(s))).toBe("done");
  });

  test("an agent's command can end in its session's queue instead of its own transcript", () => {
    const { s, sub } = sessionWithAgents("bgqueue");
    const side = (row: object) => JSON.stringify({ isSidechain: true, timestamp: new Date().toISOString(), ...row }) + "\n";
    writeFileSync(join(sub, "agent-e1.jsonl"),
      side({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 600", description: "Wait for the made-up suite" } }], stop_reason: "tool_use" } }) +
      side({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Command running in background with ID: bge1. Output is being written to: /tmp/x" }] } }) +
      side({ type: "assistant", message: { content: [{ type: "text", text: "Waiting." }], stop_reason: "end_turn" } }));
    S.apply({ sid: "bgqueue", ev: "SubagentStop", agent: "e1", t: Date.now() } as any);
    A.scanAllAgents();
    expect(A.activeAgents(s).map((x) => x.id)).toEqual(["e1"]);
    appendFileSync(s.tp!, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>bge1</task-id>\n<status>completed</status>\n</task-notification>" }) + "\n");
    A.scanAllAgents();
    expect(A.activeAgents(s)).toEqual([]);
  });
});

describe("background work in a transcript", () => {
  const at = new Date().toISOString();
  const call = (id: string, name: string, input: object) =>
    JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } }) + "\n";
  const result = (id: string, text: string, data?: object) =>
    JSON.stringify({ type: "user", timestamp: at, ...(data ? { toolUseResult: data } : {}), message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } }) + "\n";
  const queued = (body: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", content: `<task-notification>\n${body}\n</task-notification>` }) + "\n";
  const file = (name: string, text: string) => {
    const f = join(PROJECTS, name);
    writeFileSync(f, text);
    return f;
  };

  test("a command moved to the background after its timeout, said only in the text, counts", () => {
    const f = file("timeout.jsonl", call("t1", "Bash", { command: "make", description: "Build the made-up site" }) +
      result("t1", "Command did not complete within its 120s timeout and was moved to the background (ID: bto1). Output is being written to: /tmp/x"));
    expect(A.openCommands(f).map((c) => [c.id, c.detail])).toEqual([["bto1", "Build the made-up site"]]);
  });

  test("a Monitor counts until it ends or expires; its events don't end it", () => {
    const started = call("m1", "Monitor", { description: "Watch the made-up queue", command: "tail -f q.log" }) +
      result("m1", "Monitor started (task bmo1, expires in 15m unless the source ends first).", { taskId: "bmo1", timeoutMs: 900000, persistent: false });
    const event = queued("<task-id>bmo1</task-id>\n<summary>Monitor event: \"Watch the made-up queue\"</summary>\n<event>job 4 exit 0</event>");
    const f = file("monitor.jsonl", started + event);
    const [m] = A.openCommands(f);
    expect([m.id, m.monitor, m.until! - m.at]).toEqual(["bmo1", true, 900000]);
    expect(A.openCommands(file("monitor-done.jsonl", started + event + queued("<task-id>bmo1</task-id>\n<status>completed</status>")))).toEqual([]);
    expect(A.openCommands(file("monitor-gone.jsonl", started + queued("<task-id>bmo1</task-id>\n<event>[Monitor expired after 15m with no events delivered.]</event>")))).toEqual([]);
  });

  test("a session watching a Monitor after its turn shows working, until the watch expires", () => {
    const tp = file("watching.jsonl", call("m2", "Monitor", { description: "Watch the made-up deploy" }) +
      result("m2", "Monitor started (task bmo2, expires in 15m).", { taskId: "bmo2", timeoutMs: 900000 }));
    const s = newSession("watching", { tp });
    A.scanCommands(s);
    expect(A.activeCommands(s).map((c) => c.detail)).toEqual(["Watch the made-up deploy"]);
    s.commands![0].until = Date.now() - 1; // its 15 minutes are up
    expect(A.activeCommands(s)).toEqual([]);
  });
});

describe("usage readings", () => {
  test("within a week the share only goes up: a lower reading is an old one, and left out", async () => {
    const config = await import("../src/config.ts");
    const usage = await import("../src/usage.ts");
    const resets = Math.floor(Date.now() / 1000) + 3 * 86400;
    let n = 0;
    const write = (pct: number) => {
      const f = join(config.DIR, "usage.json");
      writeFileSync(f, JSON.stringify({ at: Date.now() / 1000 + n, week: { used_percentage: pct, resets_at: resets }, five_hour: null }));
      const t = Date.now() / 1000 + ++n; // a new mtime each time, as the server tells writes apart by it
      utimesSync(f, t, t);
      usage.readUsage();
      return usage.usageView(Date.now())?.week;
    };
    expect(write(20)?.pct).toBe(20);
    expect(write(8)?.pct).toBe(20); // a session that started again handed over an old number
    expect(write(25)?.pct).toBe(25);
    const kept = readFileSync(join(config.DIR, "usage-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).pct);
    expect(kept).toEqual([20, 25]);
    // Old lower lines already in the history stay out of the week's curve.
    appendFileSync(join(config.DIR, "usage-history.jsonl"), JSON.stringify({ at: Date.now() + 9e5, pct: 3, resets: resets * 1000 }) + "\n");
    usage.loadHistory();
    expect(usage.usageView(Date.now())?.week?.samples.map((x) => x[1])).toEqual([20, 25]);
  });
});

describe("workflow names", () => {
  const runTranscript = (name: string, input: object) => {
    const tp = join(PROJECTS, `${name}.jsonl`);
    writeFileSync(tp,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Workflow", input }] } }) + "\n" +
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Started run wf-123" }] } }) + "\n");
    return newSession(name, { tp });
  };

  test("from the script's file name, without opening the script", () => {
    const script = join(PROJECTS, "nightly-review.js");
    writeFileSync(script, "export const meta = { name: 'from-the-file', description: 'Read from disk' };");
    const s = runTranscript("wf-path", { scriptPath: script });
    expect(A.runName(s, "wf-123")).toMatchObject({ name: "nightly-review", description: undefined });
  });

  test("from a script passed inline, as the transcript has it", () => {
    const s = runTranscript("wf-inline", { script: "export const meta = { name: 'made-up-flow', description: 'Checks the drafts' };" });
    expect(A.runName(s, "wf-123")).toMatchObject({ name: "made-up-flow", description: "Checks the drafts" });
  });
});
