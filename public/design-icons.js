/* mac-app-design 0.2.0 (icons.js). Vendored: don't edit here. Change it in the design repo and vendor again. */
// The family's icons: drawn on a 24 px grid, all in the same 1.25 px stroke (base.css sets it).
// One source for both apps. In a page:
//   DesignIcons.svg("folder")        an inline <svg class="i"> string
//   DesignIcons.mount()              adds a hidden sprite, for <svg class="i"><use href="#i-folder"/></svg>
//   DesignIcons.names                every name
(function (root) {
  const paths = {
    "folder": "<path d=\"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z\"/>",
    "flow": "<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><path d=\"M6.5 10v3a2 2 0 0 0 2 2H14\"/>",
    "agents": "<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20a6.5 6.5 0 0 1 13 0\"/><path d=\"M16 4.5a3.5 3.5 0 0 1 0 7\"/><path d=\"M18.5 14.5A6.5 6.5 0 0 1 21.5 20\"/>",
    "spinner": "<path d=\"M21 12a9 9 0 1 1-9-9\"/>",
    "alert": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7.5v5\"/><path d=\"M12 16.5h.01\"/>",
    "question": "<path d=\"M20.5 12a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z\"/><path d=\"M9.8 9.6a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.7-.9 1.3\"/><path d=\"M12 15.8h.01\"/>",
    "error": "<path d=\"M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z\"/><path d=\"M12 9.5v4\"/><path d=\"M12 17h.01\"/>",
    "check": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m8 12.5 2.8 2.8L16.5 9.5\"/>",
    "moon": "<path d=\"M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z\"/>",
    "power": "<path d=\"M12 3v8\"/><path d=\"M6.3 7.2a8 8 0 1 0 11.4 0\"/>",
    "bot": "<rect x=\"4\" y=\"8\" width=\"16\" height=\"12\" rx=\"3\"/><path d=\"M12 4v4\"/><path d=\"M9 13.5v1\"/><path d=\"M15 13.5v1\"/>",
    "terminal": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"m7 9 3 3-3 3\"/><path d=\"M12.5 15H17\"/>",
    "file": "<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5\"/>",
    "pencil": "<path d=\"M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z\"/><path d=\"m14.5 7.5 2 2\"/>",
    "search": "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"m20 20-4.2-4.2\"/>",
    "globe": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18\"/><path d=\"M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z\"/>",
    "star": "<path d=\"m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z\"/>",
    "plug": "<path d=\"M9 3v5\"/><path d=\"M15 3v5\"/><path d=\"M6 8h12v3a6 6 0 0 1-12 0z\"/><path d=\"M12 17v4\"/>",
    "unplug": "<path d=\"M9 3v5\"/><path d=\"M15 3v5\"/><path d=\"M6 8h12v3a6 6 0 0 1-12 0z\"/><path d=\"M12 17v4\"/><path d=\"m3 3 18 18\"/>",
    "browser": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 9h18\"/><path d=\"M6.5 6.5h.01\"/><path d=\"M9 6.5h.01\"/>",
    "bulb": "<path d=\"M9 18h6\"/><path d=\"M10 21h4\"/><path d=\"M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z\"/>",
    "listChecks": "<path d=\"m4 7.75 2 2 3.5-3.5\"/><path d=\"m4 15.75 2 2 3.5-3.5\"/><path d=\"M13 8.25h7\"/><path d=\"M13 16.25h7\"/>",
    "compress": "<path d=\"M4 14h6v6\"/><path d=\"M20 10h-6V4\"/><path d=\"m14 10 7-7\"/><path d=\"m3 21 7-7\"/>",
    "clock": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>",
    "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4\"/>",
    "history": "<path d=\"M3.5 12a8.5 8.5 0 1 0 2.5-6\"/><path d=\"M3.5 4v4.5H8\"/><path d=\"M12 7.5V12l3 2\"/>",
    "calendar": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17\"/><path d=\"M8 3v4\"/><path d=\"M16 3v4\"/>",
    "layers": "<path d=\"m12 3 9 4.5-9 4.5-9-4.5z\"/><path d=\"m3 12 9 4.5 9-4.5\"/><path d=\"m3 16.5 9 4.5 9-4.5\"/>",
    "grid": "<rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"13.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.5\"/>",
    "activity": "<path d=\"M3 12h4l3-8 4 16 3-8h4\"/>",
    "calendarClock": "<path d=\"M20.5 10.5V7a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2H10\"/><path d=\"M3.5 10h17\"/><path d=\"M8 3v4\"/><path d=\"M16 3v4\"/><circle cx=\"17\" cy=\"17\" r=\"4.5\"/><path d=\"M17 15v2.2l1.4.9\"/>",
    "pause": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M10 9v6\"/><path d=\"M14 9v6\"/>",
    "alarm": "<circle cx=\"12\" cy=\"13\" r=\"7.5\"/><path d=\"M12 9.5v4\"/><path d=\"M12 16.5h.01\"/><path d=\"M4.5 3.5 2.5 5.5\"/><path d=\"m19.5 3.5 2 2\"/>",
    "wake": "<circle cx=\"12\" cy=\"13\" r=\"7.5\"/><path d=\"M12 9.5V13l2.5 1.5\"/><path d=\"M4.5 3.5 2.5 5.5\"/><path d=\"m19.5 3.5 2 2\"/>",
    "calendarPlus": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2\"/><path d=\"M3.5 10h17\"/><path d=\"M8 3v4\"/><path d=\"M16 3v4\"/><path d=\"M12 12.5v5\"/><path d=\"M9.5 15h5\"/>",
    "branch": "<circle cx=\"6\" cy=\"6\" r=\"2.5\"/><circle cx=\"6\" cy=\"18\" r=\"2.5\"/><circle cx=\"18\" cy=\"8\" r=\"2.5\"/><path d=\"M6 8.5v7\"/><path d=\"M18 10.5c0 4-3 5.5-9.5 6.5\"/>",
    "chev": "<path d=\"m6 9 6 6 6-6\"/>",
    "close": "<path d=\"M6 6l12 12\"/><path d=\"M18 6 6 18\"/>",
    "arrowDown": "<path d=\"M12 5v14\"/><path d=\"m6 13 6 6 6-6\"/>",
    "speaker": "<path d=\"M11 5 6.5 9H3.5v6h3l4.5 4z\"/><path d=\"M15.5 9a4.5 4.5 0 0 1 0 6\"/><path d=\"M18.5 6a8.5 8.5 0 0 1 0 12\"/>",
    "speakerOff": "<path d=\"M11 5 6.5 9H3.5v6h3l4.5 4z\"/><path d=\"m15.5 9.5 5 5\"/><path d=\"m20.5 9.5-5 5\"/>",
    "user": "<circle cx=\"12\" cy=\"8\" r=\"3.5\"/><path d=\"M5.5 20a6.5 6.5 0 0 1 13 0\"/>",
    "hourglass": "<path d=\"M7 3h10\"/><path d=\"M7 21h10\"/><path d=\"M8 3v3.5a4 4 0 0 0 1.6 3.2L12 12l2.4-2.3A4 4 0 0 0 16 6.5V3\"/><path d=\"M8 21v-3.5a4 4 0 0 1 1.6-3.2L12 12l2.4 2.3a4 4 0 0 1 1.6 3.2V21\"/>",
    "phone": "<path d=\"M5.5 3.5h3l1.8 4.6-2.1 1.5a11 11 0 0 0 6.2 6.2l1.5-2.1 4.6 1.8v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3.5 5.7a2 2 0 0 1 2-2.2z\"/>",
    "mail": "<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"m3.5 7 8.5 6 8.5-6\"/>",
    "chat": "<path d=\"M20.5 12a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z\"/>",
    "plus": "<path d=\"M12 5v14\"/><path d=\"M5 12h14\"/>",
    "circle": "<circle cx=\"12\" cy=\"12\" r=\"9\"/>",
    "open": "<path d=\"M14 4h6v6\"/><path d=\"m20 4-9 9\"/><path d=\"M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4\"/>"
  };
  // Icons that move: a spinner turns, an alert breathes while it's new, a bot breathes while it works.
  const classes = {"spinner": "spin", "alert": "pulse", "question": "pulse", "error": "pulse", "bot": "bot", "chev": "chev"};
  const svg = (name, cls) => `<svg class="i ${cls ?? classes[name] ?? ""}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ""}</svg>`;
  function mount(doc = root.document) {
    if (doc.getElementById("design-icons")) return;
    const sheet = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    sheet.id = "design-icons";
    sheet.setAttribute("aria-hidden", "true");
    sheet.setAttribute("style", "position: absolute; width: 0; height: 0");
    sheet.innerHTML = Object.entries(paths).map(([n, d]) => `<symbol id="i-${n}" viewBox="0 0 24 24">${d}</symbol>`).join("");
    doc.body.prepend(sheet);
  }
  root.DesignIcons = { paths, classes, names: Object.keys(paths), svg, mount };
})(typeof window !== "undefined" ? window : globalThis);
