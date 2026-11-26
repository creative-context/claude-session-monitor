# Guide

Everything Claude Session Monitor shows, and the optional pieces.

![The monitor with demo data: an Active zone of cards with sessions that need you, one asking permission to run a command with Allow and Deny, one with a mic for a spoken answer whose model, effort, ultracode and advisor show as tags, a scheduled task that can't run, an error, one working and one whose agents are working, and at the right the week's usage running hot, with its card open: it runs out tomorrow, almost two days before the reset, and the week's curve climbs above the even-week diagonal](screenshot.png)

## Install in detail

**Requirements:** macOS 14 or later on Apple silicon or Intel, Claude Code signed in with a Claude plan that includes it (Pro, Max, Team or Enterprise), [Bun](https://bun.sh) and `jq`. macOS 15 and later ship `jq`. On macOS 14, `brew install jq`.

**Status:** 0.x. It reads files that Claude Code and the Claude app keep but don't document, so a new version of either can take a detail away.

1. If you don't have Claude Code yet, install it in Terminal with its installer or with Homebrew:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   ```bash
   brew install --cask claude-code
   ```

   Then run `claude` once and sign in with your Claude account in the browser. [Claude Code's setup page](https://code.claude.com/docs/en/setup) has the other ways to install it. The app finds `claude` where these installers put it (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`), even when you open it from Finder.
2. Download the zip from the [latest release](https://github.com/creative-context/claude-session-monitor/releases/latest), unzip it and move the app to Applications.
3. Open it. The app isn't notarized, so the first time macOS can't check it. Open **System Settings › Privacy & Security** and click **Open Anyway**, or run:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Claude Session Monitor.app"
   ```
4. Click **Install Hook** when the app asks. It adds the hook to `~/.claude/settings.json`, and a status line for your [weekly usage](#weekly-usage) if you have none. It saves a copy of the file first and changes nothing else. You can install or remove it later in Settings (⌘,).

Sessions show up as soon as they do something. Open at Login stays off until you turn it on in Settings. When a new version is out, the app tells you with a notification and a notice in the window, and **Check for Updates…** looks right away. To update, put the new version in Applications in place of the old one.

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

- **Last 7 Days** (⌘1). **Active** shows cards, most urgent first: what needs you, what's working, anything touched in the last two hours (pick 4, 8, 12 or 24 in its header) and anything set to pick up again on its own. Under it, the rest of the week comes as rows by day. While the pointer is on a card or a row, nothing moves.
- **All Sessions** (⌘2). Every session by day, searchable by title, first prompt, project or last recap; accents and capitals don't matter. On first run it fills in from the sessions the Claude app already has.
- **Scheduled** (⌘3). Your scheduled tasks from the Claude app, with when each one runs next, how its last run went and a dot for each of its last seven runs. A task that should have run and didn't says Missed. One the Claude app couldn't start says Can't run, in red, with why. It shows in Active too and counts as needing you, and a click opens the run that holds it up. A one-time task moves to Ran once after it runs. A task's runs show in the other views with a calendar clock by their time.

**Pins.** Click the pin at the end of a card's or a row's top line to pin a session (in the app, Pin is also in the right-click menu). A pinned session moves up in its group, right after what needs you, and keeps its pin after a restart. Click it again to unpin.

**Pinned**, before the view tabs, shows only the pinned sessions in Last 7 Days and All Sessions, and search looks only through them. In the app it's in the toolbar, and it turns off in the narrowest window. The counts in the header, the Dock and the menu bar still count every session.

**Most active** shows only the 10 sessions Claude spent the most time working in over the last 7 days, each with its time, such as 3h 20m. Only a session's own turn counts, not the time it waits on you or its subagents and background commands. Turning on one filter turns off the other. The first time, the app fills in the time from its event log.

**Reminders, tasks and side sessions.** A session that set itself a reminder (`/loop`, a cron job or a wakeup) shows by an alarm clock when it picks up again. One that set up a scheduled task shows the task's name, and a click shows it in Scheduled. A side session, one the Claude app started from another, says where it came from, and the other one says how many it started. Point at either one and the rest of the window steps back, and click the tag to open the other session. Sessions started with `claude` in a terminal don't have side sessions.

## A card's parts

![Three demo cards with each part named. One needs you, with its state, model, effort, ultracode and advisor tags, time, pin, title, question, answers and mic, and the mic's drawer open under it. One is working, with the tool it's using, its plan step and its plan progress. One is done, with its folder, side sessions and a scheduled task it created](card-anatomy.png)

A card has the same parts in every state, and shows only some of them at a time.

- **Top line.** The state, the model and its tags (see [States](#states)), the time and the pin. The time is how long it has been waiting or working, or how long ago it finished.
- **Title and two lines.** The question it's asking you, the tool it's using and the step of its plan, or a recap of its last turn.
- **Foot.** The project folder, side sessions, agents, and a reminder or a task it created. A plan in progress shows its progress bar there instead. A question shows its answers, and in the app a mic that opens a drawer to [dictate your own answer](#dictating-an-answer).

## Weekly usage

At the right of Active, a narrow column shows how much of your plan's weekly limit you've used. Under the figure, the week shows as seven blocks from the reset, filled up to what you've used, with an indigo line where an even week would be now. Under that, how you compare (Plenty left, On pace, A little fast, Running hot, Almost at the limit or Limit reached) and the day it resets. On plans with a 5-hour limit, a last line shows the current 5 hours. The fill turns orange when you run hot and red at 90%. Once you're ahead of pace, the reset gives way to when you'd run out at the week's average pace, such as "Out Wed 1 PM". At the reset the column stays: the old week drains to the new one's 0% as one level, and it starts again from the bottom.

Point at the column, click it, or reach it with the keyboard, to open its card. It has the forecast, the week as a curve against an even week, how much you have left beyond an even pace or how far past it you are, your pace per day, the most per day that lasts until the reset, and the last 5 hours. In a narrow window and in the other views, a small version sits in the header.

Claude Code hands these numbers only to a status line, and the Claude app doesn't run one. So the hook installer adds a small status line to `~/.claude/settings.json` (only when you have none). When the numbers are old and you've used Claude Code since, the app opens Claude Code in a hidden terminal for a few seconds, at most every 10 minutes. It runs in its own empty folder, without your settings. Nothing is sent to Claude and no session is saved. Allow that folder once, from a terminal:

```bash
mkdir -p ~/.claude-session-monitor/probe && cd ~/.claude-session-monitor/probe && claude --setting-sources project --strict-mcp-config
```

Choose **Yes, I trust this folder**, then quit with Ctrl-C. Until then, the meter updates only when you use `claude` in a terminal. With the [plugin](#the-plugin), every session hands the app its numbers and none of this is needed.

## The window

**Card size.** Cards are the same size in every window, 134 px tall with the title on one line. A tall window shows more of them.

**View tabs and search.** In a browser they sit in the header, and in the app the window's toolbar holds them.

**Compact view.** In a window narrower than 640 points, as on a laptop screen on its own, Active turns into rows with the same colors, and the weekly usage becomes one line above them. Under 300 points it becomes a strip for the side of the screen, with how many sessions need you, the week, and each session's dot, title, time and question.

Click a count in the header (needs you, working, agents, last 7 days) to open its menu with what's behind it; while one is open, point at the next count to see that one. Click Show these cards, or one of its rows, to jump to those cards; click outside or press Escape to close it. Click a card or a row of All Sessions to open that session in the Claude app, or a task's last run. Right-click to copy its title or show its project or task file in Finder. Arrow keys move between cards, and an optional sound tells you when something new needs you.

## States

Most urgent first. What needs you gets a bright amber card, the only light one in the window, and the other states tint the card. The count of what needs you also shows on the Dock icon and in the menu bar, whose menu lists each one with why it needs you. Pick one to open it.

The model and its tags show beside the time, as the Claude app sets them. The effort is a letter in a solid square (L for Low, M for Medium, H for High, X for Extra, MAX for Max). UC in an outline means ultracode is on. A round tag with an initial is the model of the advisor the session turned on with Claude Code's `/advisor`, such as F for Fable. A session in a terminal shows only its model. A narrow card drops the model's name first, then the effort, then the advisor, and the time's tooltip always says all of it.

| State | Color | When |
|---|---|---|
| Needs you | Amber card, black words | It's blocked on a permission, a question, a plan approval or input. Or it asked something in the Claude app's own dialog or card and you haven't answered: to take over your screen, use your apps or guide you on screen, whether to start a new session, to change a setting or a session's permissions, or to open a folder. Or its turn ended asking you something, with a closing question, a request without a question mark ("let me know which one") or the Claude app's own summary saying you need to act. Courtesy closings like "anything else?" don't count. After a day, a question no longer counts and the card turns dark |
| Error | Crimson tint | An API error ended the turn, such as a server error or a usage limit. It counts for a day |
| Working | Blue tint | Thinking or using a tool |
| Agents working | Blue tint | Its turn ended, but subagents or a workflow are still running |
| In the background | Blue tint | Its turn ended, but a shell command it started is still running, for two hours at most. The card shows the command |
| Done | Green tint in Active | It finished its turn, or you stopped it |
| Idle | None | Open, with no turn yet |
| Closed | None | Its process is gone |

When a closing names another session that waits for your answer, or says a side session it's starting will ask you, the card turns Done once you answer there. A card that starts needing you pulses for its first minute.

## Answering from the card

When a session ends its turn with the Claude app's next-step question and answer buttons, its card shows the first two buttons in place of the folder. Click one to answer without opening the session. The button's words go at once as your next message, and the card turns blue and says Sent while the session works on it. You can't take it back. On a focused card, ⌘↩ answers with the first button.

This needs the [plugin](#the-plugin) in that session, and the app's window: the page in a browser only shows the cards, and its buttons open the session. Without the plugin, and for buttons only the Claude app can do (Commit, Create PR, Merge and the like), the button carries ↗ and opens the session. If no session takes the answer within 20 seconds, or its message doesn't arrive within 30 seconds after that, the card says it couldn't send it and needs you again.

### Allowing or denying a permission

When a session waits on a permission, its card shows what it's for (the command, the file, the address or the search) and **Allow** and **Deny** in place of the folder. Click one and the session runs the tool or refuses it at once, and its own dialog goes away. The card says Allowing… or Denying…, then Allowed or Denied. If it can't be sent, the card says so and needs you again.

This needs the [plugin](#the-plugin) in that session, 0.3.1 or later. Without it, a click opens the session. What the card shows stays in the app's memory and goes once the permission is settled. If you answer in the session's own dialog, the card keeps Allow and Deny until the tool finishes, then moves on.

When several agents of one session ask at once, the card shows the oldest ask. ⌘↩ opens the session, and no shortcut allows. Questions and plans keep their own dialogs, and a permission card has no mic.

### Dictating an answer

In the app, a card that waits on you (Done, Needs you or Error, but not a permission) has a mic at the end of its footer when the [plugin](#the-plugin) is in that session. Press it and a drawer opens under the card (above it near the bottom of the window), and the cards hold their places. Speak, and your words show as they come, with the language beside them. Press Return or Send when you're done, or end with “send message” (“enviar mensaje” in Spanish) and pause. Your words go to the session as your next message, and the card says Sending…, then Sent. If they can't be sent, they wait in a text box where you can fix them and send again. If the session moves on first, the drawer says so and keeps your words. Cancel or Esc drops them, and a click elsewhere leaves the drawer open.

Settings › Send by voice changes the closing words for each language and can keep them in your answer. One card listens at a time, for 60 seconds at most. Two soft notes say the mic started and stopped, and the same setting turns them off. To use your own sounds, run `defaults write com.creativecontext.ClaudeSessionMonitor dictationStartSound ~/Sounds/start.mp3`, and the same with `dictationStopSound`.

The words are recognized on your Mac, never over the network, and nothing is kept (see [privacy](privacy.md)). The first time, macOS asks to let the app use the microphone and speech recognition, and if you said no, the drawer says where to allow it. If the microphone gives no sound for a few seconds, it stops and says so. It listens in English (US) or Spanish (Mexico), set in the menu bar menu. If dictation isn't ready for the language, download it in System Settings › Keyboard › Dictation. In a browser there's no mic.

## The plugin

A small Claude Code plugin, `session-monitor`, is the app's side inside each session. It adds no command, shows nothing and does three things:

- **Usage, sooner.** Each time Claude Code measures your plan's limits, in a terminal or in the Claude app, it saves the two percentages for the app. The weekly usage comes sooner, and the app never opens Claude Code in a hidden terminal.
- **Answers from the card.** In the background, with nothing in the conversation, it asks the app's server (at `127.0.0.1` only) whether you sent an answer for this session, and submits it as your next message. The server hands over only a button's words or the words you dictated, and only after your click. With the app closed, it asks every 15 seconds and does nothing else.
- **Permissions from the card.** When the session asks for a permission, it tells the app's server what it's for and returns your click. See [Allowing or denying a permission](#allowing-or-denying-a-permission).

It talks to the app's server with a key the server writes at each start, and believes a reply only when the server proves it knows that key (see [privacy](privacy.md)). A plugin older than the app can't answer: the card's buttons open the session, as without the plugin. Update both.

In a terminal session:

```
/plugin install session-monitor --marketplace creative-context/claude-session-monitor
```

Answer `y` to add the marketplace and choose the user scope, so every session loads it. In the Claude app, click + next to the prompt box, then **Plugins**, **Add marketplace** with `creative-context/claude-session-monitor`, then **Add plugin**. It's in `plugin/` in this repository. If you installed the earlier `session-usage`, uninstall it first, because this plugin replaces it.

Open sessions load it on their own a moment after you install or update it. If one doesn't, run `/reload-plugins` there or open a new session. Until then, its usage comes from the app's own check, up to 10 minutes late, and its answer buttons open the session.

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
