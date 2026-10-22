#!/bin/sh
# Claude Session Monitor hook: writes one compact line per Claude Code event to ~/.claude-session-monitor/events.jsonl.
#
# It runs on every event of every session, so it must never slow down or break one:
# no network, nothing on stdout (SessionStart and UserPromptSubmit would add it to
# Claude's context), and it always exits 0, even if jq fails.
#
# $PPID is the Claude Code process that ran the hook. The server uses it to tell
# whether a session is still alive.

DIR="${CSM_DIR:-$HOME/.claude-session-monitor}"
[ -d "$DIR" ] || mkdir -p -m 700 "$DIR" 2>/dev/null

# jq ships with recent macOS at /usr/bin/jq; Homebrew puts it elsewhere.
for JQ in /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq; do
  [ -x "$JQ" ] && break
done
[ -x "$JQ" ] || exit 0

"$JQ" -c --argjson pid "${PPID:-0}" -f "$(dirname "$0")/event.jq" \
  >> "$DIR/events.jsonl" 2>/dev/null

exit 0
