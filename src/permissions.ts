// Allowing or denying a permission from a session's card. When a session asks for a
// permission, the plugin's permission hook (plugin/) sends the ask here and holds: the tool's
// name, what it asks for (the command, the file, the address… as one line), an ID of its own
// and the subagent's ID, if one asks. While the session shows that wait, its card shows what
// it asks with Allow and Deny; a click answers the held request, and the session runs or
// refuses the tool. The app's own dialog stays up the whole time: answered there (or once the
// session moves on any other way), the held request ends with 410 and the hook leaves the
// decision to the dialog. All of it lives in memory only, apart from the sessions, so none of
// it reaches sessions.db; nothing here is ever written to a file or to a log line.
//
//   POST /api/permission/:sid         {"id", "tool", "what", "agent"?}  the mod: held up to 20 s
//   POST /api/permission/:sid/decide  {"id", "allow": true|false}       the page: your decision
//
// Both need the x-csm header, like /api/answer, and the kit's host check.

import { type Session, sessions, bumpView } from "./state.ts";
import { safe } from "./server-kit.ts";

const ms = (name: string, fallback: number) => Number(process.env[name]) || fallback; // the tests shorten them
export const PERMIT_HOLD_MS = ms("CSM_PERMIT_HOLD_MS", 20_000); // how long the mod's request is held
const HEARD_MS = ms("CSM_PERMIT_HEARD_MS", 25_000); // a mod that asked this recently is still there
const SHOW_MS = ms("CSM_PERMIT_SHOW_MS", 10_000); // an ask whose session never shows the wait by then is dropped
const GIVE_UP_MS = ms("CSM_PERMIT_GIVE_UP_MS", 20_000); // a decision no mod picked up by then wasn't sent
const GONE_MS = 60_000; // a dropped ask's ID answers 410 this long, for a round already on its way

export const MAX_WHAT = 300;
const BODY_MAX = 8192;

type Waiter = { resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> };
// held: the mod asks and nothing is decided; sending: decided, not yet handed to the mod;
// sent: handed over, kept until the session leaves the wait; failed: no mod took it in time.
export type PermitState = "held" | "sending" | "sent" | "failed";
type Ask = {
  sid: string; id: string; tool: string; what: string; agent?: string;
  at: number; // when it first arrived
  heard: number; // the mod's last request for it
  seen: boolean; // its session showed the permission wait while it was here
  state: PermitState;
  allow?: boolean;
  waiter?: Waiter; // the mod's request, while it's held
  timer?: ReturnType<typeof setTimeout>; // giving up on a decision
};

// Each session's asks, oldest first (parallel subagents can ask at once).
const asks = new Map<string, Ask[]>();
// Asks dropped lately, by "sid id", so a request for one gets 410 instead of starting it over.
const gone = new Map<string, number>();

const later = (ms: number, fn: () => void) => setTimeout(safe("permission", fn), Math.max(0, ms));
const none = (status: number) => new Response(null, { status });
const decision = (a: Ask) => Response.json({ decision: a.allow ? "allow" : "deny" });

// The session shows the permission wait.
const waits = (s: Session | undefined): s is Session =>
  !!s && !s.archived && s.status === "waiting" && s.waitKind === "permission";
// Its mod is there: holding a request now, or asked a moment ago (between two rounds).
const asking = (a: Ask, now: number) => !!a.waiter || now - a.heard < HEARD_MS;
const here = (a: Ask) => asks.get(a.sid)?.includes(a) ?? false;

function end(a: Ask, w: Waiter, r: Response) {
  clearTimeout(w.timer);
  if (a.waiter === w) a.waiter = undefined;
  w.resolve(r);
  // A request that ended with nothing: if the mod doesn't ask again, the ask goes.
  if (r.status === 204) later(HEARD_MS + 50, () => checkPermits());
}

function drop(a: Ask, now: number) {
  if (a.waiter) end(a, a.waiter, none(410));
  clearTimeout(a.timer);
  const rest = (asks.get(a.sid) ?? []).filter((x) => x !== a);
  if (rest.length) asks.set(a.sid, rest);
  else asks.delete(a.sid);
  gone.set(`${a.sid} ${a.id}`, now);
}

// Hands the decision to the mod's request: the session runs or refuses the tool. The ask then
// stays "sent" until the session leaves the wait (after an allow that's only when the tool
// finishes, however long it takes), and checkPermits drops it.
function hand(a: Ask) {
  a.state = "sent";
  clearTimeout(a.timer);
}

// Ends what's settled, in the same pass as the event that settled it (server.ts runs it on
// every change) and on the 3 s tick: an ask whose session showed the wait and left it (the
// tool ran or failed, the turn stopped, a new prompt, it ended or was archived), one whose
// session never showed the wait in time, and one whose mod stopped asking.
let checking = false;
export function checkPermits(now = Date.now()) {
  if (checking) return;
  checking = true;
  try {
    let changed = false;
    for (const [sid, list] of [...asks]) {
      const inWait = waits(sessions.get(sid));
      for (const a of [...list]) {
        if (inWait) a.seen = true;
        const settled = inWait
          ? a.state === "held" && !asking(a, now)
          : a.seen || now - a.at >= SHOW_MS;
        if (!settled) continue;
        drop(a, now);
        changed = true;
      }
    }
    for (const [key, at] of gone) if (now - at >= GONE_MS) gone.delete(key);
    if (changed) bumpView();
  } finally {
    checking = false;
  }
}

// What the card shows: the oldest ask its mod is asking about, or one you decided, while the
// session shows the permission wait.
export function permitOf(s: Session, now = Date.now()) {
  if (!waits(s)) return undefined;
  const a = asks.get(s.sid)?.find((x) => x.state !== "held" || asking(x, now));
  if (!a) return undefined;
  return { id: a.id, tool: a.tool, what: a.what, state: a.state, ...(a.allow !== undefined ? { allow: a.allow } : {}) };
}

// ---------------------------------------------------------------- the routes

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max;
export const oneLine = (v: string) => v.replace(/\s+/g, " ").trim().slice(0, MAX_WHAT);

export function permissionRoutes(req: Request, url: URL): Response | Promise<Response> | undefined {
  const m = url.pathname.match(/^\/api\/permission\/([^/]+)(\/decide)?$/);
  if (!m) return undefined;
  if (req.headers.get("x-csm") !== "1") return none(403);
  const sid = m[1];
  if (!SID.test(sid)) return none(404);
  if (req.method !== "POST") return none(405);
  return m[2] ? decide(req, sid) : hold(req, sid);
}

async function body(req: Request): Promise<any> {
  try {
    const raw = await req.text();
    if (raw.length > BODY_MAX) return null;
    const b = JSON.parse(raw);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

// The mod's request: the decision as soon as there is one, 204 after 20 s with none (it asks
// again with the same ID), or 410 once the ask is settled. A newer request for the same ask
// ends the older one. An ask may come before its session's hook line, or before its session
// is known at all.
async function hold(req: Request, sid: string): Promise<Response> {
  const b = await body(req);
  if (!b || !text(b.id, 1, 64) || !text(b.tool, 1, 100) || typeof b.what !== "string") return none(400);
  if (b.agent !== undefined && !text(b.agent, 0, 64)) return none(400);
  if (gone.has(`${sid} ${b.id}`)) return none(410);
  const now = Date.now();
  let a = asks.get(sid)?.find((x) => x.id === b.id);
  if (!a) {
    a = {
      sid, id: b.id, tool: b.tool.replace(/\s+/g, " ").trim(), what: oneLine(b.what),
      ...(b.agent ? { agent: b.agent as string } : {}),
      at: now, heard: now, seen: false, state: "held",
    };
    asks.set(sid, [...(asks.get(sid) ?? []), a]);
    later(SHOW_MS + 50, () => checkPermits()); // dropped if its session never shows the wait
    if (sessions.has(sid)) bumpView();
  }
  const ask = a;
  ask.heard = now;
  if (ask.waiter) end(ask, ask.waiter, none(204));
  if (ask.state === "sending") {
    hand(ask);
    bumpView();
    return decision(ask);
  }
  if (ask.state === "sent") return decision(ask); // its answer got lost on the way: the same again
  return new Promise<Response>((resolve) => {
    const w: Waiter = { resolve, timer: later(PERMIT_HOLD_MS, () => end(ask, w, none(204))) };
    ask.waiter = w;
    req.signal?.addEventListener("abort", () => end(ask, w, none(204)));
    checkPermits(); // its session may show the wait already, or have moved on
  });
}

// The page's click. 204 taken; 404 no such ask; 409 already decided or settled, or its
// session doesn't show the permission wait.
async function decide(req: Request, sid: string): Promise<Response> {
  const b = await body(req);
  if (!b || !text(b.id, 1, 64) || typeof b.allow !== "boolean") return none(400);
  const now = Date.now();
  checkPermits(now);
  const a = asks.get(sid)?.find((x) => x.id === b.id);
  if (!a) return none(gone.has(`${sid} ${b.id}`) ? 409 : 404);
  if (a.state !== "held" || !waits(sessions.get(sid))) return none(409);
  a.allow = b.allow;
  a.state = "sending";
  if (a.waiter) {
    const w = a.waiter;
    hand(a);
    end(a, w, decision(a));
  } else {
    // The mod is between two rounds: its next request takes it.
    a.timer = later(GIVE_UP_MS, () => {
      if (!here(a) || a.state !== "sending") return;
      a.state = "failed";
      bumpView();
    });
  }
  bumpView();
  return none(204);
}
