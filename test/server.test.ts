// The server's parts that need no running server: what needs you and its words, when the
// usage probe may run, the sessions a write looks at, and the parent check. Run with
// `bun test test/server.test.ts`. Never touches ~/.claude-session-monitor: the folder is a
// temp one, set before anything reads it, and the database test checks that it is.
process.env.TZ = "UTC";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CSM_DIR ??= mkdtempSync(join(tmpdir(), "csm-unit-"));

import { describe, expect, test } from "bun:test";

const { attentionOf } = await import("../src/snapshot.ts");
const { blockedWords, whenWords } = await import("../src/tasks.ts");
const { probeDue, PROBE_EVERY } = await import("../src/usage.ts");
const state = await import("../src/state.ts");
const config = await import("../src/config.ts");
const dbm = await import("../src/db.ts");
const { parentGone, safe } = await import("../server.ts");

const NOW = Date.UTC(2026, 10, 12, 15, 0); // Thursday, November 12, 3:00 PM
const MIN = 60_000;
const words = (s: string) => s.replace(/[  ]/g, " ");
const session = (sid: string, status: any, more: object = {}) => ({ sid, title: `Session ${sid}`, status, needsYou: true, ...more });

describe("attention", () => {
  test("only what needs you, in the window's order: asking, then tasks that can't run, then errors", () => {
    const list = [
      session("w", "waiting", { wait: "Claude needs your permission to use Bash" }),
      session("a", "asks", { ask: "Should I publish it?" }),
      session("e", "error", { error: "API error: overloaded" }),
      session("old", "asks", { needsYou: false, ask: "From last week" }),
      session("busy", "working", { needsYou: false }),
    ];
    const tasks = [
      { id: "t-blocked", name: "Nightly", needsYou: true, blocked: { since: NOW - 30 * MIN, last: NOW - MIN, tries: 30, reason: "per_task_limit", queued: false, run: { sid: "r1", status: "asks" as const, at: NOW - 3 * 60 * MIN, last: NOW - 2 * 60 * MIN } } },
      { id: "t-queued", name: "Hourly", needsYou: false, blocked: { since: NOW - 5 * MIN, last: NOW - MIN, tries: 5, reason: "per_task_limit", queued: true, run: null } },
      { id: "t-fine", name: "Daily", needsYou: false, blocked: null },
    ];
    const a = attentionOf(list, tasks, NOW);
    expect(a.map((x) => [x.kind, x.id])).toEqual([["session", "w"], ["session", "a"], ["blocked", "t-blocked"], ["error", "e"]]);
    expect(a[0]).toEqual({ kind: "session", id: "w", title: "Session w", words: "Claude needs your permission to use Bash", sid: "w", error: false });
    expect(a[1].words).toBe("Should I publish it?");
    expect(a[3]).toMatchObject({ words: "API error: overloaded", error: true, sid: "e" });
    expect(a[2]).toMatchObject({ title: "Nightly", run: "r1", error: true });
    expect(a[2].sid).toBeUndefined();
    expect(words(a[2].words)).toBe("Didn't run today at 2:30 PM: the run from today at 12:00 PM is waiting for you");
  });

  test("words when the session didn't say", () => {
    const a = attentionOf([session("w", "waiting"), session("a", "asks"), session("e", "error")], [], NOW);
    expect(a.map((x) => x.words)).toEqual(["Waiting for your answer", "It asked you something", "The turn ended with an error"]);
  });

  test("long words are cut", () => {
    const a = attentionOf([session("a", "asks", { ask: "x".repeat(1000) })], [], NOW);
    expect(a[0].words.length).toBe(300);
  });

  test("a blocked task says why, for each reason", () => {
    const b = (more: object) => ({ since: NOW - 30 * MIN, last: NOW, tries: 3, reason: "per_task_limit", queued: false, run: null, ...more });
    expect(words(blockedWords(b({}), NOW))).toBe("Didn't run today at 2:30 PM: a run of it is still open");
    expect(words(blockedWords(b({ reason: "app_closed" }), NOW))).toContain("the Claude app skipped it (app closed)");
    expect(words(blockedWords(b({ reason: "" }), NOW))).toEndWith(": the Claude app skipped it");
    const stuck = b({ run: { sid: "r", status: "working", at: NOW - 26 * 60 * MIN, last: NOW - 25 * 60 * MIN } });
    expect(words(blockedWords(stuck, NOW))).toBe("Didn't run today at 2:30 PM: the run from yesterday at 1:00 PM has had no activity since yesterday at 2:00 PM");
    const open = b({ run: { sid: "r", status: "done", at: NOW - 3 * 24 * 60 * MIN, last: NOW } });
    expect(words(blockedWords(open, NOW))).toEndWith("the run from Mon at 3:00 PM is still open");
  });

  test("times far off name the date", () => {
    expect(words(whenWords(NOW - 20 * 24 * 60 * MIN, NOW))).toBe("Oct 23 at 3:00 PM");
    expect(words(whenWords(NOW + 24 * 60 * MIN, NOW))).toBe("tomorrow at 3:00 PM");
  });
});

describe("usage probe", () => {
  const last = NOW - PROBE_EVERY; // the last good reading, 10 minutes ago
  test("never read: it runs while the hook is in use", () => {
    expect(probeDue(NOW, NOW - MIN, null)).toBe(true);
  });
  test("only after something happened here since the last reading", () => {
    expect(probeDue(NOW, last - MIN, last)).toBe(false);
    expect(probeDue(NOW, last + MIN, last)).toBe(true);
  });
  test("not again soon after a reading, activity or not", () => {
    expect(probeDue(NOW, NOW - MIN, NOW - 3 * MIN)).toBe(false);
  });
  test("not when the hook has been silent for a week", () => {
    expect(probeDue(NOW, NOW - 8 * 24 * 60 * MIN, null)).toBe(false);
  });
});

describe("writes", () => {
  test("a bump marks its session, or all of them when it names none; a view change marks none", () => {
    state.clean();
    const v = state.version;
    state.bump("s1");
    state.bump({ sid: "s2" } as any);
    expect([...state.dirty].sort()).toEqual(["s1", "s2"]);
    expect(state.allDirty).toBe(false);
    state.bumpView();
    expect(state.dirty.size).toBe(2);
    state.bump();
    expect(state.allDirty).toBe(true);
    expect(state.version).toBe(v + 4);
    state.clean();
    expect(state.dirty.size + Number(state.allDirty)).toBe(0);
  });

  test("the listener hears every change, and whether there's something to write", () => {
    const heard: boolean[] = [];
    state.onBump((w) => heard.push(w));
    state.bump("x");
    state.bumpView();
    state.onBump(undefined);
    expect(heard).toEqual([true, false]);
    state.clean();
  });

  test("persist writes only marked sessions that changed", () => {
    // Only ever against the temp folder.
    expect(config.DIR).toBe(process.env.CSM_DIR!);
    expect(config.DIR.startsWith(tmpdir()) || config.DIR.includes("/csm-")).toBe(true);
    dbm.openDatabase();
    const mk = (sid: string, recap: string) => ({ sid, status: "done", since: NOW, first: NOW, last: NOW, lastMain: NOW, inFlight: 0, agents: new Map(), runs: new Map(), recap });
    state.sessions.clear();
    state.sessions.set("a", mk("a", "one") as any);
    state.sessions.set("b", mk("b", "one") as any);
    dbm.persist(true);
    const recap = (sid: string) => (dbm.db.query("SELECT recap FROM sessions WHERE sid = ?").get(sid) as any)?.recap;
    expect([recap("a"), recap("b")]).toEqual(["one", "one"]);
    // b changes but only a is marked: b waits for its own mark or the next sweep.
    state.sessions.get("a")!.recap = "two";
    state.sessions.get("b")!.recap = "two";
    state.clean();
    state.bump("a");
    dbm.persist();
    expect([recap("a"), recap("b")]).toEqual(["two", "one"]);
    dbm.persist(true);
    expect(recap("b")).toBe("two");
    // Nothing marked: nothing looked at.
    state.sessions.get("a")!.recap = "three";
    dbm.persist();
    expect(recap("a")).toBe("two");
    state.bump();
    dbm.persist();
    expect(recap("a")).toBe("three");
    state.sessions.clear();
    dbm.db.close();
  });
});

describe("staying up", () => {
  test("a part that throws is logged and the caller carries on", () => {
    const err = console.error;
    const logged: string[] = [];
    console.error = (m: string) => logged.push(m);
    let after = false;
    try {
      safe("boom", () => { throw new Error("a file went away"); })();
      safe("boom", () => { throw new Error("a file went away"); })(); // the same one, not written twice
      after = true;
    } finally {
      console.error = err;
    }
    expect(after).toBe(true);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("boom failed, still running: Error: a file went away");
  });

  test("the parent check: this process is alive, a finished one is gone, none set is never gone", () => {
    expect(parentGone(process.pid)).toBe(false);
    const p = Bun.spawnSync(["true"]);
    expect(parentGone(p.pid)).toBe(true);
    expect(parentGone(0)).toBe(false);
  });
});
