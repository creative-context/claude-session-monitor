import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Claude Session Monitor's side inside each session. Two jobs, nothing on screen:
//
// Usage, from the readings Claude Code already takes: each time the plan's limits change,
// the two percentages and when they reset go to ~/.claude-session-monitor/usage.json, the
// file the app reads, and only when the app is installed (its folder exists).
//
// Answers: when a session ends its turn with a question and answer buttons, its card in the
// app shows those buttons, and a click answers the session from there; when it waits on you,
// its card also has a mic, and the words you dictate there and send answer it the same way.
// In the background, with no turn and nothing in the conversation, this asks the app's local
// server (127.0.0.1 only) whether you sent an answer for this session; the server holds each
// ask up to 20 s. When you did, it submits that answer as the session's next prompt, as your
// own words (the session reads it bare, not as a plugin's message), exactly
// a button's words or the words you sent from that session's card (one line, up to 1,000
// characters) and nothing more, which starts a turn once the session is idle. The server only
// hands over a label the session itself offered or your own words, and only after your click.
// It sends nothing but the session's ID in the address, and with the app closed it just asks
// again every 15 s. It never runs in the app's own usage check (CSM_PROBE).

// ---------------------------------------------------------------- usage

// Stamped with when this session measured them. Every open session writes the same file, so
// one never replaces a newer reading with an older one.
const FRESH_MS = 5 * 60_000
let written = 0

async function save($: EngineInterface, limits: SessionRateLimit[], measured: number) {
  const seven = limits.find((l) => l.kind === 'seven_day')
  if (!seven?.resetsAt) return
  const home = await $.env.get('HOME')
  const dir = home && `${home}/.claude-session-monitor`
  if (!dir || !(await $.fs.exists(dir))) return
  const file = `${dir}/usage.json`
  const held = await $.fs.read(file).then((t) => Number(JSON.parse(t)?.at) * 1000).catch(() => 0)
  if (held >= measured) return
  const five = limits.find((l) => l.kind === 'five_hour')
  const window = (l?: SessionRateLimit) =>
    l?.resetsAt ? { used_percentage: l.percentUsed, resets_at: Math.floor(Date.parse(l.resetsAt) / 1000) } : null
  await $.fs.write(file, JSON.stringify({ at: measured / 1000, week: window(seven), five_hour: window(five) }))
}

// At its start a session holds the last numbers it saw, maybe hours ago, with no time on
// them: they fill the file only when there is none yet.
async function first($: EngineInterface) {
  const usage = await $.session.usage().catch(() => null)
  if (usage) await save($, usage.rateLimits, 1).catch(() => {})
}

// ---------------------------------------------------------------- answers

const PORT = 4747
const RETRY_MS = 15_000 // after an error, or a reply it doesn't expect
const ROUND_MS = 1_000 // the shortest round, so a server that answers at once never spins it
const MAX_TEXT = 1000 // a button's words, or the words you sent from the card, at most

// The answer in a 200 reply, or null when it isn't one: one line of 1,000 characters at most.
export function answerText(body: string): string | null {
  try {
    const text = JSON.parse(body)?.text
    if (typeof text !== 'string') return null
    const t = text.trim()
    return t && t.length <= MAX_TEXT && !/[\n\r]/.test(t) ? t : null
  } catch {
    return null
  }
}

// One ask: the answer to submit, 'none' when there's none yet, or 'retry' to wait first.
export async function ask($: EngineInterface, port: number): Promise<string | 'none' | 'retry'> {
  // Read each round: after a /clear the session goes on under a new ID.
  const sid = await $.session.id()
  const r = await $.http.fetch(`http://127.0.0.1:${port}/api/answer/${encodeURIComponent(sid)}/next`, {
    headers: { 'x-csm': '1' },
  })
  if (r.status === 204) return 'none'
  if (r.status !== 200) return 'retry'
  return answerText(r.text) ?? 'retry'
}

let round = 0 // a newer session start ends the older loop
let running = false // this load of the mod has a loop asking

async function listen($: EngineInterface) {
  const mine = ++round // claimed before any wait, so two events at once start one loop
  running = true
  if (await $.env.get('CSM_PROBE')) {
    running = false
    return
  }
  const port = Number(await $.env.get('CSM_PORT')) || PORT
  void (async () => {
    while (mine === round) {
      const began = await $.clock.now()
      const got = await ask($, port).catch(() => 'retry' as const)
      // As your own words, which they are (a button you clicked, or what you said): the session
      // reads them bare, not under "The session-monitor plugin sent a message".
      if (got !== 'none' && got !== 'retry' && mine === round) void $.prompt.submit({ text: got, asUser: true }).catch(() => {})
      const wait = got === 'retry' ? RETRY_MS : ROUND_MS - ((await $.clock.now()) - began)
      if (wait > 0) await $.clock.sleep(wait) // rejects when the mod unloads, which ends the loop
    }
  })()
    .catch(() => {})
    .finally(() => {
      if (mine === round) running = false
    })
}

// A load of the mod usually gets a session start, even in a session already open. In case
// one doesn't, the next turn or message starts the loop.
async function keepListening($: EngineInterface) {
  if (!running) await listen($)
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await first($)
    const started = await next(e)
    await listen($).catch(() => {})
    return started
  })
  // A measure comes right after a response of this session, so its numbers are current:
  // written when they move, and at least every 5 minutes while the session works, so the
  // app sees fresh numbers and doesn't start its own check.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.changed.includes('rateLimits') || now - written > FRESH_MS) {
      written = now
      await save($, e.rateLimits, now).catch(() => {})
    }
    await keepListening($).catch(() => {})
    return next(e)
  })
  // Without a session start, any of these starts the loop (see keepListening).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await keepListening($).catch(() => {})
    return done
  })
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    await keepListening($).catch(() => {})
    return started
  })
  on('prompt.submit', async ($, e, next) => {
    const sent = await next(e)
    await keepListening($).catch(() => {})
    return sent
  })
}
