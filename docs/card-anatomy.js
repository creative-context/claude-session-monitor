// The page behind docs/card-anatomy.png: the real page on the demo's --anatomy data, its three
// cards in one column, and each part of them named beside it. docs/card-anatomy.swift runs it
// inside the page, in WebKit. It moves and hides things with a style sheet only, so the cards
// keep the page's own markup, styles and fitting, and it draws the names on a layer above them,
// measured from the cards each time they change. It presses the first card's mic, so its drawer
// is open too. Once everything holds still, window.anatomyReady gives the picture's size, in
// page pixels.
(() => {
  // Each part: the card it's on (by its state), where it is on that card, its name and a few
  // words, and where its name goes. TIME, TEXT, ALL and DRAWER measure what a selector can't.
  const TIME = (card) => {
    const t = card.querySelector(".top .time");
    const txt = t && [...t.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!txt) return null;
    const r = document.createRange();
    r.setStartBefore(t.querySelector(":scope > svg") ?? txt);
    r.setEndAfter(txt);
    return r.getBoundingClientRect();
  };
  const TEXT = (sel) => (card) => {
    const el = card.querySelector(sel);
    if (!el) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    return [...r.getClientRects()].find((x) => x.width > 0) ?? el.getBoundingClientRect(); // its first line
  };
  const ALL = (sel) => (card) => {
    const rs = [...card.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
    if (!rs.length) return null;
    const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top));
    return new DOMRect(left, top, Math.max(...rs.map((r) => r.right)) - left, Math.max(...rs.map((r) => r.bottom)) - top);
  };
  const DRAWER = () => { // the last line of the words in the mic's drawer
    const el = document.querySelector("#dict.open .d-words > span");
    if (!el) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    return [...r.getClientRects()].filter((x) => x.width > 0).at(-1) ?? null;
  };
  const PARTS = [
    { card: "asks", at: ".top > .tag", name: "State", words: "Needs you, Working or Done", side: "left" },
    { card: "asks", at: ".meta .mdl", name: "Model", words: "", side: "up-left" },
    { card: "asks", at: ".meta .eff", name: "Effort", words: "Low, Medium, High, Extra or Max", side: "up-left" },
    { card: "asks", at: ".meta .uc", name: "Ultracode", words: "Shows when ultracode is on", side: "up-right" },
    { card: "asks", at: ".meta .advr", name: "Advisor", words: "The advisor's model, F for Fable", side: "up-right" },
    { card: "asks", at: TIME, name: "Time", words: "Minutes it has been waiting", side: "up-right" },
    { card: "asks", at: ".pin-b", name: "Pin", words: "Keeps the session near the top", side: "right" },
    { card: "asks", at: TEXT(".title"), name: "Title", words: "", side: "left" },
    { card: "asks", at: TEXT(".detail"), name: "Question", words: "From the end of its last turn", side: "left" },
    { card: "asks", at: ALL(".ans .a-b"), name: "Answers", words: "Click one to send it", side: "left" },
    { card: "asks", at: ".mic-b", name: "Mic", words: "Dictate your own answer", side: "right" },
    { card: "asks", at: DRAWER, name: "Dictation", words: "Shows your words as you speak", side: "right" },
    { card: "working", at: ".detail .line:nth-child(1)", name: "Doing now", words: "The tool it's using", side: "left" },
    { card: "working", at: ".detail .line:nth-child(2)", name: "Plan step", words: "The current step of its plan", side: "left" },
    { card: "working", at: ".bar", name: "Plan progress", words: "One segment per step", side: "right" },
    { card: "done", at: ".tags .tag.name", name: "Folder", words: "The folder it runs in", side: "left" },
    { card: "done", at: ".tags .tag.rel", name: "Side sessions", words: "Sessions it started", side: "down" },
    { card: "done", at: ".tags .tag.made", name: "Scheduled task", words: "A task it created", side: "right" },
  ];
  // The words in the mic's drawer: made up, as the app would show them while you speak.
  const SPOKEN = "Publish them, but add the new export option first";
  const ORDER = ["asks", "working", "done"]; // top to bottom, as the page sorts them
  // The picture, in page pixels, and where the cards sit in it: 320 px wide, so the model's
  // name stays beside "Needs you", with room for the names on both sides and above. Its height
  // is what the names below the last card need.
  const W = 760, X = 220, Y = 122, CARD_W = 320, GAP = 34;
  let H = 800;
  const LEFT = X - 22, RIGHT = X + CARD_W + 22; // where the names start, each side

  // The page in compact density, as a short window draws it (and as the other pictures are).
  document.documentElement.dataset.density = "compact";
  const css = document.createElement("style");
  css.textContent = `
    html, body { overflow: hidden !important; height: auto !important; }
    header, #banner, .group-head, .meter, .wstrip, #week > .group:not(.active), .quiet, .empty-state { display: none !important; }
    #content { position: absolute !important; left: ${X}px !important; top: ${Y}px !important; width: ${CARD_W}px !important;
      height: auto !important; margin: 0 !important; padding: 0 !important; overflow: visible !important;
      -webkit-mask-image: none !important; mask-image: none !important; }
    #week, #week > .group, #week .abody { margin: 0 !important; padding: 0 !important; }
    /* The first card, then a row as tall as its open drawer needs (--dict-room), then the others. */
    #week .grid { row-gap: ${GAP}px !important; grid-template-rows: var(--csm-card-h) var(--dict-room, 0px) var(--csm-card-h) var(--csm-card-h) !important; }
    #week .grid > .card.asks { grid-row: 1; } #week .grid > .card.working { grid-row: 3; } #week .grid > .card.done { grid-row: 4; }
    /* A still frame: the beating dot mid-beat, the first of the working dots lit, the step at rest. */
    .card .pdot::after { animation: none !important; opacity: 0.3 !important; transform: scale(1.9) !important; }
    .card .calm i { animation: none !important; }
    .card .calm i:first-child { opacity: 1 !important; }
    .card .bar .segs span.now { animation: none !important; }
    .dict .d-wave i { animation: none !important; transition: none !important; }
    #anatomy { position: absolute; left: 0; top: 0; width: ${W}px; pointer-events: none; z-index: 1000;
      font-family: var(--font-family-body); -webkit-font-smoothing: antialiased; }
    #anatomy svg { position: absolute; inset: 0; overflow: visible; }
    #anatomy .ln { fill: none; stroke: #5B5F67; stroke-width: 1; }
    #anatomy .end { fill: var(--color-text-primary); }
    #anatomy .lb { position: absolute; display: flex; flex-direction: column; gap: 1px; max-width: ${X - 28}px; }
    #anatomy .lb.l { text-align: right; align-items: flex-end; }
    #anatomy .lb.c { text-align: center; align-items: center; }
    #anatomy .lb b { font-size: 12px; line-height: 15px; font-weight: 600; color: var(--color-text-primary); }
    #anatomy .lb span { font-size: 11.5px; line-height: 14px; color: var(--color-text-secondary); }
  `;
  document.head.append(css);

  const root = document.createElement("div");
  root.id = "anatomy";
  const SVG = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // Every part found on its card, in page coordinates, with its card's box.
  function measure() {
    const cards = Object.fromEntries(ORDER.map((k) => [k, document.querySelector(`#week .card.${k}`)]));
    if (ORDER.some((k) => !cards[k])) return null;
    const box = (r) => ({ left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY,
      width: r.width, height: r.height, cx: r.left + scrollX + r.width / 2, cy: r.top + scrollY + r.height / 2 });
    const found = [];
    for (const p of PARTS) {
      const card = cards[p.card];
      const r = typeof p.at === "function" ? p.at(card) : card.querySelector(p.at)?.getBoundingClientRect();
      if (r?.width) found.push({ ...p, r: box(r), c: box(card.getBoundingClientRect()) });
    }
    return found;
  }

  function label(p, cls) {
    const el = document.createElement("div");
    el.className = `lb ${cls}`;
    el.innerHTML = p.words ? `<b></b><span></span>` : `<b></b>`;
    el.firstChild.textContent = p.name;
    if (p.words) el.lastChild.textContent = p.words;
    root.append(el);
    return el;
  }
  const line = (svg, pts) => svg.append(svgEl("polyline", { class: "ln", points: pts.map((p) => p.join(",")).join(" ") }));
  const end = (svg, x, y) => svg.append(svgEl("circle", { class: "end", cx: x, cy: y, r: 2 }));

  // Names left and right of the cards, joined by a line; above the first card for the parts of
  // its top line, each up and then across, the nearest one highest so no two lines cross; and
  // below the last card, straight down.
  function drawLabels(found) {
    const svg = svgEl("svg", { width: W, height: 1 });
    root.append(svg);
    const sides = { left: [], right: [] };
    for (const p of found.filter((p) => p.side === "left" || p.side === "right")) {
      const left = p.side === "left";
      const el = label(p, left ? "l" : "r");
      // A step off the part, not on it.
      sides[p.side].push({ el, left, ax: left ? p.r.left - 3 : p.r.right + 3, ay: p.r.cy, h: el.offsetHeight });
    }
    // Each side top to bottom, pushed apart where two would touch.
    for (const list of Object.values(sides)) {
      list.sort((a, b) => a.ay - b.ay);
      let floor = -Infinity;
      for (const it of list) {
        const ly = Math.max(it.ay, floor + it.h / 2 + 8);
        floor = ly + it.h / 2;
        it.el.style.top = `${ly - it.h / 2}px`;
        if (it.left) it.el.style.right = `${W - LEFT}px`;
        else it.el.style.left = `${RIGHT}px`;
        const kx = it.left ? X - 8 : X + CARD_W + 8; // just outside the card, then over to its name
        line(svg, [[it.ax, it.ay], [kx, it.ay], [it.left ? kx - 6 : kx + 6, ly], [it.left ? LEFT + 4 : RIGHT - 4, ly]]);
        end(svg, it.ax, it.ay);
      }
    }
    for (const side of ["up-left", "up-right"]) {
      const left = side === "up-left";
      const list = found.filter((p) => p.side === side).sort((a, b) => (left ? b.r.cx - a.r.cx : a.r.cx - b.r.cx));
      list.forEach((p, i) => {
        const el = label(p, left ? "l" : "r");
        const ly = p.c.top - 20 - (list.length - 1 - i) * 33;
        el.style.top = `${ly - el.offsetHeight / 2}px`;
        if (left) el.style.right = `${W - LEFT}px`;
        else el.style.left = `${RIGHT}px`;
        line(svg, [[p.r.cx, p.r.top - 1], [p.r.cx, ly], [left ? LEFT + 4 : RIGHT - 4, ly]]);
        end(svg, p.r.cx, p.r.top - 1);
      });
    }
    for (const p of found.filter((p) => p.side === "down")) {
      const el = label(p, "c");
      const ly = p.c.bottom + 22;
      el.style.top = `${ly}px`;
      el.style.left = `${p.r.cx - el.offsetWidth / 2}px`;
      line(svg, [[p.r.cx, p.r.bottom + 1], [p.r.cx, ly - 3]]);
      end(svg, p.r.cx, p.r.bottom + 1);
    }
  }

  // The mic pressed, as you would, and what the app sends back while you speak: Listening, the
  // words so far and a level. Then room under the card for the drawer it opens.
  let pressed = false;
  function openDrawer() {
    const card = document.querySelector("#week .card.asks");
    const mic = card?.querySelector("[data-mic]");
    const drawer = document.getElementById("dict");
    if (!drawer) {
      if (!mic || pressed) return false;
      pressed = true;
      mic.click();
      window.csm?.dictation?.({ sid: card.dataset.sid, state: "listening", text: SPOKEN, level: 0.55, lang: "en-US" });
      document.activeElement?.blur?.(); // no focus ring on Send
      return false;
    }
    const grid = card.closest(".grid");
    const room = Math.max(0, Math.ceil(drawer.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom) - GAP);
    if (grid.style.getPropertyValue("--dict-room") !== `${room}px`) grid.style.setProperty("--dict-room", `${room}px`);
    return true;
  }

  let last = "";
  function draw() {
    if (!openDrawer()) return false;
    const found = measure();
    if (!found) return false;
    const sig = JSON.stringify(found.map((p) => [p.r.left, p.r.top, p.r.width, p.r.height]));
    if (sig === last) return true;
    last = sig;
    root.replaceChildren();
    if (!root.isConnected) document.body.append(root);
    drawLabels(found);
    H = Math.ceil(Math.max(...[...root.querySelectorAll(".lb")].map((el) => el.offsetTop + el.offsetHeight)) + 22);
    root.style.height = `${H}px`;
    return true;
  }

  // Again on every change to the cards (the page redraws one on each update) and once a second.
  let queued = false;
  const soon = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
  new MutationObserver(soon).observe(document.getElementById("week"), { subtree: true, childList: true, characterData: true, attributes: true });
  addEventListener("resize", soon);
  setInterval(soon, 1000);
  // Ready for the picture once the three cards are drawn and have held still for a moment.
  let steady = 0;
  const ready = setInterval(() => {
    const was = last;
    if (!draw()) return;
    steady = was === last ? steady + 1 : 0;
    if (steady >= 6) { Object.defineProperty(window, "anatomyReady", { get: () => ({ w: W, h: H }) }); clearInterval(ready); }
  }, 300);
})();
