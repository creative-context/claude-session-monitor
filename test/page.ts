// The page in WebKit (the engine of the app's window), on the demo's made-up data (with its edge
// cases): where a view or the count popover scrolls out of sight it fades into its surface, only
// at an end with more past it, clicks go through the fade to the card under it, and nothing
// spills sideways. A question's answers on its card: each button clicked, sent and taken back,
// the ones that open the session, ⌘↩ and ⌘Z, sent and picked up, refused, and not sent, with the
// card's height unchanged and nothing spilling. In each window size the page has a layout for,
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
// An answer no mod takes counts as not sent 1.5 s after its 5 s, not 20 s.
const demo = Bun.spawn(["bun", join(import.meta.dir, "demo.ts"), String(PORT), "--edge"], {
  stdout: "ignore", stderr: "ignore", env: { ...process.env, CSM_ANSWER_GIVE_UP_MS: "1500" },
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
    const count = page.locator("#counts [data-pop]").last();
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

    // Sent from the card: blue, Working, what you answered, and 5 s to take it back.
    const send = card(page, SEND);
    const sendSid = await sidOf(send);
    const before = await measure(send);
    await send.locator(".ans .pri").click();
    await footIs(page, SEND, ".sentline [data-undo]");
    let m = await measure(send);
    ok(/\bsent\b/.test(m.cls) && /\bworking\b/.test(m.cls) && m.foot.startsWith("Sent") && /\d s$/.test(m.foot),
      `${tag}: a click sends it, with Undo and the seconds left ("${m.foot}")`);
    ok((await send.locator(".top .tag").textContent())?.includes("Working") && (await send.locator(".detail").textContent())?.includes("You answered “Publish now”"),
      `${tag}: the sent card says Working and what you answered`);
    ok(m.h === before.h && m.footIn && !m.spill, `${tag}: the sent card keeps its height (${before.h} → ${m.h})`);
    ok(!opened.includes(sendSid), `${tag}: sending doesn't open the session`);
    await shot("answer-sent");
    await send.locator("[data-undo]").click();
    await footIs(page, SEND, ".ans .pri");
    m = await measure(send);
    ok(/\basks\b/.test(m.cls) && m.h === before.h, `${tag}: Undo takes it back, Needs you again (${m.h})`);

    // Answers that can't go from here open the session instead.
    const app = card(page, APP);
    ok(await opensFor(page, await sidOf(app), () => app.locator(".ans .pri").click()), `${tag}: the app's own answer (Commit) opens the session`);
    ok((await app.locator(".ans .pri").getAttribute("title")) === "Only the Claude app can do this", `${tag}: its tip says only the app can do it`);
    const nomod = card(page, NOMOD);
    ok(await opensFor(page, await sidOf(nomod), () => nomod.locator(".ans .sec").click()), `${tag}: with no mod, an answer opens the session`);
    ok((await nomod.locator(".ans .sec").getAttribute("title")) === "Opens the session: answer there", `${tag}: its tip says answer there`);
    ok(!(await page.locator("#week .card.sent").count()), `${tag}: nothing was sent by those`);
    await page.close();
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

    // ⌘↩ on the focused card gives its first answer; ⌘Z takes it back.
    await send.focus();
    const n = opened.length;
    await page.keyboard.press("Meta+Enter");
    await footIs(page, SEND, ".sentline [data-undo]");
    ok(opened.length === n && (await send.locator(".detail").textContent())!.includes("Publish now"), `${tag}: ⌘↩ sends the first answer`);
    await page.keyboard.press("Meta+z");
    await footIs(page, SEND, ".ans .pri");
    ok((await measure(send)).h === h, `${tag}: ⌘Z takes it back`);

    // A 409 (its mod went away in the meantime) opens the session instead.
    await page.route("**/api/answer/*", (r: any) => r.fulfill({ status: 409 }), { times: 1 });
    ok(await opensFor(page, sid, () => send.locator(".ans .sec").click()), `${tag}: an answer the server refuses opens the session`);
    ok(!(await send.locator(".sentline").count()), `${tag}: and the card still asks`);

    if (size.name === "wide") {
      // Sent and picked up: after its 5 s the mod takes it, and the session starts working.
      await send.locator(".ans .sec").click();
      await footIs(page, SEND, ".sentline .count");
      await page.waitForFunction((t: string) => [...document.querySelectorAll("#week .card")]
        .find((c) => c.querySelector(".title")?.textContent === t)?.querySelector(".sentline")?.textContent?.includes("working on it")
        || [...document.querySelectorAll("#week .card.working:not(.sent)")].some((c) => c.querySelector(".title")?.textContent === t), SEND, { timeout: 10_000 });
      await shot("answer-going");
      await page.waitForSelector(`#week .card.working:not(.sent)[data-sid="${sid}"]`, { timeout: 10_000 });
      ok(true, `${tag}: after 5 s the session picks it up and works on it`);
      await shot("answer-picked-up");
    }

    // Not sent: its mod asked once and went away, so nothing took it. The card needs you again.
    const nomod = card(page, NOMOD);
    const nsid = await sidOf(nomod);
    if (size.name === "wide") {
      await fetch(`${base}/api/answer/${nsid}/next`, { headers: { "x-csm": "1" }, signal: AbortSignal.timeout(300) }).catch(() => {});
      await page.waitForFunction((s: string) => !document.querySelector(`#week .card[data-sid="${s}"] .a-b.opens`), nsid, { timeout: 10_000 });
      const nh = (await measure(nomod)).h;
      await nomod.locator(".ans .pri").click();
      await footIs(page, NOMOD, ".sentline [data-undo]");
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
      await footIs(page, APP, ".sentline [data-undo]");
      ok((await measure(app)).h === ah, `${tag}: a sent row keeps its height (${ah})`);
      await app.scrollIntoViewIfNeeded();
      await shot("answer-sent");
      await app.locator("[data-undo]").click();
      await footIs(page, APP, ".ans .pri");
    }
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
