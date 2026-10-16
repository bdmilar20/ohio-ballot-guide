import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOhioElectionSchedule,
  electionDateForRule,
  registrationDeadline,
  scheduleFields,
} from "../scripts/build-election-schedule.mjs";

test("generates the Secretary of State's published 2027 schedule", () => {
  const schedule = buildOhioElectionSchedule(2027);

  assert.deepEqual(
    schedule.elections.map(({ schedule_rule, date, registration_deadline, early_voting_end }) => ({
      schedule_rule,
      date,
      registration_deadline,
      early_voting_end,
    })),
    [
      {
        schedule_rule: "ohio-primary",
        date: "2027-05-04",
        registration_deadline: "2027-04-05",
        early_voting_end: "2027-05-02",
      },
      {
        schedule_rule: "ohio-august-special",
        date: "2027-08-03",
        registration_deadline: "2027-07-06",
        early_voting_end: "2027-08-01",
      },
      {
        schedule_rule: "ohio-general",
        date: "2027-11-02",
        registration_deadline: "2027-10-04",
        early_voting_end: "2027-10-31",
      },
    ],
  );
});

test("moves the primary to March in a presidential election year", () => {
  assert.equal(electionDateForRule(2028, "ohio-primary"), "2028-03-21");
  assert.deepEqual(scheduleFields(2028, "ohio-primary"), {
    schedule_rule: "ohio-primary",
    date: "2028-03-21",
    registration_deadline: "2028-02-22",
    early_voting_end: "2028-03-19",
    polls: { open: "6:30 a.m.", close: "7:30 p.m." },
  });
});

test("rolls registration through recurring and one-off office closures", () => {
  assert.equal(registrationDeadline("2023-11-07"), "2023-10-10");
  assert.equal(
    registrationDeadline("2027-05-04", { additionalClosedDates: ["2027-04-05"] }),
    "2027-04-06",
  );
});
