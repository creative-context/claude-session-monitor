// Where the server reads and writes, and how long things count. Tests and the demo point
// the folders at temp ones.

import { homedir } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.CSM_PORT ?? 4747);
export const DIR = process.env.CSM_DIR ?? join(homedir(), ".claude-session-monitor");
export const LOG = join(DIR, "events.jsonl");
export const APP_SESSIONS = process.env.CSM_APP_SESSIONS ?? join(homedir(), "Library/Application Support/Claude/claude-code-sessions");
export const PROJECTS = process.env.CSM_PROJECTS ?? join(homedir(), ".claude", "projects");
export const MAX_LOG_BYTES = 8 * 1024 * 1024; // rotate past this
export const REPLAY_BYTES = 4 * 1024 * 1024; // read this much of the log on startup
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS; // sessions live in the main view this long, then only in History
export const FORGET_MS = WEEK_MS + DAY_MS; // and leave memory a day later (the database keeps them)
export const MAX_SESSIONS = 2000; // hard cap so memory stays flat
export const AGENT_QUIET_MS = 15 * 60 * 1000; // a subagent with no sign of life this long is not shown
export const COMMAND_MAX_MS = 2 * 60 * 60 * 1000; // a background command counts this long at most: past it, it's a server or lost
export const RUN_DIR_MS = 6 * 60 * 60 * 1000; // workflow folders older than this are not scanned
