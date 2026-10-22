# Changelog

## 0.2.0

- **Scheduled** (⌘3): one card per scheduled task of the Claude app, with its schedule in words, its next run, how its last run went and a dot for each of its last seven runs. A task says Missed when a run that should have happened didn't, and Paused when it's off. A schedule too unusual for words shows as its cron expression.
- Runs of a scheduled task are marked Scheduled in Last 7 Days and All Sessions.
- The app carries its own copy of the server, the page and the hook, so it runs from anywhere, and `sh app/build.sh --release` zips it for a release. It no longer holds the path of the folder it was built from.
- The app installs the hook itself after asking, from a copy in `~/.claude-session-monitor/hooks` that moving or updating the app never breaks. Settings shows whether Claude Code is connected and can install or remove the hook.
- The app says when Bun or `jq` is missing.
- `install-hooks.ts --hook <path>` registers a given copy of the hook.
- The fonts' license and the app's ship inside the app.

## 0.1.0

First release.

- **Last 7 Days** (⌘1): an Active zone with what needs you, what's working and anything touched in the last two hours, then the rest of today, yesterday and earlier.
- **All Sessions** (⌘2): every session, grouped by day and searchable. Sessions still going keep their color and update live.
- Needs you, Error, Working, Agents working, Done, Idle and Closed, read from the hook's events and the end of each transcript, including closing questions without a question mark and API errors with or without a `Stop` event. One count of what needs you for the window, the Dock badge and the menu bar.
- Subagents and workflows with their phase and tokens, and the step of a session's plan.
- A standard macOS window: menus, Settings, a right-click menu, keyboard navigation, VoiceOver labels, loading and offline states, an optional alert sound, and Reduce Motion respected.
- A hook on 12 events that writes one short line per event and always exits 0.
