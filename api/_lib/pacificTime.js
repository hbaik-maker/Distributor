// Timezone-correct Pacific calendar-day boundaries, in pure JS (no tz
// library) — used to scope the secondary-run BoxHero lookup to "the day
// the base run was created," in Pacific time, regardless of when the
// secondary run actually gets triggered.
const PT_ZONE = "America/Los_Angeles";

// The UTC instant that reads as y-m-d 00:00:00 in Pacific time. Two passes
// converge exactly: the first guess (UTC midnight) is off by whatever the
// PST/PDT offset is; re-deriving from how that guess actually renders in
// Pacific time corrects it in one step, and the second pass just confirms
// there's no residual drift.
function pacificMidnightUtc(y, m, d) {
  let guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const targetAsUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).getTime();
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: PT_ZONE, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(guess);
    const get = (t) => parts.find((p) => p.type === t).value;
    const guessAsUtc = new Date(Date.UTC(
      Number(get("year")), Number(get("month")) - 1, Number(get("day")),
      Number(get("hour")) % 24, Number(get("minute")), Number(get("second"))
    )).getTime();
    guess = new Date(guess.getTime() + (targetAsUtc - guessAsUtc));
  }
  return guess;
}

// Returns [startIso, endIso) for the Pacific calendar day containing
// `referenceDate` (a Date, ISO string, or anything `new Date()` accepts).
function pacificDayBounds(referenceDate) {
  const d = new Date(referenceDate);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PT_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = Number(get("year")), m = Number(get("month")), day = Number(get("day"));
  const start = pacificMidnightUtc(y, m, day);
  const end = pacificMidnightUtc(y, m, day + 1); // Date arithmetic handles month/year rollover
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

module.exports = { pacificDayBounds };
