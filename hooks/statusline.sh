#!/bin/sh
# Claude Session Monitor status line: Claude Code gives it the plan's usage limits after
# each reply. It saves only the two percentages and when they reset to
# ~/.claude-session-monitor/usage.json, and prints them as the status line.
#
# Like the hook: no network, and it always exits 0, even if jq fails.

DIR="${CSM_DIR:-$HOME/.claude-session-monitor}"
[ -d "$DIR" ] || mkdir -p -m 700 "$DIR" 2>/dev/null

for JQ in /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq; do
  [ -x "$JQ" ] && break
done
[ -x "$JQ" ] || exit 0

IN=$(cat)
TMP="$DIR/usage.json.$$"
# Written whole, then moved, so the server never reads half a file. Without
# rate_limits (an API key, or before the first reply) the last numbers stay.
if printf '%s' "$IN" | "$JQ" -c '.rate_limits | select(type == "object")
    | { at: now, week: (.seven_day // null | if . then {used_percentage, resets_at} else null end),
        five_hour: (.five_hour // null | if . then {used_percentage, resets_at} else null end) }' \
    > "$TMP" 2>/dev/null && [ -s "$TMP" ]; then
  mv -f "$TMP" "$DIR/usage.json"
else
  rm -f "$TMP"
fi

printf '%s' "$IN" | "$JQ" -r '.rate_limits // empty
  | [ (.seven_day.used_percentage // empty | "Week \(floor)%"), (.five_hour.used_percentage // empty | "5h \(floor)%") ]
  | join(" · ")' 2>/dev/null

exit 0
