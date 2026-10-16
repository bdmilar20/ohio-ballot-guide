// Generates the recurring Ohio election dates and their dependent deadlines.
//
// The output is a review artifact, not proof that a local election will occur.
// Compare it with the Secretary of State's annual calendar before publishing a
// new year. See docs/ELECTION_DATES.md.
import { writeFile } from "node:fs/promises";

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const OHIO_SCHEDULE_RULES = new Set([
  "ohio-primary",
  "ohio-august-special",
  "ohio-general",
]);

export const STATUTORY_SOURCES = [
  {
    fields: ["date", "schedule_rule"],
    url: "https://codes.ohio.gov/ohio-revised-code/section-3501.01",
  },
  {
    fields: ["registration_deadline"],
    url: "https://codes.ohio.gov/ohio-revised-code/section-3503.19",
  },
  {
    fields: ["registration_deadline"],
    url: "https://codes.ohio.gov/ohio-revised-code/section-1.14",
  },
  {
    fields: ["early_voting_end"],
    url: "https://codes.ohio.gov/ohio-revised-code/section-3509.051",
  },
  {
    fields: ["polls"],
    url: "https://codes.ohio.gov/ohio-revised-code/section-3501.32",
  },
];

function assertYear(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error(`Invalid year: ${year}`);
  }
}

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function fromIso(value) {
  if (!ISO_DATE.test(value)) throw new Error(`Invalid ISO date: ${value}`);
  const [year, month, day] = value.split("-").map(Number);
  const date = utcDate(year, month, day);
  if (toIso(date) !== value) throw new Error(`Invalid calendar date: ${value}`);
  return date;
}

function addDays(date, amount) {
  return new Date(date.getTime() + amount * DAY_MS);
}

function nthWeekday(year, month, weekday, occurrence) {
  const first = utcDate(year, month, 1);
  const firstMatch = 1 + ((weekday - first.getUTCDay() + 7) % 7);
  return utcDate(year, month, firstMatch + (occurrence - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const firstOfNextMonth = month === 12 ? utcDate(year + 1, 1, 1) : utcDate(year, month + 1, 1);
  const last = addDays(firstOfNextMonth, -1);
  return addDays(last, -((last.getUTCDay() - weekday + 7) % 7));
}

export function firstTuesdayAfterFirstMonday(year, month) {
  assertYear(year);
  return toIso(addDays(nthWeekday(year, month, 1, 1), 1));
}

export function thirdTuesdayAfterFirstMonday(year, month) {
  assertYear(year);
  return toIso(addDays(nthWeekday(year, month, 1, 1), 15));
}

export function isPresidentialElectionYear(year) {
  assertYear(year);
  return year % 4 === 0;
}

function fixedHoliday(holidays, year, month, day) {
  const holiday = utcDate(year, month, day);
  holidays.add(toIso(holiday));
  // ORC 1.14 makes the following Monday a legal holiday when a fixed-date
  // holiday falls on Sunday. It does not create a Friday observance for Saturday.
  if (holiday.getUTCDay() === 0) holidays.add(toIso(addDays(holiday, 1)));
}

export function ohioLegalHolidays(year) {
  assertYear(year);
  const holidays = new Set();

  fixedHoliday(holidays, year, 1, 1);
  fixedHoliday(holidays, year, 6, 19);
  fixedHoliday(holidays, year, 7, 4);
  fixedHoliday(holidays, year, 11, 11);
  fixedHoliday(holidays, year, 12, 25);

  holidays.add(toIso(nthWeekday(year, 1, 1, 3))); // Martin Luther King day
  holidays.add(toIso(nthWeekday(year, 2, 1, 3))); // Washington-Lincoln day
  holidays.add(toIso(lastWeekday(year, 5, 1))); // Memorial day
  holidays.add(toIso(nthWeekday(year, 9, 1, 1))); // Labor day
  holidays.add(toIso(nthWeekday(year, 10, 1, 2))); // Columbus day
  holidays.add(toIso(nthWeekday(year, 11, 4, 4))); // Thanksgiving day

  return holidays;
}

export function registrationDeadline(electionDate, { additionalClosedDates = [] } = {}) {
  let deadline = addDays(fromIso(electionDate), -30);
  const extraClosures = new Set(additionalClosedDates.map((value) => toIso(fromIso(value))));

  while (
    deadline.getUTCDay() === 0 ||
    ohioLegalHolidays(deadline.getUTCFullYear()).has(toIso(deadline)) ||
    extraClosures.has(toIso(deadline))
  ) {
    deadline = addDays(deadline, 1);
  }

  return toIso(deadline);
}

export function earlyVotingEnd(electionDate) {
  let date = addDays(fromIso(electionDate), -1);
  while (date.getUTCDay() !== 0) date = addDays(date, -1);
  return toIso(date);
}

export function electionDateForRule(year, scheduleRule) {
  assertYear(year);
  switch (scheduleRule) {
    case "ohio-primary":
      return isPresidentialElectionYear(year)
        ? thirdTuesdayAfterFirstMonday(year, 3)
        : firstTuesdayAfterFirstMonday(year, 5);
    case "ohio-august-special":
      return firstTuesdayAfterFirstMonday(year, 8);
    case "ohio-general":
      return firstTuesdayAfterFirstMonday(year, 11);
    default:
      throw new Error(`Unknown Ohio schedule rule: ${scheduleRule}`);
  }
}

export function scheduleFields(year, scheduleRule, options = {}) {
  const date = electionDateForRule(year, scheduleRule);
  return {
    schedule_rule: scheduleRule,
    date,
    registration_deadline: registrationDeadline(date, options),
    early_voting_end: earlyVotingEnd(date),
    polls: { open: "6:30 a.m.", close: "7:30 p.m." },
  };
}

export function buildOhioElectionSchedule(year, options = {}) {
  assertYear(year);
  return {
    meta: {
      jurisdiction: "Ohio",
      year,
      generated_by: "scripts/build-election-schedule.mjs",
      official_calendar_url: `https://www.ohiosos.gov/assets/election-calendar-${year}.pdf`,
      review_note:
        "Compare this statutory schedule with the Secretary of State's annual calendar before publishing it.",
      statutory_sources: STATUTORY_SOURCES,
    },
    elections: [...OHIO_SCHEDULE_RULES].map((rule) => scheduleFields(year, rule, options)),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = flag.slice(2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[name] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.year) throw new Error("--year is required");
    const schedule = buildOhioElectionSchedule(Number(args.year));
    const output = `${JSON.stringify(schedule, null, 2)}\n`;
    if (args.out) {
      await writeFile(args.out, output);
      console.log(`Wrote ${args.out}`);
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
