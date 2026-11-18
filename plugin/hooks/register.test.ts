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
    return { text: e.text }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { clock, asks, prompts }
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

test('a reply that is not an answer submits nothing', async ($, on) => {
  const long = 'x'.repeat(41)
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
