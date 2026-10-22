# Instructions for AI agents working on this repository

This is **Claude Session Monitor**: a Mac app that shows the user's Claude Code sessions as they run, what each one is doing, which ones need the user, and their scheduled tasks. Everything stays on the user's Mac.

## Layout

- `hooks/session-hook.sh` and `hooks/event.jq`: the hook Claude Code runs on every event. It appends one compact line to `~/.claude-session-monitor/events.jsonl`.
- `install-hooks.ts`: adds or removes the hook's entries in `~/.claude/settings.json`, after a dated backup.
- `server.ts`: the Bun server. Reads the events, the end of each transcript and the Claude app's session files and `scheduled-tasks.json`, keeps one small state per session, saves it to `sessions.db`, and streams it to the page.
- `cron.ts`: cron schedules in local time: next run, previous run, and the schedule in words.
- `public/index.html`: the whole page, styles and script, on the Obsidian theme's tokens. The fonts next to it are under the OFL (`licenses/`).
- `app/main.swift`: the native app. `app/build.sh` builds it universal and copies the server, the page and the hook into it.
- `test/scenarios.ts`: end-to-end checks against a server with its own temp folder. `test/demo.ts`: made-up sessions and tasks for screenshots.
- `.github/workflows/ci.yml`: the tests on Linux on every push to main and on pull requests. `release.yml`: builds the app on macOS when a release is published and attaches the zip.
- `docs/banner.html` → `docs/banner.png`: the README banner, drawn at 880×440 with made-up sessions and captured at 3× with headless Chrome (the command is at the top of the file). Edit the HTML, never the PNG.
- `docs/screenshot.png`: the app's window on the demo data (`bun test/demo.ts 4747`).

## Commands

```bash
bun test/scenarios.ts      # port 4749
bun test/demo.ts           # port 4748, or 4747 to show it in the app. --edge adds edge cases
sh app/build.sh --install  # build, copy to ~/Applications, reopen
sh app/build.sh --release  # build and zip for a release
```

## Rules

- **The hook never blocks or breaks a session.** No network, nothing on stdout, always exit 0, and only hook events that every Claude Code version in use knows.
- **Privacy is a contract.** Read and store only what the README's Privacy section lists, and update that section with any new read. Never read or store a scheduled task's text, its permissions or a whole conversation.
- **Tests and the demo never touch the user's data.** They point `CSM_DIR`, `CSM_APP_SESSIONS` and `CSM_PROJECTS` at temp folders.
- **The app runs its own copy of the server.** After changing `server.ts`, `cron.ts` or `public/`, rebuild the app to see it there.
- **One rule for "needs you",** computed in `server.ts` and shared by the window, the Dock badge and the menu bar.
- **Interface copy in American English.** Text reaches 4.5:1 on its surface, motion stays calm, and Reduce Motion keeps only color fades.
- **No product or personal names, and no other brands,** in code, comments, docs or demo content, beyond the credits in the README. Demo data is made up.

## Releasing

1. Bump `CFBundleShortVersionString` and `CFBundleVersion` in `app/Info.plist`, the version line, badge and zip name in `README.md`, and add a `## x.y.z` section to `CHANGELOG.md`.
2. Commit, push, and wait for CI to pass on `main`.
3. Publish the release on that commit, with its CHANGELOG section as the notes:
   `gh release create vx.y.z --target <commit> --title vx.y.z --notes-file <notes>`.
4. The Release workflow tests it again on macOS, checks that `Info.plist` matches the tag, builds the universal app and attaches `Claude-Session-Monitor-x.y.z.zip`. Check that the zip is on the release.
5. Never move or delete a published tag. A fix is a new patch version.
