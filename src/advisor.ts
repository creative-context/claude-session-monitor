// The model that advises a session (Claude Code's /advisor), while one is turned on. No hook
// event says so, only the transcript: turning it on writes an advisor_tool attachment row with
// its model (at a new session's start, or where /advisor ran), turning it off one that isn't
// "add", and a call to it (a server tool) proves it's on, with the model that answered. The
// latest of these rows in the file decides. Read from them: the model, nothing else. Never
// what the session asks or what the advisor answers, and every assistant row's advisorModel
// alone means nothing (it's there with the advisor off too).
//
// A transcript can be hundreds of MB and the row can be anywhere in it, so each session's is
// scanned once, from the end backwards in chunks, stopping at the first such row; then only
// what it adds is read. How far it got is kept in sessions.db with the model, so a restart
// reads only what was added since. The scans read 16 MB a pass, a pass every 100 ms while one is
// under way, sessions at work first.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type Session, sessions, bump, dirty } from "./state.ts";
import { safe } from "./server-kit.ts";

const CHUNK = 4 << 20; // one read, backwards or forwards (a longer line doubles it)
const BUDGET = 16 << 20; // read per pass, across sessions (one step may go past it): about 10 ms
const PAUSE_MS = 100; // between passes while a scan is under way, so the server keeps answering
const MODEL = /^claude-[a-z0-9.-]{1,60}$/;
const modelOk = (m: unknown): m is string => typeof m === "string" && MODEL.test(m);
const NL = 10;
// What such a row holds, as Claude Code writes it (compact JSON): a quote inside a string is
// escaped, so these match only the row's own keys and values.
const MARKS = ['"advisor_tool"', '"advisor_message"', '"name":"advisor"'].map((m) => Buffer.from(m));

type Scan = { end: number; hi: number; want: number }; // end: where reading forward resumes (-1 until known); hi: the lines below it are still to read
const scans = new Map<string, Scan>(); // backward scans under way
const seen = new Set<string>(); // sessions looked at since the server started
const behind = new Set<string>(); // read forward, not to the end yet
const wants = new Map<string, number>(); // forward: a line longer than a chunk
const files = new Map<string, string>(); // the transcript each session was read from

function read(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(to - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    return n === buf.length ? buf : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// What a row says: on with a model, off (model undefined), or nothing (null).
type Decision = { model?: string };
function decide(line: string): Decision | null {
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || row.isSidechain) return null; // a subagent's
  const a = row.attachment;
  if (row.type === "attachment" && a?.type === "advisor_tool") {
    if (a.available !== true || a.toolChange !== "add") return {}; // turned off
    return modelOk(a.model) ? { model: a.model } : null;
  }
  // A call: the configured model from its row, then the one that answered, from the usage.
  let model: string | undefined;
  const content = row.message?.content;
  if (row.type === "assistant" && Array.isArray(content)) {
    for (const b of content) if (b?.type === "server_tool_use" && b.name === "advisor" && modelOk(row.advisorModel)) model = row.advisorModel;
  }
  const its = row.message?.usage?.iterations;
  if (Array.isArray(its)) for (const it of its) if (it?.type === "advisor_message" && modelOk(it.model)) model = it.model;
  return model ? { model } : null;
}

// The latest row that decides, in buf[start, end) (whole lines).
function lastDecisive(buf: Buffer, start: number, end: number): Decision | null {
  const hits: number[] = [];
  for (const m of MARKS) {
    for (let i = buf.indexOf(m, start); i >= 0 && i + m.length <= end; i = buf.indexOf(m, i + m.length)) hits.push(i);
  }
  hits.sort((x, y) => y - x);
  let below = end; // lines from here up were parsed already
  for (const hit of hits) {
    if (hit >= below) continue;
    const ls = Math.max(start, buf.lastIndexOf(NL, hit) + 1);
    let le = buf.indexOf(NL, hit);
    if (le < 0 || le > end) le = end;
    const d = decide(buf.toString("utf8", ls, le));
    if (d) return d;
    below = ls;
  }
  return null;
}

function setAdvisor(s: Session, model: string | undefined) {
  if (model === s.advisor?.model) return;
  s.advisor = model ? { model } : undefined;
  bump(s);
}

// One read of the scan backwards: returns the bytes read and whether there's more to read.
function back(s: Session, sc: Scan): [number, boolean] {
  const lo = Math.max(0, sc.hi - sc.want);
  const buf = read(s.tp!, lo, sc.hi);
  if (sc.end < 0) {
    const last = buf.lastIndexOf(NL);
    if (last < 0 && lo > 0) {
      sc.want *= 2;
      return [buf.length, true];
    }
    sc.end = last < 0 ? 0 : lo + last + 1; // a row half written is read forward later
  }
  const top = Math.min(sc.end, sc.hi) - lo;
  let bottom = 0;
  if (lo > 0) {
    const first = buf.indexOf(NL);
    if (first < 0 || first + 1 >= top) {
      sc.want *= 2; // no whole line in it: read further back
      return [buf.length, true];
    }
    bottom = first + 1;
  }
  const d = lastDecisive(buf, bottom, top);
  if (d || lo === 0) {
    scans.delete(s.sid);
    s.advisorRead = sc.end;
    dirty.add(s.sid); // how far it got goes to sessions.db with the next write
    setAdvisor(s, d?.model); // no such row at all: no advisor
    return [buf.length, false];
  }
  sc.hi = lo + bottom;
  sc.want = CHUNK;
  return [buf.length, true];
}

// One read forward from where the last one stopped, up to its last full line.
function forward(s: Session, size: number): [number, boolean] {
  const from = s.advisorRead!;
  if (size <= from) return [0, false];
  const want = wants.get(s.sid) ?? CHUNK;
  const to = Math.min(size, from + want);
  const buf = read(s.tp!, from, to);
  const last = buf.lastIndexOf(NL);
  if (last < 0) {
    if (to >= size) return [buf.length, false]; // a row half written: read again next time
    wants.set(s.sid, want * 2);
    return [buf.length, true];
  }
  wants.delete(s.sid);
  s.advisorRead = from + last + 1;
  const d = lastDecisive(buf, 0, last + 1);
  if (d) setAdvisor(s, d.model);
  return [buf.length, to < size];
}

function step(s: Session): [number, boolean] {
  const was = files.get(s.sid);
  if (was !== s.tp) {
    if (was != null) { // another transcript: read it from scratch
      scans.delete(s.sid);
      wants.delete(s.sid);
      s.advisorRead = undefined;
    }
    files.set(s.sid, s.tp!);
  }
  let size: number;
  try {
    size = statSync(s.tp!).size;
  } catch {
    scans.delete(s.sid); // no transcript (yet, or anymore): the chip stays as it was
    return [0, false];
  }
  let sc = scans.get(s.sid);
  if (sc && size < (sc.end >= 0 ? sc.end : sc.hi)) sc = undefined; // written anew while scanned
  if (!sc) {
    if (s.advisorRead != null && size < s.advisorRead) s.advisorRead = undefined; // written anew
    if (s.advisorRead == null) {
      if (!size) return [0, false];
      sc = { end: -1, hi: size, want: CHUNK };
    }
  }
  if (sc) {
    scans.set(s.sid, sc);
    return back(s, sc);
  }
  return forward(s, size);
}

// Sessions at work first, then waiting, then the rest by last activity, as the page shows them.
const rank = (s: Session) => (s.archived ? 3 : s.status === "working" ? 0 : s.status === "waiting" ? 1 : 2);

let next: ReturnType<typeof setTimeout> | undefined;

// Each tick, and a pass every 100 ms while there's more to read: every session once (its whole
// transcript the first time), then every one not ended whose transcript grew, within the
// pass's budget.
export function scanAdvisors(budget = BUDGET) {
  for (const sid of scans.keys()) if (!sessions.has(sid)) scans.delete(sid);
  for (const sid of behind) if (!sessions.has(sid)) behind.delete(sid);
  for (const sid of files.keys()) if (!sessions.has(sid)) files.delete(sid);
  for (const sid of wants.keys()) if (!sessions.has(sid)) wants.delete(sid);
  // /advisor in a quiet session writes no hook event: every session not ended is looked at (one
  // stat when its transcript didn't grow).
  const due = [...sessions.values()].filter((s) => s.tp && (scans.has(s.sid) || behind.has(s.sid) || !seen.has(s.sid) || s.status !== "ended"));
  due.sort((a, b) => rank(a) - rank(b) || b.last - a.last);
  let left = budget;
  for (const s of due) {
    if (left <= 0) break;
    seen.add(s.sid);
    try {
      for (;;) {
        const [n, more] = step(s);
        left -= n;
        if (more) behind.add(s.sid);
        else behind.delete(s.sid);
        if (!more || left <= 0) break;
      }
    } catch {
      scans.delete(s.sid);
      behind.delete(s.sid);
    }
  }
  // More to read (a scan under way, or sessions the budget didn't reach): another pass in a
  // moment rather than on the next tick.
  if ((scans.size || behind.size || left <= 0) && !next) {
    next = setTimeout(safe("scanAdvisors", () => {
      next = undefined;
      scanAdvisors();
    }), PAUSE_MS);
  }
}
