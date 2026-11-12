// Plan usage: the status line's readings, the week's history, and the probe that runs it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DIR, LOG, DAY_MS, WEEK_MS } from "./config.ts";
import { bump } from "./state.ts";

// The status line (hooks/statusline.sh) saves the plan's weekly and 5-hour usage after
// each reply: two percentages and when they reset, nothing else.
const USAGE = join(DIR, "usage.json");
export type UsageWindow = { pct: number; resets: number | null };
let usage: { at: number; week: UsageWindow | null; five: UsageWindow | null } | null = null;
let usageMtime = 0;
// Claude Code gives epoch seconds; milliseconds and ISO dates are taken too, in case.
export const toMs = (v: unknown): number | null =>
  typeof v === "number" && isFinite(v) ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) || null : null;

export function readUsage() {
  let m = 0;
  try {
    m = statSync(USAGE).mtimeMs;
  } catch {
    if (usage) { usage = null; usageMtime = 0; bump(); }
    return;
  }
  if (m === usageMtime) return;
  usageMtime = m;
  try {
    const j = JSON.parse(readFileSync(USAGE, "utf8"));
    const win = (w: any): UsageWindow | null =>
      w && typeof w.used_percentage === "number" && isFinite(w.used_percentage)
        ? { pct: Math.max(0, Math.min(100, w.used_percentage)), resets: toMs(w.resets_at) }
        : null;
    usage = { at: toMs(j.at) ?? m, week: win(j.week), five: win(j.five_hour) };
    remember(usage.at, usage.week);
  } catch {
    usage = null;
  }
  bump();
}

// The week's readings, so the page can draw how the week went: when, the share used and
// the reset, one line each time the share changes. Only those numbers; a little more than
// a week of them is kept.
const HISTORY = join(DIR, "usage-history.jsonl");
export type Reading = { at: number; pct: number; resets: number };
let readings: Reading[] = [];
export const sameWeek = (a: number, b: number) => Math.abs(a - b) < 60 * 60_000; // a reset time can drift by seconds
export function loadHistory() {
  let lines: string[];
  try {
    lines = readFileSync(HISTORY, "utf8").split("\n").filter(Boolean);
  } catch {
    return;
  }
  const keep = Date.now() - WEEK_MS - DAY_MS;
  readings = lines.flatMap((l) => {
    try {
      const r = JSON.parse(l);
      return [r.at, r.pct, r.resets].every((n) => typeof n === "number" && isFinite(n)) && r.at > keep ? [r as Reading] : [];
    } catch {
      return [];
    }
  });
  if (readings.length < lines.length) {
    try {
      writeFileSync(HISTORY, readings.map((r) => JSON.stringify(r) + "\n").join(""));
    } catch {}
  }
}
export function remember(at: number, w: UsageWindow | null) {
  if (!w?.resets) return;
  const last = readings.at(-1);
  if (last && (at <= last.at || (sameWeek(last.resets, w.resets) && last.pct === w.pct))) return;
  const r: Reading = { at, pct: w.pct, resets: w.resets };
  readings.push(r);
  try {
    appendFileSync(HISTORY, JSON.stringify(r) + "\n");
  } catch {}
}

// The Claude app doesn't run status lines, so every 10 minutes the server opens Claude
// Code in a hidden terminal for a few seconds: it runs our status line on start, which
// saves the usage, and nothing is sent to Claude. It runs in its own empty folder,
// without the user's settings, so no hook fires, nothing is saved and no card appears.
// The folder must be trusted once by hand (README); until then the probe just quits.
const PROBE_DIR = join(DIR, "probe");
export const PROBE_EVERY = 10 * 60_000;
const PROBE_SCRIPT = `set timeout 25
log_user 0
spawn -noecho env COLUMNS=100 LINES=30 [lindex $argv 1] --setting-sources project --strict-mcp-config --settings [lindex $argv 0]
set code 0
expect {
  -re "trust this folder" { set code 2 }
  -re "Week|5h " { sleep 1 }
  timeout { set code 1 }
}
send "\\003"
sleep 1
send "\\003"
expect eof
exit $code
`;
export const claudeCli = () =>
  [join(homedir(), ".local/bin/claude"), join(homedir(), ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p));
let probing = false;
let probeAfter = 0; // a wait after Claude Code asked to trust the folder
// status is the status line to run; server.ts finds it next to itself.
export function probeUsage(status: string) {
  // Only the real app: tests and the demo point CSM_DIR at a temp folder.
  if (process.env.CSM_DIR || probing || Date.now() < probeAfter) return;
  // Only while the hook is in use: without it the user never agreed to any of this.
  try {
    if (Date.now() - statSync(LOG).mtimeMs > WEEK_MS) return;
  } catch {
    return;
  }
  const cli = claudeCli();
  if (!cli || !existsSync("/usr/bin/expect") || !existsSync(status)) {
    console.log(`Usage check skipped: ${!cli ? "no claude command" : !existsSync(status) ? "no status line" : "no expect"}.`);
    return;
  }
  if (usage && Date.now() - usage.at < PROBE_EVERY - 2 * 60_000) return; // fresh from a terminal session
  try {
    mkdirSync(PROBE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(DIR, "probe.exp"), PROBE_SCRIPT);
  } catch {
    return;
  }
  probing = true;
  // Claude Code runs it through a shell, and the app's path has spaces.
  const settings = JSON.stringify({ statusLine: { type: "command", command: `'${status.replace(/'/g, "'\\''")}'` } });
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["/usr/bin/expect", join(DIR, "probe.exp"), settings, cli], { cwd: PROBE_DIR, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    probing = false;
    return;
  }
  const kill = setTimeout(() => p.kill(), 45_000);
  p.exited.then((code) => {
    clearTimeout(kill);
    probing = false;
    readUsage();
    if (code === 2) {
      probeAfter = Date.now() + 6 * 3600_000;
      console.log(`Usage check: Claude Code asks to trust ${PROBE_DIR} first (see the README). Trying again in 6 hours.`);
    }
    else if (code !== 0) console.log(`Usage check: no usage from Claude Code (exit ${code}).`);
  });
}

export function usageView(now: number) {
  if (!usage) return null;
  // Past its reset a window's number no longer holds, so it goes until the next reply.
  // One with no reset time goes after a week.
  const live = (w: UsageWindow | null) => (w && (w.resets == null ? now - usage!.at < WEEK_MS : w.resets > now) ? w : null);
  const live7 = live(usage.week);
  // This week's readings, oldest first, as [time, share]: the page draws the week's curve.
  const week = live7 && {
    ...live7,
    samples: live7.resets ? readings.filter((r) => sameWeek(r.resets, live7.resets!)).map((r) => [r.at, r.pct]) : [],
  };
  const five = live(usage.five);
  return week || five ? { at: usage.at, week, five } : null;
}
