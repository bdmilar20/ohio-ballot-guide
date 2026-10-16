# Where the election dates come from

Every election day and `registration_deadline` in `data/elections.json` has two
independent supports: the Ohio Revised Code section that fixes it, and the
Secretary of State's elections calendar for that year, which prints it. The
early-voting fields have one support each — the annual calendar prints the day
early voting *begins* but never the day it ends, so `early_voting_end` rests on
the statute alone. This document records what backs each field so a contributor
can check a date without re-deriving it, and so nobody "corrects" a date that is
already right.

## Generate first, verify second

Recurring dates are executable rules, not hand-entered arithmetic. Generate a
year with:

```bash
npm run generate:schedule -- --year=2028
```

Every stored election must carry a supported `schedule_rule` (`ohio-primary`,
`ohio-august-special`, or `ohio-general`). `npm run check` recomputes its
election day, registration deadline, early-voting end, and poll hours and fails
if the JSON drifts. It also rejects an election with no rule, so a new local or
special-election category must be implemented in the generator before it can
ship. The generator knows that presidential-year primaries move from May to
March and that registration can roll through consecutive legal holidays.

The output is still an expected statutory schedule. Compare it with the
Secretary of State's annual calendar before publishing a new year because the
law can change and ORC 1.14 recognizes one-off holidays appointed by the
governor or president. Record a source-backed one-off closure in
`schedule_exceptions.additional_closed_dates`; the validator will include it
instead of forcing an incorrect recurring-calendar answer.

## The statutes

| Date | Statute | Rule |
| --- | --- | --- |
| Primary election day | [ORC 3501.01(E)(1)](https://codes.ohio.gov/ohio-revised-code/section-3501.01) | "Primary elections shall be held on the first Tuesday after the first Monday in May of each year except in years in which a presidential primary election is held." |
| General election day | [ORC 3501.01(A)](https://codes.ohio.gov/ohio-revised-code/section-3501.01) | "the election held on the first Tuesday after the first Monday in each November" |
| August special election day | [ORC 3501.01(D)](https://codes.ohio.gov/ohio-revised-code/section-3501.01) | A special election may be held "on the first Tuesday after the first Monday in August in accordance with section 3501.022". |
| `registration_deadline` | [ORC 3503.19](https://codes.ohio.gov/ohio-revised-code/section-3503.19) | An application delivered in person must be received, and one returned by mail must be postmarked, "no later than the thirtieth day preceding a primary, special, or general election". The in-person and by-mail rules sit in separate divisions and use the same phrase. |
| Deadline rollover | [ORC 1.14](https://codes.ohio.gov/ohio-revised-code/section-1.14) | A deadline falling on a Sunday or a legal holiday extends to the next succeeding business day. See below — this moves every registration deadline we store. |
| In-person early voting opens | [ORC 3509.01(B)(2)](https://codes.ohio.gov/ohio-revised-code/section-3509.01) | Ballots "shall be printed and ready for use on the first day after the close of voter registration before the election". |
| `early_voting_end` | [ORC 3509.051](https://codes.ohio.gov/ohio-revised-code/section-3509.051) | In-person absentee voting ends "at five p.m. on the Sunday before the day of the election". The annual calendar prints only the day early voting *begins*, so this field rests on the statute alone. |
| UOCAVA ballots available | [ORC 3509.01(B)(1)](https://codes.ohio.gov/ohio-revised-code/section-3509.01) | Ballots for overseas and absent uniformed services voters are ready "other than in person on the forty-sixth day before the day of the election". |

Sources checked 2026-10-15.

## The thirtieth day lands on a Sunday, always

The thirtieth day preceding a Tuesday election is always a Sunday, so ORC 1.14
moves every registration deadline forward and the stored
`registration_deadline` is **never** election day minus thirty. Naive arithmetic
will disagree with the file by a day or two and the file is correct:

| Election | 30th day preceding | Stored deadline | Why |
| --- | --- | --- | --- |
| 2026-11-03 | 2026-10-04 (Sun) | 2026-10-05 (Mon) | Sunday rolls forward |
| 2027-05-04 | 2027-04-04 (Sun) | 2027-04-05 (Mon) | Sunday rolls forward |
| 2027-08-03 | 2027-07-04 (Sun) | 2027-07-06 (Tue) | Sunday, *and* Independence Day is observed the following Monday, so it rolls twice |
| 2027-11-02 | 2027-10-03 (Sun) | 2027-10-04 (Mon) | Sunday rolls forward |

The Secretary of State's calendar reaches the same answers and flags each one
with an asterisk whose footnote is ORC 1.14 — "In some instances, the statutory
deadline falls on a day when the offices of the Secretary of State and boards of
elections are closed. In those instances, the deadlines are extended, pursuant
to R.C. 1.14, to the next succeeding day when the appropriate office is open for
regular business hours." The 2027 calendar prints, verbatim:

```
Apr. 05* Deadline for voter registration for May 4 primary election
         (30 days before primary/special election) R.C. 3503.19
July 06* Deadline for voter registration for Aug. 3 special election
         (30 days before special election) R.C. 3503.19
Oct. 04* Deadline for voter registration for Nov. 2 general election
         (30 days before general election) R.C. 3503.19
```

## `official_info_url` and the year-stamped calendar

Each election's `official_info_url` is the link behind "Vote on", "Vote early"
and "Register by" in `app.js`, so it has to be a page that answers all three.
The Secretary of State publishes a per-year elections calendar that does, at a
stable path:

```
https://www.ohiosos.gov/assets/election-calendar-<year>.pdf
```

The three 2027 elections point at the 2027 file. It is linked from the official
[Office Publications](https://www.ohiosos.gov/office/media-center/publications)
page as "2027 Elections Calendar - tabloid-size (PDF)", immediately below the
2026 entry, and identifies itself as `SOS 0503 (updated 9/24/2026)`.

### Verifying an `ohiosos.gov` URL from a blocked host

`ohiosos.gov` sits behind Cloudflare bot management, which answers plain `curl`
and most server-side fetchers with **HTTP 403 on every path, real or invented**.
A 403 from such a client is therefore not evidence that a document is missing,
and the Wayback Machine cannot settle it either — a freshly published PDF and a
URL that never existed both come back with no capture.

Do not change a URL on the strength of a 403. Get a real answer from a browser
engine that completes the challenge, and include a control:

```js
// node, with puppeteer-core driving an installed Chrome
import puppeteer from 'puppeteer-core';

const url = 'https://www.ohiosos.gov/assets/election-calendar-2027.pdf';

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
// Load any page on the origin first; that clears Cloudflare for the session.
await page.goto('https://www.ohiosos.gov/office/media-center/publications');
// Then fetch the asset from inside the page, with the clearance cookie.
console.log(await page.evaluate(async (u) => {
  const response = await fetch(u, { credentials: 'include' });
  return { status: response.status, type: response.headers.get('content-type') };
}, url));
await browser.close();
```

Run every check against a deliberately bogus sibling URL as well. Measured
2026-10-15:

| URL | Status | Body |
| --- | --- | --- |
| `/assets/election-calendar-2027.pdf` | 200 | `application/pdf`, 208,924 bytes |
| `/assets/election-calendar-2026.pdf` | 200 | `application/pdf`, 230,902 bytes |
| `/assets/election-calendar-2099.pdf` | 404 | `application/json` |
| `/assets/election-calendar-bogus-control.pdf` | 404 | `application/json` |

The control returns 404, so the 200s mean what they say. Extract the PDF's text
with `pdfjs-dist` rather than a stream regex, and confirm a known string from the
document before trusting anything you read out of it.
