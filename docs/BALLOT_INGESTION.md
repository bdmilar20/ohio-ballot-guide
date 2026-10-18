# Ingesting county ballots

`data/elections.json` began as hand-typed candidate and issue records, which
meant the ballot went stale the day after an election and that covering a new
county was a new pull request. It does not have to be: **72 of Ohio's 88 county
boards publish real per-precinct ballots through one application the state
hosts**, and this document is the contract `scripts/ingest/vtrapp.mjs` is built
to. It records what the source is, where the adapter stops, and why each gate
fails closed rather than returning a partial snapshot.

## The source

`https://lookup.boe.ohio.gov/vtrapp/<slug>/` is a single state-hosted ASP.NET
application (vendor fingerprint `tgsistyles.css`, TGSI). It answers for 72 of
Ohio's 88 counties, 70 of which this adapter can ingest.

**Those counts are generated, not asserted here.** `npm run survey:vtrapp`
rebuilds `data/vtrapp-coverage.json`, which records per county what the vendor
answered, whether the election is offered, the board's own update stamp, and
the precinct-row counts. Quote the artifact rather than a number in this
document; a board can join or leave the application between elections.

Each precinct split has two endpoints:

| Endpoint | Returns |
|---|---|
| `getballot.aspx?elect=20261103G&prsid=<id>&bpty=X` | the ballot as PDF (~300 KB) |
| `xmlview.aspx?bpty=x&elec=20261103g&prsid=<id>&lang=en` | the accessible ballot as HTML (~12 KB) |

**The accessible HTML rendering is the authoritative transport.** It is text by
construction, so there is no PDF extraction step, and being the accessibility
rendering makes it the right correctness oracle. The cost is that it paginates
one contest per `POST` (`btn_next` with `__VIEWSTATE`), so a county costs about
one request per contest per precinct — roughly 550 for Adams. The PDF path
would be one GET per precinct, a ~20× reduction, and may be added later as an
optimization, but only once it demonstrates field-for-field normalized parity
with the HTML across several counties and styles, and falls back to HTML on any
discrepancy.

The 16 counties not on the vendor are not a tail — they include Cuyahoga,
Franklin and Hamilton, so most of Ohio's population. They need their own
adapters under `scripts/ingest/`.

### Two served counties publish no accessible ballot at all

**Lake and Wayne are served, offer the November 3 2026 election, and list their
precincts — 170 and 121 splits — with only the PDF link in every row.** Not one
row carries an `xmlview.aspx` link, so the two-link identity check declines
every row and the county fails closed on "precinct enumeration yielded no
ballots". That is the adapter behaving correctly, not a parser gap.

The accessible rendering is genuinely absent rather than merely unlinked, which
was checked with a control rather than assumed. Requesting `xmlview.aspx` for a
real Lake precinct returns the same 6,583-byte error page as a bogus precinct
id, byte-for-byte and title-for-title; Adams answers the same request with an
11,683-byte ballot reporting "contest 1 of 20". Wayne behaves identically at
6,560 bytes.

So the PDF path is not purely a request-volume optimization. It is the only
route to 291 precinct splits across two counties, and that changes the
cost/benefit of building it. The parity requirement above still stands: a PDF
reader has to demonstrate field-for-field normalized agreement with the HTML on
counties that publish both before it is trusted on counties that publish
neither.

### Six things about this source that are not guessable

Each is pinned by a test against captured fixtures in `test/fixtures/vtrapp`,
because the obvious implementation of each one fails silently rather than
loudly:

- **A county that does not use the application still answers HTTP 200**, with an
  861-byte `Not a Customer` placeholder; a nonexistent slug answers 500. A
  status check alone scores the placeholder as success.
- **The vendor slug is not our county id**: it has no hyphens, so `van-wert` is
  served as `vanwert` and `van-wert` itself returns 500.
- **The precinct table's row links are single-quoted**, so an `href="..."`
  pattern matches nothing and a populated county looks empty.
- **A user agent that does not begin with `Mozilla/5.0` gets a degraded page** —
  the listing comes back 2 KB shorter and "Find Ballots" answers an error page
  with no precinct table. The prefix is the whole gate, so the client still
  names itself after it.
- **The vendor lowercases its whole accessible query string**, including the
  precinct id, while leaving the PDF link cased: the same row offers
  `prsid=001A__1` and `prsid=001a__1`. Requiring the two to match exactly looks
  like the safer rule and is the opposite, because it passes everywhere it is
  cheap to test — Adams precinct ids are all digits and underscores, so the
  fold is a no-op there — and then declines 267 of Lucas's 315 rows, which
  fails that whole county closed. Case is not significant to the vendor either:
  `001A__1` and `001a__1` return the same 27-contest ballot, a different id
  returns a different ballot, and a bogus id returns an error page. Only
  agreement folds; the id stored and republished is the PDF link's, verbatim.
- **The results table does not paginate, and must not be assumed to.** It is
  `<table id="tblvtrlist">`, it is the only table in the response, and the
  largest served county returns all of it at once: Summit lists 479 precinct
  splits in one 692 KB response, with no `Page$n` postback anywhere on the page.
  A pager would be the one enumeration failure the listed-vs-parsed count
  cannot see, since a pager row is not a precinct row and both numbers would
  then describe the page the vendor served rather than the county — and a
  projection intersected over fewer precincts admits *more* content as common
  to all of them, so the failure direction is toward over-publishing.

Each listing also prints its own "Election data last updated" stamp, and across
the 72 counties those spanned 09/01/26 to 10/13/26 on 2026-10-16. **A successful
fetch is not a current ballot**, so the stamp is stored and its age reported.

## Precinct-level ingest, conservative county projection

The adapter preserves every precinct split. It does not flatten the vendor's
data into county records.

This follows the source rather than the current UI model: the vendor keys real
ballots by precinct split and contests genuinely differ within a county
(township, village, school district), while [the current lookup](../src/lookup.mjs)
resolves only to a county and already warns that it cannot predict a precinct
ballot.

A separate projector owns the product decision. For the county-only UI it may
publish a contest **only when that contest's complete normalized content appears
on every successfully enumerated precinct ballot** in the county — call that
`common_to_all_precincts`, never an exact ballot. Precinct-specific races and
all issues stay in the snapshot for review and for a future exact-precinct
lookup. **ZIP or city must never be used to guess a precinct.**

## Adapter output

The adapter emits a versioned source snapshot and deliberately stops short of
writing `data/elections.json`:

```json
{
  "schema_version": 2,
  "election": { "id": "2026-11-03-general", "vendor_key": "20261103G" },
  "county": { "id": "adams", "vendor_slug": "adams" },
  "source": {
    "listing_url": "https://lookup.boe.ohio.gov/vtrapp/adams/ballotlist.aspx",
    "fetched_at": "2026-10-16T00:00:00Z",
    "source_updated_at": "2026-10-12T14:32:40-04:00",
    "source_age_hours": 96
  },
  "enumeration": {
    "listed_precincts": 27,
    "parsed_precincts": 27,
    "skipped": [],
    "unexplained_rows": []
  },
  "precincts": [
    {
      "id": "01____1",
      "name": "…",
      "vendor_style": "X",
      "ballot_id": "sha256:…",
      "html_url": "…",
      "pdf_url": "…"
    }
  ],
  "ballots": { "sha256:…": { "contests": [] } }
}
```

A normalized contest retains source order, exact title, every subtitle and
instruction, the vote-for count when present, choices in ballot order, party
text (nullable, because judicial and many local races are nonpartisan),
write-in status, the complete text of an issue, and the raw extracted lines
alongside any uncertain parse, so a review report can expose ambiguity instead
of silently guessing.

**Ballots are deduplicated by a hash of that complete normalized content.** Two
rules make that safe, and both have been violated in review already:

- The vendor's **style label is evidence to retain, not a key** to deduplicate
  on.
- The hash covers **every content field of a contest**, not a hand-written list
  of them. `ballotId()` hashes the whole record minus an explicit exclusion
  list (`source_url`, which carries the precinct and so would defeat
  deduplication entirely), precisely so that a field added later is included by
  default. An earlier version listed the fields by hand and omitted
  `choice.raw_lines`: two ballots whose third choice line differed were
  preserved differently, shown to a reviewer differently, and still collapsed
  into one id.

## Validation gates

Every one of these throws rather than returning a partial snapshot, because a
snapshot covering fewer precincts than the county listed looks like coverage and
is not:

- the county response is the `Not a Customer` placeholder or matches the
  bogus-slug control;
- the selected election is absent from the listing;
- the listing carries no update stamp, so age cannot be reported;
- the "Find Ballots" response carries no `<table id="tblvtrlist">`, so the
  vendor's results markup changed;
- the results table carries a row that is neither its header row nor a precinct
  row — a pager, a repeated header, or a nested table;
- precinct enumeration yields no ballots;
- the parsed precinct count differs from the listed count;
- a row's two ballot links disagree on precinct, election or style, or either
  link is missing one of them (all three fold case, which is the vendor's own
  convention between the links, not a disagreement);
- the rows are listed under a different election than the one selected;
- an accessible ballot walk ends before its reported contest total;
- a contest cannot be represented without dropping source text; or
- the source's own update stamp changes, or goes missing, **at any boundary of
  the run** — including a re-read after the ballot walk finishes. Checking only
  at enumeration leaves the long, expensive part of the run unwatched, and a
  source update partway through yields a snapshot that mixes two versions of the
  ballot.

Missing identity evidence fails the same way a mismatch does. A stamp that is
absent is not agreement.

**Every one of those gates has to hold again at the replay boundary.** A
snapshot read from disk was not necessarily produced by the adapter in the
working tree reading it, so `assertCompleteSnapshot` re-checks the enumeration
rather than trusting the file --- including requiring `unexplained_rows` to be
present *and* empty, because an absent field is missing evidence rather than
agreement. `schema_version` is 2 for exactly this reason: a v1 snapshot came
from a parser that took the first `<table>` on the page and never checked that
it understood every row, so it carries no evidence that its precinct list was
the whole county, and the version is what lets a consumer refuse it. The field
check alone cannot, since a hand-written file can carry an empty array without
a parser having looked at a single row.

## Review and projection

`scripts/project-vtrapp.mjs` validates the complete snapshot and produces a
review artifact with two explicit lists: content common to every enumerated
precinct and content that appears on only some precinct ballots. Contest
identity is the complete normalized content, never its title: same-title issues
with different ballot text and same-title offices with different candidate sets
remain different contests. Position, source URL, and candidate sequence are
presentation rather than identity. Ohio rotates candidate names between
precinct ballots under [ORC 3505.03](https://codes.ohio.gov/ohio-revised-code/section-3505.03),
so the projector canonicalizes `choices` together with `raw.choice_lines` for
office contests while retaining every observed candidate order and contest
position in the review report. Issue choices remain order-sensitive.

Publishing is a separate, reviewed operation. A projection config must set the
maximum acceptable source age, map every common county office to a known
`data/offices.json` record, and explicitly identify statewide races or issues
whose source content does not exactly match the published candidate or issue
data. The review report exposes office-name matches separately from exact
office-and-candidate matches so a stale statewide candidate list cannot turn a
statewide race into county content. The projector calculates freshness again at
review time, rejects uncertain common parses, and emits a candidate county
record without editing `data/elections.json`.

County records now support `issues[]` alongside `races[]`. Projected records
carry their source-content fingerprint, and `coverage` records the source
update time, age at review, review timestamp, and the number of precincts
verified. The UI labels the result as content common to every enumerated
precinct, lists candidates in a deterministic canonical order with an
explicit precinct-rotation caveat, reports how many additional contests or
issues appear only on some precinct ballots, and continues to direct voters to
the official sample ballot for their exact contests and candidate order.

`scripts/refresh-vtrapp.mjs` is the operator layer over those two contracts. A
reviewed manifest can refresh several counties serially, retain each immutable
snapshot and projection, and assemble a validated candidate elections file.
It does not edit production data. Every run directory carries an explicit
status, and a failed or interrupted run never contains the candidate file that
marks a complete refresh ready for diff review. Dataset-wide metadata stays as
reviewed in the input: refreshing some counties cannot advance the whole
dataset's review date or replace its coverage description.
