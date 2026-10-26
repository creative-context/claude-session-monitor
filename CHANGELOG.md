# Changelog

## Unreleased

- Related sessions show it. A side session the Claude app started from another session gets a branch icon, and the session it came from gets one with how many it started. Point at either one and the other gets an outline, wherever it is on screen; click the icon to open it. Its tip and VoiceOver name the other session.

## 0.4.3

- When nothing needs you and nothing is working, Active stays and says "You're all caught up." instead of disappearing. Two tiny cards beside it show in a loop what the app does: both start working, one needs you and glides to the first place, then both finish and rest for a few seconds before the next round. With Reduce Motion they stay still, both done.

## 0.4.2

- In a short window, a card's plan bar sits at the foot of the card, in line with the other cards' folders.

## 0.4.1

- In a short window the cards are lower (130 px) and keep their folder close to the text; a card with a plan shows its bar in the folder's place.
- The header reads like a strip: each count's number in white and its words in gray, only what needs you in orange, the working count neutral, and Active as a small label.
- Folder names on cards are set in Medium mono, next to their folder icon.
- The window's background is darker, #030304 instead of the theme's #08090A.
- Card type follows the mockup: the state tag in Semibold, the time in Medium, the folder in Medium mono and the current step's name in Medium.

## 0.4.0

- Only what needs you moves now. Needs you has a small beating dot in place of its icon, and so does the "need you" count; Working and Done tags are soft, Working shows three calm dots, and the working count is still.
- Cards that need you or are working show how long, in minutes ("2m"); finished ones still say how long ago.
- The plan bar is thicker, drops its "2/5 done" count (the step line says it) and only the active step pulses.
- Folder names are set in SF Mono.
- The sound button in the toolbar shows its speaker in the accent color while the alert sound is on, so you can tell at a glance.
- Last 7 Days moves more smoothly, with anime.js's layout module, which ships inside the app. A card that leaves Active turns into its row in the day below, a card that goes away fades out, and the rows and sections around them slide into place. Reduce Motion turns it off.
- An open offer like "cuando quieras, dímelo" or "whenever you're ready, let me know" is a courtesy closing, not a request.
- When the Claude app reads a finished turn as done with nothing for you, a request without a question mark no longer counts as needing you. Questions still do.

## 0.3.8

- A turn the Claude app itself marks as needing you (the orange dot in its sidebar) now needs you here too, with the app's words for what to do, even when the closing message asks nothing.

## 0.3.7

- A scheduled task held up by a run that's busy and moving no longer shows as an error: it says Waiting, starts once that run ends, and doesn't count as needing you. If the run waits on you, has had no activity for 30 minutes, or is done and still open, it stays red and says which.

## 0.3.6

- A scheduled task the Claude app keeps skipping says Can't run, in red, with why: usually that its last run is still open, which lets no new one start. It used to say Missed. It shows in Active, counts as needing you, and a click opens the run that holds it up.

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
