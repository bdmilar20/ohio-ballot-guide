# Where the election dates come from

Every date in `data/elections.json` for a future election is fixed by the Ohio
Revised Code, not by an announcement. This document records the derivation so a
contributor can check a date without finding a Secretary of State publication,
and so nobody "corrects" a date that is already right.

## The statutes

| Date | Statute | Rule |
| --- | --- | --- |
| Primary election day | [ORC 3501.01(E)(1)](https://codes.ohio.gov/ohio-revised-code/section-3501.01) | "Primary elections shall be held on the first Tuesday after the first Monday in May of each year except in years in which a presidential primary election is held." |
| General election day | [ORC 3501.01(A)](https://codes.ohio.gov/ohio-revised-code/section-3501.01) | "the election held on the first Tuesday after the first Monday in each November" |
| August special election day | [ORC 3501.01(D)](https://codes.ohio.gov/ohio-revised-code/section-3501.01) | A special election may be held "on the first Tuesday after the first Monday in August in accordance with section 3501.022". |
| Registration deadline | [ORC 3503.19](https://codes.ohio.gov/ohio-revised-code/section-3503.19) | An application delivered in person must be received, and one returned by mail must be postmarked, "no later than the thirtieth day preceding a primary, special, or general election". The in-person and by-mail rules sit in separate divisions and use the same phrase. |
| In-person early voting opens | [ORC 3509.01(B)(2)](https://codes.ohio.gov/ohio-revised-code/section-3509.01) | Ballots "shall be printed and ready for use on the first day after the close of voter registration before the election". |
| UOCAVA ballots available | [ORC 3509.01(B)(1)](https://codes.ohio.gov/ohio-revised-code/section-3509.01) | Ballots for overseas and absent uniformed services voters are ready "other than in person on the forty-sixth day before the day of the election". |

Sources checked 2026-10-15.

## The thirtieth day lands on a Sunday more often than not

The thirtieth day preceding a Tuesday election is always a Sunday. Ohio rolls a
deadline that falls on a Sunday or a legal holiday to the next business day, so
the stored `registration_deadline` is **not** election day minus thirty. Naive
arithmetic will disagree with the file by a day or two and the file is correct:

| Election | 30th day preceding | Stored deadline | Why |
| --- | --- | --- | --- |
| 2026-11-03 | 2026-10-04 (Sun) | 2026-10-05 (Mon) | Sunday rolls forward |
| 2027-05-04 | 2027-04-04 (Sun) | 2027-04-05 (Mon) | Sunday rolls forward |
| 2027-08-03 | 2027-07-04 (Sun) | 2027-07-06 (Tue) | Sunday, and the Independence Day holiday is observed Monday |
| 2027-11-02 | 2027-10-03 (Sun) | 2027-10-04 (Mon) | Sunday rolls forward |

## Why `official_info_url` is not a year-stamped calendar

The Secretary of State publishes a per-year elections calendar at
`https://www.ohiosos.gov/assets/election-calendar-<year>.pdf`. The three 2027
elections used to point `official_info_url` at the 2027 file. That URL has never
been confirmed to exist: the 2026 file is archived, the 2027 file has no capture,
and the same query against a deliberately bogus year returns the same empty
result — so the archive cannot tell "not published yet" from "never crawled".

`official_info_url` is the link behind "Vote on", "Vote early" and "Register by"
in `app.js`, and the active election rolls to 2027-05-04 on its own once the 2026
general passes. A guessed URL would have become three broken links for every
voter with no code change to trigger it. All future elections therefore point at
the year-agnostic voting schedule page, which is archived and does not go stale:

```
https://www.ohiosos.gov/elections/voting-schedule-text-only
```

Swap in a year-stamped calendar only after opening it and confirming it loads.
