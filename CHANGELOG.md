# Changelog

## 0.3.5

- A session that set itself a reminder (`/loop`, a cron job, a wakeup) shows when it picks up again, and stays in Active until then. The reminder goes when it fires, is deleted or the session closes.
- A session that set up a scheduled task shows the task's name. A click on it opens the task in Scheduled.
- Scheduled shows one-time tasks too, and moves them to Ran once after they run.
- The hook keeps a scheduled task's title, not its description, when a session creates or changes one.

## 0.3.4

- A turn that ends on an open offer for more ("if you want another change, let me know", "let me know how it looks") or a short "anything else?" no longer counts as needing you, in English or Spanish. An offer of one specific thing still does, and so does "I need to know…".

## 0.3.3

- All Sessions splits a long day into two columns in a wide window, as Last 7 Days does.

## 0.3.2

- The page's header row lines up with the window buttons and the toolbar to the pixel. It sat one device pixel lower.

## 0.3.1

- Fixed: a finished plan stayed on the card as "6/6 done" when the next request came in. A new request now drops a plan with every step done, and the bar only shows while a step is in progress.

## 0.3.0

- **Check for Updates…** in the app menu and the menu bar item. The app also looks on its own 10 seconds after it opens and once a day, and when a newer version is out it sends a notification (once per version), shows a notice in the window with Download and Later, and adds Update to the menu bar item. Settings › Updates turns the daily check off. It is the app's only network request, to GitHub's public releases API.
- Each count in the header shows what's behind it on hover or focus: the sessions that need you and what they ask, what each working session is doing, every agent with its session and tokens, and the last 7 days by state. The arrow keys move through the rows, and Escape closes it.
- A click on a count, or on one of its rows, jumps to those cards in Last 7 Days and rings them for a moment.
- Last 7 Days shows only Active as cards. Under it, the rest of the week comes as rows, and a day with more than six splits into two columns in a wide window.
- The counts in the header show a small chevron, so they read as controls. The plan bar says how many steps are done, such as "2/5 done".
- A workflow with no name reads "A workflow", not "Workflow Workflow".
- Fixed: a subagent's permission request kept the session on Needs you after the agent got its answer, because only the main agent's activity ended the wait. Now that agent moving on ends it too.
- A run of a scheduled task shows a calendar clock by its time instead of a Scheduled tag.
- The Working, Done and Error tags are a step darker, so their white text reaches 5.8:1. Idle and Closed titles are easier to read.
- In a short window (under 600 px tall) the cards are lower: one line of title and both lines of detail, so more of the week shows under them.
- Every day's list is as wide as the cards above it, so the edges line up.
- When the header runs out of room, the counts keep only their number, then drop the less important ones, and are never cut.
- The step in progress on the plan bar breathes while the session works.
- The page uses Apple's system fonts, SF Pro (titles in Semibold) and SF Mono, like the rest of the Mac, instead of Inter and Space Grotesk. It ships no font files now. The colors stay the Obsidian theme's.
- The window moves again when you drag its top row, as with any title bar, except over the counts. A double click there does what System Settings says (zoom by default).

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
