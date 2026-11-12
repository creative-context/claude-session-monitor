// The plan's weekly usage in words: how the week is going against an even pace, when it
// runs out at that pace, and the times that go with it. Pure functions of the reading and
// the time now, so they can be tested (test/usage.test.ts). The page loads this file with a
// plain script tag and reads it as `CsmUsage`; Bun's tests require it.
(function () {
  const HOUR = 36e5;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  const clock = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // Within a day, the time it resets; further off, the day (and the time, in the tooltip).
  // On the day the week resets, its next reset is a week off: "next Thu", not "Thu", which
  // would read as today.
  const nextDay = (t, now) => {
    const day = new Date(t).toLocaleDateString("en-US", { weekday: "short" });
    return t - now > DAY && new Date(t).getDay() === new Date(now).getDay() ? `next ${day}` : day;
  };
  const resetWords = (t, full, now) => {
    if (!t) return "";
    return t - now < DAY ? clock(t) : full ? `${nextDay(t, now)} ${clock(t)}` : nextDay(t, now);
  };

  // How the week is going: the share used against the share of the week gone by.
  function pace(w, now) {
    // At 100% the week is over until the reset, not almost.
    if (w.pct >= 90) {
      return { key: "limit", say: w.pct >= 100 ? "Limit reached" : "Almost at the limit",
        gone: w.resets ? Math.min(1, Math.max(0, 1 - (w.resets - now) / WEEK)) * 100 : null };
    }
    if (!w.resets) return { key: "", say: "" };
    const gone = Math.min(1, Math.max(0, 1 - (w.resets - now) / WEEK)) * 100;
    const ahead = w.pct - gone;
    if (ahead > 15) return { key: "hot", say: "Running hot", gone };
    if (ahead > 5) return { key: "fast", say: "A little fast", gone };
    if (ahead < -15) return { key: "plenty", say: "Plenty left", gone };
    return { key: "on-pace", say: "On pace", gone };
  }

  // When the week runs out at its pace so far: only ahead of pace or near the limit, only
  // after its first day (before that the average overstates), and only before the reset.
  function forecast(w, p, now) {
    if (!w?.resets || w.pct <= 0 || w.pct >= 100 || !["fast", "hot", "limit"].includes(p.key)) return null;
    const start = w.resets - WEEK, gone = now - start;
    if (gone <= 0 || (gone < DAY && p.key !== "limit")) return null;
    const at = start + (100 / w.pct) * gone;
    return at > now && at < w.resets ? { at } : null;
  }

  // Where the chart's dashed line ends: the share at the pace so far, at the reset, or where it
  // reaches 100% if that comes first. From the week's first hour; in its first day (`early`) a
  // few hours make a rough average, so the chart draws it fainter and the forecast waits.
  // Nothing at 100% or past the reset.
  function projection(w, p, now) {
    if (!w?.resets || w.pct >= 100) return null;
    const start = w.resets - WEEK, gone = now - start;
    if (gone < HOUR || now >= w.resets) return null;
    const end = w.pct + (w.pct / gone) * (w.resets - now);
    const early = gone < DAY && p.key !== "limit";
    return end <= 100 ? { at: w.resets, pct: end, early } : { at: start + (100 / w.pct) * gone, pct: 100, early };
  }

  // The card's rows under the chart, as [label, value]: how far over or under the even pace,
  // the pace so far a day, and the most a day that lasts until the reset, in the same unit.
  // The pace a day waits for the first day, like the forecast: a few hours make a poor day.
  function paceRows(w, p, now) {
    if (!w?.resets) return [];
    const diff = w.pct - (p.gone ?? 0), off = Math.round(diff);
    const days = (now - (w.resets - WEEK)) / DAY, left = Math.max(0, 100 - w.pct), daysLeft = (w.resets - now) / DAY;
    const rows = [[p.say, off === 0 ? "on the line" : `${Math.abs(off)}% ${diff > 0 ? "over" : "under"}`]];
    if (days >= 1) rows.push(["Your pace", `${Math.round(w.pct / days)}% a day`]);
    rows.push(daysLeft >= 1 ? ["To last the week", `${Math.floor(left / daysLeft)}% a day`] : ["Left until the reset", `${Math.round(left)}%`]);
    return rows;
  }

  // Times to the hour: it's an estimate, and "10:47 PM" would claim more than it knows.
  const hourOf = (t) => { const d = new Date(t + 30 * 60_000); d.setMinutes(0, 0, 0); return d.getTime(); };
  const hourWords = (t) => new Date(hourOf(t)).toLocaleTimeString("en-US", { hour: "numeric" });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  const dayName = (t, long) => new Date(t).toLocaleDateString("en-US", { weekday: long ? "long" : "short" });
  // "11 PM" today, "Wed 1 PM" another day: short enough for the column.
  const outWords = (t, now) => (sameDay(hourOf(t), now) ? hourWords(t) : `${dayName(hourOf(t))} ${hourWords(t)}`);
  // "Tonight 11 PM", "Tomorrow 2 PM", "Wednesday 8 AM": for the card.
  // A reset is a known time, not an estimate: `exact` keeps its minutes ("Today 3:44 PM").
  function whenWords(t, exact, now) {
    const h = exact ? t : hourOf(t), d = new Date(h);
    const time = exact ? d.toLocaleTimeString("en-US", d.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" }) : hourWords(t);
    if (sameDay(h, now)) return `${d.getHours() >= 18 ? "Tonight" : "Today"} ${time}`;
    if (sameDay(h, now + DAY)) return `Tomorrow ${time}`;
    return `${dayName(h, true)} ${time}`;
  }
  // "Thu 1 AM", with minutes only when it isn't on the hour.
  const dayTime = (t, now) => {
    const d = new Date(t);
    return `${nextDay(t, now)} ${d.toLocaleTimeString("en-US", d.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" })}`;
  };

  const api = { HOUR, DAY, WEEK, pace, forecast, projection, paceRows, nextDay, resetWords, hourOf, hourWords, outWords, whenWords, dayTime };
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CsmUsage = api;
})();
