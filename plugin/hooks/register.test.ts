import { expect, mock, test } from 'claude-code/testing'

// The answers side of the mod against a stand-in for the app's server, which holds each ask 20 s: it asks for its
// own session with the x-csm header, submits exactly the answer it gets, asks again at once,
// waits 15 s when the app is closed, and never runs in the app's usage check.
const SID = '00000000-0000-4000-8000-00000000abcd'
type Reply = { status: number; text?: string } | 'down'
function setup(on: any, o: { env?: Record<string, string>; replies?: Reply[] } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, o.env ?? {})
  const asks: { url: string; headers: any; at: number }[] = []
  const prompts: string[] = []
  const asUser: boolean[] = []
  const replies = [...(o.replies ?? [])]
  on('session.id', () => ({ value: SID }))
  on('http.fetch', async (_: any, e: any) => {
    asks.push({ url: e.url, headers: e.init?.headers, at: clock.now() })
    const r = replies.shift()
    if (r === 'down') throw new Error('connection refused')
    if (!r) {
      await clock.sleep(20_000) // nothing clicked: the server lets the ask go after 20 s
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    return { value: { status: r.status, ok: r.status < 300, headers: {}, text: r.text ?? '' } }
  })
  on('prompt.submit', (_: any, e: any) => {
    prompts.push(e.text)
    asUser.push(e.origin?.asUser === true)
    return { text: e.text }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { clock, asks, prompts, asUser }
}
const start = ($: any) => $.session.start({ cwd: '/work/notes', surface: 'desktop', isInteractive: false })

test('it asks the app for its own session and keeps asking, with nothing to submit', async ($, on) => {
  const s = setup(on)
  await start($)
  await s.clock.advance(65_000)
  expect(s.asks.length).toBe(4) // one at the start, then again as each 20 s ask ends
  expect(s.asks[0].url).toBe(`http://127.0.0.1:4747/api/answer/${SID}/next`)
  expect(s.asks[0].headers).toEqual({ 'x-csm': '1' })
  expect(s.prompts).toEqual([])
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
const HOME = '/home/someone'
const FILE = `${HOME}/.claude-session-monitor/usage.json`
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
