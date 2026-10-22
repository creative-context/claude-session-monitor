# Claude Session Monitor

A Mac app that shows every Claude Code session you have going: what each one is doing right now, which plan step it's on, which subagents and workflows it's running, and which ones are waiting on you. It works with the Claude desktop app and with `claude` in a terminal. Nothing leaves your Mac.

> This is an independent project. It isn't made, endorsed or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.

![Claude Session Monitor with demo data: an Active zone with two sessions that need you, one with an error, two working and one done, then earlier sessions of the day](docs/screenshot.png)

## What it shows

- **Last 7 Days.** On top, **Active**: what needs you, what's working, and anything touched in the last two hours, most urgent first. Then the rest of today, yesterday and earlier. After 7 days a session leaves this view on its own.
- **All Sessions.** Every session ever, grouped by day and searchable by title, first prompt, project or last recap. The ones still going keep their color and update as they change. On first run it fills in from the sessions the Claude app already has.
- **What needs you.** A session that's blocked on a permission or a question, one whose turn ended asking you something, or one that stopped on an error. Questions and errors count for a day. The same count shows in the window, on the Dock icon and in the menu bar, and an optional sound tells you when it goes up.
- **What's running.** The tool a session is using and on what, the step of its plan, and its subagents and workflows with their phase and tokens.

Click a card or a row to open that session in the Claude app. In the app, right-click to copy its title or show its project in Finder. Arrow keys move between cards.

## Requirements

- macOS 14 or later, on Apple silicon or Intel
- Claude Code: the Claude desktop app, the `claude` command, or both
- [Bun](https://bun.sh) to run the local server
- The Xcode command line tools to build the app: `xcode-select --install`
- `jq` for the hook. Recent macOS has it at `/usr/bin/jq`. If yours doesn't, `brew install jq`

## Install

```bash
git clone https://github.com/creative-context/claude-session-monitor.git
cd claude-session-monitor
bun install-hooks.ts
sh app/build.sh --install
```

`install-hooks.ts` adds the hook to `~/.claude/settings.json`. It saves a dated copy of the file first and touches only its own entries. `app/build.sh --install` builds the app, copies it to `~/Applications` and opens it.

Open at Login is off. Turn it on in Settings (⌘,) or from the app's menu bar item.

The app needs nothing else running: it starts the server and stops it when you quit. To use a browser instead, run `bun server.ts` and open http://127.0.0.1:4747.

## Uninstall

```bash
bun install-hooks.ts --uninstall
rm -rf ~/Applications/"Claude Session Monitor.app" ~/.claude-session-monitor
```

## Privacy

Everything stays on your Mac. The server listens on `127.0.0.1` only and answers only requests addressed to its own host name.

What it keeps, in `~/.claude-session-monitor`:

- `events.jsonl`: one line per Claude Code event. Each line has the session ID, its folder, the tool's name and a short detail (a file name, or a command or its description, up to 160 characters), the first 200 characters of each prompt, and the text of a session's last question or recap, up to 300 characters. The file rotates at 8 MB.
- `sessions.db`: one row per session with its title, folder, first prompt, status, last recap or question, and times.

It never stores whole conversations.

What it reads and never writes:

- The end of each session's transcript in `~/.claude/projects`, to tell how a turn ended and to find its subagents and workflows.
- The Claude desktop app's session files in `~/Library/Application Support/Claude`, for titles and the archived flag.

What it changes: the hook entries in `~/.claude/settings.json`, and nothing else.

## How it works

1. **Hook** (`hooks/session-hook.sh`). Claude Code runs it on every event of every session, and it appends one short line to `events.jsonl`. No network, no output, and it always exits 0, so it never slows down or breaks a session. It takes about 12 ms.
2. **Server** (`server.ts`, Bun). It reads that file, keeps a small state per session, saves it to `sessions.db`, and streams it to the page.
3. **Page** (`public/index.html`). The cards, the zones, History and the empty states. It uses the Obsidian theme tokens from [astryx-theme-obsidian](https://github.com/creative-context/astryx-theme-obsidian) and its fonts, Inter and Space Grotesk, served locally under the SIL Open Font License (see `licenses/`).
4. **App** (`app/main.swift`). A standard macOS window with a transparent title bar, the usual menus and a Settings window, a toolbar for the view switch, search and sound, a Dock icon and a menu bar item. It shows the page and runs the server. If the server stops answering, the toolbar and the page say so, and the app starts it again.

Titles, subagents and workflows come from files that Claude Code and the Claude app keep but don't document. If a future version changes them, the app keeps working with less detail.

## States

Most urgent first. The whole card takes its state's color, strongest for what needs you and for errors.

| State | Color | When |
|---|---|---|
| Needs you | Orange, strong | Blocked mid-turn: it asks for permission, asks a question, waits for a plan approval or needs input. Or its turn ended asking you something: the app's next-step question, a question in the last two sentences of its closing message, or a request without a question mark ("let me know which one"). Courtesy closings don't count |
| Error | Red, strong | An API error ended the turn, such as a server error or a usage limit. Caught with or without a `Stop` event |
| Working | Blue | Thinking or using a tool |
| Agents working | Light blue | Its own turn ended, but subagents or a workflow are still running |
| Done | Green in Active, plain after that | Finished its turn, or you stopped it |
| Idle | None | Open, with no turn yet |
| Closed | None | Its process is gone |

A card that starts needing you breathes for its first minute, then holds still.

How a turn ended is read from the end of its transcript about a second after `Stop`. Errors are the lines Claude Code marks with `isApiErrorMessage`.

## Develop

```bash
bun test/scenarios.ts    # end-to-end checks of the tricky cases, against a server with its own temp folder
bun test/demo.ts         # a server with made-up sessions on http://127.0.0.1:4748, for screenshots
bun test/demo.ts --edge  # the same, plus edge cases: long text, a usage limit, many agents
```

Neither one reads your sessions or the Claude app's files.

## Lessons from other projects

| Lesson | From |
|---|---|
| The hook hands off the event and exits right away, and never exits with an error | [agents-observe](https://github.com/simple10/agents-observe), and bug #30 in [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) |
| The Claude process ID tells whether a session is alive. It's checked once to be Claude, in case the ID gets reused | [claude-glance](https://github.com/adrienlupo/claude-glance), [Vibe Notch](https://github.com/farouqaldori/claude-island) |
| Stopping a session sends no `Stop` event. It's caught from the interrupt marker in the transcript | Vibe Notch |
| A `PostToolUse` that arrives after `Stop` doesn't flip the session back to working | Vibe Notch #98 |
| Subagent events don't change the session's own status or trigger alerts | Vibe Notch #36 and #18 |
| Workflow agents never send `SubagentStart`, so agents are tracked by ID from their hooks and files, not with a counter | Found here |
| A comment line keeps a stream open, but the page can't see it. A ping event every 10 seconds lets the page notice a server that died without closing the connection | Found here |
| "Needs you" lasts until the next real activity | agents-observe |
| Only hook events that every Claude Code version in use knows are registered. Older versions lack `StopFailure` and `PermissionDenied` | agents-observe #7 |
| Memory stays flat: one small state per session, with a cap and a daily cleanup | Vibe Notch #112 |
| `claude://resume?session=…&cwd=…` opens a session in the app | [Raycast TokenTrack](https://github.com/raycast/extensions/tree/main/extensions/tokentrack), [agentsview](https://github.com/kenn-io/agentsview) |

## License

MIT, see `LICENSE`. The fonts in `public/` are under the SIL Open Font License, see `licenses/`.
