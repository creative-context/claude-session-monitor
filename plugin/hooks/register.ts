import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Claude Session Monitor's side inside each session. Three jobs, nothing on screen:
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
//
// Permissions: when the session asks for a permission, its card in the app shows what it asks
// for with Allow and Deny. This sends the app's local server (127.0.0.1 only) the session's ID
// in the address and, in the body, the tool's name, what it asks for as one line of up to 300
// characters (the command, the file, the address…), an ID for the ask and the subagent's ID
// if one asks; then it waits for your click and returns it to the session as the hook's
// decision. The session's own dialog shows all the while: answered there, or with the app
// closed, this steps aside and the dialog decides.

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

// ---------------------------------------------------------------- permissions

// Their dialogs are a question or a plan for you; a hook's allow doesn't settle them.
const SKIP = new Set(['AskUserQuestion', 'ExitPlanMode'])
const MAX_WHAT = 300
const ASK_FOR_MS = 60 * 60_000 // after an hour of rounds the dialog alone decides
const DENIED = "Denied from the session's card."
const FIELDS = ['command', 'file_path', 'path', 'url', 'query', 'pattern', 'title', 'prompt', 'description']

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

// What the permission is for, as one line: the command, the file, the address, the search...
export function whatOf(tool: string, input: unknown): string {
  const x = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  let what: string | undefined
  if (tool === 'Bash') what = str(x.command)
  else if (['Edit', 'Write', 'Read', 'MultiEdit'].includes(tool)) what = str(x.file_path)
  else if (tool === 'NotebookEdit') what = str(x.notebook_path)
  else if (tool === 'WebFetch') what = str(x.url)
  else if (tool === 'WebSearch') what = str(x.query)
  else if (tool === 'Glob' || tool === 'Grep') {
    const p = str(x.pattern)
    what = p && (str(x.path) ? `${p} in ${x.path}` : p)
  } else if (tool === 'Skill') what = str(x.skill)
  what ??= FIELDS.map((k) => str(x[k])).find((v) => v !== undefined)
  if (what === undefined) {
    try {
      what = JSON.stringify(input) ?? ''
    } catch {
      what = ''
    }
  }
  return what.slice(0, MAX_WHAT * 20).replace(/\s+/g, ' ').trim().slice(0, MAX_WHAT)
}

let asked = 0 // with the clock, an ID unique in this session

// Your decision from the card, or null to leave it to the dialog: the app is closed, the
// ask was settled there, or a reply it doesn't expect.
export async function permit($: EngineInterface, e: { session_id?: string; tool_name: string; tool_input: unknown; agent_id?: string }): Promise<'allow' | 'deny' | null> {
  const port = Number(await $.env.get('CSM_PORT')) || PORT
  const sid = e.session_id || (await $.session.id())
  const began = await $.clock.now()
  const agent = typeof e.agent_id === 'string' && e.agent_id && e.agent_id.length <= 64 ? e.agent_id : undefined
  const body = JSON.stringify({
    id: `${began.toString(36)}-${++asked}`,
    tool: String(e.tool_name).slice(0, 100),
    what: whatOf(e.tool_name, e.tool_input),
    ...(agent ? { agent } : {}),
  })
  const url = `http://127.0.0.1:${port}/api/permission/${encodeURIComponent(sid)}`
  let quick = 0 // rounds the server ended at once: a server that never holds is left alone
  for (;;) {
    const sent = await $.clock.now()
    const r = await $.http.fetch(url, { method: 'POST', headers: { 'x-csm': '1', 'content-type': 'application/json' }, body })
    if (r.status === 200) {
      try {
        const d = JSON.parse(r.text)?.decision
        return d === 'allow' || d === 'deny' ? d : null
      } catch {
        return null
      }
    }
    if (r.status !== 204) return null // 410: settled in the dialog; anything else: not ours to guess
    const now = await $.clock.now()
    if (now - began >= ASK_FOR_MS) return null
    quick = now - sent < 1_000 ? quick + 1 : 0
    if (quick >= 3) return null
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on) => {
  on('classic.PermissionRequest', async ($, e, next) => {
    if (SKIP.has(e.tool_name) || (await $.env.get('CSM_PROBE'))) return next(e)
    const d = await permit($, e).catch(() => null)
    if (d === 'allow') return { decision: { behavior: 'allow' as const } }
    if (d === 'deny') return { decision: { behavior: 'deny' as const, message: DENIED } }
    return next(e)
  })
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
