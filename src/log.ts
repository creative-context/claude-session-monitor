// Reading the events the hook appends to events.jsonl: on startup, as it grows, and past a rotation.

import { closeSync, existsSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { DIR, LOG, MAX_LOG_BYTES, REPLAY_BYTES } from "./config.ts";
import { sessions } from "./state.ts";
import { hydrate, apply } from "./session.ts";

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
}

export function rotate() {
  const old = join(DIR, "events.1.jsonl");
  renameSync(LOG, old);
  // Pick up anything a hook appended between our last read and the rename.
  const size = statSync(old).size;
  consume(readRange(old, offset, size));
  offset = 0;
  partial = "";
}

export function replay() {
  if (!existsSync(LOG)) return;
  const size = statSync(LOG).size;
  const from = Math.max(0, size - REPLAY_BYTES);
  let text = readRange(LOG, from, size);
  if (from > 0) text = text.slice(text.indexOf("\n") + 1); // skip the cut first line
  consume(text);
  offset = size;
}
