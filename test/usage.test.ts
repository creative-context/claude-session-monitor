// The weekly usage words in public/usage.js: the pace against an even week, when the week
// runs out at that pace, and the times shown with them. Run with `bun test test/usage.test.ts`.
process.env.TZ = "UTC"; // the time words are local; pin them before any Date is made

import { describe, expect, test } from "bun:test";

const U = require("../public/usage.js");
const { DAY, HOUR, WEEK } = U;
// ICU puts a narrow no-break space before AM and PM; the words are the same either way.
const words = (s: string) => s.replace(/[  ]/g, " ");

const NOW = Date.UTC(2026, 10, 12, 10, 0); // Thursday, November 12, 10:00 AM
const halfway = NOW + WEEK / 2; // a week that resets in 3.5 days: half of it gone
const week = (pct: number, resets: number | null = halfway) => ({ pct, resets });

describe("pace", () => {
  test("90% or more is the limit, with or without a reset time", () => {
    expect(U.pace(week(90), NOW)).toMatchObject({ key: "limit", say: "Almost at the limit", gone: 50 });
    expect(U.pace(week(99.9), NOW).say).toBe("Almost at the limit");
    expect(U.pace(week(92, null), NOW)).toEqual({ key: "limit", say: "Almost at the limit", gone: null });
  });
  test("100% says the limit is reached", () => {
    expect(U.pace(week(100), NOW)).toMatchObject({ key: "limit", say: "Limit reached" });
    expect(U.pace(week(130), NOW).say).toBe("Limit reached");
  });
  test("without a reset time there is no pace below 90%", () => {
    expect(U.pace(week(50, null), NOW)).toEqual({ key: "", say: "" });
  });
  test("thresholds against the share of the week gone by", () => {
    const key = (pct: number) => U.pace(week(pct), NOW).key;
    expect(key(50)).toBe("on-pace");
    expect(key(55)).toBe("on-pace"); // 5 ahead is still on pace
    expect(key(55.1)).toBe("fast");
    expect(key(65)).toBe("fast"); // 15 ahead is still a little fast
    expect(key(65.1)).toBe("hot");
    expect(key(35)).toBe("on-pace"); // 15 behind is still on pace
    expect(key(34.9)).toBe("plenty");
    expect(U.pace(week(65.1), NOW).say).toBe("Running hot");
    expect(U.pace(week(60), NOW).say).toBe("A little fast");
    expect(U.pace(week(20), NOW).say).toBe("Plenty left");
    expect(U.pace(week(50), NOW).say).toBe("On pace");
  });
  test("the share gone stays between 0 and 100", () => {
    expect(U.pace(week(10, NOW + 8 * DAY), NOW).gone).toBe(0);
    expect(U.pace(week(10, NOW - DAY), NOW).gone).toBe(100);
  });
});

describe("forecast", () => {
  const fc = (w: { pct: number; resets: number | null }, now = NOW) => U.forecast(w, U.pace(w, now), now);
  test("ahead of pace, when it runs out at the pace so far", () => {
    // 70% in 3.5 days: 100% at 5 days, a day and a half from now.
    expect(fc(week(70))).toEqual({ at: NOW + 1.5 * DAY });
    expect(fc(week(60))?.at).toBeGreaterThan(NOW);
  });
  test("not on pace or with plenty left", () => {
    expect(fc(week(50))).toBeNull();
    expect(fc(week(20))).toBeNull();
  });
  test("not in the first day, except at the limit", () => {
    const resets = NOW + 6.5 * DAY; // half a day gone
    expect(U.pace(week(15, resets), NOW).key).toBe("fast");
    expect(fc(week(15, resets))).toBeNull();
    expect(fc(week(92, resets))).toEqual({ at: resets - WEEK + (100 / 92) * (DAY / 2) });
  });
  test("only before the reset", () => {
    // At 90% with 95% of the week gone, the pace runs past the reset.
    expect(fc(week(90, NOW + 0.05 * WEEK))).toBeNull();
  });
  test("nothing at 100%, at 0% or without a reset time", () => {
    expect(fc(week(100))).toBeNull();
    expect(fc(week(0))).toBeNull();
    expect(fc(week(95, null))).toBeNull();
  });
  test("nothing before the week starts", () => {
    expect(U.forecast(week(95, NOW + 8 * DAY), { key: "limit" }, NOW)).toBeNull();
  });
});

describe("paceRows", () => {
  const rows = (w: { pct: number; resets: number | null }) => U.paceRows(w, U.pace(w, NOW), NOW);
  test("12.5 hours in, a hair under: on the line, no pace a day yet, the rest a day", () => {
    const w = week(7, NOW - 12.5 * HOUR + WEEK);
    expect(rows(w)).toEqual([["On pace", "on the line"], ["To last the week", "14% a day"]]);
  });
  test("over or under comes from the unrounded share", () => {
    expect(rows(week(48.6))[0]).toEqual(["On pace", "1% under"]);
    expect(rows(week(50.4))[0]).toEqual(["On pace", "on the line"]);
    expect(rows(week(49.6))[0]).toEqual(["On pace", "on the line"]);
    expect(rows(week(51.2))[0]).toEqual(["On pace", "1% over"]);
  });
  test("after the first day, the pace a day and what a day can take, in the same unit", () => {
    // 70% in 3.5 days: 20% a day; 30% left over 3.5 days is 8.57, so 8% a day lasts.
    expect(rows(week(70))).toEqual([["Running hot", "20% over"], ["Your pace", "20% a day"], ["To last the week", "8% a day"]]);
  });
  test("on the last day, what's left until the reset", () => {
    expect(rows(week(80, NOW + 12 * HOUR))).toEqual([["On pace", "13% under"], ["Your pace", "12% a day"], ["Left until the reset", "20%"]]);
  });
  test("nothing without a reset time", () => {
    expect(rows(week(50, null))).toEqual([]);
  });
});

describe("time words", () => {
  const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h, m);
  test("a reset on the same weekday a week off is next Thu", () => {
    expect(U.nextDay(NOW + WEEK, NOW)).toBe("next Thu");
    expect(U.nextDay(at(14, 15), NOW)).toBe("Sat");
    expect(U.nextDay(at(12, 23), NOW)).toBe("Thu"); // later today
  });
  test("resetWords: the time within a day, the day further off", () => {
    expect(words(U.resetWords(at(12, 15), false, NOW))).toBe("3:00 PM");
    expect(U.resetWords(at(14, 15), false, NOW)).toBe("Sat");
    expect(words(U.resetWords(at(14, 15), true, NOW))).toBe("Sat 3:00 PM");
    expect(words(U.resetWords(at(19, 10, 30), true, NOW))).toBe("next Thu 10:30 AM");
    expect(U.resetWords(0, false, NOW)).toBe("");
  });
  test("hourOf rounds to the nearest hour", () => {
    expect(U.hourOf(at(12, 10, 29))).toBe(at(12, 10));
    expect(U.hourOf(at(12, 10, 30))).toBe(at(12, 11));
  });
  test("outWords: the hour today, the day and hour another day", () => {
    expect(words(U.outWords(at(12, 22, 50), NOW))).toBe("11 PM");
    expect(words(U.outWords(at(14, 13, 10), NOW))).toBe("Sat 1 PM");
  });
  test("whenWords: tonight, today, tomorrow, or the weekday", () => {
    expect(words(U.whenWords(at(12, 21), false, NOW))).toBe("Tonight 9 PM");
    expect(words(U.whenWords(at(12, 14, 10), false, NOW))).toBe("Today 2 PM");
    expect(words(U.whenWords(at(13, 9), false, NOW))).toBe("Tomorrow 9 AM");
    expect(words(U.whenWords(at(14, 13), false, NOW))).toBe("Saturday 1 PM");
    expect(words(U.whenWords(at(12, 15, 44), true, NOW))).toBe("Today 3:44 PM");
    expect(words(U.whenWords(at(12, 15), true, NOW))).toBe("Today 3 PM");
  });
  test("dayTime: minutes only when it isn't on the hour", () => {
    expect(words(U.dayTime(at(13, 1), NOW))).toBe("Fri 1 AM");
    expect(words(U.dayTime(at(19, 1, 30), NOW))).toBe("next Thu 1:30 AM");
  });
  test("units", () => {
    expect(HOUR).toBe(36e5);
    expect(WEEK).toBe(7 * DAY);
  });
});
