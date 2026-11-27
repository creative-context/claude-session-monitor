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
// It sends the session's ID in the address and a nonce with its HMAC (below) in its headers, nothing else,
// and with the app closed it just asks again every 15 s. It never runs in the app's own usage
// check (CSM_PROBE).
//
// Permissions: when the session asks for a permission, its card in the app shows what it asks
// for with Allow and Deny. This sends the app's local server (127.0.0.1 only) the session's ID
// in the address, a nonce with its HMAC (below) in its headers and, in the body, the tool's name, what it asks
// for as one line of up to 300 characters (the command, the file, the address…), an ID for the
// ask and the subagent's ID if one asks; then it waits for your click and returns it to the
// session as the hook's decision. The session's own dialog shows all the while: answered
// there, or with the app closed, this steps aside and the dialog decides.
//
// The key: the app's server writes a new one at each start to
// ~/.claude-session-monitor/plugin.key, readable only by you. This reads that file before each
// request to the server (no file: no request) and never sends it. Each request carries
// x-csm-nonce, 32 random hex characters new each time, and x-csm-plugin, the HMAC-SHA256 of
// "plugin:" and the nonce with the key. A server that knows the key answers with x-csm-proof,
// the HMAC-SHA256 of "server:" and the nonce. A reply without that proof is never trusted, even
// from 127.0.0.1: no answer is submitted, no decision returned, and the dialog decides. Since
// the key never goes over the wire, a program that took the port can't forge an answer or a
// decision.

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

// ---------------------------------------------------------------- the key and its proof

// SHA-256 and HMAC-SHA256 here, in plain code: the mod's runtime may have no WebCrypto.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export function utf8(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

export function sha256(bytes: number[]): number[] {
  const len = bytes.length
  const m = bytes.slice()
  m.push(0x80)
  while (m.length % 64 !== 56) m.push(0)
  const hi = Math.floor(len / 0x20000000) // the length in bits, as 64 bits big-endian
  const lo = (len * 8) >>> 0
  m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64)
  for (let off = 0; off < m.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = (m[off + 4 * t] << 24) | (m[off + 4 * t + 1] << 16) | (m[off + 4 * t + 2] << 8) | m[off + 4 * t + 3]
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + hh) | 0
  }
  return h.flatMap((x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255])
}

export const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('')

// HMAC-SHA256 of the text with the key, both as UTF-8, in hex.
export function hmac(key: string, text: string): string {
  let k = utf8(key)
  if (k.length > 64) k = sha256(k)
  while (k.length < 64) k.push(0)
  const inner = sha256([...k.map((b) => b ^ 0x36), ...utf8(text)])
  return hex(sha256([...k.map((b) => b ^ 0x5c), ...inner]))
}

// Whole strings, every character looked at whatever differs.
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// 32 hex characters, new for each request.
export function nonce(): string {
  const bytes = new Uint8Array(16)
  try {
    ;(globalThis as any).crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return hex([...bytes])
}

// The key the app's server wrote at its start, read again before each request: the server
// makes a new one each time it starts. '' when there's none (the app isn't installed or
// never ran), and then nothing is asked.
async function key($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) return ''
  const k = await $.fs.read(`${home}/.claude-session-monitor/plugin.key`).then((t) => String(t).trim()).catch(() => '')
  return /^[0-9a-f]{64}$/i.test(k) ? k : ''
}

// The headers of a request: the nonce and this side's HMAC of it, never the key itself.
export const headersFor = (k: string, n: string) => ({ 'x-csm': '1', 'x-csm-plugin': hmac(k, `plugin:${n}`), 'x-csm-nonce': n })

// The reply came from a server that knows the key: its proof is the server side's HMAC of this
// request's nonce (a different prefix, so neither side's proof stands for the other's).
export function proved(headers: unknown, k: string, n: string): boolean {
  if (!headers || typeof headers !== 'object') return false
  const entry = Object.entries(headers as Record<string, unknown>).find(([name]) => name.toLowerCase() === 'x-csm-proof')
  return typeof entry?.[1] === 'string' && same(entry[1].toLowerCase(), hmac(k, `server:${n}`))
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
  const k = await key($)
  if (!k) return 'retry' // no key: the app isn't there, ask nothing
  const n = nonce()
  const r = await $.http.fetch(`http://127.0.0.1:${port}/api/answer/${encodeURIComponent(sid)}/next`, {
    headers: headersFor(k, n),
  })
  // 403: no key or an old one (the server started again since), read again next round.
  // Without the proof, whatever it says isn't from the app's server.
  if (r.status === 403 || !proved(r.headers, k, n)) return 'retry'
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


// Your decision from the card, or null to leave it to the dialog: the app is closed, the
// ask was settled there, a reply it doesn't expect, or one without the server's proof.
export async function permit($: EngineInterface, e: { session_id?: string; tool_name: string; tool_input: unknown; agent_id?: string }): Promise<'allow' | 'deny' | null> {
  const port = Number(await $.env.get('CSM_PORT')) || PORT
  const sid = e.session_id || (await $.session.id())
  const began = await $.clock.now()
  const agent = typeof e.agent_id === 'string' && e.agent_id && e.agent_id.length <= 64 ? e.agent_id : undefined
  const body = JSON.stringify({
    id: nonce(), // random, so no one can guess it and hold an ask under it first
    tool: String(e.tool_name).slice(0, 100),
    what: whatOf(e.tool_name, e.tool_input),
    ...(agent ? { agent } : {}),
  })
  const url = `http://127.0.0.1:${port}/api/permission/${encodeURIComponent(sid)}`
  let quick = 0 // rounds the server ended at once: a server that never holds is left alone
  for (;;) {
    const sent = await $.clock.now()
    const k = await key($) // each round: the server may have started again with a new key
    if (!k) return null
    const n = nonce()
    const r = await $.http.fetch(url, { method: 'POST', headers: { ...headersFor(k, n), 'content-type': 'application/json' }, body })
    // A 403 (no key or an old one) or a reply without the proof: the dialog decides.
    if (r.status === 403 || !proved(r.headers, k, n)) return null
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
