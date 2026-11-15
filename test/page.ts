// The page in WebKit (the engine of the app's window), on the demo's made-up data: where a view
// or the count popover scrolls out of sight it fades into its surface, only at an end with more
// past it, clicks go through the fade to the card under it, and nothing spills sideways. In each
// window size the page has a layout for, in a browser and inside the app (?embed).
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
const demo = Bun.spawn(["bun", join(import.meta.dir, "demo.ts"), String(PORT)], { stdout: "ignore", stderr: "ignore" });
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

const browser = await webkit.launch();
try {
  for (const size of SIZES) for (const mode of ["", "?embed"]) {
    const tag = `${size.name}${mode ? " in the app" : ""}`;
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
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
