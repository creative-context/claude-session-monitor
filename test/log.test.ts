// Reading events.jsonl across restarts: the saved position, a replaced or rotated log, and
// rotation at startup. Everything happens in a temp folder. Run with `bun test test/log.test.ts`.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The folders before any module reads them, and never the real ones.
process.env.CSM_DIR ??= mkdtempSync(join(tmpdir(), "csm-unit-"));
process.env.CSM_APP_SESSIONS ??= join(process.env.CSM_DIR, "app");
process.env.CSM_PROJECTS ??= join(process.env.CSM_DIR, "projects");

let L: typeof import("../src/log.ts");
let sessions: typeof import("../src/state.ts").sessions;
let DIR = "", LOG = "";
beforeAll(async () => {
  const config = await import("../src/config.ts");
  if (!config.DIR.startsWith(tmpdir()) && !config.DIR.startsWith("/tmp") && !config.DIR.includes("/T/")) throw new Error(`not a temp folder: ${config.DIR}`);
  ({ DIR, LOG } = config);
  L = await import("../src/log.ts");
  ({ sessions } = await import("../src/state.ts"));
});

const line = (sid: string, ev = "UserPromptSubmit") => JSON.stringify({ t: Date.now(), ev, sid, prompt: `made-up ${sid}` }) + "\n";
const clean = () => {
  for (const f of ["events.jsonl", "events.1.jsonl", "events.pos.json", "server.log", "server.1.log"]) rmSync(join(DIR, f), { force: true });
  sessions.clear();
};
afterEach(clean);

describe("start", () => {
  test("with no saved position, it reads the log's tail as before", () => {
    clean();
    writeFileSync(LOG, line("a") + line("b"));
    L.replay();
    expect(L.lastStart).toBe("replayed");
    expect([...sessions.keys()].sort()).toEqual(["a", "b"]);
  });

  test("with a saved position, it reads only what came after", () => {
    clean();
    writeFileSync(LOG, line("a"));
    L.replay();
    L.savePosition();
    appendFileSync(LOG, line("b"));
    sessions.clear();
    L.replay(); // a restart
    expect(L.lastStart).toBe("resumed");
    expect([...sessions.keys()]).toEqual(["b"]);
  });

  test("a half-written line is read whole after the restart", () => {
    clean();
    const b = line("b");
    writeFileSync(LOG, line("a") + b.slice(0, 20));
    L.replay();
    L.savePosition();
    appendFileSync(LOG, b.slice(20));
    sessions.clear();
    L.replay();
    expect(L.lastStart).toBe("resumed");
    expect([...sessions.keys()]).toEqual(["b"]);
  });

  test("a log replaced by another file falls back to the tail", () => {
    clean();
    writeFileSync(LOG, line("a"));
    L.replay();
    L.savePosition();
    writeFileSync(join(DIR, "new.jsonl"), line("a") + line("c"));
    renameSync(join(DIR, "new.jsonl"), LOG); // a new inode
    sessions.clear();
    L.replay();
    expect(L.lastStart).toBe("replayed");
    expect([...sessions.keys()].sort()).toEqual(["a", "c"]);
  });

  test("the same file with other bytes before the position falls back too", () => {
    clean();
    writeFileSync(LOG, line("a"));
    L.replay();
    L.savePosition();
    const p = L.loadPosition()!;
    writeFileSync(join(DIR, "events.pos.json"), JSON.stringify({ ...p, tail: Buffer.from("something else").toString("base64") }));
    appendFileSync(LOG, line("b"));
    sessions.clear();
    L.replay();
    expect(L.lastStart).toBe("replayed");
  });

  test("a rotation after the save: the rest of the old file, then the new one", () => {
    clean();
    writeFileSync(LOG, line("a"));
    L.replay();
    L.savePosition();
    appendFileSync(LOG, line("b"));
    L.rotate(); // reads b on the way
    writeFileSync(LOG, line("c"));
    sessions.clear();
    L.replay();
    expect(L.lastStart).toBe("resumed");
    expect([...sessions.keys()].sort()).toEqual(["b", "c"]);
  });

  test("a log past 8 MB rotates at startup, after it's read", () => {
    clean();
    const big = line("x").repeat(Math.ceil((8.2 * 1024 * 1024) / line("x").length));
    writeFileSync(LOG, big + line("z"));
    L.replay();
    expect(sessions.has("z")).toBe(true);
    expect(existsSync(LOG)).toBe(false);
    expect(statSync(join(DIR, "events.1.jsonl")).size).toBeGreaterThan(8 * 1024 * 1024);
  });
});

describe("saving the position", () => {
  test("while running, the one saved is a few seconds old", () => {
    clean();
    writeFileSync(LOG, line("a"));
    L.replay();
    const t = Date.now();
    L.notePosition(t); // a's end, noted
    appendFileSync(LOG, line("b"));
    L.pump();
    L.notePosition(t + 1000);
    expect(L.loadPosition()).toBeUndefined(); // too recent to save
    L.notePosition(t + 5000);
    expect(L.loadPosition()!.offset).toBe(line("a").length);
  });

  test("an unchanged position isn't written again", () => {
    clean();
    writeFileSync(LOG, line("a"));
    L.replay();
    L.savePosition();
    const first = statSync(join(DIR, "events.pos.json")).mtimeMs;
    L.savePosition();
    expect(statSync(join(DIR, "events.pos.json")).mtimeMs).toBe(first);
  });
});

describe("server.log", () => {
  test("past 8 MB, its old part moves to server.1.log and it starts empty", () => {
    clean();
    writeFileSync(join(DIR, "server.log"), "x".repeat(8 * 1024 * 1024 + 10));
    L.rotateServerLog();
    expect(statSync(join(DIR, "server.log")).size).toBe(0);
    expect(statSync(join(DIR, "server.1.log")).size).toBe(8 * 1024 * 1024 + 10);
  });

  test("under 8 MB, it stays as it is", () => {
    clean();
    writeFileSync(join(DIR, "server.log"), "app: started\n");
    L.rotateServerLog();
    expect(readFileSync(join(DIR, "server.log"), "utf8")).toBe("app: started\n");
    expect(existsSync(join(DIR, "server.1.log"))).toBe(false);
  });
});
