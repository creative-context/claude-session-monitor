import { expect, mock, test } from 'claude-code/testing'
import { headersFor, hex, hmac, nonce, proved, sha256, utf8, whatOf } from './register.ts'

// The key the app's server writes at its start, in a made-up home folder: no test ever reads a
// real one. The stand-in server checks the mod's proof of the key and signs its replies with it,
// unless a reply says to leave the proof out ('none'), to sign with the wrong key ('bad'), or to
// send back the mod's own proof as its own ('echo').
const HOME = '/home/someone'
const KEY_FILE = `${HOME}/.claude-session-monitor/plugin.key`
const KEY = 'a1'.repeat(32)
const OTHER = 'b2'.repeat(32)
type Proof = 'none' | 'bad' | 'echo'
// What the mod sends for a key, given the nonce it sent.
const mine = (key: string, h: any) => hmac(key, `plugin:${h['x-csm-nonce']}`)
// The files the mod can read, and the key the server holds; tests change them.
function keys(on: any, o: { file?: string | null; server?: string } = {}) {
  const k = { file: o.file === undefined ? KEY + '\n' : o.file, server: o.server ?? KEY }
  on('fs.read', (_: any, e: any) => {
    if (e.path !== KEY_FILE || k.file === null) throw new Error('no such file')
    return { value: k.file }
  })
  return k
}
// A reply from the stand-in: 403 at once and without proof when the mod's proof is wrong, else
// signed as the app's server signs (src/keys.ts).
const refused = (k: { server: string }, e: any) => {
  const h = e.init?.headers ?? {}
  return h['x-csm'] !== '1' || typeof h['x-csm-nonce'] !== 'string' || h['x-csm-plugin'] !== mine(k.server, h)
}
const forbidden = { value: { status: 403, ok: false, headers: {}, text: '' } }
function reply(k: { server: string }, e: any, status: number, text = '', proof?: Proof) {
  const h = e.init?.headers ?? {}
  if (refused(k, e)) return forbidden
  const p = proof === 'echo' ? h['x-csm-plugin'] : hmac(proof === 'bad' ? OTHER : k.server, `server:${h['x-csm-nonce']}`)
  const headers = proof === 'none' ? {} : { 'x-csm-proof': p }
  return { value: { status, ok: status < 300, headers, text } }
}

// The answers side of the mod against a stand-in for the app's server, which holds each ask 20 s: it asks for its
// own session with the x-csm header and its proof of the key, submits exactly the answer it gets, asks again at once,
// waits 15 s when the app is closed, and never runs in the app's usage check.
const SID = '00000000-0000-4000-8000-00000000abcd'
type Reply = { status: number; text?: string; proof?: Proof } | 'down'
function setup(on: any, o: { env?: Record<string, string>; replies?: Reply[]; file?: string | null; server?: string } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME, ...o.env })
  const k = keys(on, o)
  const asks: { url: string; headers: any; at: number }[] = []
  const prompts: string[] = []
  const asUser: boolean[] = []
  const replies = [...(o.replies ?? [])]
  on('session.id', () => ({ value: SID }))
  on('http.fetch', async (_: any, e: any) => {
    asks.push({ url: e.url, headers: e.init?.headers, at: clock.now() })
    if (refused(k, e)) return forbidden
    const r = replies.shift()
    if (r === 'down') throw new Error('connection refused')
    if (!r) {
      await clock.sleep(20_000) // nothing clicked: the server lets the ask go after 20 s
      return reply(k, e, 204)
    }
    return reply(k, e, r.status, r.text, r.proof)
  })
  on('prompt.submit', (_: any, e: any) => {
    prompts.push(e.text)
    asUser.push(e.origin?.asUser === true)
    return { text: e.text }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { clock, asks, prompts, asUser, k }
}
const start = ($: any) => $.session.start({ cwd: '/work/notes', surface: 'desktop', isInteractive: false })

test('it asks the app for its own session and keeps asking, with nothing to submit', async ($, on) => {
  const s = setup(on)
  await start($)
  await s.clock.advance(65_000)
  expect(s.asks.length).toBe(4) // one at the start, then again as each 20 s ask ends
  expect(s.asks[0].url).toBe(`http://127.0.0.1:4747/api/answer/${SID}/next`)
  expect(Object.keys(s.asks[0].headers).sort()).toEqual(['x-csm', 'x-csm-nonce', 'x-csm-plugin'])
  expect(s.asks[0].headers['x-csm']).toBe('1')
  expect(s.asks[0].headers['x-csm-plugin']).toBe(mine(KEY, s.asks[0].headers)) // from the file's key, trimmed
  expect(s.asks[0].headers['x-csm-nonce']).toMatch(/^[0-9a-f]{32}$/)
  expect(s.asks[1].headers['x-csm-nonce']).not.toBe(s.asks[0].headers['x-csm-nonce']) // new each time
  expect(s.prompts).toEqual([])
})

test('an answer without the proof, with a wrong one, or with its own proof sent back, is never submitted', async ($, on) => {
  const answer = { status: 200, text: JSON.stringify({ text: 'Yes, ship it' }) }
  const s = setup(on, { replies: [{ ...answer, proof: 'none' }, { ...answer, proof: 'bad' }, { ...answer, proof: 'echo' }] })
  await start($)
  await s.clock.advance(14_000)
  expect(s.asks.length).toBe(1) // an unproved reply is treated like an error: it waits 15 s
  await s.clock.advance(2_000)
  expect(s.asks.length).toBe(2)
  await s.clock.advance(60_000)
  expect(s.asks.length).toBeGreaterThan(3)
  expect(s.prompts).toEqual([])
})

// No header name or value of any request holds the key, or any half of it.
function keyNeverIn(all: unknown[]) {
  expect(all.length).toBeGreaterThan(0)
  for (const h of all) {
    for (const [name, value] of Object.entries(h as Record<string, string>)) {
      for (const part of [KEY, KEY.slice(0, 32), KEY.slice(32)]) {
        expect(name.toLowerCase().includes(part)).toBe(false)
        expect(String(value).toLowerCase().includes(part)).toBe(false)
      }
    }
  }
}

test('the key itself is never sent, in any header of an ask for an answer', async ($, on) => {
  const s = setup(on, { replies: [{ status: 200, text: '{"text":"Go on"}' }, 'down'] })
  await start($)
  await s.clock.advance(65_000)
  expect(s.prompts).toEqual(['Go on'])
  keyNeverIn(s.asks.map((a) => a.headers))
})

test('a 204 without the proof is treated like an error: it waits 15 s', async ($, on) => {
  const s = setup(on, { replies: [{ status: 204, proof: 'none' }] })
  await start($)
  await s.clock.advance(14_000)
  expect(s.asks.length).toBe(1)
  await s.clock.advance(2_000)
  expect(s.asks.length).toBe(2)
})

test('with no key file it asks nothing, and starts once the file is there', async ($, on) => {
  const s = setup(on, { file: null, replies: [{ status: 200, text: '{"text":"Go on"}' }] })
  await start($)
  await s.clock.advance(60_000)
  expect(s.asks.length).toBe(0)
  s.k.file = KEY
  await s.clock.advance(15_500)
  expect(s.asks.length).toBeGreaterThan(0)
  expect(s.asks[0].headers['x-csm-plugin']).toBe(mine(KEY, s.asks[0].headers))
  expect(s.prompts).toEqual(['Go on'])
})

test('a 403 (an old key) makes it read the key file again', async ($, on) => {
  const s = setup(on, { server: OTHER }) // the server started again since the file was read
  await start($)
  await s.clock.settle()
  expect(s.asks.length).toBe(1)
  expect(s.asks[0].headers['x-csm-plugin']).toBe(mine(KEY, s.asks[0].headers))
  s.k.file = OTHER + '\n' // the new key reaches the file
  await s.clock.advance(16_000)
  expect(s.asks.length).toBe(2)
  expect(s.asks[1].headers['x-csm-plugin']).toBe(mine(OTHER, s.asks[1].headers))
  await s.clock.advance(21_000)
  expect(s.asks.length).toBe(3) // accepted now: the next ask follows the 20 s hold at once
})

test('a clicked answer is submitted as the prompt, exactly, and it asks again', async ($, on) => {
  const s = setup(on, { replies: [{ status: 200, text: JSON.stringify({ text: 'Yes, ship it' }) }] })
  await start($)
  await s.clock.advance(1_500)
  expect(s.prompts).toEqual(['Yes, ship it'])
  expect(s.asUser).toEqual([true]) // as your own words, not framed as the plugin's message
  expect(s.asks.length).toBe(2)
})

test('with the app closed it waits 15 s between asks, then picks up again', async ($, on) => {
  const s = setup(on, { replies: ['down', 'down', { status: 200, text: '{"text":"Second one"}' }] })
  await start($)
  await s.clock.advance(14_000)
  expect(s.asks.length).toBe(1)
  await s.clock.advance(2_000)
  expect(s.asks.length).toBe(2)
  await s.clock.advance(14_500)
  expect(s.asks.length).toBe(3)
  expect(s.prompts).toEqual(['Second one'])
})

test('words you sent from the card are submitted whole, up to 1,000 characters', async ($, on) => {
  const said = 'Yes, go ahead with the second layout and keep the old colors for now. ' + 'a'.repeat(900)
  const s = setup(on, { replies: [{ status: 200, text: JSON.stringify({ text: said.slice(0, 1000) }) }] })
  await start($)
  await s.clock.advance(1_500)
  expect(s.prompts).toEqual([said.slice(0, 1000)])
})

test('a reply that is not an answer submits nothing', async ($, on) => {
  const long = 'x'.repeat(1001)
  const s = setup(on, {
    replies: [
      { status: 200, text: 'not json' },
      { status: 200, text: JSON.stringify({ text: long }) },
      { status: 200, text: JSON.stringify({ text: 'two\nlines' }) },
      { status: 403 },
    ],
  })
  await start($)
  await s.clock.advance(70_000)
  expect(s.prompts).toEqual([])
  expect(s.asks.length).toBeGreaterThan(4)
})

test('the port comes from CSM_PORT when set', async ($, on) => {
  const s = setup(on, { env: { CSM_PORT: '4759' } })
  await start($)
  await s.clock.settle()
  expect(s.asks[0].url).toBe(`http://127.0.0.1:4759/api/answer/${SID}/next`)
})

test('in the app own usage check it never asks', async ($, on) => {
  const s = setup(on, { env: { CSM_PROBE: '1' } })
  await start($)
  await s.clock.advance(60_000)
  expect(s.asks.length).toBe(0)
})

test('a load with no session start of its own starts asking when a turn ends, once', async ($, on) => {
  const s = setup(on)
  on('turn.complete', (_: any, e: any) => ({ text: e.answer ?? '' }))
  await s.clock.settle()
  expect(s.asks.length).toBe(0) // reloaded mid-session: nothing yet
  const turn = { answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' }
  await $.turn.complete(turn as any)
  await s.clock.settle()
  expect(s.asks.length).toBe(1)
  await $.turn.complete({ ...turn, turnId: 't2' } as any) // a loop is already asking: no second one
  await s.clock.advance(21_000)
  expect(s.asks.length).toBe(2) // one loop: the first ask ended at 20 s, then the next
})

test('an older loop does not submit an answer that reaches it after a newer session start', async ($, on) => {
  const s = setup(on, { replies: [] })
  await start($)
  await s.clock.advance(1_000)
  await start($) // a newer start ends the older loop
  await s.clock.advance(65_000)
  expect(s.prompts).toEqual([])
})

// The usage side: every open session writes the same usage.json, so a reading never replaces
// a newer one, and a session's start (numbers it saw who knows when) only fills an empty file.
const FILE =`${HOME}/.claude-session-monitor/usage.json`
const week = (pct: number) => [{ kind: 'seven_day', percentUsed: pct, resetsAt: '2030-01-03T00:00:00Z' }]
function usageSetup(on: any, held?: { at: number; pct: number }) {
  const clock = mock.clock(on, { now: 2_000_000_000 })
  mock.env(on, { HOME, CSM_PROBE: '1' }) // CSM_PROBE keeps the answers loop out of these tests
  const files = new Map<string, string>()
  if (held) files.set(FILE, JSON.stringify({ at: held.at / 1000, week: { used_percentage: held.pct, resets_at: 1893628800 }, five_hour: null }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path === `${HOME}/.claude-session-monitor` || files.has(e.path) }))
  on('fs.read', (_: any, e: any) => {
    if (!files.has(e.path)) throw new Error('no such file')
    return { value: files.get(e.path) }
  })
  on('fs.write', (_: any, e: any) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: week(40) } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  const pct = () => (files.has(FILE) ? JSON.parse(files.get(FILE)!).week.used_percentage : null)
  const at = () => (files.has(FILE) ? JSON.parse(files.get(FILE)!).at * 1000 : null)
  return { clock, pct, at }
}
const measure = ($: any, pct: number) => $.session.measure({ context: {}, rateLimits: week(pct), changed: ['rateLimits'] })

test('a measured change is written with the time it was measured', async ($, on) => {
  const u = usageSetup(on)
  await measure($, 86)
  expect(u.pct()).toBe(86)
  expect(u.at()).toBe(2_000_000_000)
})

test("a session's start fills an empty file", async ($, on) => {
  const empty = usageSetup(on)
  await start($)
  expect(empty.pct()).toBe(40)
})

test("a session's start leaves a newer reading alone", async ($, on) => {
  const u = usageSetup(on, { at: 1_999_999_000, pct: 86 })
  await start($)
  expect(u.pct()).toBe(86)
})

test('an older measurement never replaces a newer one in the file', async ($, on) => {
  const u = usageSetup(on, { at: 2_000_000_500, pct: 86 }) // another session measured after this one
  await measure($, 85)
  expect(u.pct()).toBe(86)
})

// The permissions side: it sends the ask to the app's server, which holds each request 20 s,
// asks again on 204, and returns your decision; on 410, an error or anything it doesn't
// expect, the session's own dialog decides.
const PSID = '00000000-0000-4000-8000-00000000beef'
type PermitReply = { status: number; text?: string; after?: number; proof?: Proof } | 'down'
function permitSetup(on: any, o: { env?: Record<string, string>; replies?: PermitReply[]; file?: string | null; server?: string } = {}) {
  const clock = mock.clock(on, { now: 3_000_000 })
  mock.env(on, { HOME, ...o.env })
  const k = keys(on, o)
  const posts: { url: string; init: any; body: any }[] = []
  const replies = [...(o.replies ?? [])]
  let passed = 0
  on('session.id', () => ({ value: PSID }))
  on('http.fetch', async (_: any, e: any) => {
    if (!e.url.includes('/api/permission/')) {
      await clock.sleep(20_000) // the answers loop, if it runs: nothing to submit
      return reply(k, e, 204)
    }
    posts.push({ url: e.url, init: e.init, body: JSON.parse(e.init?.body ?? 'null') })
    if (refused(k, e)) return forbidden
    const r = replies.shift()
    if (r === 'down') throw new Error('connection refused')
    if (!r) {
      await clock.sleep(20_000)
      return reply(k, e, 204)
    }
    if (r.after) await clock.sleep(r.after)
    return reply(k, e, r.status, r.text, r.proof)
  })
  on('classic.PermissionRequest', () => {
    passed++ // the dialog decides
    return {}
  })
  return { clock, posts, passed: () => passed, k }
}
// Raises the ask and runs the clock past the server's replies.
const askPermit = async ($: any, s: { clock: any }, tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) => {
  const r = $.classic.PermissionRequest({ session_id: PSID, tool_name, tool_input, ...extra })
  await s.clock.advance(70_000)
  return r
}
const decided = (d: string) => ({ status: 200, text: JSON.stringify({ decision: d }), after: 5_000 })

test('a permission allowed on the card is allowed', async ($, on) => {
  const s = permitSetup(on, { replies: [decided('allow')] })
  const r = await askPermit($, s, 'Bash', { command: 'make test' })
  expect(r.decision).toEqual({ behavior: 'allow' })
  expect(s.passed()).toBe(0)
  expect(s.posts.length).toBe(1)
  expect(s.posts[0].url).toBe(`http://127.0.0.1:4747/api/permission/${PSID}`)
  expect(s.posts[0].init.method).toBe('POST')
  expect(s.posts[0].init.headers['x-csm']).toBe('1')
  expect(s.posts[0].init.headers['x-csm-plugin']).toBe(mine(KEY, s.posts[0].init.headers))
  expect(s.posts[0].init.headers['x-csm-nonce']).toMatch(/^[0-9a-f]{32}$/)
  expect(Object.keys(s.posts[0].body).sort()).toEqual(['id', 'tool', 'what'])
  expect(s.posts[0].body.tool).toBe('Bash')
  expect(s.posts[0].body.what).toBe('make test')
})

test('the key itself is never sent, in any header of a held permission', async ($, on) => {
  const s = permitSetup(on, { replies: [{ status: 204, after: 20_000 }, decided('allow')] })
  const r = await askPermit($, s, 'Bash', { command: 'ls' })
  expect(r.decision).toEqual({ behavior: 'allow' })
  expect(s.posts.length).toBe(2)
  keyNeverIn(s.posts.map((x) => x.init.headers))
})

const proofWords = { none: 'no proof', bad: 'a wrong proof', echo: 'its own proof sent back' }
for (const proof of ['none', 'bad', 'echo'] as Proof[]) {
  for (const d of ['allow', 'deny']) {
    test(`a decision to ${d} with ${proofWords[proof]} is never returned: the dialog decides`, async ($, on) => {
      const s = permitSetup(on, { replies: [{ ...decided(d), proof }] })
      const r = await askPermit($, s, 'Bash', { command: 'ls' })
      expect(r.decision).toBeUndefined()
      expect(s.passed()).toBe(1)
      expect(s.posts.length).toBe(1)
    })
  }
}

for (const status of [204, 409, 410]) {
  test(`a ${status} without the proof: the dialog decides at once`, async ($, on) => {
    const s = permitSetup(on, { replies: [{ status, after: 1_000, proof: 'none' }, decided('allow')] })
    const r = await askPermit($, s, 'Bash', { command: 'ls' })
    expect(r.decision).toBeUndefined()
    expect(s.passed()).toBe(1)
    expect(s.posts.length).toBe(1) // never asked again, so the allow after it never comes
  })
}

test('with no key file it sends nothing and the dialog decides', async ($, on) => {
  const s = permitSetup(on, { file: null, replies: [decided('allow')] })
  const r = await askPermit($, s, 'Bash', { command: 'ls' })
  expect(r.decision).toBeUndefined()
  expect(s.posts.length).toBe(0)
  expect(s.passed()).toBe(1)
})

test('a 403 (an old key) steps aside, and the next ask reads the new key', async ($, on) => {
  const s = permitSetup(on, { server: OTHER, replies: [decided('allow'), decided('allow')] })
  const first = await askPermit($, s, 'Bash', { command: 'ls' })
  expect(first.decision).toBeUndefined()
  expect(s.posts[0].init.headers['x-csm-plugin']).toBe(mine(KEY, s.posts[0].init.headers))
  s.k.file = OTHER + '\n'
  const second = await askPermit($, s, 'Bash', { command: 'ls' })
  expect(second.decision).toEqual({ behavior: 'allow' })
  expect(s.posts[1].init.headers['x-csm-plugin']).toBe(mine(OTHER, s.posts[1].init.headers))
  expect(s.passed()).toBe(1)
})

test('each round of a held ask has a new nonce, and each reply is checked', async ($, on) => {
  const s = permitSetup(on, { replies: [{ status: 204, after: 20_000 }, { ...decided('allow'), proof: 'bad' }] })
  const r = await askPermit($, s, 'Bash', { command: 'ls' })
  expect(r.decision).toBeUndefined() // the first round was proved, the second wasn't
  expect(s.posts.length).toBe(2)
  expect(s.posts[1].init.headers['x-csm-nonce']).not.toBe(s.posts[0].init.headers['x-csm-nonce'])
})

// The proof: SHA-256 and HMAC-SHA256 against known answers.
test('SHA-256 and HMAC-SHA256 give the known answers', async () => {
  expect(hex(sha256(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(hex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  // Two blocks of padding: 56 bytes leave no room for the length in the first.
  expect(hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
  // RFC 4231, test case 2.
  expect(hmac('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  // A key like the app's, 64 hex characters: exactly one block, so it is neither hashed nor
  // padded. Built here from HMAC's definition, with no shortcut through hmac().
  const k = utf8(KEY)
  const n = '0123456789abcdef0123456789abcdef'
  const inner = sha256([...k.map((b) => b ^ 0x36), ...utf8(n)])
  expect(hmac(KEY, n)).toBe(hex(sha256([...k.map((b) => b ^ 0x5c), ...inner])))
  // The same key and nonce, with the values node:crypto's createHmac gives, as the server computes them.
  expect(hmac(KEY, n)).toBe('b7a997d0984067092815b2fe91612ca818b74b6da48bd54370f32ec4746b8ebe')
  expect(hmac(KEY, `plugin:${n}`)).toBe('5421020a64927c839dff2c076c6aa031d6e1cc17614094395e1992ff54999b0b')
  expect(hmac(KEY, `server:${n}`)).toBe('a3ad64d936eab5a111f016485a528b4b405f53721b866084beee119256e151ff')
})

test('the request carries the plugin side HMAC of its nonce, never the key', async () => {
  const n = '0123456789abcdef0123456789abcdef'
  expect(headersFor(KEY, n)).toEqual({
    'x-csm': '1',
    'x-csm-plugin': '5421020a64927c839dff2c076c6aa031d6e1cc17614094395e1992ff54999b0b',
    'x-csm-nonce': n,
  })
})

test('a proof is checked whole, in any letter case, only for its own nonce and only from the server side', async () => {
  const n = nonce()
  expect(n).toMatch(/^[0-9a-f]{32}$/)
  expect(nonce()).not.toBe(n)
  const p = hmac(KEY, `server:${n}`)
  expect(proved({ 'x-csm-proof': p }, KEY, n)).toBe(true)
  expect(proved({ 'X-CSM-Proof': p.toUpperCase() }, KEY, n)).toBe(true)
  expect(proved({ 'x-csm-proof': p.slice(0, 63) }, KEY, n)).toBe(false)
  expect(proved({ 'x-csm-proof': p }, KEY, nonce())).toBe(false)
  expect(proved({ 'x-csm-proof': hmac(OTHER, `server:${n}`) }, KEY, n)).toBe(false)
  expect(proved({ 'x-csm-proof': hmac(KEY, `plugin:${n}`) }, KEY, n)).toBe(false) // the request's own proof, sent back
  expect(proved({ 'x-csm-proof': hmac(KEY, n) }, KEY, n)).toBe(false) // no side named
  expect(proved({ 'x-csm-proof': KEY }, KEY, n)).toBe(false)
  expect(proved({}, KEY, n)).toBe(false)
  expect(proved(undefined, KEY, n)).toBe(false)
})

test('a permission denied on the card is denied, with a message', async ($, on) => {
  const s = permitSetup(on, { replies: [decided('deny')] })
  const r = await askPermit($, s, 'Write', { file_path: '/work/notes/todo.md', content: 'x' })
  expect(r.decision).toEqual({ behavior: 'deny', message: "Denied from the session's card." })
})

test('it asks again on 204 with the same ask, then takes the decision', async ($, on) => {
  const s = permitSetup(on, { replies: [{ status: 204, after: 20_000 }, { status: 204, after: 20_000 }, decided('allow')] })
  const r = await askPermit($, s, 'WebFetch', { url: 'https://example.com/docs' }, { agent_id: 'agent-7' })
  expect(r.decision).toEqual({ behavior: 'allow' })
  expect(s.posts.length).toBe(3)
  expect(s.posts[1].init.body).toBe(s.posts[0].init.body)
  expect(s.posts[2].init.body).toBe(s.posts[0].init.body)
  expect(s.posts[0].body.agent).toBe('agent-7')
  expect(s.posts[0].body.what).toBe('https://example.com/docs')
})

test('settled in the dialog (410), the dialog decides', async ($, on) => {
  const s = permitSetup(on, { replies: [{ status: 410, after: 3_000 }] })
  const r = await askPermit($, s, 'Bash', { command: 'ls' })
  expect(r.decision).toBeUndefined()
  expect(s.passed()).toBe(1)
  expect(s.posts.length).toBe(1)
})

for (const [name, reply] of [['the app closed', 'down'], ['a 500', { status: 500 }], ['a body that is not JSON', { status: 200, text: 'not json' }],
  ['a decision it does not know', { status: 200, text: '{"decision":"maybe"}' }]] as [string, PermitReply][]) {
  test(`with ${name}, the dialog decides at once`, async ($, on) => {
    const s = permitSetup(on, { replies: [reply] })
    const r = await askPermit($, s, 'Bash', { command: 'ls' })
    expect(r.decision).toBeUndefined()
    expect(s.posts.length).toBe(1) // never retried
    expect(s.passed()).toBe(1)
  })
}

test('a question or a plan is left to its dialog, and so is everything in the usage check', async ($, on) => {
  const s = permitSetup(on)
  await askPermit($, s, 'AskUserQuestion', { questions: [] })
  await askPermit($, s, 'ExitPlanMode', { plan: 'x' })
  expect(s.posts.length).toBe(0)
  expect(s.passed()).toBe(2)
})

test('in the app own usage check it never asks for a permission', async ($, on) => {
  const s = permitSetup(on, { env: { CSM_PROBE: '1' } })
  await askPermit($, s, 'Bash', { command: 'ls' })
  expect(s.posts.length).toBe(0)
  expect(s.passed()).toBe(1)
})

test('the port comes from CSM_PORT for permissions too', async ($, on) => {
  const s = permitSetup(on, { env: { CSM_PORT: '4759' }, replies: [decided('allow')] })
  await askPermit($, s, 'Bash', { command: 'ls' })
  expect(s.posts[0].url).toBe(`http://127.0.0.1:4759/api/permission/${PSID}`)
})

test('after an hour of rounds the dialog decides', async ($, on) => {
  const s = permitSetup(on) // the server holds each round 20 s and nothing is clicked
  const r = $.classic.PermissionRequest({ session_id: PSID, tool_name: 'Bash', tool_input: { command: 'ls' } })
  await s.clock.advance(61 * 60_000)
  expect((await r).decision).toBeUndefined()
  expect(s.passed()).toBe(1)
  expect(s.posts.length).toBe(180)
})

test('what it asks, as one line', async () => {
  expect(whatOf('Bash', { command: 'npm run build \\\n  --watch', description: 'Build' })).toBe('npm run build \\ --watch')
  expect(whatOf('Edit', { file_path: '/work/notes/a.md', old_string: 'x' })).toBe('/work/notes/a.md')
  expect(whatOf('NotebookEdit', { notebook_path: '/work/n.ipynb' })).toBe('/work/n.ipynb')
  expect(whatOf('WebFetch', { url: 'https://example.com', prompt: 'Read it' })).toBe('https://example.com')
  expect(whatOf('WebSearch', { query: 'tide tables' })).toBe('tide tables')
  expect(whatOf('Grep', { pattern: 'TODO', path: '/work/src' })).toBe('TODO in /work/src')
  expect(whatOf('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  expect(whatOf('Skill', { skill: 'pdf' })).toBe('pdf')
  expect(whatOf('mcp__notes__save', { body: 'x', title: 'Shopping list' })).toBe('Shopping list')
  expect(whatOf('mcp__notes__count', { n: 3, flags: { all: true } })).toBe('{"n":3,"flags":{"all":true}}')
  expect(whatOf('Bash', { command: 'a\n\n\tb   c ' })).toBe('a b c')
  expect(whatOf('Bash', { command: 'x'.repeat(5000) })).toBe('x'.repeat(300))
})
