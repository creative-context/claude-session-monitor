// Adds (or removes, with --uninstall) the Claude Session Monitor hook in ~/.claude/settings.json.
//
//   bun install-hooks.ts               install, or refresh if already there
//   bun install-hooks.ts --hook <path> register that copy of the hook instead (the app
//                                      uses ~/.claude-session-monitor/hooks/session-hook.sh)
//   bun install-hooks.ts --uninstall   remove only this app's entries
//
// It saves a dated copy of settings.json first, touches nothing but its own
// entries, and writes the new file atomically so Claude never reads half a file.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SETTINGS = join(homedir(), ".claude", "settings.json");
const flag = process.argv.indexOf("--hook");
const HOOK = flag > 0 && process.argv[flag + 1] ? resolve(process.argv[flag + 1]) : resolve(import.meta.dir, "hooks", "session-hook.sh");
const MARK = "session-hook.sh";

// Only long-standing events, so older Claude Code versions still load them (the CLI
// can lag behind the desktop app). StopFailure and PermissionDenied are left out on
// purpose: an event an older version does not know can stop all hooks from loading.
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];
const OTHER_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Notification",
  "Stop", "SubagentStart", "SubagentStop", "PreCompact",
];

type Entry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

const uninstall = process.argv.includes("--uninstall");
const raw = existsSync(SETTINGS) ? readFileSync(SETTINGS, "utf8") : "{}";
const settings = JSON.parse(raw);

if (existsSync(SETTINGS)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(SETTINGS, `${SETTINGS}.csm-backup-${stamp}`);
}

const hooks: Record<string, Entry[]> =
  settings.hooks && !Array.isArray(settings.hooks) ? settings.hooks : {};

// Drop any earlier entry of ours, keep everything else as it was.
for (const event of Object.keys(hooks)) {
  hooks[event] = hooks[event]
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !h.command?.includes(MARK)) }))
    .filter((e) => e.hooks.length > 0);
  if (hooks[event].length === 0) delete hooks[event];
}

if (!uninstall) {
  // Claude Code runs the command through a shell, so a path with spaces is quoted.
  const command = { type: "command", command: /\s/.test(HOOK) ? `"${HOOK}"` : HOOK, timeout: 5 };
  for (const event of TOOL_EVENTS) (hooks[event] ??= []).push({ matcher: "*", hooks: [command] });
  for (const event of OTHER_EVENTS) (hooks[event] ??= []).push({ hooks: [command] });
}

if (Object.keys(hooks).length > 0) settings.hooks = hooks;
else delete settings.hooks;

const tmp = `${SETTINGS}.csm-tmp`;
writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
JSON.parse(readFileSync(tmp, "utf8")); // fails loudly before replacing if something is off
renameSync(tmp, SETTINGS);

const count = TOOL_EVENTS.length + OTHER_EVENTS.length;
console.log(uninstall ? "Claude Session Monitor hooks removed." : `Claude Session Monitor hook installed on ${count} events: ${HOOK}`);
