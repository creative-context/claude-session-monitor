// Reading the events the hook appends to events.jsonl: on startup, as it grows, and past a rotation.
// Where reading stopped is saved in events.pos.json, so a start reads only what the hooks wrote
// while the server was off, however much that was, instead of a fixed tail of the log.

import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, LOG, MAX_LOG_BYTES, REPLAY_BYTES } from "./config.ts";
import { sessions } from "./state.ts";
import { hydrate, apply } from "./session.ts";

const OLD_LOG = join(DIR, "events.1.jsonl");
const POSITION = join(DIR, "events.pos.json");
const SERVER_LOG = join(DIR, "server.log");
const RESUME_MAX = 64 * 1024 * 1024; // past this much unread log, read only its tail as before
const SAVE_LAG_MS = 5000; // a saved position is one the database has caught up with (it saves every 2 s)

let offset = 0;
let partial = "";

export function readRange(file: string, from: number, to: number): string {
  if (to <= from) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function consume(text: string) {
  const lines = (partial + text).split("\n");
  partial = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    try {
      apply(JSON.parse(line));
    } catch {
      // A broken line never stops the rest.
    }
  }
}

export function pump() {
  if (!existsSync(LOG)) {
    offset = 0;
    partial = "";
    return;
  }
  const size = statSync(LOG).size;
  if (size < offset) {
    offset = 0; // the file was replaced
    partial = "";
  }
  if (size > offset) {
    consume(readRange(LOG, offset, size));
    offset = size;
    for (const s of sessions.values()) if (!s.hydrated && s.tp) hydrate(s);
  }
  if (offset > MAX_LOG_BYTES) rotate();
  notePosition(Date.now());
  if (Date.now() - serverLogChecked > 600_000) rotateServerLog();
}

export function rotate() {
  renameSync(LOG, OLD_LOG);
  // Pick up anything a hook appended between our last read and the rename.
  const size = statSync(OLD_LOG).size;
  consume(readRange(OLD_LOG, offset, size));
  offset = 0;
  partial = "";
  pending = undefined;
  noted = -1;
}

// ---------------------------------------------------------------- where reading stopped

// A position is a byte offset in one file, known by its inode and the bytes just before the
// offset, so a log that was replaced or rotated is never read from the wrong place.
export type Position = { ino: number; offset: number; tail: string };

function positionIn(file: string, at: number): Position | undefined {
  try {
    const tail = Buffer.from(readRange(file, Math.max(0, at - 64), at), "utf8").toString("base64");
    return { ino: statSync(file).ino, offset: at, tail };
  } catch {
    return undefined;
  }
}

// Whether a saved position still points into this file, at the same bytes.
function matches(file: string, p: Position): boolean {
  try {
    const st = statSync(file);
    if (st.ino !== p.ino || st.size < p.offset) return false;
    return positionIn(file, p.offset)?.tail === p.tail;
  } catch {
    return false;
  }
}

export function loadPosition(): Position | undefined {
  try {
    const p = JSON.parse(readFileSync(POSITION, "utf8"));
    return typeof p?.ino === "number" && typeof p?.offset === "number" && typeof p?.tail === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

let saved = "";
function writePosition(p: Position) {
  const text = JSON.stringify(p);
  if (text === saved) return;
  try {
    writeFileSync(`${POSITION}.tmp`, text);
    renameSync(`${POSITION}.tmp`, POSITION);
    saved = text;
  } catch {}
}

// Up to the last whole line read: a half-written line is read again next time.
const readUpTo = () => offset - Buffer.byteLength(partial);

// Saves where reading stopped. Call it right after the database is written (on quit), so the
// two agree; while running, notePosition() saves one a few seconds old instead.
export function savePosition() {
  if (!existsSync(LOG)) return;
  const p = positionIn(LOG, readUpTo());
  if (p) writePosition(p);
}

// The position from SAVE_LAG_MS ago, by then in the database too: after a crash, a start
// reads a few seconds of events twice (they apply the same way) rather than skip any.
let pending: { p: Position; at: number } | undefined;
let noted = -1;
export function notePosition(now: number) {
  if (pending && now - pending.at >= SAVE_LAG_MS) {
    writePosition(pending.p);
    pending = undefined;
  }
  const at = readUpTo();
  if (!pending && at !== noted) {
    const p = positionIn(LOG, at);
    if (p) pending = { p, at: now };
    noted = at;
  }
}

// How the last start read the log, for tests: from the saved position, or the tail as before.
export let lastStart: "resumed" | "replayed" | "empty" = "empty";

export function replay() {
  rotateServerLog();
  const pos = loadPosition();
  partial = "";
  offset = 0;
  if (!existsSync(LOG)) {
    // Rotated with nothing new since: only the old file may have lines we haven't read.
    if (pos && matches(OLD_LOG, pos)) consume(readRange(OLD_LOG, pos.offset, statSync(OLD_LOG).size) + "\n");
    partial = "";
    lastStart = "empty";
    return;
  }
  const size = statSync(LOG).size;
  let from: number | undefined;
  if (pos && matches(LOG, pos) && size - pos.offset <= RESUME_MAX) from = pos.offset;
  else if (pos && matches(OLD_LOG, pos)) {
    // The log rotated after the position was saved: the rest of the old file, then all of this one.
    const oldSize = statSync(OLD_LOG).size;
    if (oldSize - pos.offset + size <= RESUME_MAX) {
      consume(readRange(OLD_LOG, pos.offset, oldSize) + "\n");
      partial = "";
      from = 0;
    }
  }
  if (from !== undefined) {
    consume(readRange(LOG, from, size));
    lastStart = "resumed";
  } else {
    // No position, or one in a file that's gone: the last REPLAY_BYTES, as before.
    const start = Math.max(0, size - REPLAY_BYTES);
    let text = readRange(LOG, start, size);
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // skip the cut first line
    consume(text);
    lastStart = "replayed";
  }
  offset = size;
  // The hook only appends; with the server off, the log can pass its limit.
  if (offset > MAX_LOG_BYTES) rotate();
}

// server.log holds what the server prints and the app's own lines. Every writer appends
// (O_APPEND), so it can be cut in place: the old part goes to server.1.log.
let serverLogChecked = 0;
export function rotateServerLog() {
  serverLogChecked = Date.now();
  try {
    if (statSync(SERVER_LOG).size <= MAX_LOG_BYTES) return;
    copyFileSync(SERVER_LOG, join(DIR, "server.1.log"));
    truncateSync(SERVER_LOG, 0);
  } catch {}
}
