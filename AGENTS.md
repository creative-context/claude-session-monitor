# Instructions for AI agents working on this repository

This is **Claude Session Monitor**: a Mac app that shows the user's Claude Code sessions as they run, what each one is doing, which ones need the user, and their scheduled tasks. Everything stays on the user's Mac.

## Layout

- `hooks/session-hook.sh` and `hooks/event.jq`: the hook Claude Code runs on every event. It appends one compact line to `~/.claude-session-monitor/events.jsonl`. `hooks/statusline.sh`: the status line that saves the plan's weekly and 5-hour usage to `usage.json`; the server runs Claude Code in a hidden terminal so it runs (`probeUsage`), every 10 minutes at most and only after a hook event since the last reading.
- `install-hooks.ts`: adds or removes the hook's entries in `~/.claude/settings.json`, after a dated backup.
- `app/ShellKit.swift`: the native shell's shared parts (the log, running and replacing the server, the page view), vendored from `mac-app-kit` with `src/server-kit.ts`; never edit it. `app/build.sh` compiles it with `main.swift`.
- `src/server-kit.ts` and `kit.json`: the server's life shared by the family's apps, vendored from `mac-app-kit` (`bun ../mac-app-kit/tools/vendor.ts .`); never edit it. It holds the host check, exit 3, stopping with the app, `safe()`, `/api/state` and the stream, the page's files and the 3 s tick.
- `server.ts`: the Bun server. Reads the events, the end of each transcript and the Claude app's session files and `scheduled-tasks.json`, keeps one small state per session, saves it to `sessions.db`, and streams it to the page. The file itself is the web server, the timers and startup (only when run, behind `import.meta.main`): changes go out on `bump()`, not on a poll, and one 3 s tick does what changes with the clock; each part is wrapped so a throw is logged and the rest goes on; its parts live in `src/`, one per job, and import without side effects:
  - `config.ts` folders and time limits; `state.ts` the types and the shared state (sessions, tasks, the version that bumps on each change, and the sessions changed since the last write: `bump(s)` names one, `bump()` marks all, `bumpView()` none).
  - `session.ts` the state machine (`apply`); `log.ts` reading, rotating and replaying `events.jsonl`; `turns.ts` process checks and how a turn ended.
  - `db.ts` `sessions.db` and History; `desktop.ts` the Claude app's session files; `agents.ts` subagents, workflows and background commands.
  - `tasks.ts` scheduled tasks and reminders; `usage.ts` plan usage and its probe; `snapshot.ts` what the page gets, with the "needs you" rule and the `attention` list built from it.
- `closing.ts`: the rules that read a turn's closing message (done, asks you, or passes on another session's question), with its cases in `test/closing.test.ts` (`bun test`).
- `cron.ts`: cron schedules in local time: next run, previous run, and the schedule in words.
- `public/index.html`: the page, its script and its own styles (layout, the usage meter and strip, menus). The tokens, the base and the shared components come from the family's design system, `mac-app-design`, vendored as `public/design-tokens.css`, `design-base.css`, `design-components.css`, `design-dataviz.css`, `design-icons.js` and `design.json`; never edit those. The Obsidian theme's colors in Apple's system fonts (SF Pro, SF Mono), with no font files.
- `public/anime-layout.js`: anime.js's layout module (`createLayout`), MIT, built from the npm package with `bun build` (its header says how). It animates Last 7 Days; the page works without it. Never load it from a CDN: the app makes one network request only.
- `plugin/` and `.claude-plugin/marketplace.json`: the optional usage plugin (`session-usage`), a Claude Code mod that writes `usage.json` each time Claude Code measures the plan's limits. Nothing on screen, no timer, no process, no network. Check it with `claude plugin validate plugin`.
- `app/main.swift`: the native app. `app/build.sh` builds it universal and puts the server, bundled into one `server.js` with `bun build`, the page, the hook and its installer into it.
- `test/scenarios.ts`: end-to-end checks against a server with its own temp folder. `test/demo.ts`: made-up sessions and tasks for screenshots.
- `.github/workflows/ci.yml`: the tests on Linux on every push to main and on pull requests. `release.yml`: builds the app on macOS when a release is published and attaches the zip.
- `docs/banner.html` → `docs/banner.png`: the README banner, drawn at 880×440 with made-up sessions and captured at 3× with headless Chrome on a Mac, for SF Pro (the command is at the top of the file). Edit the HTML, never the PNG.
- `docs/screenshot.png`: the page on the demo data running hot (`bun test/demo.ts --hot`), drawn in WebKit at 2× with the weekly usage card open, by `docs/screenshot.swift` (the command is at the top of the file).
- `docs/demo.gif`: the README's top animation, 880 px wide, recorded in WebKit by `docs/demo-gif.swift` (the command is at the top of the file), which runs `bun test/demo.ts --gif` in UTC and cues its story: a session turns Needs you and moves first, then another one finishes. Needs ffmpeg.

## Commands

```bash
bun test/scenarios.ts      # port 4749
bun test/demo.ts           # port 4748, or 4747 to show it in the app. --edge adds edge cases, --hot a week running hot
sh app/build.sh --install  # build, copy to ~/Applications, reopen
sh app/build.sh --release  # build and zip for a release
```

## Rules

- **The hook never blocks or breaks a session.** No network, nothing on stdout, always exit 0, and only hook events that every Claude Code version in use knows.
- **Privacy is a contract.** Read and store only what the README's Privacy section lists, and update that section with any new read. Never read or store a scheduled task's text, its permissions or a whole conversation.
- **One network request, and only one:** the app's update check in `app/main.swift`, to GitHub's releases API. The usage probe starts Claude Code itself, which connects as it always does; the app adds nothing to that and sends nothing of its own. It only ever opens this repository's release pages. To test it, serve a fake reply such as `{"tag_name": "v9.9.9", "html_url": "…/releases/tag/v9.9.9"}` and point the app at it with `defaults write com.creativecontext.ClaudeSessionMonitor updateFeedURL http://127.0.0.1:4760/latest` (delete the key afterwards).
- **Tests and the demo never touch the user's data.** They point `CSM_DIR`, `CSM_APP_SESSIONS` and `CSM_PROJECTS` at temp folders.
- **The app runs its own copy of the server.** After changing `server.ts`, `src/`, `closing.ts`, `cron.ts` or `public/`, rebuild the app to see it there.
- **One rule for "needs you",** computed in `src/snapshot.ts` and shared by the window, the Dock badge and the menu bar: sessions, History rows and tasks carry `needsYou`, and the state carries `attention`, the list with its words. The page and the app show them and never work them out.
- **The server ends with its app and survives its own errors.** It exits when `CSM_PARENT_PID` is gone and with code 3 when the port is taken; `/api/state` carries `server: { version, pid }`. Wrap new timers in `safe()`.
- **The look of shared pieces lives in the design system.** A token, a component or an icon changes in `mac-app-design` first, then it's vendored here with `bun ../mac-app-design/tools/vendor.ts public`, and `bun ../mac-app-design/tools/compare.ts` (Playwright, WebKit) shows what changed on screen against the page before. Session Monitor's look is the design system's reference: a change that isn't meant to change this page must compare with no differences. `bun test/scenarios.ts` checks the vendored files weren't edited.
- **Interface copy in American English.** Text reaches 4.5:1 on its surface, motion stays calm, and Reduce Motion keeps only color fades.
- **No product or personal names, and no other brands,** in code, comments, docs or demo content, beyond the credits in the README. Demo data is made up.

## Releasing

1. Bump `CFBundleShortVersionString` and `CFBundleVersion` in `app/Info.plist`, the version line, badge and zip name in `README.md`, and add a `## x.y.z` section to `CHANGELOG.md`.
2. Commit, push, and wait for CI to pass on `main`.
3. Publish the release on that commit, with its CHANGELOG section as the notes:
   `gh release create vx.y.z --target <commit> --title vx.y.z --notes-file <notes>`.
4. The Release workflow tests it again on macOS, checks that `Info.plist` matches the tag, builds the universal app and attaches `Claude-Session-Monitor-x.y.z.zip`. Check that the zip is on the release.
5. Never move or delete a published tag. A fix is a new patch version.
