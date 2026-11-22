# Guide

Everything Claude Session Monitor shows, and the optional pieces.

![The monitor with demo data: an Active zone of cards with sessions that need you, one of them with a mic for a spoken answer, a scheduled task that can't run, an error, one working and one whose agents are working, and at the right the week's usage running hot, with its card open: it runs out tomorrow, almost two days before the reset, and the week's curve climbs above the even-week diagonal](screenshot.png)

## What it does differently

- **What needs you comes first.** A session blocked on a permission or a question, one whose turn ended asking you something, and one that stopped on an error get the strongest colors and the top of the screen, and so does a scheduled task the Claude app can't start. The same count shows in the window, on the Dock icon and in the menu bar, whose menu lists them with why each one needs you; pick one to open it.
- **It reads how a turn ended.** A closing question, a request without a question mark ("let me know which one"), an API error, and a turn the Claude app itself marks as needing you each count as needing you. Courtesy closings don't: "anything else?", or an open offer like "if you want another change, let me know".
- **It sees the work behind a session.** The tool it's using and on what, the step of its plan, and its subagents and workflows with their phase and tokens.
- **Scheduled tasks too.** When each task runs next, how its last run went, and which runs never happened. A session that set itself a reminder or set up a task says so on its card.
- **A real Mac app.** A standard window with the usual menus, Settings, a right-click menu, keyboard navigation and VoiceOver labels. Calm motion, with Reduce Motion respected.
- **It never slows Claude down.** The hook writes one short line and exits, never with an error, so it can't block or break a session.

## Install in detail

**Requirements:** macOS 14 or later on Apple silicon or Intel, Claude Code signed in with a Claude plan that includes it (Pro, Max, Team or Enterprise), [Bun](https://bun.sh) and `jq`. macOS 15 and later ship `jq`. On macOS 14, `brew install jq`.

**Status:** 0.x. It reads files Claude Code and the Claude app keep but don't document, so a future version of either can take some detail away.

1. If you don't have Claude Code yet, install it in Terminal with its installer, or with Homebrew:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   ```bash
   brew install --cask claude-code
   ```

   Then run `claude` once and sign in with your Claude account in the browser it opens. [Claude Code's setup page](https://code.claude.com/docs/en/setup) has the other ways to install it. The app finds `claude` where these installers put it (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`), even when you open the app from Finder, and starts it only to read your [weekly usage](#weekly-usage).
2. Download the zip from the [latest release](https://github.com/creative-context/claude-session-monitor/releases/latest), unzip it and move the app to Applications.
3. Open it. The app isn't notarized, so the first time macOS says it can't check it. Open **System Settings › Privacy & Security** and click **Open Anyway**. Or run:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Claude Session Monitor.app"
   ```
4. The app asks to connect Claude Code. **Install Hook** adds the hook to `~/.claude/settings.json`, and a status line for your weekly usage if you have none. It saves a copy of the file first and changes nothing else. You can install or remove it later in Settings (⌘,).

Sessions show up as soon as they do something. Open at Login is off until you turn it on in Settings.

The app tells you when a newer version is out, with a notification and a notice in the window, and **Check for Updates…** in its menu looks right away. To update, download the new version and put it in Applications in place of the old one.

## Uninstall in detail

Remove the hook in Settings (or run `bun install-hooks.ts --uninstall` from a clone), then:

```bash
rm -rf "/Applications/Claude Session Monitor.app" ~/.claude-session-monitor
```

If you added [the plugin](#the-plugin), remove it too:

```bash
claude plugin uninstall session-monitor@claude-session-monitor
```

## The views

- **Last 7 Days** (⌘1). **Active** comes as cards: what needs you, what's working, anything touched in the last two hours (pick 4, 8, 12 or 24 in its header) and anything set to pick up again on its own, most urgent first. Under it, the rest of today, yesterday and earlier come as rows, and a long day splits into two columns in a wide window. After 7 days a session leaves this view on its own. While the pointer is on a card or a row, nothing changes place, so what you're about to click stays put; once it leaves, the list glides into its new order.
- **All Sessions** (⌘2). Every session ever, grouped by day and searchable by title, first prompt, project or last recap. The ones still going keep their color and update as they change. A long day splits into two columns in a wide window, as in Last 7 Days. On first run it fills in from the sessions the Claude app already has.
- **Scheduled** (⌘3). The tasks you scheduled in the Claude app: when each one runs, when it runs next, how its last run went and a dot for each of its last seven runs. A task that should have run and didn't says Missed. One the Claude app tried to start and couldn't says Can't run, in red, with why, usually that its last run is still open. It shows in Active too and counts as needing you, and a click opens the run that holds it up. A one-time task moves to Ran once after it runs. Its runs show up in the other views too, with a calendar clock by their time.

A session that set itself a reminder, with `/loop`, a cron job or a wakeup, shows when it picks up again by an alarm clock, until its time comes or the session closes. One that set up a scheduled task shows the task's name; click it to see the task in Scheduled.

A side session, one the Claude app started from another session, says which one it came from on its card, and that session says how many side sessions it started. Point at either one and its family stays in focus while everything else steps back, wherever they are on screen, and click the tag to open it. In a full footer the name shortens; the whole name is in the tag's tip and in what VoiceOver reads. Only the Claude app records this, so sessions you start with `claude` in a terminal never show it.

## Weekly usage

 At the right of Active, a narrow column, which stays in sight while you scroll through Active's cards, shows how much of your plan's weekly limit you've used: the figure, then the week as seven blocks from the reset, bottom up, filled up to what you've used, with a blue line for now, where an even week would be. Under it, how that compares: Plenty left, On pace, A little fast, Running hot, Almost at the limit or, at 100%, Limit reached, and the day it resets. On plans with a 5-hour limit, a last line shows how much of the current 5 hours you've used. The column spans Active's first two rows of cards, from their top edge to the second row's bottom edge, and the week's blocks take the room in between. Only the part ahead of the blue line takes a color, orange when you run hot, and the whole fill turns red at 90%. Ahead of pace, once a day of the week has gone by (sooner near the limit), the reset gives way to when you'd run out at the week's average pace, to the hour, if that comes before the reset: "Out Wed 1 PM". Pointing at the column, or reaching it with the keyboard, opens a card with that forecast in a solid block, the week as a curve against the blue diagonal of an even week (today has its band and a dot at now, and a dashed line goes on at the same pace to where it ends, with a dotted line down to the day it reaches 100% when that comes before the reset), how much you have left beyond an even pace (Extra left) or how far past it you are (Over pace), your pace a day once the first day has gone by, the most a day that lasts until the reset, the last 5 hours on plans that have that limit, and when it resets. The curve comes from the readings the app keeps through the week. In a narrow window and in the other views, a small version sits in the header instead. Claude Code only hands these numbers to a status line, and the Claude app doesn't run one, so the hook installer adds a small status line to `~/.claude/settings.json` (only when you have none), and, when the numbers are more than a few minutes old and you've used Claude Code since, at most every 10 minutes the app opens Claude Code in a hidden terminal for a few seconds, in its own empty folder and without your settings, so it runs that status line. Nothing is sent to Claude and no session is saved. Allow that folder once, from a terminal:

```bash
mkdir -p ~/.claude-session-monitor/probe && cd ~/.claude-session-monitor/probe && claude --setting-sources project --strict-mcp-config
```

Choose **Yes, I trust this folder**, then quit with Ctrl-C. Until then, the meter updates only when you use `claude` in a terminal. With the [plugin](#the-plugin), none of this is needed: every session hands the app its numbers, and the hidden check doesn't run while they're fresh.

**Card size.** Cards are the same size in every window, with titles at 13.5 points on one line, so a tall window shows more of them instead of bigger ones.

**Compact view.** In a window narrower than 640 points, as on a laptop screen on its own, Active turns into rows: a dot in the state's color, the title and time, the question or what the session is doing, its folder and relations on one line, and the plan's bar, on the same tinted backgrounds as the cards. The weekly usage becomes one line above it, and the view switch keeps only its icons. Under 300 points it becomes a strip for the side of the screen: how many sessions need you, the week in two lines, and each session's dot, title, time and question. The window goes down to 171 points wide at 100% zoom, and proportionally more when the page is zoomed in.

Hover a count in the header (needs you, working, agents, last 7 days) to see what's behind it, and click the count or one of its rows to jump to those cards. Click a card or a row of All Sessions to open that session in the Claude app, or a task's last run. Right-click to copy its title or show its project or task file in Finder. Arrow keys move between cards, and an optional sound tells you when something new needs you.

## States

Most urgent first. The whole card takes its state's color, strongest for what needs you and for errors.

Beside its time, a card shows the session's model and effort, with UC in an outlined tag when ultracode is on, as the Claude app sets them. The effort is its initial in a small solid square: L for Low, M for Medium, H for High, X for Extra, and MAX written whole. A session in a terminal shows only its model. A narrow card drops the model, then the effort, and the time's tip and VoiceOver always say all of it in words. The compact view keeps them to that tip.

| State | Color | When |
|---|---|---|
| Needs you | Orange, strong | Blocked mid-turn: it asks for permission, asks a question, waits for a plan approval or needs input. Or its turn ended asking you something: the app's next-step question, a question in the last two sentences of its closing message or at the end of a point in the list it ends on, a request without a question mark, or the Claude app's own summary of the turn saying you need to do something, unless the session closed with its next-step box and asked nothing in it. Questions count for a day |
| Error | Red, strong | An API error ended the turn, such as a server error or a usage limit. Caught with or without a `Stop` event. Errors count for a day |
| Working | Blue | Thinking or using a tool |
| Agents working | Light blue | Its own turn ended, but subagents or a workflow are still running |
| In the background | Light blue | Its own turn ended, but a shell command it started is still running; Claude Code wakes the session when it ends. The card shows the command's description. It counts until Claude Code says the command ended or it's stopped, for two hours at most |
| Done | Green in Active, plain after that | Finished its turn, or you stopped it |
| Idle | None | Open, with no turn yet |
| Closed | None | Its process is gone |

A question that belongs to another session needs you there, not here: when a closing links or names the session that waits for your answer, or says a side session it's about to start will ask you ("la sesión te va a preguntar…"), this card turns Done once you answer in that session or start that side session.

A card that starts needing you breathes for its first minute, then holds still. How a turn ended is read from the end of its transcript about a second after `Stop`. Errors are the lines Claude Code marks with `isApiErrorMessage`.

## Answering from the card

When a session ends its turn with the Claude app's next-step question and answer buttons, its Needs you card shows the first two buttons in its footer, in place of the folder. Click one to answer without opening the session: the answer goes at once to the session as your next message, exactly the button's words, and the card turns blue and says Sent while the session starts working on it. There's no taking it back, so click the one you mean. From the click on, it no longer counts as needing you.

This needs the [plugin](#the-plugin) in that session. Without it, and for a button only the Claude app can do (Commit, Create PR, Merge and the like), the button carries ↗ and opens the session, as a click on the card does. If no session takes the answer within 20 seconds of your click, or one takes it but its message doesn't reach the session within 30 seconds after that, the card says it couldn't send it and needs you again. On a focused card, ⌘↩ answers with the first button.

### Dictating an answer

In the app, a card whose session waits on you (Done, Needs you or Error, not a permission and not working) has a mic at the end of its footer, when the [plugin](#the-plugin) is in that session. Press it and a composer opens out from under the card, as wide as it (or from above it, when the card is near the bottom of the window); the card itself doesn't change, so its question stays in sight, and the mic stays lit. While you dictate, the cards hold their places. Speak: the words show in the composer as they come, with five bars that follow your voice and the language beside them. Press Return or Send when you're done, or end with “enviar mensaje” (“send message” in English) and pause: the composer says Sending… for a moment, and talking on or pressing Esc stops it. Only as your last words does a phrase send. Settings › Send by voice changes those words, one or more for each language, and can keep them in your answer, for words that are the answer itself; by default they don't go with it. Your words go to the session as your next message, as one line; then the composer closes and the card says Sending… and Sent, as for a button. If they can't be sent, they wait in a text box, where you can fix a word by typing and press Return or Send again. Cancel, Close or Esc drops it at any point; a click elsewhere in the window leaves it open, so a stray click doesn't lose your words. If the session moves on before you send, the composer says the words weren't sent and shows them. One card listens at a time, for 60 seconds at most. Two soft notes going up say the mic is listening, and the same two going down say it stopped and has your words; Settings › Send by voice turns them off. To play your own sounds instead, give the app their files: `defaults write com.creativecontext.ClaudeSessionMonitor dictationStartSound ~/Sounds/start.mp3`, and the same with `dictationStopSound`.

The words are recognized on your Mac, never over the network, and nothing is kept: see [privacy](privacy.md). The first time, macOS asks to let the app use the microphone and speech recognition; if you said no, the composer says where to allow it in System Settings. It listens in your Mac's language, English (US) or Spanish (Mexico); change it in the menu bar menu. If the composer says dictation isn't ready for the language, download it in System Settings, under Keyboard, Dictation. If the microphone gives no sound for a few seconds, it stops and says so. In a browser there's no mic: only the app can listen.

## The plugin

A small Claude Code plugin, `session-monitor`, is the app's side inside each session. It does two things, and shows nothing and adds no command:

- **Usage, sooner.** Each time Claude Code measures your plan's limits, in a terminal or in the Claude app, it saves the two percentages for the app, so the weekly usage comes faster and the app never opens Claude Code in a hidden terminal.
- **Answers from the card.** In the background, with no turn and nothing in the conversation, it asks the app's server, at `127.0.0.1` only, whether you sent an answer for this session, and when you did, it submits that answer as your next message. The server only hands it the words of a button that session offered, or the words you dictated and sent from its card, only after your click. With the app closed, it asks again every 15 seconds and does nothing else.

In a terminal session:

```
/plugin install session-monitor --marketplace creative-context/claude-session-monitor
```

Answer `y` to add the marketplace and choose the user scope, so every session loads it. In the Claude app, click + next to the prompt box, then **Plugins**, **Add marketplace** with `creative-context/claude-session-monitor`, then **Add plugin**. It's in `plugin/` in this repository. If you installed the earlier `session-usage`, uninstall it first: this plugin replaces it.

Sessions already open load it on their own a moment after you install or update it. If one doesn't, run `/reload-plugins` there or open a new session; until then its usage comes from the app's own check, up to 10 minutes late, and its answer buttons open the session.

## Build from source

```bash
git clone https://github.com/creative-context/claude-session-monitor.git
cd claude-session-monitor
sh app/build.sh --install
```

That builds the app with the Xcode command line tools (`xcode-select --install`), copies it to `~/Applications` and opens it. The app carries its own copy of the server, the page and the hook.

To use a browser instead of the app, run `bun install-hooks.ts` once, then `bun server.ts`, and open http://127.0.0.1:4747.

## AI assistants

To have Claude Code set it up on your Mac, give it this line:

> Install Claude Session Monitor from https://github.com/creative-context/claude-session-monitor on this Mac. Follow the Install section of its README, and ask me before installing the hook.

To work on this repository itself, an agent reads [`AGENTS.md`](../AGENTS.md), which `CLAUDE.md` imports.
