# Architecture

How Claude Session Monitor is built, how to work on it, and what it learned from other projects.

## Parts

1. **Hook** (`hooks/session-hook.sh`). Claude Code runs it on every event of every session, and it appends one short line to `events.jsonl`. No network, no output, and it always exits 0. Its neighbor `hooks/statusline.sh` is the status line that saves your usage.
2. **Server** (`server.ts` and `src/`, Bun). It reads that file, keeps a small state per session, saves it to `sessions.db` and streams it to the page, only when something changed. After a restart it goes on reading the log where it stopped. It makes the one list of what needs you that the window, the Dock and the menu bar show. `closing.ts` holds the rules that tell a closing message that asks you from one that only reports, and `cron.ts` reads the scheduled tasks' schedules, to say them in words and to work out the next run and a missed one. Inside the app it ships as one bundled `server.js`.
3. **Page** (`public/index.html`). The cards, the three views and their empty and offline states. Its look (tokens, shared components and icons) comes from the family's design system, [mac-app-design](https://github.com/creative-context/mac-app-design), vendored next to the page (`public/design-*`); it uses Apple's system fonts, so it ships no font files. In Last 7 Days, cards that move, leave or turn into rows are animated with the layout module of [anime.js](https://animejs.com), which ships inside the app (`public/anime-layout.js`), so it loads nothing from the network. Reduce Motion turns it off.
4. **Answers** (`src/answers.ts` and `plugin/`). The hook keeps the words of the answer buttons a session ends its turn with, and the card shows them. A click waits 5 s in the server's memory, so you can undo it, then goes to the session's plugin (`session-monitor`), a Claude Code mod that holds a request open to `/api/answer/:sid/next` and submits what it gets with `$.prompt.submit`, which starts a turn once the session is idle. The `claude://` links can open a session but not send it anything, so a mod inside the session is the one way to answer it. The server never saves an answer, takes only a label the session offered, and turns one no mod picks up within 20 s into a card that needs you again.
5. **App** (`app/main.swift`). A standard macOS window with a transparent title bar, the usual menus, Settings, a toolbar for the views, search and sound, a Dock icon and a menu bar item. In full screen the toolbar hides with the menu bar, as in Safari, so the page fills the screen; it comes down when the pointer reaches the top. It runs the server it carries, starts it again if it stops, and replaces one an older version left running. It takes its counts for the Dock and the menu bar from the page.

## Tests and tools

```bash
bun test                 # unit tests: the closing rules, the usage words, the log, the readers, the server's state
bun test/scenarios.ts    # end-to-end checks of the tricky cases, against a server with its own temp folder
bun test/lifecycle.ts    # starts, stops, restarts, a taken port, the app going away, the log rotating
bun test/page.ts         # the page in WebKit on the demo: the fades at a view's edges (Playwright from ../mac-app-design)
claude plugin test plugin          # the plugin against a stand-in for the server
bun test/demo.ts         # a server with made-up sessions and tasks on http://127.0.0.1:4748, for screenshots
bun test/demo.ts --edge  # the same, plus edge cases: long text, a usage limit, many agents
bun test/demo.ts --hot   # the same, with a week running hot (--limit: a week used up)
sh app/build.sh --release  # the universal app, zipped for a release
```

The pictures in the README and the guide are drawn by scripts, in a window that never shows on screen and with the page's clock in UTC: `docs/screenshot.swift` (the command is at its top) and `docs/demo-gif.swift`, which starts its own demo.

None of them reads your sessions or the Claude app's files. The app runs its own copy of the server, so rebuild it after changing `server.ts`, `src/`, `closing.ts`, `cron.ts` or `public/`.

Every push to `main` runs the tests on GitHub Actions. Publishing a release builds the universal app on macOS and attaches the zip to it.

## Lessons from other projects

| Lesson | From |
|---|---|
| The hook hands off the event and exits right away, and never exits with an error | [agents-observe](https://github.com/simple10/agents-observe), and bug #30 in [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) |
| The Claude process ID tells whether a session is alive. It's checked once to be Claude, in case the ID gets reused | [claude-glance](https://github.com/adrienlupo/claude-glance), [Vibe Notch](https://github.com/farouqaldori/claude-island) |
| Stopping a session sends no `Stop` event. It's caught from the interrupt marker in the transcript | Vibe Notch |
| A `PostToolUse` that arrives after `Stop` doesn't flip the session back to working | Vibe Notch #98 |
| Subagent events don't change the session's own status or trigger alerts | Vibe Notch #36 and #18 |
| Workflow agents never send `SubagentStart`, so agents are tracked by ID from their hooks and files, not with a counter | Found here |
| A run of a scheduled task is a normal session. Its file in the Claude app names its task (`scheduledTaskId`), and the task's schedule is a cron expression in local time | Found here |
| A side session's file in the Claude app names the session it was started from (`spawnedFrom.sessionId`), by the app's own ID, not Claude Code's | Found here |
| A comment line keeps a stream open, but the page can't see it. A ping event every 10 seconds lets the page notice a server that died without closing the connection | Found here |
| "Needs you" lasts until the next real activity | agents-observe |
| Only hook events that every Claude Code version in use knows are registered. Older versions lack `StopFailure` and `PermissionDenied` | agents-observe #7 |
| Memory stays flat: one small state per session, with a cap and a daily cleanup | Vibe Notch #112 |
| `claude://resume?session=…&cwd=…` opens a session in the app | [Raycast TokenTrack](https://github.com/raycast/extensions/tree/main/extensions/tokentrack), [agentsview](https://github.com/kenn-io/agentsview) |
