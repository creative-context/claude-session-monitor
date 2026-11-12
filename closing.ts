// The rules that read a turn's closing message: does it ask you something, and is the
// question its own or one it passes on from another session? Pure text rules, no state:
// `test/closing.test.ts` holds a table of cases for them.
//
// A closing asks you when it speaks to you: a question it ends on (or one just before a
// sentence that explains it), or a request in the second person or the imperative ("dime
// cuál", "Elige una", "Approve the PR", "waiting for you to pick"). The same words said of
// something else ("El servidor elige el puerto", "The logs tell me…") don't ask you.

// Another session, as a closing may name it: its Claude Code ID, the Claude app's own ID
// for it ("local_…", when the app has one), and the names it goes by (its titles, its folder).
export type Other = { sid: string; local?: string; names: string[] };
export type Closing = {
  ask?: string; // the question or request, as found
  askText?: string; // what the card says
  relayed: string[]; // the sessions whose question it passes on to you
  relays: string[]; // every session it says is waiting for you
};

export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
// A sentence ends at . ! or ? followed by a space or the end, so "0.1.0" or "server.ts"
// stays inside one.
const SENTENCE = /(?:[^.!?\n]|[.!?]+(?=[^\s.!?]))+[.!?]*/g;
const LIST_ITEM = /^\s*(\d+[.)]|[-•+*])\s/;
const markless = (line: string) => line.replace(/[*_`#>]/g, "");
// Quoted lines ("> …") are what the session quotes, such as a message it sent for you;
// a question in them isn't one for you.
const closingLines = (text: string) => text.replace(/```[\s\S]*?```/g, " ").replace(/^[ \t]*>.*$/gm, "").split("\n");

// Everything a closing is read against: the other sessions, and this one's own names.
type Ctx = { others: Other[]; own: string[] };

export function classifyClosing(text: string, others: Other[] = [], own: string[] = []): Closing {
  const ctx = { others, own };
  const ask = closingQuestion(text) ?? closingRequest(text);
  return { ask, askText: ask && askWithLead(text, ask), relayed: ask ? relayedTo(text, ask, ctx) : [], relays: relaysIn(text, ctx) };
}

// ---------------------------------------------------------------- what the closing asks

// The last sentences of a closing message's last paragraph.
function closingSentences(text: string, count: number): string[] {
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/^[ \t]*>.*$/gm, "").replace(/[*_`#>]/g, "").trim();
  const last = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).at(-1) ?? "";
  const sentences = (last.match(SENTENCE) ?? []).map((s) => s.trim()).filter(Boolean);
  return sentences.slice(-count);
}

// The question a closing message ends on: its last sentence, or the one before it when that
// one speaks to you and the last explains it ("¿Lo subo a main? Así sale hoy."). A question
// the next sentence answers ("¿Por qué fallaba? La regla estaba en otra hoja.") is the
// session talking to itself. A question earlier in the text doesn't count, and neither does
// a short courtesy one ("¿Algo más?", "Anything else I can help with?").
// When the message ends on a list ("Lo que queda:" and its points), a question that ends
// one of its items counts too: "1. **La segunda parte.** … ¿La arranco?".
function closingQuestion(text: string): string | undefined {
  const open = (s: string) => s.endsWith("?") && !courtesyQuestion(s);
  const [prev, last] = closingSentences(text, 2).length === 2 ? closingSentences(text, 2) : [undefined, closingSentences(text, 1)[0]];
  const q = last && open(last) ? last
    : prev && open(prev) && !rhetorical(prev, last ?? "") ? prev
    : closingItems(text).map(lastSentence).find(open);
  return q && q.length > 3 ? q.slice(0, 160) : undefined;
}

// A question followed by its own answer: "¿Funcionó? Sí, ya pasa.", or one that asks about
// the work ("¿Por qué fallaba?", "What changed?") without speaking to you.
const ANSWER = /^(s[ií],|sí\b|yes\b|yep\b|yeah\b|nope\b|porque\b|because\b)/i;
const WH = /^(por que|para que|que|como|cual|cuales|donde|cuando|cuanto|cuantos|cuantas|quien|quienes|why|what|how|where|when|which|who)\b/;
function rhetorical(q: string, next: string): boolean {
  if (ANSWER.test(next.trim())) return true;
  return !addressesYou(q) && WH.test(fold(q).replace(/^[¿\s]+/, ""));
}

// Words that speak to you: tú/te/you, a verb in the second person, or the session offering
// its next step ("¿Lo subo?", "¿Sigo?", "Should I…?").
const SECOND = /\b(tu|tus|te|ti|contigo|usted|ustedes|you|your|yours|quieres|prefieres|puedes|podrias|necesitas|crees|opinas|piensas|eliges|escoges|decides|apruebas|confirmas|ves|sabes|tienes|gustas|ocupas|buscas|esperas|recuerdas|usas|dices|vas)\b/;
const NOT_VERB = new Set(["como", "cuando", "cuanto", "todo", "pero", "algo", "esto", "eso", "solo", "nuevo", "otro", "mismo", "claro", "listo", "junto", "ningun", "alguno", "ninguno", "tanto", "poco", "mucho", "luego", "pronto"]);
function addressesYou(q: string): boolean {
  const f = fold(q).replace(/^[¿\s]+/, "");
  if (SECOND.test(f)) return true;
  if (/^(should|shall|can|could|may) (i|we)\b|^(want me|ok to|okay to|ready to|good to go)\b|^(what|which|how|where|when)\b.*\b(should|shall)\b/.test(f)) return true;
  // "¿Lo subo…?", "¿Cómo lo dejo?", "¿Arranco?", "¿Por qué no lo probamos?": a verb in the
  // first person, after a question word. Read with its accents: "¿Qué cambió?" is the past.
  const lower = q.toLowerCase().replace(/^[¿\s]+/, "");
  const verb = lower.match(/^(?:(?:por qué|para qué|qué|cómo|cuál|cuáles|dónde|cuándo|cuánto|y|entonces|ya|también|mejor|ahora|no)\s+)*(?:(?:lo|la|los|las|le|les|se|me|nos)\s+)*(\p{L}+)/u)?.[1] ?? "";
  if (NOT_VERB.has(verb)) return false;
  return /^([a-zñ]{2,}o|doy|voy|estoy|[a-zñ]{2,}(amos|emos|imos))$/.test(verb);
}

// The items of the list a closing message ends on, each with its lines joined. Its items may
// sit apart, with blank lines between them; the list starts after its lead-in.
function closingItems(text: string): string[] {
  const lines = closingLines(text);
  const inList = (l: string) => LIST_ITEM.test(l) || /^\s+\S/.test(l);
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  const items: string[] = [];
  let cur: string[] = [];
  for (; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) {
      let j = i - 1;
      while (j >= 0 && !lines[j].trim()) j--;
      if (j < 0 || !inList(lines[j])) break;
      continue;
    }
    if (!inList(l)) break;
    cur.unshift(l.trim());
    if (LIST_ITEM.test(l) && !/^\s{2}/.test(l)) {
      items.unshift(cur.join(" ")); // a top-level item; indented lines above it are its own
      cur = [];
    }
  }
  return items;
}
const lastSentence = (item: string) =>
  (markless(item).replace(LIST_ITEM, "").match(SENTENCE) ?? []).map((s) => s.trim()).filter(Boolean).at(-1) ?? "";

// A question from a list item reads better with the item's bold lead: "La segunda parte,
// el menú. ¿La arranco?".
function askWithLead(text: string, ask: string): string {
  const item = closingItems(text).find((it) => markless(it).includes(ask));
  const lead = item?.match(/^\s*(?:\d+[.)]|[-•+*])\s+\*\*([^*]{3,80})\*\*/)?.[1].trim();
  if (!lead || lead.includes(ask) || ask.includes(lead)) return ask;
  return `${/[.!?:]$/.test(lead) ? lead : `${lead}.`} ${ask}`.slice(0, 160);
}
function courtesyQuestion(s: string): boolean {
  return COURTESY.test(fold(s)) && s.split(/\s+/).length <= 6;
}

// Requests without a question mark ("Solo me falta saber cuál prefieres", "Con un
// 'adelante' lo hago", "Let me know which one"). Each speaks to you: a second-person form,
// an imperative with you as its object ("dímelo", "apruébalo"), or one of the requests below.
// Courtesy closings, open offers for anything more ("si necesitas algo más, avísame", "si
// quieres seguir con otro ajuste, dime", "if you want another change, let me know"), don't
// count. An offer of one thing ("si quieres que lo suba, dime") does.
const REQUEST = [
  /\b(me falta saber|solo falta|necesito (saber|que)|falta que (me )?(digas|confirmes|decidas|elijas|apruebes))\b/,
  /\b(dime|dimelo|confirmame|avisame|indicame|me dices|me confirmas|me avisas)\b/,
  /\b(confirma|aprueba|elige|escoge|decide|contesta|responde|revisa|manda|pasa)(me|lo|la|los|las|melo|mela)\b/,
  /\bcual(es)? (prefieres|quieres|te gusta|eliges|escoges)\b/,
  /\bo (lo|la|los|las) (hago|mando|envio|publico|subo) yo\b/,
  /\bcon (un|una) ["'“‘][^"'”’]{1,40}["'”’] (lo|la|los|las|te|me|sigo|arranco)\b/,
  /\b(espera|esperan|falta|faltan|necesito|pendientes? de) tu (visto bueno|aprobacion|ok|decision)\b/,
  // "sigue esperando que elijas versión", "solo falta tu respuesta", "waiting for you to pick one"
  /\b(espera|esperan|esperamos|esperando|falta|faltan) (a )?(que (elijas|escojas|decidas|confirmes|apruebes|me digas|respondas|contestes)|tu (respuesta|eleccion))\b/,
  /\b(waiting|waits) (for|on) you to (choose|pick|decide|confirm|approve|answer|reply|say)\b/,
  /\b(awaits?|awaiting|needs?|pending) your (approval|ok|okay|sign-off|go-ahead|decision)\b/,
  // It's your turn: "Te toca responder", "Lo que queda de tu lado", "over to you".
  /\b(te toca|tu turno|de tu lado|over to you|your turn|on your (side|end))\b/,
  /\b(let me know|should i|do you want|would you like|want me to|shall i|please confirm|your call|say the word|which (one|option)s? (do |would |should )?you|i need (you|your|to know)|need you to|waiting (for|on) (you|your)|(can|could|would) you (tell|let) me)\b/,
  /\byou(['’]ll| will)?( still| also| just)?( need to| have to| must| should| can)? (approve|choose|pick|decide|confirm|answer|reply)\b/,
];
// Words that ask you only at the start of a clause, as an imperative or a direct question
// without its marks: "Elige una", "Si te late, escoge el azul", "Tú decide", "Approve the PR",
// "Quieres que lo suba". After a subject they say what something else does.
const IMPERATIVE = /^(decide|elige|escoge|aprueba|confirma|contesta|responde|tell me|approve|choose|pick|confirm|reply to|answer|(quieres|prefieres) que|te parece (bien )?(que|si))\s+\S/;
const LEAD = /^((y|o|pero|entonces|ahora|solo|nomas|mejor|ya|tu|usted|porfa|por favor|and|or|but|so|then|now|just|please|you|also|tambien)\s+)+/;
const imperative = (f: string) =>
  f.split(/[,;:()—–]|\s-\s/).some((c) => IMPERATIVE.test(c.trim().replace(LEAD, "")));

const COURTESY = new RegExp(String.raw`\b(${[
  String.raw`si (necesitas|quieres|gustas|te late|ocupas) (algo|cualquier|otr[oa]s?|mas|seguir|hacer otr[oa]s?|ver otr[oa]s?)`,
  String.raw`cualquier (cosa|duda|otr[oa])`,
  String.raw`(algo|otra cosa) mas`,
  String.raw`(quieres|necesitas) que (haga|cambie|ajuste|revise|vea|agregue|mueva) (algo|otr[oa]s?|mas)`,
  String.raw`en que mas`,
  String.raw`que mas (necesitas|quieres|hago|ocupas|puedo|te ayudo)`,
  String.raw`(dime|avisame|cuentame) (como (se ve|queda|te va|funciona)|si algo (no|se ve|falla|truena|sale mal))`,
  String.raw`(quedo|sigo) (atento|pendiente|a la orden)`,
  String.raw`cuando (quieras|gustes|lo necesites|te late)`,
  String.raw`whenever you(['’]re ready| want| like| need)`,
  String.raw`if (you|you['’]?d|you would) (need|want|like|have) (anything|any|something|another|more|other|to (keep going|continue))`,
  String.raw`if there['’]?s anything`,
  String.raw`(anything|what) else`,
  String.raw`any (other|more)`,
  String.raw`any questions`,
  String.raw`(let me know|tell me) how it (looks|goes|works|went)`,
  String.raw`if (anything|something) (looks|seems|feels) (off|wrong|odd|weird|broken)`,
  String.raw`if (anything|something) (breaks|is unclear)`,
  String.raw`happy to help`,
].join("|")})\b`);

// What waits on you, said the other way round: "Nada espera tu respuesta", or only if it
// happens: "Solo te escribo si algo espera tu respuesta".
const WAITS_NOT = /\b(nada|ninguna?|nothing|none)\b[^.]{0,20}\b(espera|esperan|waits?|waiting)\b|\b(si|if)\b[^,.]{0,40}\b(espera|esperan|waits?|waiting)\b/;
function closingRequest(text: string): string | undefined {
  // The first request in the closing lines says the most ("which of the two"); the
  // ones after it tend to be the how ("say 'send it' and I send it").
  // The last sentence of each point of a closing list too ("…esperan tu visto bueno."), unless
  // it starts with a condition: "Si prefieres el otro, lo cambio" is a note beside the point.
  const items = closingItems(text).map(lastSentence).filter((s) => !/^(si|if)\b/i.test(s));
  const hit = [...closingSentences(text, 3), ...items].find((s) => {
    const f = fold(s);
    return !COURTESY.test(f) && !WAITS_NOT.test(f) && (REQUEST.some((re) => re.test(f)) || imperative(f));
  });
  return hit ? hit.slice(0, 160) : undefined;
}

// ---------------------------------------------------------------- whose question it is

// Sessions a text links to, as the Claude app writes them: [title](#local_…), or the ID
// alone, whole or its first 8 characters or more ("en su sesión (local_1a2b3c4d)"). The
// cleaned text of a closing message has lost the "_" too.
function linkedSessions(text: string, ctx: Ctx): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/local_?([0-9a-f]{8}[0-9a-f-]{0,28})/g)) {
    const key = `local_${m[1]}`;
    const hits = ctx.others.filter((o) => o.local && (o.local === key || o.local.startsWith(key)));
    if (hits.length === 1) ids.push(hits[0].sid);
  }
  return [...new Set(ids)];
}

// Sessions a text names: a whole title, the short name before a title's colon or dash
// ("billing-api" in "billing-api: retry rules"), or its folder. Only read where the text
// says that session is waiting for you, and never this session's own names.
export const nameWords = (name: string) => fold(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /^\d+$/.test(w));
function namesOf(names: string[]): string[] {
  return names.flatMap((n) => {
    const base = n.includes("/") ? n.replace(/\/+$/, "").split("/").at(-1) ?? "" : n;
    return [base, base.split(/:|\s[-–—·|]\s|\s\(/)[0]];
  }).map((n) => nameWords(n).join(" ")).filter((n) => n.length >= 6);
}
function namedSessions(text: string, ctx: Ctx): string[] {
  const said = ` ${nameWords(text).join(" ")} `;
  const own = new Set(namesOf(ctx.own));
  return ctx.others.filter((o) => namesOf(o.names).some((n) => !own.has(n) && said.includes(` ${n} `))).map((o) => o.sid);
}

// Words that say another session is the one waiting for you: "La sesión [X] te hace tres
// preguntas:", "Contéstale en esa sesión.", "en su sesión", "can't start until you answer",
// "is waiting for you", "in its own session".
const RELAY = new RegExp(String.raw`\b(${[
  String.raw`en (esa|su) (propia )?sesion`,
  String.raw`contesta(le|les|la|las|lo|los)|responde(le|les)`,
  String.raw`te (espera|esta esperando|pregunta|hace \S+ preguntas?|necesita)`,
  String.raw`(esta|estan|sigue|siguen) esperando`,
  String.raw`espera tu respuesta`,
  String.raw`esperan? (a )?que (elijas|escojas|decidas|confirmes|apruebes|contestes|respondas|le digas)`,
  String.raw`necesita que (decidas|contestes|respondas|elijas|apruebes|confirmes)`,
  String.raw`in (that|its|their) (own )?session`,
  String.raw`(is|are) (still )?waiting (for|on) (you|your)`,
  String.raw`waits for you`,
  String.raw`until you (answer|reply|decide|confirm|choose)`,
  String.raw`(answer|reply) (it |them )?there`,
].join("|")})\b`);

// The sessions a relaying sentence points to: the ones it links, or else the ones it names.
function pointedAt(text: string, ctx: Ctx): string[] {
  const linked = linkedSessions(text, ctx);
  return linked.length ? linked : namedSessions(text, ctx);
}

// The links nearest above line i, from line i itself up.
function linksAbove(lines: string[], i: number, ctx: Ctx): string[] {
  for (let j = i; j >= 0; j--) {
    const ids = linkedSessions(lines[j], ctx);
    if (ids.length) return ids;
  }
  return [];
}

// The linked sessions whose question a closing message passes on to you, when its question
// (`ask`, from the last paragraph) is theirs: its own sentence links one ("The [Draft review]
// session can't start until you answer: …?") or says so ("…de billing-api en su sesión"), a
// later sentence of the paragraph says so without naming another session ("…? Contéstale en
// esa sesión."), or the question is in a list whose lead-in says so ("La sesión [X] te hace
// tres preguntas:"). Otherwise the question is this session's own, even when the message
// links another one elsewhere.
function relayedTo(text: string, ask: string, ctx: Ctx): string[] {
  const lines = closingLines(text);
  const at = lines.findLastIndex((l) => markless(l).includes(ask));
  if (at < 0) return [];
  const sentences = markless(lines[at]).match(SENTENCE) ?? [];
  const k = sentences.findIndex((x) => x.trim().startsWith(ask));
  const own = sentences[k] ?? "";
  if (linkedSessions(own, ctx).length) return linkedSessions(own, ctx);
  if (RELAY.test(fold(own))) return namedOr(own, () => linksAbove(lines, at, ctx), ctx);
  const rest: string[] = sentences.slice(k + 1);
  for (let j = at + 1; j < lines.length && lines[j].trim(); j++) rest.push(markless(lines[j]));
  for (const x of rest) {
    if (linkedSessions(x, ctx).length) break; // that names something else
    if (RELAY.test(fold(x))) return namedOr(x, () => linksAbove(lines, at, ctx), ctx);
  }
  if (!LIST_ITEM.test(lines[at]) && !/^\s+\S/.test(lines[at])) return [];
  let j = at - 1;
  while (j >= 0 && (LIST_ITEM.test(lines[j]) || /^\s+\S/.test(lines[j]))) j--;
  while (j >= 0 && !lines[j].trim()) j--; // a lead-in paragraph right before the list
  if (j < 0 || LIST_ITEM.test(lines[j])) return [];
  const lead = markless(lines[j]);
  if (RELAY.test(fold(lead))) return namedOr(lead, () => linksAbove(lines, j, ctx), ctx);
  return lead.trim().endsWith(":") && linkedSessions(lead, ctx).length ? linksAbove(lines, j, ctx) : [];
}
function namedOr(text: string, otherwise: () => string[], ctx: Ctx): string[] {
  const named = namedSessions(text, ctx);
  return named.length ? named : otherwise();
}

// Every session a closing message says is waiting for you, anywhere in it.
function relaysIn(text: string, ctx: Ctx): string[] {
  const lines = closingLines(text);
  return [...new Set(lines.flatMap((l, i) => {
    if (!RELAY.test(fold(markless(l)))) return [];
    const here = pointedAt(markless(l), ctx);
    return here.length ? here : linksAbove(lines, i, ctx);
  }))];
}

// The sessions a note (the Claude app's own summary of a turn) says the waiting is in:
// "Answer billing-api's two questions in its session". Empty when it doesn't say so.
export function relayTargets(text: string, others: Other[] = [], own: string[] = []): string[] {
  return RELAY.test(fold(text)) ? pointedAt(text, { others, own }) : [];
}
