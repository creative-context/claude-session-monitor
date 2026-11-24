// The page in WebKit (the engine of the app's window), on the demo's made-up data (with its edge
// cases): where a view or the count popover scrolls out of sight it fades into its surface, only
// at an end with more past it, clicks go through the fade to the card under it, and nothing
// spills sideways. A question's answers on its card: each button clicked and sent at once,
// the ones that open the session, ⌘↩, sent and picked up, refused, and not sent, with the
// card's height unchanged and nothing spilling. Dictating an answer on a card, with a stand-in
// for the app: the mic opens a composer anchored to it (below, or above in the last row,
// inside the window, following its card as the list scrolls), listening with the words and
// the level, stopped and editable, sending, sent, refused, each error, the moved-on note,
// Esc, Cancel and Close every time, Tab kept inside, the card under it unchanged, and one
// card at a time; no mic in a plain browser. A permission on its card: what it asks on one
// line in mono, Allow and Deny POSTing the decision, Allowing…, Allowed, Denied, not sent
// (needs you again), ⌘↩ opening the session, and a card with no plugin as before. The advisor:
// its chip after the model's tags, each tag's letters moved by the ink table and up by the
// screen pixels the height table says for the scale (1×, 2×, and 1× zoomed 1.25), and the
// order the tags give way in as a card narrows, in a wide, short 1568 × 324 window at 1× and 2×.
// In each window size the page has a layout for,
// in a browser and inside the app (?embed). Opening a session is caught, never sent.
// Screenshots of each state go in the folder given.
//
//   bun test/page.ts [out folder]    (port 4751; Playwright from ../mac-app-design)
//
// Playwright comes from the design system's clone next to this folder, as its compare tool does.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PW = join(import.meta.dir, "..", "..", "mac-app-design", "node_modules", "playwright", "index.mjs");
const { webkit } = await import(PW).catch(() => {
  console.error(`Playwright not found at ${PW}: clone creative-context/mac-app-design next to this folder and run bun install there.`);
  process.exit(2);
});
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "csm-page-"));
mkdirSync(OUT, { recursive: true });

let fails = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) fails++; };

const PORT = 4751;
// An answer no mod takes counts as not sent after 1.5 s, not 20 s, and a session that got one
// asks again 1.5 s into its turn, not 8 s.
const demo = Bun.spawn(["bun", join(import.meta.dir, "demo.ts"), String(PORT), "--edge"], {
  // A permission decided while no mod holds its ask counts as not sent after 1.5 s, and the
  // demo's sessions run the tool 3 s after a click, so Allowed and Denied stay long enough to see.
  stdout: "ignore", stderr: "ignore", env: { ...process.env, CSM_ANSWER_GIVE_UP_MS: "1500", CSM_DEMO_TURN_MS: "1500", CSM_PERMIT_GIVE_UP_MS: "1500", CSM_DEMO_PERMIT_MS: "3000" },
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/state")).ok) break; } catch {} await Bun.sleep(100); }

const SIZES = [
  { name: "tall", width: 1280, height: 900 },
  { name: "short", width: 1280, height: 560 },
  { name: "narrow", width: 600, height: 900 },
  { name: "strip", width: 280, height: 800 },
];

// What a scroller's fades show, and whether it has more past each end.
const read = (sel: string) => (page: any) => page.evaluate((sel: string) => {
  const box = document.querySelector(sel) as HTMLElement;
  const up = box.querySelector(":scope > .scroll-fade.up") as HTMLElement, down = box.querySelector(":scope > .scroll-fade.down") as HTMLElement;
  const shown = (b: HTMLElement) => b.classList.contains("on") && getComputedStyle(b).opacity !== "0";
  const r = box.getBoundingClientRect(), ur = up.getBoundingClientRect(), dr = down.getBoundingClientRect();
  return {
    up: shown(up), down: shown(down),
    above: box.scrollTop > 1, below: box.scrollTop + box.clientHeight < box.scrollHeight - 1,
    // Each band sits on its edge of the visible box.
    upAt: Math.round(ur.top - r.top), downAt: Math.round(r.bottom - dr.bottom),
    // Near the end the band stays at the end of the content, and only the box's empty padding
    // shows below it: that much gap is fine, more would be a hard edge.
    gap: Math.max(0, parseFloat(getComputedStyle(box).paddingBottom) - (box.scrollHeight - box.clientHeight - box.scrollTop)),
    clicks: getComputedStyle(up).pointerEvents + "/" + getComputedStyle(down).pointerEvents,
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
  };
}, sel);
const content = read("#content"), pop = read("#pop");
const settle = (page: any) => page.waitForTimeout(250); // the 120 ms fade

// The sessions the page asked to open (the server would open the Claude app): caught here.
const opened: string[] = [];
const catchOpens = (page: any) => page.route("**/api/open/**", (r: any) => {
  opened.push(decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop()!));
  return r.fulfill({ status: 204 });
});
const opensFor = async (page: any, sid: string, act: () => Promise<unknown>) => {
  const n = opened.length;
  await act();
  for (let i = 0; i < 20 && opened.length === n; i++) await page.waitForTimeout(50);
  return opened.slice(n).includes(sid);
};

// The demo's sessions with answers, by title.
const SEND = "Release notes for 2.4"; // its mod is there: answers go from the card
const APP = "Fix the login redirect loop"; // its first answer is the app's (Commit)
const NOMOD = "Rename the image folders"; // no mod: its answers open the session
const LONG = "Migrate the billing exports to the new storage layout"; // 40-character answers
// The demo's sessions waiting on a permission, by title.
const PERMIT = "Upgrade the payments SDK"; // its plugin holds the ask: a short command
const LONGCMD = "Clean up the downloads folder"; // a very long command
const LONGPATH = "Add tests for the identity check step"; // a long path to write
const NOPERMIT = "Tag the release candidate"; // no plugin: the card as before
const permitOf = async (sid: string) => ((await (await fetch(`${base}/api/state`)).json()) as any).sessions.find((x: any) => x.sid === sid)?.permit;
// The ask's line under the wait: one line in mono, inside the card, the whole text in its tooltip;
// and the wait's line above it, one line too.
const askOf = (c: any) => c.evaluate((el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  const lines = [...el.querySelectorAll(":scope > .detail > .line")] as HTMLElement[];
  const line = el.querySelector(":scope > .detail > .line[data-what]") as HTMLElement | null;
  const txt = line?.querySelector(".txt") as HTMLElement | null;
  const lh = parseFloat(getComputedStyle(el.querySelector(".detail")!).lineHeight);
  const one = (e: HTMLElement) => e.getBoundingClientRect().height <= lh * 1.4;
  const b = txt?.getBoundingClientRect();
  return {
    has: !!line, title: line?.getAttribute("title") ?? "", text: txt?.textContent ?? "",
    one: !!txt && lines.every(one), mono: !!txt && /mono|SF Mono|Menlo/i.test(getComputedStyle(txt).fontFamily),
    inside: !!b && b.right <= r.right - parseFloat(getComputedStyle(el).paddingRight) + 0.5 && b.left >= r.left,
    cut: !!txt && txt.scrollWidth > txt.clientWidth + 1,
    buttons: [...el.querySelectorAll("[data-permit]")].map((x) => x.textContent!.trim() + "|" + x.getAttribute("title")),
    tag: el.querySelector(".top .tag")?.textContent?.trim() ?? "", aria: el.getAttribute("aria-label") ?? "",
  };
});
// The demo's permission sessions run the tool after a click, then ask again: wait for all of
// them to be held, so Active isn't moving under a measurement.
const permitsHeld = async (page: any) => { for (const t of [PERMIT, LONGCMD, LONGPATH]) await footIs(page, t, ".ans.permit .pri"); };
const card = (page: any, title: string) => page.locator("#week .card", { has: page.locator(".title", { hasText: title }) });
const sidOf = (c: any) => c.getAttribute("data-sid");
// A card's size and its foot: the same height as a card without answers, the foot inside its
// padding, and no button or word past the card's edge.
const measure = (c: any) => c.evaluate((el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  const foot = el.querySelector(":scope > .ans, :scope > .sentline") as HTMLElement | null;
  const f = foot?.getBoundingClientRect();
  const gridCard = getComputedStyle(el).display !== "grid"; // a row of free height under 640 pt
  const want = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--csm-card-h"));
  const parts = [...el.querySelectorAll(".a-b, .say, .count")] as HTMLElement[];
  return {
    h: Math.round(r.height), sized: !gridCard || Math.round(r.height) === Math.round(want),
    footIn: !!f && f.bottom <= r.bottom - parseFloat(getComputedStyle(el).paddingBottom) + 2.5,
    spill: parts.some((p) => { const b = p.getBoundingClientRect(); return b.right > r.right - 4 || b.left < r.left; })
      || (!!foot && foot.scrollWidth > foot.clientWidth + 1),
    cls: el.className, foot: foot?.textContent?.trim() ?? "",
  };
});
// The model, effort and ultracode beside a card's time: which parts show, and that they fit
// in the top row (inside the padding, clear of the state's tag, not clipped), with the card's
// height unchanged. A row of the compact view has no tag to clear.
const metaOf = (c: any) => c.evaluate((el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  const time = el.querySelector(":scope > .top > .time") as HTMLElement;
  const meta = time.querySelector(".meta") as HTMLElement | null;
  const visible = (e: Element | null | undefined) => !!e && (e as HTMLElement).getClientRects().length > 0 && (e as HTMLElement).getBoundingClientRect().width > 0;
  const shown = (sel: string) => visible(meta) && visible(meta!.querySelector(sel));
  const isCard = getComputedStyle(el).display !== "grid";
  const want = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--csm-card-h"));
  const t = time.getBoundingClientRect(), g = (el.querySelector(":scope > .top > .tag") as HTMLElement).getBoundingClientRect();
  return {
    w: Math.round(r.width), h: Math.round(r.height), sized: !isCard || Math.round(r.height) === Math.round(want), isCard,
    model: shown(".mdl"), effort: shown(".eff"), ultra: shown(".uc"), advisor: shown(".advr"), any: visible(meta),
    cls: meta?.className ?? "", timeShown: visible(time),
    text: visible(meta) ? meta!.innerText.replace(/\s+/g, " ").trim() : "",
    fits: t.right <= r.right - parseFloat(getComputedStyle(el).paddingRight) + 0.5 && (!isCard || g.right <= t.left + 0.5)
      && (!meta || meta.scrollWidth <= meta.clientWidth + 1),
    tip: time.getAttribute("title") ?? "", aria: el.getAttribute("aria-label") ?? "",
  };
});
// Waits for a state on a card's foot, then for any fade or slide to end before measuring.
const footIs = async (page: any, title: string, sel: string) => {
  await card(page, title).locator(sel).first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(350);
};

const browser = await webkit.launch();
try {
  for (const size of SIZES) for (const mode of ["", "?embed"]) {
    const tag = `${size.name}${mode ? " in the app" : ""}`;
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
    await catchOpens(page);
    await page.goto(base + "/" + mode);
    await page.waitForSelector("#week .card");
    await permitsHeld(page);
    await settle(page);
    const shot = (what: string) => page.screenshot({ path: join(OUT, `${size.name}${mode ? "-app" : ""}-${what}.png`) });

    for (const view of ["week", "history", "scheduled"]) {
      if (view !== "week") {
        // The app has the view switch in its toolbar; the page's is hidden there.
        await page.evaluate((v: string) => (document.querySelector(`[data-view="${v}"]`) as HTMLElement).click(), view);
        await page.waitForSelector(`#${view}:not([hidden])`);
      }
      await page.evaluate(() => document.getElementById("content")!.scrollTo({ top: 0 }));
      await settle(page);
      let s = await content(page);
      ok(!s.up && s.down === s.below, `${tag}, ${view}, at the top: no fade above, one below only if there's more (${s.below})`);
      ok(s.clicks === "none/none", `${tag}, ${view}: the fades let clicks through`);
      ok(!s.sideways, `${tag}, ${view}: nothing spills sideways`);
      await shot(`${view}-top`);
      if (!s.below) continue;

      await page.evaluate(() => { const c = document.getElementById("content")!; c.scrollTo({ top: Math.round((c.scrollHeight - c.clientHeight) / 2) }); });
      await settle(page);
      s = await content(page);
      ok(s.up && s.down && s.upAt === 0 && Math.abs(s.downAt - Math.round(s.gap)) <= 1, `${tag}, ${view}, halfway: a fade on each edge (${s.upAt}, ${s.downAt})`);
      await shot(`${view}-middle`);

      // A card under the bottom fade still takes the pointer.
      const hit = await page.evaluate(() => {
        const c = document.getElementById("content")!.getBoundingClientRect();
        for (let x = c.left + 24; x < c.right - 24; x += 16) {
          const el = document.elementFromPoint(x, c.bottom - 12);
          const row = el?.closest(".card, .hrow, .trow, button");
          if (row) return { x, y: c.bottom - 12, row: row.className };
        }
        return null;
      });
      if (hit) {
        await page.mouse.move(hit.x, hit.y);
        const hovered = await page.evaluate(({ x, y }: { x: number; y: number }) => !!document.elementFromPoint(x, y)?.closest(":hover"), hit);
        ok(hovered, `${tag}, ${view}: the pointer reaches the row under the fade (${hit.row})`);
        await page.mouse.move(1, 1);
      }

      await page.evaluate(() => { const c = document.getElementById("content")!; c.scrollTo({ top: c.scrollHeight }); });
      await settle(page);
      s = await content(page);
      ok(s.up && !s.down, `${tag}, ${view}, at the end: a fade above, none below`);
      await shot(`${view}-end`);
    }

    // The count popover: in a short window its list scrolls, and fades into its raised surface.
    await page.evaluate(() => (document.querySelector('[data-view="week"]') as HTMLElement).click());
    await page.evaluate(() => document.getElementById("content")!.scrollTo({ top: 0 }));
    // The last count that shows: with the view switch and the search in the header, a narrow
    // window keeps only the first counts.
    const count = page.locator("#counts [data-pop]:visible").last();
    if (await count.isVisible()) {
      await count.hover();
      await page.waitForSelector("#pop.open");
      await settle(page);
      let p = await pop(page);
      ok(!p.up && p.down === p.below, `${tag}, popover at the top: a fade below only if there's more (${p.below})`);
      if (p.below) {
        await page.evaluate(() => { const b = document.getElementById("pop")!; b.scrollTo({ top: b.scrollHeight }); });
        await settle(page);
        p = await pop(page);
        ok(p.up && !p.down, `${tag}, popover at the end: a fade above, none below`);
      }
      const color = await page.evaluate(() => getComputedStyle(document.querySelector("#pop > .scroll-fade.down")!).backgroundImage);
      ok(color.includes("gradient"), `${tag}, popover: its fade is drawn`);
      await shot("popover");
    }

    // A question's answers, on the cards in Last 7 Days.
    await page.mouse.move(1, 1);
    await page.evaluate(() => document.getElementById("pop")?.classList.remove("open"));
    await page.evaluate(() => document.getElementById("content")!.scrollTo({ top: 0 }));
    await footIs(page, SEND, ".ans .pri");
    for (const t of [SEND, APP, NOMOD, LONG]) {
      const m = await measure(card(page, t));
      ok(m.sized && m.footIn && !m.spill, `${tag}, "${t}": its answers fit, the card keeps its height (${m.h})`);
    }
    // The long answers: the first keeps most of the row, the second gives way.
    const long = await card(page, LONG).evaluate((el: HTMLElement) =>
      [...el.querySelectorAll(".a-b > span")].map((s) => (s as HTMLElement).scrollWidth > (s as HTMLElement).clientWidth + 1));
    if (size.width >= 640) ok(long[1] === true, `${tag}: a long second answer gives way (${long})`);
    const marks = await page.evaluate((t: string[]) => t.map((x) => [...document.querySelectorAll("#week .card")]
      .find((c) => c.querySelector(".title")?.textContent === x)!.querySelectorAll(".a-b.opens").length), [SEND, APP, NOMOD]);
    ok(marks.join() === "0,1,2", `${tag}: only answers that open the session carry the open mark (${marks})`);
    await card(page, SEND).scrollIntoViewIfNeeded();
    await shot("answers");

    // Sent from the card at once: blue, Working, what you answered, and no way back.
    const send = card(page, SEND);
    const sendSid = await sidOf(send);
    const before = await measure(send);
    // Pressing an answer presses the answer, not the card; pressing the card's body presses the card.
    // Each press ends away from the card, so nothing is clicked.
    const pressAt = async (sel: string) => {
      const b = (await send.locator(sel).first().boundingBox())!;
      await page.mouse.move(b.x + Math.min(10, b.width / 2), b.y + b.height / 2, { steps: 3 });
      await page.mouse.down();
      await page.waitForTimeout(200);
      const got = await send.evaluate((el: HTMLElement, sel: string) => ({ card: getComputedStyle(el).transform, own: getComputedStyle(el.querySelector(sel)!).transform }), sel);
      await page.mouse.move(2, 2, { steps: 3 });
      await page.mouse.up();
      return got;
    };
    const onAnswer = await pressAt(".ans .pri");
    ok(onAnswer.card === "none" && onAnswer.own !== "none", `${tag}: pressing an answer presses the answer, not the card (${onAnswer.card}, ${onAnswer.own})`);
    const onBody = await pressAt(".title");
    ok(onBody.card !== "none", `${tag}: pressing the card's body presses the card (${onBody.card})`);
    await send.locator(".ans .pri").click();
    await footIs(page, SEND, ".sentline");
    let m = await measure(send);
    ok(/\bsent\b/.test(m.cls) && /\bworking\b/.test(m.cls) && m.foot.startsWith("Sent. The session is working on it") && !(await send.locator("[data-undo]").count()),
      `${tag}: a click sends it at once, with no Undo ("${m.foot}")`);
    ok((await send.locator(".top .tag").textContent())?.includes("Working") && (await send.locator(".detail").textContent())?.includes("You answered “Publish now”"),
      `${tag}: the sent card says Working and what you answered`);
    ok(m.h === before.h && m.footIn && !m.spill, `${tag}: the sent card keeps its height (${before.h} → ${m.h})`);
    ok(!opened.includes(sendSid), `${tag}: sending doesn't open the session`);
    await shot("answer-sent");
    await footIs(page, SEND, ".ans .pri");
    m = await measure(send);
    ok(/\basks\b/.test(m.cls) && m.h === before.h, `${tag}: its turn over, it asks again (${m.h})`);

    // Answers that can't go from here open the session instead.
    const app = card(page, APP);
    ok(await opensFor(page, await sidOf(app), () => app.locator(".ans .pri").click()), `${tag}: the app's own answer (Commit) opens the session`);
    ok((await app.locator(".ans .pri").getAttribute("title")) === "Only the Claude app can do this", `${tag}: its tip says only the app can do it`);
    const nomod = card(page, NOMOD);
    ok(await opensFor(page, await sidOf(nomod), () => nomod.locator(".ans .sec").click()), `${tag}: with no mod, an answer opens the session`);
    ok((await nomod.locator(".ans .sec").getAttribute("title")) === "Opens the session: answer there", `${tag}: its tip says answer there`);
    ok(!(await page.locator("#week .card.sent").count()), `${tag}: nothing was sent by those`);

    // A permission on its card: what it asks under the wait, one line in mono, with Allow and Deny.
    await page.evaluate(() => document.getElementById("content")!.scrollTo({ top: 0 }));
    for (const t of [PERMIT, LONGCMD, LONGPATH]) {
      await footIs(page, t, ".ans.permit .pri");
      const c = card(page, t);
      const p = await permitOf(await sidOf(c));
      const m = await measure(c), a = await askOf(c);
      ok(m.sized && m.footIn && !m.spill && a.one && a.inside && a.mono && a.title === p.what && a.text === p.what,
        `permit: ${tag}, "${t}": what it asks on one line in mono, inside the card, the whole of it in the tooltip; Allow and Deny fit, the card keeps its height (${m.h}${a.cut ? ", cut with an ellipsis" : ""})`);
      if (t !== PERMIT && size.width >= 600) ok(a.cut, `permit: ${tag}, "${t}": the long ask is cut at the card's width`);
      ok(a.buttons.join() === `Allow|Allow ${p.tool} (the session runs it),Deny|Deny ${p.tool} (the session doesn't run it)` && a.tag === "Needs you"
        && a.aria.includes("Answers: Allow, Deny") && a.aria.includes("Command-Return opens the session"),
        `permit: ${tag}, "${t}": Allow and Deny with their tips, Needs you, and VoiceOver says them`);
    }
    await card(page, PERMIT).scrollIntoViewIfNeeded();
    await shot("permit-held");
    await card(page, LONGCMD).scrollIntoViewIfNeeded();
    await shot("permit-long");
    // No plugin in its session: the card as before, the folder in the foot, and a click opens it.
    const none = card(page, NOPERMIT);
    const na = await askOf(none);
    ok(!na.has && !na.buttons.length && !(await none.locator(".ans, .sentline").count()) && (size.width < 300 || (await none.locator(".tags .tag.name").count()) === 1),
      `permit: ${tag}: with no plugin, the permission's card is as before`);
    ok(await opensFor(page, await sidOf(none), () => none.locator(".title").click()), `permit: ${tag}: and a click on it opens the session`);
    await none.scrollIntoViewIfNeeded();
    await shot("permit-none");

    // Allow: the decision goes at once with the ask's ID, the card turns blue, Working, Allowed.
    for (const [t, allow] of [[PERMIT, true], [LONGCMD, false]] as const) {
      const c = card(page, t);
      const sid = await sidOf(c);
      await footIs(page, t, ".ans.permit .pri");
      const p = await permitOf(sid);
      const before = await measure(c);
      const req = page.waitForRequest((r: any) => r.url().endsWith(`/api/permission/${sid}/decide`) && r.method() === "POST");
      await c.locator(allow ? ".ans.permit .pri" : ".ans.permit .sec").click();
      const sent = await req;
      const body = sent.postDataJSON();
      ok(body.id === p.id && body.allow === allow && Object.keys(body).length === 2 && sent.headers()["x-csm"] === "1",
        `permit: ${tag}: ${allow ? "Allow" : "Deny"} POSTs {"id": "${p.id}", "allow": ${allow}} with x-csm`);
      await footIs(page, t, ".sentline");
      const m = await measure(c), a = await askOf(c);
      const word = allow ? "Allowed" : "Denied";
      ok(/\bsent\b/.test(m.cls) && /\bworking\b/.test(m.cls) && m.foot === word && a.tag.includes("Working") && a.has && a.one
        && (await c.locator(".detail").textContent())!.includes(allow ? "You allowed it" : "You denied it") && m.h === before.h && m.footIn && !m.spill,
        `permit: ${tag}: the card says ${word}, in blue, Working, what you decided above what it asked (${before.h} → ${m.h})`);
      ok(!opened.includes(sid), `permit: ${tag}: ${allow ? "allowing" : "denying"} doesn't open the session`);
      await c.scrollIntoViewIfNeeded();
      await shot(allow ? "permit-allowed" : "permit-denied");
    }
    await page.close();
  }

  // A wide, short window: Active's first two rows beside the week's
  // usage, with a permission held.
  {
    const page = await browser.newPage({ viewport: { width: 1570, height: 330 }, deviceScaleFactor: 2 });
    await page.goto(base + "/?embed");
    await permitsHeld(page);
    await page.evaluate(() => document.getElementById("content")!.scrollTo({ top: 0 }));
    await settle(page);
    const m = await measure(card(page, PERMIT)), a = await askOf(card(page, PERMIT));
    ok(m.sized && m.footIn && !m.spill && a.one && a.inside, `permit: wide and short (1570×330): the held card fits, its height as its neighbors' (${m.h})`);
    await page.screenshot({ path: join(OUT, "frame-wide-short-permit.png") });
    await page.close();
  }

  // The model beside the time, in every window size: whole in a wide card, the model gone
  // from a narrow one and then the effort's square, the time always there and nothing spilling; only
  // the tooltip in the compact view's rows. The demo's release notes run on Opus 5.5 at
  // Extra effort with ultracode; its email copy ran in a terminal, so only the model is known.
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
    await page.goto(base + "/?embed");
    await page.waitForSelector("#week .card");
    await settle(page);
    const tag = `${size.name}, the model`;
    const ultra = card(page, SEND);
    const m = await metaOf(ultra);
    ok(m.tip.startsWith("Opus 5.5 · Extra effort · Ultracode · Advised by Fable 5.2\n"), `${tag}: the time's tooltip says it in words (${JSON.stringify(m.tip)})`);
    ok(m.aria.includes("Opus 5.5. Extra effort. Ultracode. Advised by Fable 5.2"), `${tag}: VoiceOver says it too`);
    const uc = await ultra.locator(".uc").evaluate((el: HTMLElement) => ({ text: el.textContent, svg: !!el.querySelector("svg"), line: getComputedStyle(el).borderTopWidth === "1px" && getComputedStyle(el).borderTopStyle === "solid" }));
    ok(uc.text === "UC" && !uc.svg && uc.line, `${tag}: ultracode is UC in a tag drawn in a line (${JSON.stringify(uc)})`);
    ok((await ultra.locator(".msep").evaluate((el) => el.textContent)) === "", `${tag}: no dot between the model and the time`);
    const term = await metaOf(card(page, "Onboarding email copy"));
    ok(term.tip.startsWith("Sonnet 5.5") && !term.tip.includes("effort") && !term.tip.includes("Ultracode"), `${tag}: a terminal session's tooltip has its model only`);
    const none = await metaOf(card(page, "Upgrade the payments SDK"));
    ok(!none.any && !none.tip.includes("Opus"), `${tag}: a session with no known model shows none`);
    if (!m.isCard) {
      ok(!m.any && !term.any, `${tag}: a compact row keeps it to the tooltip`);
    } else {
      ok(m.effort && m.ultra && m.model === m.w >= 284 && m.fits && m.sized,
        `${tag}: a ${m.w} px card shows "${m.text}", the model only from 284 px, fitting, ${m.h} px high`);
      ok(m.text.includes("X") && !m.text.includes("Extra"), `${tag}: the effort is its square, X for Extra ("${m.text}")`);
      ok(term.model && !term.effort && !term.ultra && term.fits && term.sized, `${tag}: a terminal session shows "${term.text}"`);
      const all = await page.locator("#week .card").evaluateAll((els: HTMLElement[]) => els.length);
      let spills = 0;
      for (let i = 0; i < all; i++) if (!(await metaOf(page.locator("#week .card").nth(i))).fits) spills++;
      ok(spills === 0, `${tag}: no card's top row spills (${all} cards)`);
      await page.screenshot({ path: join(OUT, `${size.name}-model.png`) });
      // The same card made narrower: the model goes under 284 px, the effort under 224, and
      // sooner when its tag leaves no room for them; ultracode and the time stay.
      for (const w of [360, 300, 284, 283, 250, 224, 223, 200]) {
        await ultra.evaluate((el: HTMLElement, w: number) => { el.style.width = `${w}px`; }, w);
        await page.waitForTimeout(80);
        const f = await metaOf(ultra);
        const want = (w >= 300 ? f.model && f.effort : true) && (w < 284 ? !f.model : true) && (w < 224 ? !f.effort : true);
        ok(f.w === w && want && f.ultra && f.fits && f.sized,
          `${tag}: at ${w} px, "${f.text}"${f.fits ? "" : " spills"} (${f.h} px high)`);
        if (size.name === "tall" && [360, 283, 223].includes(w)) await ultra.screenshot({ path: join(OUT, `model-${w}.png`) });
      }
      await ultra.evaluate((el: HTMLElement) => { el.style.width = ""; });
    }
    if (!m.isCard) await page.screenshot({ path: join(OUT, `${size.name}-model.png`) });
    await page.close();
  }

  // The advisor (/advisor) on a session's card: a round chip with its initial after the model's
  // tags and "Advised by …" in the tooltip. Every tag's letters sit on their ink by a fixed
  // table across, and go up by the whole screen pixels a second table says for the scale they
  // are drawn at (its zoom times the screen's); the expected raises are written out again
  // here and checked on the computed transform. A wide, short 1568 × 324 window, at 1×, at 2×
  // and at 1× with --csm-scale 1.25 (a 125% zoom). As a card narrows, the model's name goes first,
  // then the effort, then the advisor, then all of it. The demo: the release notes have the
  // full row (Opus 5.5 X UC F), the checkout fix has its F, and the pricing FAQ (with --edge) ran in a terminal: its model and an O only.
  {
    const INK: Record<string, number> = { "eff L": 0.5, "eff M": 0.25, "eff H": 0.25, "eff X": 0.25, "eff MAX": 0.5, "uc UC": 0.5, "advr F": 0.5, "advr O": 0.25, "advr S": 0.25, "advr H": 0.25 };
    // Screen pixels each letter goes up, by the scale (the table's rounding, written out).
    const UP: Record<string, Record<string, number>> = {
      "1": { "uc UC": 1, "advr O": 1, "advr S": 1, "advr H": 1 },
      "2": { "eff L": 1, "eff M": 1, "eff H": 1, "eff X": 1, "eff MAX": 1 },
      "1.25": {},
    };
    const FAQ = "Sketch the pricing page FAQ";
    const letters = (page: any) => page.evaluate(() => [...document.querySelectorAll("#week .card > .top > .time > .meta > :is(.eff, .uc, .advr) > i")]
      .filter((i) => (i as HTMLElement).getClientRects().length)
      .map((i) => { const m = new DOMMatrixReadOnly(getComputedStyle(i).transform === "none" ? undefined : getComputedStyle(i).transform); return { key: `${i.parentElement!.classList[0]} ${i.textContent}`, x: m.e, y: m.f }; }));
    const parts = (c: any) => c.evaluate((el: HTMLElement) => [...el.querySelectorAll(":scope > .top > .time > .meta > *")].map((x) => `${x.className}:${x.textContent}`));
    const chipOf = (c: any) => c.locator(".advr").evaluate((el: HTMLElement) => {
      const cs = getComputedStyle(el), uc = el.parentElement!.querySelector(".uc, .mdl") as HTMLElement, r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, round: cs.borderTopLeftRadius === "50%" || parseFloat(cs.borderTopLeftRadius) >= 8,
        size: cs.fontSize, weight: cs.fontWeight, sameColor: cs.color === getComputedStyle(uc).color, inI: el.firstElementChild?.tagName === "I" };
    });
    for (const [scale, zoom] of [[1, 1], [2, 1], [1, 1.25]] as const) {
      const page = await browser.newPage({ viewport: { width: 1568, height: 324 }, deviceScaleFactor: scale });
      await catchOpens(page);
      await page.goto(base + "/?embed");
      await page.waitForSelector("#week .card .advr");
      // The app sets --csm-scale (zoom × backing) on a zoom change; the page redraws the letters.
      if (zoom !== 1) await page.evaluate((k: number) => document.documentElement.style.setProperty("--csm-scale", String(k)), scale * zoom);
      await settle(page);
      const drawn = scale * zoom;
      const tag = `advisor at ${zoom !== 1 ? `${scale}× zoomed ${zoom}` : `${scale}×`}, 1568 × 324`;
      const full = card(page, SEND);
      ok(JSON.stringify(await parts(full)) === JSON.stringify(["mdl:Opus 5.5", "eff:X", "uc:UC", "advr:F"]), `${tag}: the release notes' row is the model, X, UC, then the advisor's F (${JSON.stringify(await parts(full))})`);
      const chip = await chipOf(full);
      ok(chip.w === 16 && chip.h === 16 && chip.border === "1px solid" && chip.round && chip.size === "9.5px" && chip.weight === "700" && chip.sameColor && chip.inI,
        `${tag}: the chip is a 16 × 16 circle in a 1 px line, 9.5 px bold, the tags' color (${JSON.stringify(chip)})`);
      const m = await metaOf(full);
      ok(m.tip.includes("Advised by Fable 5.2") && m.aria.includes("Advised by Fable 5.2"), `${tag}: the tooltip and VoiceOver say "Advised by Fable 5.2"`);
      const all = await page.locator("#week .card").evaluateAll((els: HTMLElement[]) => els.length);
      let spills = 0;
      for (let i = 0; i < all; i++) { const f = await metaOf(page.locator("#week .card").nth(i)); if (f.isCard && !f.fits) spills++; }
      ok(spills === 0, `${tag}: no card's top row spills (${all} cards)`);
      // Each letter on the page moved by the tables: right by the ink's, up by the height's.
      const upOf = (key: string) => -(UP[String(drawn)][key] ?? 0) / drawn;
      const seen = await letters(page);
      const wrong = seen.filter((l: any) => Math.abs(l.x - (INK[l.key] ?? 0)) > 0.01 || Math.abs(l.y - upOf(l.key)) > 0.01);
      const keys = [...new Set(seen.map((l: any) => l.key))].sort();
      ok(seen.length > 0 && wrong.length === 0, `${tag}: every tag's letters moved by the table (${keys.join(", ")})${wrong.length ? ` wrong: ${JSON.stringify(wrong)}` : ""}`);
      for (const k of ["eff L", "eff M", "eff H", "eff X", "uc UC", "advr F", "advr O"]) ok(keys.includes(k), `${tag}: the demo shows ${k}`);
      const yOf = (k: string) => seen.find((l: any) => l.key === k)?.y;
      const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 0.01;
      if (drawn === 1) ok(["uc UC", "advr O"].every((k) => near(yOf(k), -1)) && ["eff L", "eff M", "eff X", "advr F"].every((k) => near(yOf(k), 0)), `${tag}: UC and O go up 1 px, the effort's letters and F do not`);
      if (drawn === 2) ok(["eff L", "eff M", "eff H", "eff X"].every((k) => near(yOf(k), -0.5)) && ["uc UC", "advr O", "advr F"].every((k) => near(yOf(k), 0)), `${tag}: the effort's letters go up 0.5 CSS px, UC, O and F do not`);
      if (drawn === 1.25) ok(seen.every((l: any) => near(l.y, 0)), `${tag}: nothing goes up`);
      const sx = (n: string) => join(OUT, `advisor-${scale}x${zoom !== 1 ? `-zoom${zoom}` : ""}-${n}.png`);
      await page.screenshot({ path: sx("frame") });
      await full.screenshot({ path: sx("full-row") });

      // A model and the chip only: the pricing FAQ, in a terminal, advised by Opus 5.5.
      const faq = card(page, FAQ);
      ok(JSON.stringify(await parts(faq)) === JSON.stringify(["mdl:Haiku 4.5", "advr:O"]), `${tag}: a terminal session shows its model and the chip only (${JSON.stringify(await parts(faq))})`);
      { const tp = (await metaOf(faq)).tip; ok(tp.split("\n")[0] === "Haiku 4.5 · Advised by Opus 5.5", `${tag}: its tooltip says "Haiku 4.5 · Advised by Opus 5.5" (${JSON.stringify(tp)})`); }
      await faq.screenshot({ path: sx("model-only") });

      if (scale === 1 && zoom === 1) {
        // Giving way, card by card narrower: what shows is always the end of the order
        // model, effort, advisor, UC (the model's name goes first, all of it last), the time
        // stays, nothing spills, and once a part has gone it doesn't come back.
        for (const [title, order] of [[SEND, ["model", "effort", "advisor", "ultra"]], ["Fix the login redirect loop", ["model", "effort", "advisor"]], [FAQ, ["model", "advisor"]]] as const) {
          const c = card(page, title);
          const steps: string[] = [];
          let last = 99, bad = "", narrowest = 0;
          for (let w = 400; w >= 150; w -= 2) {
            await c.evaluate((el: HTMLElement, w: number) => { el.style.width = `${w}px`; }, w);
            await page.waitForTimeout(40);
            const f: any = await metaOf(c);
            if (!f.isCard) break;
            narrowest = w;
            const shown = order.map((k) => !!f[k]);
            const n = shown.filter(Boolean).length;
            const suffix = shown.every((x, i) => !x || shown.slice(i).every(Boolean));
            if (!suffix || n > last || !f.fits || !f.timeShown || !f.sized) bad ||= `${w} px: ${JSON.stringify(order.filter((k) => f[k]))}${f.fits ? "" : " spills"}${f.sized ? "" : ` ${f.h} px high`}`;
            if (n !== last) {
              steps.push(`${w}: ${order.filter((k) => f[k]).join(" ") || "time only"}${/no-/.test(f.cls) ? ` (${f.cls.replace("meta", "").trim()})` : ""}`);
              const short = title === SEND ? "full" : title === FAQ ? "faq" : "login";
              if (scale === 1) await c.screenshot({ path: sx(`narrow-${short}-${w}`) });
              last = n;
            }
          }
          ok(!bad && steps.length === order.length + 1, `${tag}: "${title}" gives way in order down to ${narrowest} px: ${steps.join(" · ")}${bad ? ` · wrong at ${bad}` : ""}`);
          await c.evaluate((el: HTMLElement) => { el.style.width = ""; });
        }
      }
      await page.close();
    }
  }

  // Pins. The demo pins the release notes. A pin at the end of a card's top row and of a row:
  // filled and in the card's ink when pinned, faint at rest and an outline on hover;
  // a click or Return pins without opening anything or moving the card. The Pinned toggle
  // before the view tabs, with its count, filters Last 7 Days and All Sessions (kept for next
  // time), with a quiet line when nothing is pinned. In the app, the toggle is the toolbar's:
  // the page tells it the filter and the count, and takes its pinnedOnly and togglePin.
  {
    const pinApi = (sid: string, pinned: boolean) => fetch(`${base}/api/pin/${sid}`, { method: "POST", headers: { "x-csm": "1", "content-type": "application/json" }, body: JSON.stringify({ pinned }) });
    const pinOf = (c: any) => c.evaluate((el: HTMLElement) => {
      const p = el.querySelector("[data-pin]") as HTMLElement | null, r = el.getBoundingClientRect();
      if (!p) return null;
      const b = p.getBoundingClientRect(), i = p.querySelector("svg")!.getBoundingClientRect(), cs = getComputedStyle(p), title = el.querySelector(".title, .htitle") as HTMLElement;
      return { on: p.classList.contains("on"), pressed: p.getAttribute("aria-pressed"), label: p.getAttribute("aria-label"), tip: p.title, opacity: Number(cs.opacity),
        // Its icon ends within the content edge; its box (which may overhang that edge) within the border box.
        inside: i.right <= r.right - parseFloat(getComputedStyle(el).paddingRight) + 0.5 && b.right <= r.right && b.left >= r.left && b.top >= r.top && b.bottom <= r.bottom && b.width > 0,
        filled: getComputedStyle(p.querySelector("svg")!).fill, color: cs.color, ink: getComputedStyle(title).color, aria: el.getAttribute("aria-label") ?? "" };
    });
    const posted: any[] = [];
    for (const size of [SIZES[0], SIZES[2], SIZES[3]]) {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
      await catchOpens(page);
      page.on("request", (r: any) => { if (r.url().includes("/api/pin/")) posted.push({ body: r.postDataJSON(), csm: r.headers()["x-csm"] }); });
      await page.goto(base + "/");
      await page.evaluate(() => { try { localStorage.removeItem("csm-pinned-only"); } catch {} });
      await page.reload();
      await page.waitForSelector("#week .card .pin-b.on");
      await settle(page);
      const tag = `pins, ${size.name}`;
      const shot = (what: string) => page.screenshot({ path: join(OUT, `${size.name}-pins-${what}.png`) });
      const send = card(page, SEND), other = card(page, NOPERMIT);
      const sendSid = await sidOf(send);
      let p = await pinOf(send);
      ok(!!p && p.on && p.pressed === "true" && p.label === "Unpin" && p.tip === "Unpin" && p.opacity === 1 && p.inside && p.filled !== "none" && p.color === p.ink && p.aria.includes("Pinned"),
        `${tag}: a pinned card shows its pin filled, in its ink, inside the card, with Unpin (${JSON.stringify(p)})`);
      await page.mouse.move(1, 1);
      await settle(page);
      p = await pinOf(other);
      ok(!!p && !p.on && p.pressed === "false" && p.tip === "Pin" && !p.aria.includes("Pinned"), `${tag}: an unpinned card's pin says Pin`);
      // At rest, faint: one neutral gray on every dark card, whatever its tint; the dark ink at 45% on an amber one.
      const rest = await page.evaluate(() => {
        const one = (sel: string) => {
          const c = [...document.querySelectorAll(sel)].find((c) => c.querySelector(".pin-b:not(.on):not(.gap)") && (c as HTMLElement).getClientRects().length);
          if (!c) return null;
          const cs = getComputedStyle(c.querySelector(".pin-b")!);
          return { color: cs.color, opacity: Number(cs.opacity), ink: getComputedStyle(c.querySelector(".title")!).color };
        };
        return { dark: one("#week .card:not(.waiting, .asks, .needs), #week .card.stale"), amber: one("#week .card:is(.waiting, .asks, .needs):not(.stale)") };
      });
      ok(rest.dark?.color === "rgb(102, 106, 115)" && rest.dark.opacity === 1 && !!rest.amber && rest.amber.color === rest.amber.ink && Math.abs(rest.amber.opacity - 0.45) < 0.01,
        `${tag}: an unpinned pin shows faint until you point at its card: #666A73 on a dark card, the ink at 45% on amber (${JSON.stringify(rest)})`);
      await other.scrollIntoViewIfNeeded();
      const box = (await other.boundingBox())!;
      await page.mouse.move(box.x + 40, box.y + 40, { steps: 3 });
      await settle(page);
      p = await pinOf(other);
      ok(p.opacity === 1 && p.inside && p.filled === "none", `${tag}: pointing at a card shows its pin as an outline (${p.opacity})`);
      await shot("hover");
      // A click pins it: no session opens, the card stays where it was, the count goes up.
      const before = (await other.boundingBox())!;
      const sid = await sidOf(other);
      const n = posted.length;
      ok(!(await opensFor(page, sid, () => other.locator("[data-pin]").click())), `${tag}: a click on the pin opens nothing`);
      await other.locator(".pin-b.on").waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
      const after = (await other.boundingBox())!;
      ok(posted.length > n && posted.at(-1).body?.pinned === true && posted.at(-1).csm === "1", `${tag}: the click posts {"pinned": true} with x-csm`);
      ok(Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1, `${tag}: the card stays where it is`);
      ok((await page.locator("#pinf .n").textContent()) === "2", `${tag}: the toggle counts 2`);
      // From the keyboard: Space takes it off again, nothing opens, the pin keeps the focus.
      await other.locator("[data-pin]").focus();
      ok(!(await opensFor(page, sid, () => page.keyboard.press(" "))), `${tag}: Space on the pin opens nothing`);
      await other.locator(".pin-b:not(.on)").waitFor({ timeout: 5000 });
      ok(await page.evaluate(() => !!document.activeElement?.matches("[data-pin]")), `${tag}: the pin keeps the keyboard`);
      await page.keyboard.press("Enter");
      await other.locator(".pin-b.on").waitFor({ timeout: 5000 });
      await page.mouse.move(1, 1);
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await settle(page);
      await shot("cards");
      // The filter: only pinned sessions; group heads count what shows; the week's usage stays.
      await page.click("#pinf");
      await page.waitForTimeout(700);
      const week = await page.evaluate(() => {
        const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && !(e as HTMLElement).closest("[data-leaving]");
        const items = [...document.querySelectorAll("#week .card, #week .hrow")].filter(shown);
        const heads = [...document.querySelectorAll("#week .group")].filter(shown).map((g) => ({ n: g.querySelector(".count")!.textContent, k: [...g.querySelectorAll(".card, .hrow")].filter(shown).length }));
        return { all: items.length, pinned: items.filter((e) => e.querySelector(".pin-b.on")).length, heads, usage: shown(document.querySelector("#week .meter")!) || shown(document.querySelector("#week .wstrip")!),
          pressed: document.getElementById("pinf")!.getAttribute("aria-pressed"), sideways: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      ok(week.pressed === "true" && week.all === 2 && week.pinned === 2 && week.heads.every((h) => h.k === 0 ? h.n === "" : Number(h.n) === h.k) && week.usage && !week.sideways,
        `${tag}: the filter shows the 2 pinned, each group counting what shows, the week's usage still there (${JSON.stringify(week)})`);
      await shot("filter");
      await page.reload();
      await page.waitForSelector("#week .card .pin-b.on");
      ok((await page.getAttribute("#pinf", "aria-pressed")) === "true" && (await page.locator("#week .card:visible").count()) === 2, `${tag}: the filter is kept for next time`);
      // All Sessions: only the pinned ones, from the server.
      await page.evaluate(() => (document.querySelector('[data-view="history"]') as HTMLElement).click());
      await page.waitForSelector("#history .hrow");
      await page.waitForTimeout(500);
      const rows = await page.evaluate(() => [...document.querySelectorAll("#history .hrow")].map((r) => !!r.querySelector(".pin-b.on")));
      ok(rows.length === 2 && rows.every(Boolean), `${tag}: All Sessions shows the 2 pinned rows (${rows})`);
      p = await pinOf(page.locator("#history .hrow").first());
      ok(p.inside && p.opacity === 1, `${tag}: a row's pin sits inside it`);
      ok(!(await content(page)).sideways, `${tag}: All Sessions with the filter: nothing spills sideways`);
      await shot("history-filter");
      // Nothing pinned: a quiet line in Last 7 Days and in All Sessions.
      await pinApi(sendSid, false);
      await pinApi(sid, false);
      await page.waitForTimeout(800);
      ok((await page.locator("#history .empty-state h3").textContent()) === "No pinned sessions", `${tag}: All Sessions says there are no pinned sessions`);
      await shot("history-empty");
      await page.evaluate(() => (document.querySelector('[data-view="week"]') as HTMLElement).click());
      await page.waitForTimeout(800);
      ok((await page.locator("#week .quiet.pinq").textContent()) === "No pinned sessions. Pin one from its card." && (await page.locator("#pinf .n").textContent()) === "",
        `${tag}: Last 7 Days says so, and the toggle has no count`);
      ok(!(await content(page)).sideways, `${tag}: nothing pinned: nothing spills sideways`);
      await shot("empty");
      await page.click("#pinf");
      await page.evaluate(() => { try { localStorage.removeItem("csm-pinned-only"); } catch {} });
      await page.close();
      await pinApi(sendSid, true); // back as the demo had it: the release notes pinned
    }

    // In the app: no toggle in the page; the toolbar's is told, and drives it.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await catchOpens(page);
      await page.addInitScript(() => {
        (window as any).__sent = [];
        (window as any).webkit = { messageHandlers: { strip: { postMessage: (m: any) => (window as any).__sent.push(JSON.parse(JSON.stringify(m))) } } };
      });
      await page.goto(base + "/?embed");
      await page.waitForSelector("#week .card .pin-b.on");
      await settle(page);
      const sent = () => page.evaluate(() => (window as any).__sent.filter((m: any) => m.pinned || m.menu));
      ok(!(await page.locator("#pinf").isVisible()), "pins, in the app: no toggle in the page");
      let got = await sent();
      ok(got.some((m: any) => m.pinned && m.pinned.on === false && m.pinned.count === 0) && got.some((m: any) => m.pinned && m.pinned.count === 1),
        `pins, in the app: the page tells the app the filter and the count, on load and when it changes (${JSON.stringify(got)})`);
      await page.evaluate(() => (window as any).csm.pinnedOnly(true));
      await page.waitForTimeout(700);
      ok((await page.locator("#week .card:visible").count()) === 1 && (await sent()).at(-1)?.pinned?.on === true, "pins, in the app: pinnedOnly(true) filters, and the page says so");
      await page.evaluate(() => (window as any).csm.pinnedOnly(false));
      const other = card(page, NOPERMIT);
      const sid = await sidOf(other);
      await page.evaluate((sid: string) => (window as any).csm.togglePin(sid), sid);
      await other.locator(".pin-b.on").waitFor({ timeout: 5000 });
      ok((await sent()).at(-1)?.pinned?.count === 2, "pins, in the app: togglePin pins a session from the app's menu");
      await other.click({ button: "right" });
      const menu = (await sent()).filter((m: any) => m.menu).at(-1)?.menu;
      ok(menu?.sid === sid && menu?.pinned === true, `pins, in the app: the card's menu says it's pinned (${JSON.stringify(menu)})`);
      await page.evaluate((sid: string) => (window as any).csm.togglePin(sid), sid);
      await other.locator(".pin-b:not(.on)").waitFor({ timeout: 5000 });
      await page.screenshot({ path: join(OUT, "app-pins.png") });
      await page.close();
    }
  }

  // Most active. The toggle after Pinned, one filter at a time: on, Last 7 Days keeps its usual
  // view (Active's cards beside the week's usage, the days' rows) with only the 10 sessions
  // Claude worked in most, most first in each part, each with its time working beside its state
  // (the working mark's color, the amber card's ink on amber); All Sessions the same, by day.
  // Kept for next time. Nothing counted yet: a quiet line. An amber row's icons are in its ink.
  // In the app the toolbar has it: the page says {active: {on}} and takes activeOnly().
  {
    const minutes = (t: string) => { const h = /(\d+)h/.exec(t), m = /(\d+)m/.exec(t); return t.startsWith("<") ? 0 : (h ? 60 * Number(h[1]) : 0) + (m ? Number(m[1]) : 0); };
    // Relative luminance contrast of two computed colors.
    const contrastJs = `(a, b) => { const L = (c) => { const v = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }; const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }`;
    for (const size of [SIZES[0], SIZES[2], SIZES[3]]) {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
      await catchOpens(page);
      await page.goto(base + "/");
      await page.evaluate(() => { try { localStorage.removeItem("csm-active-only"); localStorage.removeItem("csm-pinned-only"); } catch {} });
      await page.reload();
      await page.waitForSelector("#week .card");
      await settle(page);
      const tag = `most active, ${size.name}`;
      const shot = (what: string) => page.screenshot({ path: join(OUT, `${size.name}-most-${what}.png`) });
      ok(await page.locator("#maf").isVisible() && (await page.getAttribute("#maf", "aria-pressed")) === "false" && (await page.locator("#week .ma-b").count()) === 0,
        `${tag}: the toggle is there, off, and no card shows its time`);
      await shot("off");
      await page.click("#maf");
      await page.waitForTimeout(800);
      await page.mouse.move(1, 1);
      await settle(page);
      const week = await page.evaluate((contrast: string) => {
        const ratio = eval(contrast);
        const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && !(e as HTMLElement).closest("[data-leaving]");
        const cards = [...document.querySelectorAll("#week .card")].filter(shown) as HTMLElement[];
        const rows = [...document.querySelectorAll("#week .hrow")].filter(shown) as HTMLElement[];
        const groups = [...document.querySelectorAll("#week .group")].filter(shown);
        const ma = (c: Element) => [...c.querySelectorAll(".ma-b")].find(shown) as HTMLElement;
        const meets = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        const bgOf = (el: HTMLElement) => { for (let e: HTMLElement | null = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(.*, 0\)$/.test(c) && c !== "transparent") return c; } return "rgb(0, 0, 0)"; };
        return {
          n: cards.length + rows.length, cards: cards.length,
          times: groups.map((g) => [...g.querySelectorAll(".card, .hrow")].filter(shown).map((c) => ma(c)?.textContent ?? "")),
          heads: groups.map((g) => [g.querySelector(".group-head > span")!.textContent, g.querySelector(".group-head .count")!.textContent, [...g.querySelectorAll(".card, .hrow")].filter(shown).length]),
          rowsInside: rows.every((c) => { const b = ma(c).getBoundingClientRect(), r = c.getBoundingClientRect(); return b.right <= r.right && b.left >= r.left; }),
          usage: shown(document.querySelector("#week .meter")!) || shown(document.querySelector("#week .wstrip")!),
          // One time per card, inside it, over neither its title, its words nor anything else on its top line.
          inside: cards.every((c) => {
            const b = ma(c)?.getBoundingClientRect(), r = c.getBoundingClientRect();
            if (!b || c.querySelectorAll(".ma-b").length !== 2 || [...c.querySelectorAll(".ma-b")].filter(shown).length !== 1) return false;
            const others = [...c.querySelectorAll(".title, .detail, .top > .tag, .time > :not(.ma-b), .pin-b")].filter(shown).map((e) => e.getBoundingClientRect());
            return b.right <= r.right && b.left >= r.left && others.every((o) => !meets(b, o));
          }),
          ink: cards.filter((c) => c.matches(".waiting, .asks, .needs")).map((c) => getComputedStyle(ma(c)).color === getComputedStyle(c.querySelector(".title")!).color),
          contrast: Math.min(...cards.map((c) => ratio(getComputedStyle(ma(c)).color, bgOf(c)))),
          // Pointed at or selected (a card keeps .selected with the keyboard), on its hover step.
          selContrast: Math.min(...cards.map((c) => { c.classList.add("selected"); const r = ratio(getComputedStyle(ma(c)).color, bgOf(c)); c.classList.remove("selected"); return r; })),
          icon: cards.every((c) => !!ma(c)?.querySelector("svg")),
          tip: (cards[0] && ma(cards[0])?.getAttribute("title")) ?? "", aria: cards[0]?.getAttribute("aria-label") ?? "",
          pressed: [document.getElementById("maf")!.getAttribute("aria-pressed"), document.getElementById("pinf")!.getAttribute("aria-pressed")],
          sideways: document.documentElement.scrollWidth > innerWidth + 1,
          counts: (() => { const c = document.getElementById("counts")!; return c.scrollWidth <= c.clientWidth + 1; })(), // the header's counts aren't cut by the two toggles
        };
      }, contrastJs);
      const desc = (ts: string[]) => ts.map(minutes).every((m, i, a) => m > 0 && (i === 0 || a[i - 1] >= m));
      ok(week.pressed.join() === "true,false" && week.n === 10 && week.cards > 0 && week.heads[0]?.[0] === "Active" && week.heads.every((h: any[]) => Number(h[1]) === h[2] || (h[2] === 0 && h[1] === "")),
        `${tag}: the usual view, Active first, with only 10 sessions, each group counting what shows (${JSON.stringify([week.n, week.heads, week.pressed])})`);
      ok(week.times.every(desc) && week.icon, `${tag}: each with its time and the activity icon, most first in each group (${JSON.stringify(week.times)})`);
      ok(week.usage && week.inside && week.rowsInside && !week.sideways && week.counts, `${tag}: the week's usage stays; each time fits its card's top row; nothing spills sideways (${JSON.stringify([week.usage, week.inside, week.sideways])})`);
      ok(week.ink.length > 0 && week.ink.every(Boolean), `${tag}: on an amber card, the time is in the card's ink (${week.ink})`);
      ok(week.contrast >= 4.5, `${tag}: the time reaches 4.5:1 on every card (${week.contrast.toFixed(2)})`);
      ok(week.selContrast >= 4.5, `${tag}: the time reaches 4.5:1 on every card's hover step too (${week.selContrast.toFixed(2)})`);
      ok(/working in the last 7 days$/.test(week.tip) && /working in the last 7 days/.test(week.aria), `${tag}: the tip and the card's label say it in words (${week.tip})`);
      await shot("cards");
      // One filter at a time.
      await page.click("#pinf");
      await page.waitForTimeout(700);
      const both = [await page.getAttribute("#pinf", "aria-pressed"), await page.getAttribute("#maf", "aria-pressed"), await page.locator("#week .ma-b:visible").count()];
      ok(both.join() === "true,false,0", `${tag}: Pinned turns Most active off (${both})`);
      await page.click("#maf");
      await page.waitForTimeout(700);
      ok((await page.getAttribute("#pinf", "aria-pressed")) === "false" && (await page.getAttribute("#maf", "aria-pressed")) === "true", `${tag}: and Most active turns Pinned off`);
      await page.reload();
      await page.locator("#week .card .ma-b:visible").first().waitFor();
      ok((await page.getAttribute("#maf", "aria-pressed")) === "true" && (await page.locator("#week .card:visible, #week .hrow:visible").count()) === 10, `${tag}: the filter is kept for next time`);
      // All Sessions: the same 10 as rows, most first, from the server.
      await page.evaluate(() => (document.querySelector('[data-view="history"]') as HTMLElement).click());
      await page.waitForSelector("#history .hrow .ma-b");
      await page.waitForTimeout(500);
      const rows = await page.evaluate(() => {
        const amber = [...document.querySelectorAll("#history .hrow.live:is(.s-waiting, .s-asks)")];
        const ink = (e: Element) => getComputedStyle(e).color;
        return {
          n: document.querySelectorAll("#history .hrow").length,
          times: [...document.querySelectorAll("#history .group")].map((g) => [...g.querySelectorAll(".hrow")].map((r) => r.querySelector(".ma-b")?.textContent ?? "")),
          heads: [...document.querySelectorAll("#history .group-head > span:not(.count)")].map((h) => h.textContent),
          inside: [...document.querySelectorAll("#history .hrow")].every((r) => { const b = r.querySelector(".ma-b")!.getBoundingClientRect(), x = r.getBoundingClientRect(); return b.right <= x.right && b.left >= x.left; }),
          // An amber row: its scheduled-run icon, its time working and its other icons in its ink, never the plain rows' gray.
          amber: amber.map((r) => [...r.querySelectorAll(".hsched, .ma-b, .hicon, .tag.name svg.i")].map((e) => [ink(e), [ink(r.querySelector(".htitle")!), ink(r.querySelector(".htime")!)].includes(ink(e))])),
          hsched: amber.some((r) => r.querySelector(".hsched")),
        };
      });
      ok(rows.n === 10 && rows.times.every(desc) && rows.inside && !rows.heads.includes("Most active"),
        `${tag}: All Sessions shows the 10 as its usual rows by day, most first in each, each with its time (${JSON.stringify(rows.times)})`);
      ok(rows.hsched && rows.amber.flat().every((x: any) => x[1]), `${tag}: an amber row's icons are in its ink (${JSON.stringify(rows.amber)})`);
      ok(!(await content(page)).sideways, `${tag}: All Sessions with the filter: nothing spills sideways`);
      await shot("history");
      await page.evaluate(() => (document.querySelector('[data-view="week"]') as HTMLElement).click());
      await page.click("#maf");
      await page.waitForTimeout(500);
      ok((await page.locator("#week .ma-b:visible").count()) === 0 && (await page.locator("#week .card:visible, #week .hrow:visible").count()) > 10,
        `${tag}: off again, every session is back and no time shows`);
      await page.close();
    }

    // Nothing counted yet: the stream and History serve the demo's state without any time.
    {
      const plain = await (await fetch(`${base}/api/state`)).json();
      for (const x of plain.sessions) delete x.worked;
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
      await catchOpens(page);
      await page.route("**/api/stream", (r: any) => r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `retry: 600000\ndata: ${JSON.stringify(plain)}\n\n` }));
      await page.route("**/api/history**", (r: any) => r.request().url().includes("active=1") ? r.fulfill({ json: { total: 0, sessions: [] } }) : r.continue());
      await page.addInitScript(() => { try { localStorage.setItem("csm-active-only", "1"); } catch {} });
      await page.goto(base + "/");
      await page.waitForSelector("#week .quiet.maq");
      ok((await page.locator("#week .quiet.maq").textContent()) === "Nothing counted yet. Sessions show here once Claude has worked in them." && (await page.locator("#week .card:visible, #week .hrow:visible").count()) === 0,
        "most active, nothing counted: Last 7 Days says so in a quiet line");
      await page.screenshot({ path: join(OUT, "tall-most-empty.png") });
      await page.evaluate(() => (document.querySelector('[data-view="history"]') as HTMLElement).click());
      await page.waitForSelector("#history .empty-state h3");
      ok((await page.locator("#history .empty-state h3").textContent()) === "Nothing counted yet", "most active, nothing counted: All Sessions says so");
      await page.screenshot({ path: join(OUT, "tall-most-history-empty.png") });
      await page.evaluate(() => { try { localStorage.removeItem("csm-active-only"); } catch {} });
      await page.close();
    }

    // In the app: no toggle in the page; the toolbar's is told, and drives it.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await catchOpens(page);
      await page.addInitScript(() => {
        (window as any).__sent = [];
        (window as any).webkit = { messageHandlers: { strip: { postMessage: (m: any) => (window as any).__sent.push(JSON.parse(JSON.stringify(m))) } } };
      });
      await page.goto(base + "/?embed");
      await page.waitForSelector("#week .card");
      await settle(page);
      const sent = () => page.evaluate(() => (window as any).__sent.filter((m: any) => m.active || m.pinned));
      ok(!(await page.locator("#maf").isVisible()), "most active, in the app: no toggle in the page");
      ok((await sent()).some((m: any) => m.active && m.active.on === false), "most active, in the app: the page tells the app the filter on load");
      await page.evaluate(() => (window as any).csm.pinnedOnly(true));
      await page.waitForTimeout(300);
      await page.evaluate(() => (window as any).csm.activeOnly(true));
      await page.waitForTimeout(800);
      const got = await sent();
      const lastPinned = got.filter((m: any) => m.pinned).at(-1)?.pinned, lastActive = got.filter((m: any) => m.active).at(-1)?.active;
      ok((await page.locator("#week .card:visible, #week .hrow:visible").count()) === 10 && lastActive?.on === true && lastPinned?.on === false,
        `most active, in the app: activeOnly(true) filters, says so, and says Pinned is off (${JSON.stringify([lastActive, lastPinned])})`);
      await page.screenshot({ path: join(OUT, "app-most.png") });
      await page.evaluate(() => (window as any).csm.activeOnly(false));
      await page.waitForTimeout(300);
      ok((await sent()).filter((m: any) => m.active).at(-1)?.active?.on === false, "most active, in the app: activeOnly(false) turns it off");
      await page.close();
    }
  }

  // The rest changes the demo's sessions for good, so it runs once, in the app's window and
  // in the compact view.
  for (const size of [{ name: "wide", width: 1280, height: 900 }, { name: "compact", width: 600, height: 900 }]) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
    await catchOpens(page);
    await page.goto(base + "/?embed");
    const tag = size.name;
    const shot = (what: string) => page.screenshot({ path: join(OUT, `${size.name}-app-${what}.png`) });
    await footIs(page, SEND, ".ans .pri");
    const send = card(page, SEND);
    const sid = await sidOf(send);
    const h = (await measure(send)).h;

    // ⌘↩ on the focused card gives its first answer, at once.
    await send.focus();
    const n = opened.length;
    await page.keyboard.press("Meta+Enter");
    await footIs(page, SEND, ".sentline");
    ok(opened.length === n && (await send.locator(".detail").textContent())!.includes("Publish now"), `${tag}: ⌘↩ sends the first answer`);
    await footIs(page, SEND, ".ans .pri");
    ok((await measure(send)).h === h, `${tag}: its turn over, it asks again, the same height`);

    // A 409 (its mod went away in the meantime) opens the session instead.
    await page.route("**/api/answer/*", (r: any) => r.fulfill({ status: 409 }), { times: 1 });
    ok(await opensFor(page, sid, () => send.locator(".ans .sec").click()), `${tag}: an answer the server refuses opens the session`);
    ok(!(await send.locator(".sentline").count()), `${tag}: and the card still asks`);

    if (size.name === "wide") {
      // Sent and picked up: the mod takes it at once, and the session starts working.
      await send.locator(".ans .sec").click();
      await footIs(page, SEND, ".sentline");
      await page.waitForFunction((t: string) => [...document.querySelectorAll("#week .card")]
        .find((c) => c.querySelector(".title")?.textContent === t)?.querySelector(".sentline")?.textContent?.includes("working on it")
        || [...document.querySelectorAll("#week .card.working:not(.sent)")].some((c) => c.querySelector(".title")?.textContent === t), SEND, { timeout: 10_000 });
      await shot("answer-going");
      await page.waitForSelector(`#week .card.working:not(.sent)[data-sid="${sid}"]`, { timeout: 10_000 });
      ok(true, `${tag}: the session picks it up and works on it`);
      await shot("answer-picked-up");
    }

    // ⌘↩ on a permission's card opens the session; no key allows.
    {
      const pc = card(page, PERMIT);
      const psid = await sidOf(pc);
      await footIs(page, PERMIT, ".ans.permit .pri");
      let posted = 0;
      const count = (r: any) => { if (r.url().includes("/api/permission/")) posted++; };
      page.on("request", count);
      await pc.focus();
      ok(await opensFor(page, psid, () => page.keyboard.press("Meta+Enter")), `permit: ${tag}: ⌘↩ on a permission's card opens the session`);
      await page.waitForTimeout(300);
      page.off("request", count);
      ok(posted === 0 && (await pc.locator(".ans.permit").count()) === 1, `permit: ${tag}: and allows nothing`);
      // Refused (settled in the meantime): the click opens the session instead.
      await page.route("**/api/permission/*/decide", (r: any) => r.fulfill({ status: 409 }), { times: 1 });
      ok(await opensFor(page, psid, () => pc.locator(".ans.permit .pri").click()), `permit: ${tag}: a decision the server refuses opens the session`);
      ok((await pc.locator(".ans.permit").count()) === 1, `permit: ${tag}: and the card still asks`);
    }
    // Not sent: the plugin asked once, then went away between two rounds, so your Allow waits
    // (Allowing…), then nothing took it: the card says so and needs you again.
    {
      const nc = card(page, NOPERMIT);
      const nsid = await sidOf(nc);
      if (size.name === "wide") {
        const nh = (await measure(nc)).h;
        await fetch(`${base}/api/permission/${nsid}`, { method: "POST", headers: { "x-csm": "1" }, body: JSON.stringify({ id: "page-1", tool: "Bash", what: "git tag -a v3.1.0-rc.1 -m 'Release candidate 1'" }), signal: AbortSignal.timeout(300) }).catch(() => {});
        await footIs(page, NOPERMIT, ".ans.permit .pri");
        await nc.locator(".ans.permit .pri").click();
        await footIs(page, NOPERMIT, ".sentline:not(.failed)");
        const g = await measure(nc);
        ok(g.foot === "Allowing…" && /\bsent\b/.test(g.cls) && g.h === nh, `permit: ${tag}: while no mod has taken it, the card says Allowing… ("${g.foot}", ${g.h})`);
        await nc.scrollIntoViewIfNeeded();
        await shot("permit-sending");
        await footIs(page, NOPERMIT, ".sentline.failed");
        const f = await measure(nc), a = await askOf(nc);
        const st = (await (await fetch(`${base}/api/state`)).json()) as any;
        const ss = st.sessions.find((x: any) => x.sid === nsid);
        ok(/\bwaiting\b/.test(f.cls) && !/\bsent\b/.test(f.cls) && f.foot.startsWith("Couldn't send") && a.tag === "Needs you" && a.has && f.h === nh && !f.spill
          && ss.needsYou === true && a.aria.includes("Couldn't send your answer"),
          `permit: ${tag}: a decision nothing took says so, Needs you again ("${f.foot}", ${f.h})`);
        await shot("permit-failed");
        ok(await opensFor(page, nsid, () => nc.locator(".sentline [data-open-sid]").click()), `permit: ${tag}: its Open opens the session`);
        ok(await opensFor(page, nsid, () => nc.locator(".title").click()), `permit: ${tag}: and so does a click on the card`);
      } else {
        await footIs(page, NOPERMIT, ".sentline.failed");
        const f = await measure(nc);
        ok(f.footIn && !f.spill, `permit: ${tag}: the not-sent row fits`);
        await nc.scrollIntoViewIfNeeded();
        await shot("permit-failed");
      }
    }

    // Not sent: its mod asked once and went away, so nothing took it. The card needs you again.
    const nomod = card(page, NOMOD);
    const nsid = await sidOf(nomod);
    if (size.name === "wide") {
      await fetch(`${base}/api/answer/${nsid}/next`, { headers: { "x-csm": "1" }, signal: AbortSignal.timeout(300) }).catch(() => {});
      await page.waitForFunction((s: string) => !document.querySelector(`#week .card[data-sid="${s}"] .a-b.opens`), nsid, { timeout: 10_000 });
      const nh = (await measure(nomod)).h;
      await nomod.locator(".ans .pri").click();
      await footIs(page, NOMOD, ".sentline:not(.failed)");
      ok((await nomod.locator(".sentline").textContent())?.trim() === "Sending…", `${tag}: while no mod has taken it, the card says Sending…`);
      await footIs(page, NOMOD, ".sentline.failed");
      const f = await measure(nomod);
      ok(/\basks\b/.test(f.cls) && !/\bsent\b/.test(f.cls) && f.foot.startsWith("Couldn't send") && f.h === nh && !f.spill,
        `${tag}: an answer nothing took says so, Needs you again ("${f.foot}", ${f.h})`);
      await shot("answer-failed");
      ok(await opensFor(page, nsid, () => nomod.locator(".sentline [data-open-sid]").click()), `${tag}: its Open opens the session`);
    } else {
      // The compact view's rows with the not-sent card, its sent card and the answers.
      await footIs(page, NOMOD, ".sentline.failed");
      const f = await measure(nomod);
      ok(f.footIn && !f.spill, `${tag}: the not-sent row fits`);
      await nomod.scrollIntoViewIfNeeded();
      await shot("answer-failed");
      const app = card(page, APP);
      const ah = (await measure(app)).h;
      await app.locator(".ans .sec").click();
      await footIs(page, APP, ".sentline");
      ok((await measure(app)).h === ah, `${tag}: a sent row keeps its height (${ah})`);
      await app.scrollIntoViewIfNeeded();
      await shot("answer-sent");
      await footIs(page, APP, ".ans .pri");
    }
    await page.close();
  }

  // The week's usage doesn't move while Active's cards scroll by, and leaves with Active.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 560 }, deviceScaleFactor: 2 });
    await page.goto(base + "/?embed");
    await page.waitForSelector("#week .card");
    await page.waitForSelector(".abody > .meter:not([hidden])");
    await settle(page);
    const at = () => page.evaluate(() => {
      const c = document.getElementById("content")!, m = document.querySelector(".abody > .meter") as HTMLElement;
      const body = m.parentElement!.getBoundingClientRect();
      return { top: Math.round(m.getBoundingClientRect().top - c.getBoundingClientRect().top), body: Math.round(body.bottom - c.getBoundingClientRect().top),
        h: Math.round(m.getBoundingClientRect().height), scrolled: Math.round(c.scrollTop) };
    });
    const start = await at();
    // Flush with the cards, the tile a box as tall as two cards: "This week"'s own line starts on
    // the first row's top edge and its last line's (the 5-hour window in the demo, then the reset
    // without it) ends on the second row's bottom edge, the letters inside, with the room the
    // line keeps over its capitals and under its baseline, like a card's text.
    const flush = await page.evaluate(() => {
      const m = document.querySelector(".abody > .meter") as HTMLElement;
      const rows = [...m.parentElement!.querySelectorAll(".grid > .card")].map((c) => c.getBoundingClientRect());
      const second = rows.find((r) => r.top > rows[0].bottom)!;
      // A baseline: an empty inline block sits its bottom on it. A capital's height: 1cap.
      const probe = (el: Element, h = "0") => {
        const p = document.createElement("span");
        p.style.cssText = `display:inline-block;width:0;height:${h};vertical-align:baseline`;
        el.append(p);
        const r = p.getBoundingClientRect();
        p.remove();
        return r;
      };
      // Where the line's box ends against the edge, and how far under the letters' baseline.
      const line = (box: Element, text: Element) => ({ bottom: box.getBoundingClientRect().bottom - second.bottom,
        under: box.getBoundingClientRect().bottom - probe(text).bottom });
      const five = m.querySelector(".m-five")!, reset = m.querySelector(".m-reset")!;
      const withFive = line(five, five.firstElementChild!), last = m.lastElementChild!.className;
      // The line above the 5-hour window, halfway between the reset's baseline and its capitals.
      const rule = five.getBoundingClientRect().top, caps = probe(five.firstElementChild!, "1cap").top;
      const half = { above: rule - probe(reset).bottom, below: caps - rule };
      const next = five.nextSibling;
      five.remove();
      m.getBoundingClientRect();
      const without = line(reset, reset);
      m.insertBefore(five, next);
      const lbl = m.querySelector(".m-lbl")!;
      const trim = (el: Element) => getComputedStyle(el).getPropertyValue("text-box-trim") || "none";
      return { top: lbl.getBoundingClientRect().top - rows[0].top, over: probe(lbl, "1cap").top - lbl.getBoundingClientRect().top,
        last, withFive, without, half, trim: [lbl, reset, five.firstElementChild!].map(trim).join(" ") };
    });
    const sits = (l: { bottom: number; under: number }) => Math.abs(l.bottom) < 0.5 && l.under > 2.5 && l.under < 4;
    ok(Math.abs(flush.top) < 0.5 && flush.over > 2.5 && flush.over < 4 && flush.last === "m-five" && sits(flush.withFive) && sits(flush.without) && flush.trim === "none none none",
      `the week's usage spans the first two rows: This week's line on their top (${flush.top.toFixed(1)}), its capitals ${flush.over.toFixed(1)} px inside; the last line's box on the second's bottom, its letters ${flush.withFive.under.toFixed(1)} px inside: the 5-hour line (${flush.withFive.bottom.toFixed(1)}), the reset without it (${flush.without.bottom.toFixed(1)}, ${flush.without.under.toFixed(1)} px)`);
    ok(Math.abs(flush.half.above - flush.half.below) < 0.6,
      `the line above the 5-hour window, halfway between the reset's baseline and its capitals (${flush.half.above.toFixed(1)}, ${flush.half.below.toFixed(1)})`);
    const room = start.body - start.top - start.h; // how far Active's cards go on below it
    ok(room > 60, `the demo's Active is taller than the usage tile (${room} px more)`);
    await page.evaluate((y: number) => document.getElementById("content")!.scrollTo({ top: y }), Math.min(room, 200));
    await settle(page);
    const mid = await at();
    ok(mid.top === start.top && mid.scrolled > 0, `scrolled ${mid.scrolled} px, the usage tile stays where it started (${start.top} → ${mid.top})`);
    await page.screenshot({ path: join(OUT, "meter-sticky.png") });
    const band = await page.evaluate(() => getComputedStyle(document.getElementById("content")!).overscrollBehaviorY);
    ok(band === "none", `the list doesn't rubber-band at its ends, so a flick to the top leaves the tile still (${band})`);
    await page.evaluate(() => document.getElementById("content")!.scrollTo({ top: 100_000 }));
    await settle(page);
    const end = await at();
    ok(end.top + end.h <= end.body + 1, `past Active, it goes with it (${end.top + end.h} ≤ ${end.body})`);
    await page.close();
  }

  // A window so short the count popover's list scrolls: its fades sit on its edges.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 380 }, deviceScaleFactor: 2 });
    await page.goto(base + "/?embed");
    await page.waitForSelector("#week .card");
    await page.locator("#counts [data-pop]").last().hover();
    await page.waitForSelector("#pop.open");
    await settle(page);
    let p = await pop(page);
    ok(p.below && !p.up && p.down && p.downAt === 0, `a short window: the popover scrolls, a fade on its bottom edge (${p.downAt})`);
    await page.screenshot({ path: join(OUT, "popover-scrolls-top.png") });
    await page.evaluate(() => { const b = document.getElementById("pop")!; b.scrollTo({ top: Math.round((b.scrollHeight - b.clientHeight) / 2) }); });
    await settle(page);
    p = await pop(page);
    ok(p.up && p.down && p.upAt === 0 && Math.abs(p.downAt - Math.round(p.gap)) <= 1, `a short window, popover halfway: a fade on each edge (${p.upAt}, ${p.downAt})`);
    await page.screenshot({ path: join(OUT, "popover-scrolls-middle.png") });
    await page.evaluate(() => { const b = document.getElementById("pop")!; b.scrollTo({ top: b.scrollHeight }); });
    await settle(page);
    p = await pop(page);
    ok(p.up && !p.down, "a short window, popover at the end: a fade above, none below");
    await page.close();
  }

  // The family spotlight follows the real pointer only. Leaving the window ends it, and a replay
  // of the last pointer position (WebKit sends one when the layout changes, without moving)
  // never lights it: not while the pointer is out, and not right after it comes back in
  // somewhere else.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + "/?embed");
    await page.waitForSelector("#week .card");
    await settle(page);
    const lit = async () => { await page.waitForTimeout(350); return page.evaluate(() => document.getElementById("content")!.classList.contains("family")); };
    const family = page.locator("#week .card", { hasText: "Fix the flaky checkout test" }).first();
    const loner = page.locator("#week .card", { hasText: "Upgrade the payments SDK" }).first();
    const replay = () => family.evaluate((el) => {
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, movementX: 0, movementY: 0 }));
    });
    await page.evaluate(() => (window as any).csm.pointer(true));
    await page.mouse.move(5, 5);
    await family.hover();
    await page.waitForTimeout(130);
    const soon = await page.evaluate(() => document.getElementById("content")!.classList.contains("family"));
    ok(soon, "the family lights up after a short pause (80 ms)");
    ok(await lit(), "the family lights up under the real pointer");
    await page.evaluate(() => (window as any).csm.pointer(false));
    ok(!(await lit()), "it goes when the pointer leaves the window");
    await replay();
    ok(!(await lit()), "a replay of the last position while the pointer is out lights nothing");
    await page.evaluate(() => (window as any).csm.pointer(true));
    await replay();
    ok(!(await lit()), "coming back in, a replay of where it left lights nothing");
    await loner.hover();
    ok(!(await lit()), "the pointer back in, over a card with no relatives: nothing lit");
    await family.hover();
    ok(await lit(), "and over the family again, it lights up");
    await page.close();
  }

  // Dictation, as in the app: a stand-in for the app's bridge records what the page asks
  // (start, stop, cancel), and the test plays the app's side through window.csm.dictation.
  // The composer is one popover in the list, outside the card, anchored to the card's mic.
  const SAY = "Write the cart race regression test"; // a Done card whose mod listens
  const LONGSAY = "Yes, go ahead and merge the regression test, then run the whole checkout suite twice on staging and tell me if the race shows up again before we ship the fix to everyone tomorrow.";
  const WORDS120 = "Yes, go ahead and merge the regression test, then run the checkout suite twice and tell me if the race shows up again.";
  for (const size of SIZES) {
    const tag = `${size.name}, dictation`;
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
    await catchOpens(page);
    await page.addInitScript(() => {
      (window as any).__said = [];
      const RealES = (window as any).EventSource; // keeps the last state, to replay a changed one
      (window as any).EventSource = function (u: string) { const e = new RealES(u); (window as any).__es = e; e.addEventListener("message", (m: any) => ((window as any).__last = m.data)); return e; };
      (window as any).webkit = { messageHandlers: { dictate: { postMessage: (m: any) => (window as any).__said.push(m) } } };
    });
    await page.goto(base + "/?embed");
    await page.waitForSelector("#week .card");
    const shot = async (what: string) => { await page.waitForTimeout(200); await page.screenshot({ path: join(OUT, `${size.name}-dictation-${what}.png`) }); }; // after the composer's fade in
    const said = () => page.evaluate(() => (window as any).__said.splice(0));
    const app = (m: object) => page.evaluate((m: object) => (window as any).csm.dictation(m), m);
    const replay = () => page.evaluate(() => (window as any).__es.onmessage({ data: (window as any).__last })); // the same state again, from the server
    // Pointing at a card holds Last 7 Days still: the server's order changes and nothing moves;
    // off the cards, a moment later, they glide where they belong. Then the real order comes back.
    {
      const order = () => page.evaluate(() => [...document.querySelectorAll("#week .grid > .card")]
        .filter((x) => !("leaving" in (x as HTMLElement).dataset)).map((x) => (x as HTMLElement).dataset.sid));
      const held = await sidOf(card(page, SAY));
      const orig = await page.evaluate(() => (window as any).__last);
      await card(page, SAY).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const hb = (await card(page, SAY).boundingBox())!;
      await page.mouse.move(hb.x + 30, hb.y + 30, { steps: 5 }); // a real move: the page in the app ignores a pointer that doesn't move
      const o0 = await order();
      await page.evaluate((sid: string) => {
        const w = window as any, st = JSON.parse(w.__last);
        const i = st.sessions.findIndex((x: any) => x.sid === sid);
        const [m] = st.sessions.splice(i, 1);
        st.sessions.push(m);
        w.__es.onmessage({ data: JSON.stringify(st) });
      }, held);
      await page.waitForTimeout(700);
      ok((await order()).join() === o0.join(), `${tag}: with the pointer on a card, the cards hold still when the order changes`);
      await page.mouse.move(1, 1, { steps: 3 });
      // Meanwhile the week's usage beside the cards stays where it is while they glide.
      const drift = await page.evaluate(async () => {
        const m = document.querySelector(".abody > .meter") as HTMLElement | null;
        if (!m || m.hidden || !m.getClientRects().length) return null;
        const y0 = m.getBoundingClientRect().top;
        let most = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < 1300) { await new Promise((r) => requestAnimationFrame(r)); most = Math.max(most, Math.abs(m.getBoundingClientRect().top - y0)); }
        return most;
      });
      if (drift !== null) ok(drift <= 1, `${tag}: the week's usage holds still while the cards glide (${drift.toFixed(1)} px)`);
      else await page.waitForTimeout(1300);
      const o2 = await order();
      ok(o2[o2.length - 1] === held, `${tag}: off the cards, they go where they belong (${o2.indexOf(held) + 1} of ${o2.length})`);
      await page.evaluate((st: string) => (window as any).__es.onmessage({ data: st }), orig);
      await page.waitForTimeout(900);
    }
    const c = card(page, SAY);
    const mic = c.locator("[data-mic]");
    const D = page.locator("#dict");
    await mic.waitFor({ timeout: 15_000 });
    await c.scrollIntoViewIfNeeded();
    await settle(page);
    const sid = await sidOf(c);
    const phase = () => page.evaluate(() => document.getElementById("dict")?.className.match(/\b(listening|stopping|review|sending|error)\b/)?.[1] ?? "");
    // The card as it is, with the mic's on state set aside: dictating must not change it.
    const cardNow = () => c.evaluate((el: HTMLElement) => {
      const x = el.cloneNode(true) as HTMLElement;
      x.querySelector("[data-mic]")?.classList.remove("on");
      x.querySelector("[data-mic]")?.setAttribute("aria-expanded", "false");
      return { html: x.innerHTML, top: el.querySelector(".top")!.getClientRects().length > 0 || getComputedStyle(el).display === "grid", inner: (el as any)._inner };
    });
    // Where the composer is: inside the window, its parts inside it, a drawer flush with its card's
    // edge (below it, or above when there's no room), as wide as the card. Measured where it rests,
    // without the slide it may still be in.
    const geo = () => page.evaluate((sid: string) => {
      const d = document.getElementById("dict");
      if (!d) return null;
      const r = d.getBoundingClientRect(), c = document.getElementById("content")!.getBoundingClientRect();
      const mic = document.querySelector(`#week .card[data-sid="${CSS.escape(sid)}"] [data-mic]`) as HTMLElement | null;
      const m = mic?.getBoundingClientRect();
      const parts = [...d.querySelectorAll(".d-b, .d-row, .d-head, .d-edit, .d-words")] as HTMLElement[];
      const out = parts.filter((p) => { const b = p.getBoundingClientRect(); return b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5 || b.bottom > r.bottom + 0.5); }).map((p) => p.className);
      const cut = [...d.querySelectorAll(".d-row, .d-head, .d-b")].filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.className);
      const above = d.classList.contains("above");
      const ke = document.querySelector(`#week .card[data-sid="${CSS.escape(sid)}"]`) as HTMLElement | null;
      const k = ke?.getBoundingClientRect();
      const tuck = ke ? parseFloat(getComputedStyle(ke).borderBottomLeftRadius) || 0 : 0; // it starts under the card's round corners
      const ty = new DOMMatrix(getComputedStyle(d).transform).m42 || 0;
      const side = !k || (above ? Math.abs(r.bottom - ty - (k.top + tuck)) <= 1 : Math.abs(r.top - ty - (k.bottom - tuck)) <= 1);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, above, side, out, cut, inWindow: r.left >= 0 && r.right <= innerWidth && r.right <= c.right + 8,
        flush: !k || (Math.abs(r.left - k.left) <= 1 && Math.abs(r.width - k.width) <= 1), open: d.classList.contains("open") && d.style.display !== "none",
        micOn: !!mic?.classList.contains("on") && mic?.getAttribute("aria-expanded") === "true", micTop: m?.top ?? 0, micBottom: m?.bottom ?? 0 };
    }, sid);
    const fits = async (what: string, settle = 400) => {
      await page.waitForTimeout(settle); // it grows to its new height first
      const g = await geo();
      ok(!!g && g.open && g.inWindow && g.side && g.flush && !g.out.length && !g.cut.length,
        `${tag}: ${what}: the composer opens ${g?.above ? "above" : "below"} its card, flush and as wide, inside the window${g?.out.length ? `, out: ${g.out}` : ""}${g?.cut.length ? `, cut: ${g.cut}` : ""}${g && !g.inWindow ? `, at ${Math.round(g.left)}–${Math.round(g.right)}` : ""}`);
      return g;
    };
    const unchanged = async (before: any, what: string) => {
      const now = await cardNow();
      ok(now.html === before.html && now.inner === before.inner && now.top, `${tag}: ${what}: the card under it is the same, its top row in sight`);
    };
    const closed = async (what: string) => {
      // The close can lag the click (twice in a row in one run, cause not pinned down): give it a moment.
      await D.waitFor({ state: "detached", timeout: 2000 }).catch(() => {});
      const left = await D.count(), on = await mic.evaluate((el: HTMLElement) => el.classList.contains("on"));
      ok(!left && !on, `${tag}: ${what} closes it and the mic is off${left || on ? ` (still open: ${left}, phase ${await phase()}, mic on: ${on})` : ""}`);
    };

    // Idle: the mic sits at the end of the foot.
    ok((await mic.getAttribute("aria-label")) === "Dictate an answer" && !!(await mic.getAttribute("title")) && (await mic.getAttribute("aria-haspopup")) === "dialog", `${tag}: the mic has its label, tip and popup`);
    await shot("1-mic");
    const before = await cardNow();

    // Pressed: the app is asked to listen for this card, nothing opens, the composer comes out of the mic.
    ok(!(await opensFor(page, sid, () => mic.click())), `${tag}: pressing the mic doesn't open the session`);
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "start", sid }]), `${tag}: the app is asked to listen for this card`);
    ok((await phase()) === "listening", `${tag}: the composer listens`);
    ok((await D.getAttribute("role")) === "dialog" && !!(await D.getAttribute("aria-label")), `${tag}: the composer is a dialog with a label`);
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-dict") === "send"), `${tag}: Send has the keyboard`);
    ok((await D.locator('[data-dict="send"]').innerText()) === "Send" && (await D.locator('[data-dict="cancel"]').innerText()) === "Cancel", `${tag}: Cancel and Send, by name`);
    ok((await D.locator('[data-dict="send"]').getAttribute("title")) === "Send what you said (Return)" && !(await D.locator('[data-dict="stop"]').count()), `${tag}: Send's tip, and no Done`);
    await settle(page);
    let g = await fits("listening");
    ok(!!g?.micOn, `${tag}: the mic shows it's on`);
    await unchanged(before, "listening");
    await shot("2-listening-empty");
    await app({ sid, state: "listening", text: WORDS120, level: 0.7, lang: "es-MX" });
    ok((await D.locator(".d-words").innerText()).includes("Yes, go ahead and merge"), `${tag}: the words show as they come`);
    ok((await D.locator(".d-wave").evaluate((el: HTMLElement) => el.style.getPropertyValue("--lvl"))) === "0.7", `${tag}: the level reaches the wave`);
    // Quiet or loud, the wave keeps its width, so Listening beside it stays put.
    const sayAt = () => D.locator(".d-say").evaluate((el: HTMLElement) => el.getBoundingClientRect().left);
    const loud = await sayAt();
    await app({ sid, state: "listening", text: WORDS120, level: 0, lang: "es-MX" });
    const hushed = await sayAt();
    ok(Math.abs(loud - hushed) < 0.5, `${tag}: Listening stays put whether you talk or not (${loud} → ${hushed})`);
    await app({ sid, state: "listening", text: WORDS120, level: 0.7, lang: "es-MX" });
    ok((await D.locator(".d-tip").innerText()) === "End with “enviar mensaje” to send" && (await D.locator(".d-tip > span").getAttribute("title")) === "End with “enviar mensaje” and stop talking to send", `${tag}: under the words, the hint says the phrase that sends, and its tooltip all of them`);
    await fits("120 characters");
    await shot("3-listening");
    await app({ sid, state: "listening", text: LONGSAY, level: 0.3, lang: "es-MX" });
    await fits("a long sentence");
    const end = await D.locator(".d-words").evaluate((el: HTMLElement) => { const t = el.firstElementChild!.getBoundingClientRect(), b = el.getBoundingClientRect(); return t.bottom <= b.bottom + 1; });
    ok(end, `${tag}: the newest words are the ones in view`);
    await shot("4-listening-long");
    // A click elsewhere doesn't lose the words.
    await page.mouse.click(4, 4);
    ok((await phase()) === "listening", `${tag}: a click outside leaves it open`);
    // Only one popover: the counts' details don't open over it.
    await page.locator("#counts [data-pop]").first().dispatchEvent("mouseover");
    await page.waitForTimeout(450);
    ok(!(await page.locator("#pop.open").count()), `${tag}: the counts' details stay shut while you dictate`);
    // It follows its card when the list scrolls.
    const g0 = await geo();
    await page.evaluate(() => { document.getElementById("content")!.scrollTop += 40; });
    const g1 = await geo();
    ok(!!g0 && !!g1 && Math.abs((g1.top - g1.micBottom) - (g0.top - g0.micBottom)) < 1 && Math.abs(g1.top - g0.top) > 1, `${tag}: it moves with its card as the list scrolls`);
    await page.evaluate(() => { document.getElementById("content")!.scrollTop -= 40; });

    // Send stops and sends the final words at once (the server holds a moment, then refuses).
    await page.route(`**/api/answer/${sid}`, async (r: any) => { await Bun.sleep(700); await r.fulfill({ status: 409 }); });
    await D.locator('[data-dict="send"]').click();
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "stop" }]), `${tag}: Send asks the app to stop`);
    ok((await phase()) === "stopping" && (await D.locator(".d-head").innerText()).includes("Sending…")
      && (await D.locator('[data-dict="send"]').getAttribute("aria-disabled")) === "true", `${tag}: while it stops it says Sending… and Send is off`);
    await fits("stopping");
    await shot("5-stopping");
    let early = false;
    const spy = (r: any) => { if (r.url().endsWith(`/api/answer/${sid}`)) early = true; };
    page.on("request", spy);
    await page.keyboard.press("Enter"); // a second press while it stops
    await D.locator('[data-dict="send"]').click({ force: true });
    await page.waitForTimeout(100);
    page.off("request", spy);
    ok(!early && (await phase()) === "stopping" && !(await said()).length, `${tag}: a second Send or Return while it stops does nothing`);
    const req1 = page.waitForRequest((r: any) => r.url().endsWith(`/api/answer/${sid}`) && r.method() === "POST");
    await app({ sid, state: "done", text: "  Yes, go ahead   and merge the test  ", lang: "es-MX" });
    const sent1 = await req1;
    const body1 = JSON.parse(sent1.postData() ?? "{}");
    ok(body1.text === "Yes, go ahead and merge the test" && typeof body1.since === "number", `${tag}: the final words go straight to the session, folded to one line (${body1.text})`);
    ok((await phase()) === "sending" && (await D.locator('[data-dict="send"]').innerText()) === "Sending…", `${tag}: from listening it goes straight to sending`);
    ok(!(await said()).length, `${tag}: the app isn't asked for anything more`);
    await fits("sending from listening");
    await unchanged(before, "sending from listening");
    await shot("6-sending");
    // Refused: the words wait in the text box, with a note, to fix and send again.
    const box = D.locator("textarea");
    await D.locator(".d-say.note").waitFor({ timeout: 3000 });
    early = false;
    page.on("request", spy);
    await page.keyboard.press("Enter"); // a Return right after it came back
    await page.waitForTimeout(100);
    page.off("request", spy);
    await page.unroute(`**/api/answer/${sid}`);
    ok((await phase()) === "review" && (await box.inputValue()) === "Yes, go ahead and merge the test", `${tag}: a refused send keeps the words in the text box`);
    ok((await D.locator(".d-head").innerText()).includes("Couldn't send"), `${tag}: it says it couldn't send`);
    ok(await box.evaluate((el) => el === document.activeElement), `${tag}: the text box has the keyboard`);
    ok(!early && (await phase()) === "review", `${tag}: a Return right after the refusal doesn't send again`);
    await fits("send refused");
    await shot("7-send-refused");
    await page.waitForTimeout(600);
    ok(!(await opensFor(page, sid, async () => { await box.click(); await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length)); await page.keyboard.type(" now"); await page.keyboard.press("Space"); await page.keyboard.press("ArrowLeft"); })), `${tag}: clicking and typing in the box opens nothing`);
    ok((await box.inputValue()) === "Yes, go ahead and merge the test now ", `${tag}: what you type goes in the box (${await box.inputValue()})`);
    await fits("review");
    await unchanged(before, "review");
    // The server's order shifts while you dictate: the cards hold still, and the composer stays on its card.
    const at = () => c.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)}`; });
    const at0 = await at();
    for (const to of ["end", "start"]) {
      await page.evaluate(({ sid, to }) => {
        const w = window as any, st = JSON.parse(w.__last);
        const i = st.sessions.findIndex((x: any) => x.sid === sid);
        if (i >= 0) { const [m] = st.sessions.splice(i, 1); to === "end" ? st.sessions.push(m) : st.sessions.unshift(m); }
        w.__last = JSON.stringify(st);
        w.__es.onmessage({ data: w.__last });
      }, { sid, to });
      await page.waitForTimeout(900);
      const gm = await geo();
      const at1 = await at();
      ok(!!gm && gm.open && gm.side && gm.flush && at1 === at0, `${tag}: the order puts the card at the ${to} of Active: while you dictate it holds its place, the composer on it (${at0} → ${at1}, side ${gm?.side}, flush ${gm?.flush})`);
    }
    await shot("7-review-edited");
    // Tab stays in the composer.
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    ok(await page.evaluate(() => !!document.getElementById("dict")?.contains(document.activeElement)), `${tag}: Tab stays in the composer`);
    // A state update and a view change leave what you typed and where.
    await box.focus();
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
    await replay();
    await page.evaluate(() => (window as any).csm.setView("week"));
    ok((await box.inputValue()).endsWith("now ") && await box.evaluate((el: HTMLTextAreaElement) => el === document.activeElement && el.selectionStart === 3), `${tag}: an update keeps the words, the focus and the caret`);
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));

    // Return sends again: one line, to the session (held a moment, to see Sending…); then the card says it's on its way.
    await page.route(`**/api/answer/${sid}`, async (r: any) => { await Bun.sleep(700); await r.continue(); });
    const req = page.waitForRequest((r: any) => r.url().endsWith(`/api/answer/${sid}`) && r.method() === "POST");
    await box.focus();
    await page.keyboard.press("Enter");
    const sent = await req;
    ok((await phase()) === "sending" && (await D.locator('[data-dict="send"]').innerText()) === "Sending…", `${tag}: it says it's sending`);
    await fits("sending again");
    await shot("8-sending-again");
    const body = JSON.parse(sent.postData() ?? "{}");
    const status = (await sent.response())?.status();
    await page.unroute(`**/api/answer/${sid}`);
    ok(body.text === "Yes, go ahead and merge the test now" && status === 204, `${tag}: Return sends the words, folded to one line (${body.text}, ${status})`);
    await c.locator(".sentline").waitFor({ timeout: 5000 });
    ok(!(await D.count()), `${tag}: the composer goes once it's sent`);
    await shot("8-sent");

    // Back to Done (the demo's session works a moment, then ends its turn): the errors.
    await mic.waitFor({ timeout: 15_000 });
    await settle(page);
    for (const [err, words] of [["denied", "System Settings"], ["unavailable", "Download it"], ["failed", "Try again"], ["silent", "no sound"]]) {
      // Just before, once the card has settled from its last turn: its time may move on between rounds.
      let before2 = await cardNow();
      for (let i = 0; i < 10; i++) { await page.waitForTimeout(400); const again = await cardNow(); if (again.html === before2.html) break; before2 = again; }
      await mic.click();
      await said();
      await app({ sid, state: "error", error: err });
      const text = await D.locator(".d-words").innerText();
      ok((await phase()) === "error" && text.includes(words), `${tag}: ${err} says what to do (${text})`);
      await fits(`the ${err} message`);
      await unchanged(before2, err);
      await shot(`9-error-${err}`);
      await D.locator('[data-dict="cancel"]').click();
      await closed(`Close on ${err}`);
    }
    // Try again from an error listens again.
    await mic.click();
    await app({ sid, state: "error", error: "failed" });
    await said();
    await D.locator('[data-dict="retry"]').click();
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "start", sid }]) && (await phase()) === "listening", `${tag}: Try again listens again`);
    // Send with nothing heard: it says so, and nothing goes.
    await D.locator('[data-dict="send"]').click();
    await said();
    await app({ sid, state: "done", text: "   " });
    ok((await phase()) === "error" && (await D.locator(".d-words").innerText()).includes("No words"), `${tag}: no words heard says so`);
    await shot("10-error-empty");
    await page.keyboard.press("Escape");
    await closed("Esc on an error");

    // A second press on the mic closes it, as Cancel does, and tells the app.
    await mic.click();
    await said();
    ok(await mic.evaluate((el: HTMLElement) => el.classList.contains("on") && el.getAttribute("aria-expanded") === "true"), `${tag}: while it's open the mic is on`);
    await mic.click();
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "cancel" }]) && !(await D.count()), `${tag}: a second press on the mic closes it and tells the app`);
    await page.waitForTimeout(250);
    // The app says its language as the page loads (no card): the next composer shows it from its first frame.
    await app({ lang: "es-MX", phrases: ["enviar mensaje"], keep: false });
    await mic.click();
    await said();
    ok((await D.locator(".d-lang").innerText()) === "ES", `${tag}: the language the app said on load shows from the start (ES)`);
    await mic.click();
    await said();
    await page.waitForTimeout(250);
    await app({ lang: "en-US", phrases: ["send message"], keep: false });
    // Esc while listening, right after a word and a language change: the app is told, the mic has the keyboard.
    await mic.click();
    await said();
    await app({ sid, state: "listening", text: "Never mind", level: 0.2, lang: "en-US" });
    ok((await D.locator(".d-lang").innerText()) === "EN", `${tag}: the language shows as a hint (EN)`);
    await page.keyboard.press("Escape");
    const out = await page.evaluate(() => { const l = document.querySelector(".dict:not(#dict)") as HTMLElement | null; return { there: !!l, open: !!l?.classList.contains("open"), inert: !!l?.inert }; });
    ok(out.there && !out.open && out.inert, `${tag}: Esc slides it back under its card (${JSON.stringify(out)})`);
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "cancel" }]), `${tag}: Esc drops it and tells the app`);
    await page.waitForTimeout(350);
    ok(!(await page.locator(".dict").count()), `${tag}: and then it's gone`);
    await closed("Esc while listening");
    ok(await mic.evaluate((el) => el === document.activeElement), `${tag}: after Esc the mic has the keyboard`);
    // Cancel while listening, right after an update from the app and one from the server, every time.
    for (let i = 0; i < 3; i++) {
      await mic.click();
      await said();
      await app({ sid, state: "listening", text: `Try ${i}`, level: 0.5, lang: i % 2 ? "es-MX" : "en-US" });
      await replay();
      await D.locator('[data-dict="cancel"]').click();
      ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "cancel" }]), `${tag}: Cancel right after updates tells the app (${i + 1})`);
      await closed(`Cancel right after updates (${i + 1})`);
    }
    // Esc right after a server update, with the focus moved off the composer.
    await mic.click();
    await replay();
    await page.locator("#week .card").first().focus();
    await page.keyboard.press("Escape");
    await closed("Esc with the focus elsewhere");
    await said();
    // Return while listening, wherever the focus is, sends; refused, Cancel in the text box drops it.
    await page.route(`**/api/answer/${sid}`, (r: any) => r.fulfill({ status: 409 }));
    await mic.click();
    await said();
    await page.locator("#week .card").first().focus();
    await page.keyboard.press("Enter");
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "stop" }]) && (await phase()) === "stopping", `${tag}: Return while listening sends`);
    await app({ sid, state: "done", text: "Drop this one" });
    await D.locator(".d-say.note").waitFor({ timeout: 3000 });
    await replay();
    await D.locator('[data-dict="cancel"]').click();
    await closed("Cancel in review");
    await page.unroute(`**/api/answer/${sid}`);
    // Esc and Cancel while it stops and while it sends: the app is told only while it still listens.
    for (const [when, how] of [["stopping", "Escape"], ["stopping", "Cancel"], ["sending", "Escape"], ["sending", "Cancel"]]) {
      await page.route(`**/api/answer/${sid}`, async (r: any) => { await Bun.sleep(500); await r.fulfill({ status: 409 }).catch(() => {}); });
      await mic.click();
      await said();
      await D.locator('[data-dict="send"]').click();
      await said();
      if (when === "sending") { await app({ sid, state: "done", text: "Not this time" }); const ph = await phase(); ok(ph === "sending", `${tag}: sending, to drop it (${ph}, ${await D.locator(".d-head").innerText()})`); }
      if (how === "Escape") await page.keyboard.press("Escape"); else await D.locator('[data-dict="cancel"]').click();
      const told = await said();
      ok(JSON.stringify(told) === JSON.stringify(when === "stopping" ? [{ cmd: "cancel" }] : []), `${tag}: ${how} while ${when} (${JSON.stringify(told)})`);
      await closed(`${how} while ${when}`);
      await page.waitForTimeout(600);
      ok(!(await D.count()), `${tag}: ${how} while ${when} stays closed`);
      await page.unroute(`**/api/answer/${sid}`);
    }
    // The app ends it when another card starts (one at a time).
    await mic.click();
    await said();
    await app({ sid, state: "canceled" });
    await closed("the app canceling");
    // From the keyboard: focus the mic, Return starts.
    await mic.focus();
    await page.keyboard.press("Enter");
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "start", sid }]) && (await phase()) === "listening", `${tag}: Return on the mic starts`);
    await page.keyboard.press("Escape");
    await said();

    // The closing phrase: said as the last words, then 1.2 s, it sends as Send does, without the phrase.
    // The server refuses each send, so the session stays as it is; Cancel then drops the words.
    const armed = () => D.locator(".d-tip.armed").count().then((n: number) => n > 0);
    const tipText = () => D.locator(".d-tip").innerText();
    let posted = 0;
    const count = (r: any) => { if (r.url().endsWith(`/api/answer/${sid}`)) posted++; };
    page.on("request", count);
    await page.route(`**/api/answer/${sid}`, (r: any) => r.fulfill({ status: 409 }));
    // own: the phrases set in Settings, as the app sends them with each message.
    const viaPhrase = async (words: string, final: string, lang: string, want: string, what: string, shotAs = "", own: object = {}) => {
      await mic.click();
      await said();
      ok(/^End with “.+” to send$/.test(await tipText()), `${tag}: ${what}: the hint says the phrase (${await tipText()})`);
      if (shotAs) await page.waitForTimeout(400); // grown, before the phrase starts its 1.2 s
      await app({ sid, state: "listening", text: words, level: 0.4, lang, ...own });
      ok(await armed(), `${tag}: ${what}: saying the phrase last arms it`);
      ok((await D.locator(".d-head .d-say").innerText()) === "Sending…" && (await tipText()) === "Keep talking or press Esc to stop" && (await D.locator(".d-tip .d-bar").count()) === 1, `${tag}: ${what}: the cue says Sending…, how to stop, and its bar fills`);
      const cut = await D.locator(".d-tip > *").evaluateAll((els: HTMLElement[]) => els.filter((x) => x.scrollWidth > x.clientWidth + 1 || x.getBoundingClientRect().right > x.parentElement!.getBoundingClientRect().right + 0.5).map((x) => x.className || x.tagName));
      ok(!cut.length, `${tag}: ${what}: the cue isn't cut (${cut})`);
      if (shotAs) { await fits("armed", 0); await shot(shotAs); } // grown already, and the 1.2 s is running
      await page.waitForTimeout(800);
      ok(!(await said()).length && (await phase()) === "listening", `${tag}: ${what}: nothing goes before 1.2 s`);
      await page.waitForTimeout(600);
      ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "stop" }]) && (await phase()) === "stopping", `${tag}: ${what}: after the pause it stops, as Send does`);
      // A Return and a Send press right after: no second send.
      await page.keyboard.press("Enter");
      await D.locator('[data-dict="send"]').click({ force: true });
      await page.waitForTimeout(100);
      ok(!(await said()).length && (await phase()) === "stopping", `${tag}: ${what}: a Return or Send after it adds nothing`);
      if (want === "") {
        await app({ sid, state: "done", text: final, lang });
        ok((await phase()) === "error" && (await D.locator(".d-words").innerText()).includes("No words"), `${tag}: ${what}: nothing left says no words heard`);
        await D.locator('[data-dict="cancel"]').click();
        return;
      }
      const n0 = posted;
      const req = page.waitForRequest((r: any) => r.url().endsWith(`/api/answer/${sid}`) && r.method() === "POST");
      await app({ sid, state: "done", text: final, lang, ...own });
      const body = JSON.parse((await req).postData() ?? "{}");
      ok(body.text === want, `${tag}: ${what}: the words go without the phrase (“${body.text}”)`);
      await D.locator(".d-say.note").waitFor({ timeout: 3000 });
      ok(posted === n0 + 1, `${tag}: ${what}: one send only (${posted - n0})`);
      await D.locator('[data-dict="cancel"]').click();
      await closed(`${what}: Cancel after the refused send`);
    };
    await viaPhrase("Sí, súbelo enviar mensaje", "Sí, súbelo, enviar mensaje.", "es-MX", "Sí, súbelo", "the phrase at the end", "13-armed");
    await viaPhrase("Mándalo ya. Enviar mensaje.", "Mándalo ya. Enviar mensaje.", "es-MX", "Mándalo ya", "the phrase with a stop");
    await viaPhrase("Ship it, send message", "Ship it, send message.", "en-US", "Ship it", "in English");
    await viaPhrase("Enviar mensaje", "Enviar mensaje.", "es-MX", "", "the phrase alone");
    // Your own phrases, from Settings: kept in the answer when Settings say so, or not.
    const mine = { phrases: ["listo", "va que va"], keep: true };
    await viaPhrase("Sí, listo", "Sí, listo.", "es-MX", "Sí, listo.", "a phrase of your own stays in the answer", "", mine);
    await viaPhrase("Va que va", "Va que va.", "es-MX", "Va que va.", "a phrase of your own alone is the answer", "", mine);
    await viaPhrase("Ya quedó, listo", "Ya quedó, listo.", "es-MX", "Ya quedó", "a phrase of your own goes when Settings don't keep it", "", { phrases: ["listo"], keep: false });
    await viaPhrase("Sí, súbelo enviar mensaje", "Sí, súbelo, enviar mensaje.", "es-MX", "Sí, súbelo", "the default phrase is back when Settings have none", "", { phrases: ["enviar mensaje"], keep: false });
    // Never inside a sentence: the phrase with more words after it, or its words apart.
    const n1 = posted;
    for (const words of ["Enviar mensaje a Tomás con el resumen", "Hay que enviar el mensaje a Tomás", "Send message to the team", "Hay que enviar el mensaje", "Listo el reporte, pero falta la gráfica", "Listo, pero primero corre las pruebas"]) {
      await mic.click();
      await said();
      const en = words.startsWith("Send");
      await app({ sid, state: "listening", text: words, level: 0.4, lang: en ? "en-US" : "es-MX", phrases: en ? ["send message"] : ["enviar mensaje", "listo"], keep: !en });
      ok(!(await armed()), `${tag}: “${words}” doesn't arm`);
      await page.waitForTimeout(1400);
      ok(!(await said()).length && (await phase()) === "listening", `${tag}: “${words}” sends nothing`);
      await page.keyboard.press("Escape");
      await said();
    }
    // English listens for its own phrase only.
    await mic.click();
    await said();
    await app({ sid, state: "listening", text: "Looks good, enviar mensaje", level: 0.4, lang: "en-US" });
    ok(!(await armed()) && (await tipText()) === "End with “send message” to send", `${tag}: in English the hint and the phrase are “send message”`);
    // Talking on after it armed disarms it.
    await app({ sid, state: "listening", text: "Looks good, send message", level: 0.4, lang: "en-US" });
    ok(await armed(), `${tag}: armed, to talk on`);
    await app({ sid, state: "listening", text: "Looks good, send message and the notes", level: 0.4, lang: "en-US" });
    ok(!(await armed()) && (await tipText()).startsWith("End with") && (await D.locator(".d-head .d-say").innerText()) === "Listening", `${tag}: talking on disarms it, the head says Listening and the hint comes back`);
    await page.waitForTimeout(1400);
    ok(!(await said()).length && (await phase()) === "listening", `${tag}: talking on sends nothing`);
    // Send while armed sends at once, without the phrase.
    await app({ sid, state: "listening", text: "Looks good, send message", level: 0.4, lang: "en-US" });
    ok(await armed(), `${tag}: armed again`);
    await D.locator('[data-dict="send"]').click();
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "stop" }]), `${tag}: Send while armed stops at once`);
    const reqS = page.waitForRequest((r: any) => r.url().endsWith(`/api/answer/${sid}`) && r.method() === "POST");
    await app({ sid, state: "done", text: "Looks good, send message.", lang: "en-US" });
    ok(JSON.parse((await reqS).postData() ?? "{}").text === "Looks good", `${tag}: Send while armed sends without the phrase`);
    await D.locator(".d-say.note").waitFor({ timeout: 3000 });
    await page.waitForTimeout(1400);
    ok(!(await said()).length && posted === n1 + 1, `${tag}: and the timer doesn't send again (${posted - n1})`);
    await D.locator('[data-dict="cancel"]').click();
    // Esc while armed drops it: the app is told, nothing is sent.
    await mic.click();
    await said();
    await app({ sid, state: "listening", text: "Sí, enviar mensaje", level: 0.4, lang: "es-MX" });
    ok(await armed(), `${tag}: armed, to press Esc`);
    const n2 = posted;
    await page.keyboard.press("Escape");
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "cancel" }]), `${tag}: Esc while armed drops it and tells the app`);
    await closed("Esc while armed");
    await page.waitForTimeout(1400);
    ok(!(await said()).length && posted === n2, `${tag}: Esc while armed sends nothing`);
    // Cancel while armed, the same.
    await mic.click();
    await said();
    await app({ sid, state: "listening", text: "Sí, enviar mensaje", level: 0.4, lang: "es-MX" });
    await D.locator('[data-dict="cancel"]').click();
    await page.waitForTimeout(1400);
    ok(JSON.stringify(await said()) === JSON.stringify([{ cmd: "cancel" }]) && posted === n2 && !(await D.count()), `${tag}: Cancel while armed drops it, nothing sent`);
    page.off("request", count);
    await page.unroute(`**/api/answer/${sid}`);

    // The risk frames: the card in the list's last visible row opens it upward.
    // When the list can't scroll that far, the window gets shorter until it does.
    await c.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "end" }));
    await settle(page);
    const spare = await c.evaluate((el: HTMLElement) => document.getElementById("content")!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom);
    if (spare > 60) {
      await page.setViewportSize({ width: size.width, height: Math.round(size.height - spare + 40) });
      await c.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "end" }));
      await settle(page);
    }
    await mic.click();
    await app({ sid, state: "listening", text: WORDS120, level: 0.5, lang: "es-MX" });
    await settle(page);
    g = await fits("in the last row");
    ok(!!g?.above, `${tag}: in the last row it opens upward`);
    await shot("11-last-row");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: size.width, height: size.height });
    await c.scrollIntoViewIfNeeded();
    await settle(page);

    // The session does a whole turn while the page can't draw (hidden): the words aren't sent, and it says so.
    await mic.click();
    await app({ sid, state: "listening", text: "For the old turn", level: 0.1, lang: "es-MX" });
    await page.evaluate((sid) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      const st = JSON.parse((window as any).__last);
      for (const s of st.sessions) if (s.sid === sid) s.since += 60_000; // working, then done again: a new since
      (window as any).__es.onmessage({ data: JSON.stringify(st) });
      delete (document as any).hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    }, sid);
    const note = await D.locator(".d-words").innerText();
    ok((await phase()) === "error" && note.includes("Not sent") && note.includes("“For the old turn”"), `${tag}: a new turn while hidden says the words weren't sent, with them in quotes`);
    ok((await D.locator('[data-dict="retry"]').count()) === 0 && (await D.locator('[data-dict="cancel"]').innerText()) === "Close", `${tag}: only Close on a session that moved on`);
    await fits("the moved-on note");
    await shot("12-moved-on");
    await D.locator('[data-dict="cancel"]').click();
    await closed("Close on the moved-on note");
    await said();
    // Another card's mic takes over: this composer goes.
    await mic.click();
    const other = card(page, SEND).locator("[data-mic]");
    if (await other.count()) {
      await other.click();
      ok((await D.count()) === 1 && (await other.evaluate((el: HTMLElement) => el.classList.contains("on"))) && !(await mic.evaluate((el: HTMLElement) => el.classList.contains("on"))), `${tag}: one card at a time`);
      await page.keyboard.press("Escape");
    } else {
      await page.keyboard.press("Escape");
    }
    ok(!(await D.count()), `${tag}: nothing left dictating`);
    // Another view closes the composer and tells the app to stop listening.
    await mic.click();
    await page.evaluate(() => (window as any).csm.setView("history"));
    ok(!(await D.count()) && JSON.stringify((await said()).slice(-1)) === JSON.stringify([{ cmd: "cancel" }]), `${tag}: another view closes the composer`);
    await page.evaluate(() => (window as any).csm.setView("week"));
    await settle(page);
    ok(!(await content(page)).sideways, `${tag}: nothing spills sideways`);
    await page.close();
  }

  // In a plain browser there's no app to listen: no mic anywhere.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + "/");
    await page.waitForSelector("#week .card");
    await page.waitForTimeout(1500);
    ok((await page.locator("[data-mic]").count()) === 0, "in a plain browser: no mic");
    await page.close();
  }

  // A window tall enough for everything: no fade at all.
  const page = await browser.newPage({ viewport: { width: 1280, height: 4000 } });
  await page.goto(base + "/?embed");
  await page.waitForSelector("#week .card");
  await settle(page);
  const s = await content(page);
  ok(!s.below && !s.up && !s.down, "a window with nothing out of view: no fades");
  await page.close();
} finally {
  await browser.close();
  demo.kill();
  await demo.exited;
}
console.log(fails ? `${fails} failed. Screenshots in ${OUT}` : `All passed. Screenshots in ${OUT}`);
process.exit(fails ? 1 : 0);
