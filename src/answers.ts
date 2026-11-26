// Answering a session from its card. A session that ends its turn with a question and answer
// buttons (the Claude app's next-step box) shows those buttons on its Needs you card. A click
// hands the answer at once to the session's answers mod (plugin/), which is waiting on its
// ask here and submits it as the session's next prompt. In the app, a card whose session
// is waiting on you (Done, Needs you or Error, its mod listening: canSay) also takes words
// you dictated with its mic and sent, the same way. Only a label the session offered or the
// words you sent, only after your click, and never saved: they live in memory.
//
//   POST /api/answer/:sid       {"i": 0}       the page: answer with button i
//   POST /api/answer/:sid       {"text": "…"}  the page: answer with your words (1–1000 characters)
//   GET  /api/answer/:sid/next                 the mod: waits up to 20 s for an answer to submit
//
// Both need the x-csm header, like /api/open, and the kit's host check. An answer the session
// can no longer take (a new prompt came, it began working, it ended, or it now waits on a
// permission) is dropped, never handed over.

import { type Answer, type Reply, type Session, sessions, bump, bumpView } from "./state.ts";
import { fromPage, fromPlugin, signed } from "./keys.ts";
import { activeAgents } from "./agents.ts";
import { safe } from "./server-kit.ts";
import { shownStatus } from "./snapshot.ts";

export const HOLD_MS = 20_000; // how long the mod's ask waits for an answer
export const LISTEN_MS = 60_000; // a mod that asked this recently is there to take one
// How long an answer waits for a mod to ask, when none is asking at the click, before it counts as not sent.
export const GIVE_UP_MS = Number(process.env.CSM_ANSWER_GIVE_UP_MS) || 20_000;
// How long a handed-over answer waits for its prompt to show up before it counts as not sent.
export const ARRIVE_MS = Number(process.env.CSM_ANSWER_ARRIVE_MS) || 30_000;

// The Claude app's own actions, in the words its buttons show. Only the app can do them, so
// their button only opens the session.
const APP_WORDS: Record<string, string> = {
  commit: "Commit", create_pr: "Create PR", merge: "Merge", fix_ci: "Fix CI",
  address_comments: "Address comments", resolve_conflicts: "Resolve conflicts", verify: "Verify",
  archive: "Archive", new_session: "New session",
};

export const MAX_SAID = 1000; // the words you send from a card, at most
const words = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

// The buttons, from a hook line's acts ({l, a}) or the transcript's wrap_up actions
// ({label, action}): the first two, cut as the hook cuts them.
export function answersOf(raw: unknown): Answer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.slice(0, 2).flatMap((b: any): Answer[] => {
    if (!b || typeof b !== "object") return [];
    const label = words(b.l ?? b.label, 40);
    const app = words(b.a ?? b.action, 30);
    if (app) return [{ label: APP_WORDS[app] ?? (label || app), app }];
    return label ? [{ label }] : [];
  });
  return list.length ? list : undefined;
}

// ---------------------------------------------------------------- who can take an answer

// When each session's mod last asked, by session ID. Kept apart from the sessions, since a
// mod can ask before the session's first hook line arrives.
const heard = new Map<string, number>();
export const canAnswer = (sid: string, now = Date.now()) => now - (heard.get(sid) ?? -Infinity) < LISTEN_MS;

// The mod's ask that's waiting, one per session.
type Waiter = { resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> };
const waiters = new Map<string, Waiter>();
// The timers of each session's answer: giving up when no mod takes it, or when its prompt never arrives.
const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

const later = (name: string, ms: number, fn: () => void) => setTimeout(safe(name, fn), Math.max(0, ms));

// A session's answer timer: when it has fired it leaves the list, and the entry goes with the last one.
function slot(sid: string, name: string, ms: number, fn: () => void) {
  const t: ReturnType<typeof setTimeout> = later(name, ms, () => {
    const rest = (timers.get(sid) ?? []).filter((x) => x !== t);
    if (rest.length) timers.set(sid, rest);
    else timers.delete(sid);
    fn();
  });
  timers.set(sid, [...(timers.get(sid) ?? []), t]);
}

const live = (s: Session | undefined): s is Session => !!s && !s.archived && s.status !== "ended";
// It ended its turn with this question and it still stands.
const asking = (s: Session) => s.status === "done" && s.outcome === "asks" && shownStatus(s, activeAgents(s)) === "asks";
// Its turn is over and nothing of it runs: it waits on you (Done, Needs you or Error), not on a
// permission. It takes words you send, when its mod is listening (canSay in the snapshot).
const SAYS = new Set(["asks", "done", "error"]);
export const sayable = (s: Session | undefined): s is Session => live(s) && s.status === "done" && SAYS.has(shownStatus(s, activeAgents(s)));
// Whether the session can still take this reply: a button's needs its question, words need it to wait on you.
const takes = (s: Session, r: { i: number }) => (r.i >= 0 ? live(s) && asking(s) : sayable(s));

function end(sid: string, w: Waiter, r: Response) {
  clearTimeout(w.timer);
  if (waiters.get(sid) === w) waiters.delete(sid);
  w.resolve(r);
}

// Hands a clicked answer to the mod that's waiting, if one is. A session that can no longer
// take it (it moved on with no prompt: a background task woke it, it ended, or it wants a
// permission) drops the answer instead, so it never lands as a prompt in a turn it wasn't
// meant for.
function deliver(sid: string) {
  const s = sessions.get(sid);
  const r = s?.reply;
  if (!s || !r || r.state !== "pending") return;
  if (!takes(s, r)) {
    clearReply(s);
    bump(s);
    return;
  }
  const w = waiters.get(sid);
  if (!w) return;
  r.state = "sent";
  end(sid, w, Response.json({ text: r.text }));
  slot(sid, "answer", ARRIVE_MS, () => {
    if (s.reply !== r || r.state !== "sent") return; // its prompt arrived, or a newer closing came
    r.state = "failed"; // handed over but never became a prompt: the card needs you again
    bump(s);
  });
  bump(s);
}

function clearTimers(sid: string) {
  for (const t of timers.get(sid) ?? []) clearTimeout(t);
  timers.delete(sid);
}

// A new prompt (the answer arriving, or you typing) ends the question and its answer.
export function forgetAnswer(s: Session) {
  s.answers = undefined;
  clearReply(s);
}

// A reply and its timers, for a closing that brings its own buttons.
export function clearReply(s: Session) {
  s.reply = undefined;
  clearTimers(s.sid);
}

// The 3 s tick: a mod that stopped asking can no longer take an answer, and the card says so
// (its buttons open the session, its mic goes). An answer still waiting for a mod, for a
// session that moved on, is dropped.
let couldAnswer = new Set<string>();
export function checkAnswers(now = Date.now()) {
  for (const [sid, at] of heard) if (now - at >= LISTEN_MS) heard.delete(sid);
  for (const s of sessions.values()) if (s.reply?.state === "pending" && !takes(s, s.reply)) deliver(s.sid);
  const can = new Set([...heard.keys()].filter((sid) => sessions.has(sid)));
  if (can.size !== couldAnswer.size || [...can].some((sid) => !couldAnswer.has(sid))) bumpView();
  couldAnswer = can;
}

// ---------------------------------------------------------------- the routes

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const none = (status: number) => new Response(null, { status });

export function answerRoutes(req: Request, url: URL): Response | Promise<Response> | undefined {
  const m = url.pathname.match(/^\/api\/answer\/([^/]+)(\/next)?$/);
  if (!m) return undefined;
  if (req.headers.get("x-csm") !== "1") return none(403);
  const sid = m[1];
  // The plugin's ask needs the plugin key; sending an answer needs the window's (src/keys.ts).
  if (m[2] === "/next") {
    if (!fromPlugin(req)) return none(403);
    if (!SID.test(sid)) return signed(req, none(404));
    return signed(req, req.method === "GET" ? next(req, sid) : none(405));
  }
  if (!fromPage(req)) return none(403);
  if (!SID.test(sid)) return none(404);
  if (req.method !== "POST") return none(405);
  return answer(req, sid);
}

async function answer(req: Request, sid: string): Promise<Response> {
  let i = -1;
  let said: string | undefined;
  let since: unknown;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.i)) i = body.i;
    else if (typeof body?.text === "string") { said = body.text.replace(/\s+/g, " ").trim(); since = body.since; }
  } catch {}
  const s = sessions.get(sid);
  let text: string;
  if (said !== undefined) {
    // Your words: one line, 1 to 1000 characters, for a session that waits on you.
    if (!said || said.length > MAX_SAID) return none(400);
    if (!s) return none(404);
    if (since !== undefined && since !== s.since) return none(409); // the session moved on since you spoke
    if (!sayable(s)) return none(409); // it works, waits on a permission, or ended: open it
    text = said;
  } else {
    const a = live(s) ? s.answers?.[i] : undefined;
    if (!s || !a || a.app || !asking(s)) return none(404);
    text = a.label;
  }
  if (s.reply?.state === "sent") return none(409); // already on its way
  const now = Date.now();
  if (!canAnswer(sid, now)) return none(409); // no mod to take it: the page opens the session
  clearTimers(sid);
  // Pending only until the mod takes it: at once when it's asking, at its next ask otherwise.
  const r: Reply = (s.reply = { text, i: said !== undefined ? -1 : i, at: now, state: "pending" });
  slot(sid, "answer", GIVE_UP_MS, () => {
    if (s.reply !== r || r.state !== "pending") return;
    r.state = "failed"; // no mod took it: the card needs you again
    bump(s);
  });
  bump(s);
  deliver(sid);
  return none(204);
}

// The mod's ask: an answer as soon as there is one, or nothing after 20 s. A newer ask for the
// same session ends the older one.
function next(req: Request, sid: string): Promise<Response> {
  const now = Date.now();
  const was = canAnswer(sid, now);
  heard.set(sid, now);
  if (!was && sessions.has(sid)) bumpView(); // its card can send now: its buttons, its mic
  const old = waiters.get(sid);
  if (old) end(sid, old, none(204));
  return new Promise<Response>((resolve) => {
    const w: Waiter = { resolve, timer: later("answer", HOLD_MS, () => end(sid, w, none(204))) };
    waiters.set(sid, w);
    req.signal?.addEventListener("abort", () => end(sid, w, none(204)));
    deliver(sid); // one clicked while it wasn't asking
  });
}
