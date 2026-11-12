# Changelog

## 0.5.1

- The README says that sessions already open load the usage plugin with `/reload-plugins`; until then their usage comes from the app's own check, up to 10 minutes late.
- Fix: the usage card's dashed line ends where the pace so far reaches 100%, when that comes before the reset. Before, it stopped at 100% on the reset, which read as "you'll end right at the limit" even when the pace got there days earlier. In the week's first day it's drawn fainter, as a few hours make a rough average.
- Fix: within a week the share only goes up. A lower number for the same week, from a session that starts again with the last one it saw, no longer takes the card or the week's curve back for a moment.
- Fix: a session whose agent ended its turn while a command of its own kept running in the background shows as working, with that agent and its command, until Claude Code says the command ended. It showed as Done while the agent waited.
- Fix: background commands Claude Code reports only in the result's text, in any of its three wordings ("running in background", "was moved to the background", "did not complete within its timeout and was moved to the background"), now count.
- A session watching with Monitor shows as working until the watch ends or expires; the events it reports along the way don't end it.
- An optional Claude Code plugin, `session-usage`, gives the app your weekly usage from every session, terminal or Claude app, the moment Claude Code measures it. It shows nothing and sends nothing, and with it the app no longer opens Claude Code in a hidden terminal to read the numbers. Install it with `/plugin install session-usage --marketplace creative-context/claude-session-monitor`.

## 0.5.0

- Fix: closings that only report no longer need you. "El servidor elige el puerto libre", "The logs tell me…", a question the message answers itself ("¿Por qué fallaba? Porque…") and "I couldn't approve it" read as done. A request counts when it speaks to you: at the start of a sentence ("Elige una", "Tell me which"), as "dime" or "avísame", or as a question you answer ("¿Lo subo a main?").
- Fix: a question one session passes on from another shows only in the session it's from, when that one already shows it. "Responde las preguntas de billing-api en su sesión (local_…)", "la sesión del borrador espera que escojas…" and the Claude app's note on such a turn no longer mark the passing session too. After a restart the server reads this again for every session still asking you.
- Fix: a session whose agent stopped and then got another message from it, after its own turn ended, shows the agent working again. It showed as Done while the agent worked.
- Fix: the usage card's numbers add up. Its pace row says "on the line" when you're within half a point instead of "0% over" while just under, "To last the week" says the most per day that lasts until the reset in the same unit as your pace ("14% a day"), and your pace a day waits for the week's first day, as the forecast does.
- In a session the Claude app knows, a request without a question mark waits up to 4 seconds for the app's own summary of the turn before it needs you, so a closing the app reads as done never sounds or badges first. Questions, the next-step box and terminal sessions don't wait.
- The window does nothing while it's hidden, and redraws only the cards that changed. The app takes its Dock badge and menu bar counts from the page instead of asking the server every 2 seconds.
- The server reads only what changed: the Claude app's session files when one changes, the database only for sessions that changed, and agents' folders only for sessions where something moved. Its log resumes where it stopped after a restart instead of reading the last 4 MB again, a session waiting on you keeps what it waits on across the restart, and both its logs move aside at 8 MB when it starts too.
- The app replaces a server an older version of it left running, and only its own: a server you run by hand is used as it is. It tells a taken port from a crash, restarts a crashed server after 2 seconds and then less often, and says in `server.log` which Bun it runs. Its window stays on its own local page: anything else is blocked, and this app's release pages open in your browser. It replaces its copy of the hook in one step, so a session never runs a half-written one.
- The hook starts faster on every event (no subprocess to find its folder), and its lines stay short: at most 20 plan steps, and folders and paths cut at 400 characters.
- The weekly usage keeps its last numbers when it reads `usage.json` while another program is still writing it, instead of going blank until the next change.
- The hook installer keeps its 5 newest backups of `settings.json`, not all of them, and leaves hook entries of a shape it doesn't know as they are.
- Privacy lists every read and everything kept, including what was missing: the model, process, transcript path, note, error and wait in `sessions.db`; the URLs, search queries, patterns, notification text and plan steps in `events.jsonl`; `server.log` and its `app:` lines; and the app's check of what holds its port. It no longer opens a workflow's script file to name the run.
- The server is split into modules under `src/`, ships inside the app as one `server.js`, and has unit tests besides the end-to-end ones. CI and the release build run them on a pinned Bun.
- Fix: a closing message that says something waits on your choice, without a question mark ("…sigue esperando que elijas versión", "solo falta tu respuesta", "still waiting for you to pick a slot"), now needs you. One that says nothing waits ("Nada espera tu respuesta") or only if it happens ("si algo espera tu respuesta") doesn't.
- Fix: the usage card and the column no longer disagree. The card's pace row uses the column's words ("On pace · 4% under", not "Behind pace" beside On pace), and on the day the week resets, its next reset reads "next Thu", not "Thu", which looked like today.
- Fix: at 100% the weekly usage says Limit reached instead of Almost at the limit, and its card says when the week resets and how long until then, in the red block where the forecast would be.
- Weekly usage says when you'd run out. Ahead of pace, once a day of the week has gone by (sooner near the limit), and if it comes before the reset, the column, the narrow window's strip and the header's small version say when, to the hour, at the week's average pace: "Out Wed 1 PM", in the pace's color, where the reset was.
- A card replaces the weekly usage's tooltip, on hover or keyboard focus of the column, the strip or the header's small version. It has the forecast in a solid orange or red block, "Runs out around Tonight 11 PM" and how long before the reset; the week as a curve against the blue diagonal of an even week, with today's band, a dot at now, the part ahead of the diagonal tinted and a dashed line on at the same pace; how far ahead or behind you are, your pace a day and what's left a day; the last 5 hours on plans that still have that limit; and when it resets and was updated. It opens after the pointer rests a moment, so passing over doesn't flash it, and settles in gently from the side of what it explains. In a narrow window it narrows to fit, and the curve with it. Escape closes it, and Reduce Motion keeps only its fade.
- The app keeps the week's readings for that curve in `usage-history.jsonl`: the time, the share used and the reset, one line each time the share changes, about a week of them.
- A session whose turn ended with a shell command still running in the background, which Claude Code wakes it up from when the command ends, stays in Active as In the background, in light blue, with the command's description and how long it has run. It used to show as Done. It counts until Claude Code says the command ended or it's stopped, for two hours at most.
- In full screen the toolbar no longer sits in a gray bar above the page: it hides with the menu bar, as in Safari, and comes down when the pointer reaches the top of the screen. The page fills the screen, and the views stay on Command-1 to 3 and in the View menu.
- Fix: the icon of what a session is doing sat 2 px above its text, and the plan step's icon was drawn a little high; both now center on the text, one screen pixel lower than its capitals' middle, as lowercase text reads.
- Fix: a closing message that ends on a list of what's left now needs you when one of its points asks you something ("1. **La segunda parte.** … ¿La arranco?") or waits for your OK ("…esperan tu visto bueno"), not only when the question is in its last two sentences. The card shows the point's bold lead with the question ("La segunda parte, el menú. ¿La arranco?"). A point that only adds an option ("Si prefieres el otro, lo cambio") still doesn't count.
- The blue line in the weekly usage stands out more from the fill: its dark contour is 2 screen pixels at 125% instead of 1. When the fill is all one color (on pace, plenty left, near the limit), it stays one piece under the line; when the part ahead of pace takes a color, the two parts meet with straight corners.
- Fix: the weekly usage's seven days sit evenly at any zoom. Their size, the gaps between them and the blue line are whole screen pixels, so at 125% every gap is 3 pixels instead of 2 or 3 depending on where it fell. The app tells the page how many screen pixels a page pixel is.
- The server stays up: a part that fails (a transcript that went away, a file of an unexpected shape) is written to `server.log` once, and the rest carries on. Before, one failure in a timer ended the server and the window went offline until the app started it again.
- The server ends with its app: it checks every 3 seconds that the app that started it is still there, so one left behind by a crash or a forced quit no longer holds the port. When the port is taken it exits with its own code, so the app can tell that from a crash. `/api/state` and the stream say which server answers: its version and process.
- One list of what needs you, made by the server with its words: the window's header, the Dock badge and the menu bar show the same items. A scheduled task that can't run says why in the menu bar ("Didn't run today at 2:30 PM: the run from today at 12:00 PM is waiting for you"), not always "its last run is still open". History rows say whether they need you, so the page no longer works it out itself.
- The server works only when something changes. A change goes to the window about 30 ms after the event (it waited up to 250 ms), a turn is read the moment it can be, and the database gets only the sessions that changed. With nothing happening it wakes once every 3 seconds instead of several times a second, and builds the state once per change for the stream and `/api/state` alike. The scheduled tasks' runs come from one query instead of one per task.
- The usage check runs only after something happened on this Mac since the last reading, still every 10 minutes at most. With no session at work it no longer opens Claude Code.

## 0.4.8

- Fix: a Claude app note that names a related session ("In the … session, choose…", or its whole title) no longer marks this session as needing you; the question belongs to that one. A note that only starts with the same words as a related session's title still asks you here.
- Fix: a Claude app note that only invites the next piece of work ("Send the next part…") is an open offer and no longer marks the session as needing you. A note that asks for something and mentions more or another ("Give the OK to push, or ask for more changes") still does.
- A session that passes on another session's question stops needing you once that session gets a message: you answered there. It counts only when the message says the question is that session's ("… te hace dos preguntas; contéstalas en esa sesión:", "can't start until you answer"); a question of its own, beside a link to another session, still asks you.
- A Claude app note that says to answer in another session by name ("Answer in the … session: …") leaves the question to that session, which already shows it. Names that point to no session in particular ("in the next session") don't count.

## 0.4.7

- Fix: a session whose closing message quotes a question it sent to someone else no longer shows as asking you.
- Fix: when the Claude app's note on a finished turn sends you to another session, the turn no longer shows as needing you in this one.
- Fix: in full screen and in Split View beside another app, the header shows below the toolbar instead of under it.
- The weekly usage column is always two cards tall, so its day blocks keep their size when Active has a single row of cards.
- A compact view for a narrow window, such as a laptop screen on its own: under 640 points, Active shows rows instead of cards, with the same tints, the question in up to two lines, the folder and relations on one line and the plan's bar; the weekly usage becomes one line above it with the days under their blocks; and the view switch keeps only its icons. Under 300 points the window becomes a strip for the side of the screen: how many sessions need you, the week in two lines, and each session's dot, title, time and question; the toolbar's buttons step aside, and the views stay on Command-1 to 3 and in the View menu. The window now goes down to 171 points wide at 100% zoom (more when zoomed in), from 640.

## 0.4.6

- Fix: the related-sessions spotlight no longer turns on by itself while you're in another window. WebKit replays the last pointer position when cards move, and a card also keeps focus after a click opens its session; now only a pointer that's really in the window, or keyboard navigation, lights it up.

## 0.4.5

- The weekly usage refreshes every 10 minutes instead of every 30.
- Fix: the related-sessions spotlight ends when the pointer leaves the window, even when the window isn't the active one.

## 0.4.4

- Weekly usage, at the right of Active: a narrow column with how much of your plan's weekly limit you've used, the week as seven day blocks filled up to it, a blue line for where an even week would be by now, and how you're doing against it (Plenty left, On pace, A little fast, Running hot, Almost at the limit) with the day it resets. Only the part ahead of the line takes a color; the fill turns red at 90%. Its tip adds the last 5 hours. In a narrow window and the other views, a small version sits in the header. A status line saves the numbers (the hook installer adds it when you have none), and every 30 minutes the app opens Claude Code in a hidden terminal for a few seconds to run it, sending nothing to Claude. Its folder needs to be allowed once; the README says how.
- The menu bar menu starts with what needs you: each session's title and why (its question, the permission it waits for, or its error), with a dot in its color. Pick one to open it in the Claude app. Up to eight show; the rest are a click away in the window.
- Related sessions show it. A side session the Claude app started from another session says on its card which one it came from ("From …"), and that session says how many side sessions it started. Point at either one and its family stays in focus while the rest steps back, wherever it is on screen; click the tag to open it. In a full footer the name shortens, and its tip and VoiceOver have it whole.
- Fix: a finished session no longer shows "Compacting context" for hours. The Claude app compacts idle sessions in the background after their turn ends, and the app took that for new work. Sessions already stuck that way go back to done once their transcript shows the turn ended.

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
