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
Ohio's 88 counties, 70 of which it enumerates a complete, adapter-compatible
precinct list for.

**Those counts are generated, not asserted here.** `npm run survey:vtrapp`
rebuilds `data/vtrapp-coverage.json`, which records per county what the vendor
answered, whether the election is offered, the board's own update stamp, and
the precinct-row counts. Quote the artifact rather than a number in this
document; a board can join or leave the application between elections.

The statewide survey journals each complete county to
`.cache/vtrapp-survey-<election>.ndjson`. If the vendor stops answering or the
process is interrupted, re-running the same command resumes those records and
retries unanswered requests; it does not spend another request on counties
already observed. The journal also keeps the start time of each attempt, so a
resumed survey contributes truthful batches to the append-only stamp log rather
than claiming every county was observed at the last restart. A complete run
removes its journal. Use `--partial <path>` to place it elsewhere or `--partial
none` for a deliberately non-resumable diagnostic run.

`--counties` is diagnostic only. It requires both `--out <path>` and `--log
none`, so a one-county probe cannot replace statewide coverage or masquerade as
a statewide freshness observation.

**The artifact's field is `enumerable`, and it is weaker than "ingestable."**
The survey stops at the precinct listing. A real ingest then walks every
accessible ballot in the county and parses every contest on it, so `enumerable`
establishes the precondition for an ingest and not that the walk would finish —
proving that would cost the walk the survey exists to avoid. The adapter has
been run to completion on Adams and Vinton; the other 68 are enumerated, not ingested.

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
How that stamp decides whether a county may be published is
[its own contract](#deciding-a-county-is-settled-enough-to-publish); the short
version is that the stamp's *age* decides nothing.

The shared client retries a request that never receives a response at most two
times, using the same pacing delay as the rest of the walk. A timeout or dropped
body is transport weather, so a bounded retry prevents one transient failure
from discarding a county-sized walk. An HTTP response, parser refusal, changed
source stamp, or incomplete ballot is evidence from the source and is never
retried into a different answer.

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

Statewide issue identity is generated rather than repeated in every county
config. `scripts/build-statewide-issues.mjs` reads one ballot from every county
the coverage survey marks enumerable, learns each published issue body from the
county headings the title matcher recognizes, and then requires that exact body
once in every county read. The canonical artifact is not replaced after a
partial run, a county failure, a duplicate, or a text disagreement. The
projector uses the resulting exact body as a title-independent backstop;
`statewide_issue_mappings` remains available only for reviewed source drift.

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

A county projection refusal is isolated to that job after its snapshot is
saved. The refresh records the refusal, continues projecting the remaining
counties, and ends failed with no candidate file if any projection refused.
This keeps one previously unseen title or contest from hiding the results for
every county after it while preserving the rule that only an entirely complete
run can produce a publication candidate. Adapter and artifact-write failures
still stop immediately because they can indicate a source-wide or storage-wide
failure rather than one county's projection decision.

The completed summary records the SHA-256 of the exact validated candidate
file. The publication gate re-hashes that file and re-runs the canonical data
validator before checking any county stamp, so settlement evidence cannot be
applied to a candidate edited after validation, copied from another refresh
run, or paired with a hand-written claim that invalid data was checked.

## Deciding a county is settled enough to publish

Every listing carries the board's own "Election data last updated" stamp, and
the obvious gate is an age limit. It does not work. On 2026-10-18 the 70
enumerable counties' stamps spanned 09/01/26 to 10/13/26, and 38 of them had
not moved in over a month — Huron's was 46 days old. Ohio closes candidate
filing long before November, so a board that stopped editing in September is as
likely to be **finished** as behind. The stamp's age cannot tell those apart,
and any limit tight enough to catch a genuinely stale county rejects most of
the state. `max_source_age_hours` remains a projection input, but it is a
backstop against a wildly old snapshot, not the freshness decision.

Because that is what it is for, it is no longer a number anybody types. The
refresh-config generator derives it from the election's own cycle — the span
from the election that precedes this one under the schedule rules in
`scripts/build-election-schedule.mjs`, which for the November 2026 general is
the 4368 hours since the May primary — and refuses any surveyed source stamp
that predates the cycle. A board's "Election data last updated" stamp cannot
precede the listing it describes, so a stamp from before the cycle is a
snapshot of a different ballot, and that is the only thing age can decide. The
hand-written 168-hour limit this replaced was inherited from a config with one
county in it; measured against the surveyed seventy it admitted one, so a
statewide refresh under it would have stopped on its first job.

What does distinguish finished from behind is **movement**. The stamp only ever
advances, so seeing the same value twice proves no edit happened in between.
That makes the decision evidential rather than a judgment call:

> A county may be published when its stamp has been observed unchanged at least
> twice, across sightings spanning at least 48 hours, and the data in hand was
> walked at that same stamp.

Each `npm run survey:vtrapp` run appends one observation to
`data/vtrapp-stamp-log.json` — 88 counties for up to three requests each, which
came to 232 on the observed run, about the cost of one county's ingest. `scripts/vtrapp-stamp-log.mjs` holds the rule and
`npm run gate:vtrapp` applies it:

```bash
npm run gate:vtrapp                                            # what the log supports today
npm run gate:vtrapp -- --refresh .cache/vtrapp-refresh-2026-10-20   # gate a bundle
```

Five properties are deliberate:

- **The span is measured between sightings, not from the stamp.** A stamp six
  weeks old seen twice two days apart is settled. A stamp edited this morning
  is not, however current it looks.
- **The walk counts as a sighting.** `assertSettled` takes the stamp and fetch
  time from the snapshot itself, which closes the window between the last
  survey and the ingest: a board that edited in that gap moved the stamp, and
  the county waits instead of publishing a ballot nobody watched settle.
- **A later survey may vouch for an earlier walk.** Because the stamp only
  moves forward, a survey taken after a walk that still reports the same stamp
  proves the captured ballot is still current. Walking first and settling
  afterwards is allowed; walking at a stamp the board has since replaced is
  not, even once the replacement settles.
- **The log is append-only, and the one file under `data/` that is not
  rebuildable.** Last week's observation cannot be regenerated, so it is
  evidence rather than output. `appendObservation` refuses out-of-order
  appends and another election's stamps, and `npm run check` re-verifies the
  timeline, because `gate:vtrapp` reads "the stamp did not move" straight out
  of this file and a scrambled log would answer that confidently and wrongly.
  The gate validates the log too, with the same function `npm run check` uses,
  because `--log <path>` accepts a file that never went through check.
- **A stamp is only evidence about its own election.** Settlement compares
  stamp strings, which two elections can coincidentally share, so every job in
  a bundle must name the vendor election it walked and it must be the one the
  log observes. A mismatch is a malformed bundle and fails before any county's
  settlement is considered — otherwise a log of November observations would
  settle a May bundle and report it as watched evidence.

Three limits worth stating.

**"Settled" is an observation, not a promise.** It says the board was not
editing across the window we watched; it cannot say the board is finished. A
county quiet for 48 hours can be edited on the third day. That is why the gate
is re-run against each refresh bundle rather than recorded once as a property
of the county, and why the walk's own stamp has to match: the question is
always "is this data still current," never "was this county ever settled."

**A board that edits without touching its stamp is invisible here**, as it is
to every other consumer of the stamp — including the adapter's own cross-page
`requireSameStamp` check, which already treats an unchanged stamp as unchanged
content. This gate inherits that assumption rather than adding one.

**A county seen once can never settle**, so the gate fails closed on a county
surveyed for the first time. The fix is another survey, not a lower threshold.
Such a county reports `seen-once` rather than `moving`, because on a first run
every county has one sighting and calling all 70 of them "moving" would claim
every board in Ohio is mid-edit when the log has said nothing at all.
