import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Claude Session Monitor's usage, from the readings Claude Code already takes: each time
// the plan's limits change, the two percentages and when they reset go to
// ~/.claude-session-monitor/usage.json, the file the app reads. Nothing on screen, no
// timer, no process, no network: it only writes when Claude Code hands it new numbers,
// and only when the app is installed (its folder exists).

// Written when the numbers change, and at least every 5 minutes while Claude Code keeps
// measuring, so the app sees fresh numbers and never starts its own check.
const FRESH_MS = 5 * 60_000
let written = 0

async function save($: EngineInterface, limits: SessionRateLimit[]) {
  const seven = limits.find((l) => l.kind === 'seven_day')
  if (!seven?.resetsAt) return
  const home = await $.env.get('HOME')
  const dir = home && `${home}/.claude-session-monitor`
  if (!dir || !(await $.fs.exists(dir))) return
  const five = limits.find((l) => l.kind === 'five_hour')
  const window = (l?: SessionRateLimit) =>
    l?.resetsAt ? { used_percentage: l.percentUsed, resets_at: Math.floor(Date.parse(l.resetsAt) / 1000) } : null
  const now = await $.clock.now()
  written = now
  await $.fs.write(`${dir}/usage.json`, JSON.stringify({ at: now / 1000, week: window(seven), five_hour: window(five) }))
}

async function first($: EngineInterface) {
  const usage = await $.session.usage().catch(() => null)
  if (usage) await save($, usage.rateLimits).catch(() => {})
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await first($)
    return next(e)
  })
  on('session.measure', async ($, e, next) => {
    const stale = (await $.clock.now()) - written > FRESH_MS
    if (e.changed.includes('rateLimits') || stale) await save($, e.rateLimits).catch(() => {})
    return next(e)
  })
}
