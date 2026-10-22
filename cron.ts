// Cron schedules the way Claude's scheduled tasks write them: five fields in local time,
//
//   minute  hour  day-of-month  month  day-of-week
//
// with *, numbers, lists (1,3), ranges (1-5), steps (*/15, 0-30/10), names (mon, jan)
// and the @daily-style shortcuts. Used to say when a task runs next, whether it missed a
// run, and to put its schedule in words.

export type Cron = {
  min: number[]; hour: number[]; dom: number[]; mon: number[]; dow: number[];
  domAny: boolean; dowAny: boolean; // exactly "*": any day
  domStar: boolean; dowStar: boolean; // starts with "*", like "*/2": counts as unrestricted below
  fields: string[];
};

const NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const SHORTCUTS: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
};

function field(text: string, lo: number, hi: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.toLowerCase().split(",")) {
    const m = part.match(/^(\*|\?|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1)) return null;
    let a = lo;
    let b = hi;
    if (m[1] !== "*" && m[1] !== "?") {
      const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : NAMES[v] ?? NaN);
      const [x, y] = m[1].split("-");
      a = num(x);
      b = y !== undefined ? num(y) : m[2] ? hi : a; // "5/2" runs from 5 to the end
      if (Number.isNaN(a) || Number.isNaN(b)) return null;
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((p, q) => p - q);
}

export function parseCron(expr: string): Cron | null {
  const text = SHORTCUTS[expr.trim().toLowerCase()] ?? expr.trim();
  const f = text.split(/\s+/);
  if (f.length !== 5) return null;
  const min = field(f[0], 0, 59);
  const hour = field(f[1], 0, 23);
  const dom = field(f[2], 1, 31);
  const mon = field(f[3], 1, 12);
  const dowRaw = field(f[4], 0, 7);
  if (!min || !hour || !dom || !mon || !dowRaw) return null;
  const dow = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort((p, q) => p - q); // 7 is Sunday too
  const star = (x: string) => x.startsWith("*") || x === "?";
  return {
    min, hour, dom, mon, dow, fields: f,
    domAny: f[2] === "*" || f[2] === "?", dowAny: f[4] === "*" || f[4] === "?",
    domStar: star(f[2]), dowStar: star(f[4]),
  };
}

// Standard (Vixie) cron: when both day fields are restricted, either one is enough; when
// one of them starts with "*", both must match.
function dayMatches(c: Cron, d: Date): boolean {
  if (!c.mon.includes(d.getMonth() + 1)) return false;
  const domOk = c.dom.includes(d.getDate());
  const dowOk = c.dow.includes(d.getDay());
  return c.domStar || c.dowStar ? domOk && dowOk : domOk || dowOk;
}

const DAYS_AHEAD = 5 * 366; // a "Feb 29 on a Monday" schedule can be years away

// The first run strictly after `after`, or null if the schedule never fires.
export function nextRun(c: Cron, after: number): number | null {
  const from = new Date(after);
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (!dayMatches(c, day)) continue;
    for (const h of c.hour) for (const m of c.min) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
      if (t > after) return t;
    }
  }
  return null;
}

// The last run at or before `before`, or null.
export function prevRun(c: Cron, before: number): number | null {
  const from = new Date(before);
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() - i);
    if (!dayMatches(c, day)) continue;
    for (const h of [...c.hour].reverse()) for (const m of [...c.min].reverse()) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
      if (t <= before) return t;
    }
  }
  return null;
}

// ---------------------------------------------------------------- in words

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const clock = (h: number, m: number) => `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const plain = (s: string) => /^\d+(,\d+)*$/.test(s); // fixed values, no ranges or steps

function days(c: Cron): string | null {
  const [, , dm, mo, dw] = c.fields;
  if (mo !== "*") {
    if (c.mon.length === 1 && c.dom.length === 1 && c.dowAny) return `Every year on ${MONTHS[c.mon[0] - 1]} ${c.dom[0]}`;
    return null;
  }
  if (!c.domAny && c.dowAny) return plain(dm) ? `Monthly on the ${and(c.dom.map(ordinal))}` : null;
  if (!c.domAny) return null; // both set: rare enough to show the raw schedule
  if (c.dowAny || c.dow.length === 7) return "Every day";
  if (same(c.dow, [1, 2, 3, 4, 5])) return "Weekdays";
  if (same(c.dow, [0, 6])) return "Weekends";
  if (c.dow.length === 1) return DAY_NAMES[c.dow[0]];
  return /^[\d,\-a-z]+$/i.test(dw) ? and(c.dow.map((d) => DAY_SHORT[d])) : null;
}

// "Weekdays at 7:00 AM", "Every 15 minutes", "Monthly on the 1st at 9:00 AM"; null when
// the schedule is too unusual to say well, and the page shows the raw expression.
export function describeCron(expr: string): string | null {
  const c = parseCron(expr);
  if (!c) return null;
  const [mi, ho] = c.fields;
  const everyDay = c.domAny && c.dowAny && c.fields[3] === "*";
  const on = (d: string | null) => (d && d !== "Every day" ? ` on ${d.replace(/^(Weekdays|Weekends)$/, (w) => w.toLowerCase())}` : "");
  // "on" fits days of the week; a monthly or yearly day under an hourly schedule doesn't.
  const fitsOn = (d: string | null) => !d || !/^(Monthly|Every year)/.test(d);

  // Minute by minute, or every few minutes.
  if (ho === "*" && (mi === "*" || /^\*\/\d+$/.test(mi))) {
    const d = days(c);
    if ((!everyDay && !d) || !fitsOn(d)) return null;
    const every = mi === "*" ? "Every minute" : `Every ${mi.slice(2)} minutes`;
    return every + on(everyDay ? null : d);
  }
  if (!plain(mi)) return null;
  // Every hour, or every few hours, at fixed minutes.
  if (ho === "*" || /^\*\/\d+$/.test(ho)) {
    const d = days(c);
    if ((!everyDay && !d) || !fitsOn(d)) return null;
    const at = c.min.length === 1 && c.min[0] === 0 ? "" : ` at ${and(c.min.map((m) => `:${String(m).padStart(2, "0")}`))}`;
    const every = ho === "*" ? "Every hour" : `Every ${ho.slice(2)} hours`;
    return every + at + on(everyDay ? null : d);
  }
  // Fixed times of day.
  if (!plain(ho) || c.hour.length * c.min.length > 4) return null;
  const d = days(c);
  if (!d) return null;
  const times = c.hour.flatMap((h) => c.min.map((m) => clock(h, m)));
  return `${d} at ${and(times)}`;
}
