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
application (vendor fingerprint `tgsistyles.css`, TGSI) serving 72 counties.
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

### Four things about this source that are not guessable

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
  "schema_version": 1,
  "election": { "id": "2026-11-03-general", "vendor_key": "20261103G" },
  "county": { "id": "adams", "vendor_slug": "adams" },
  "source": {
    "listing_url": "https://lookup.boe.ohio.gov/vtrapp/adams/ballotlist.aspx",
    "fetched_at": "2026-10-16T00:00:00Z",
    "source_updated_at": "2026-10-12T14:32:40-04:00",
    "source_age_hours": 96
  },
  "enumeration": { "listed_precincts": 27, "parsed_precincts": 27, "skipped": [] },
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
- precinct enumeration yields no ballots;
- the parsed precinct count differs from the listed count;
- a row's two ballot links disagree on precinct, election or style, or either
  link is missing one of them;
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

## What is not built yet

The projector, the county-issue schema and UI, and the review report. The
current schema has no county-level issues collection; the adapter extracts
issues anyway, but publishing them needs that separate reviewed change.
