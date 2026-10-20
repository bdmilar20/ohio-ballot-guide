# Contributing

Thank you for helping make Ohio election information easier to inspect.

## Data corrections

1. Edit the matching record in the `elections` array in `data/elections.json`.
2. Link the correction to an official Ohio Secretary of State or county board of elections source.
3. Set `last_verified` to the date you checked the official source.
4. Run `npm run check` and `npm test`.
5. In the pull request, identify the changed contest and explain what the official source shows.

Mark a certified write-in candidate with `"party": "Write-in"`. The interface
relies on that exact value to separate write-ins from the candidates printed on
the ballot, so do not use it for a candidate whose name appears on the ballot
and do not substitute another spelling.

Keep descriptions factual and concise. Candidate campaign websites may provide useful context, but they are not authoritative for ballot status.

## Coverage additions

Add county coverage in small, reviewable changes. Start with countywide races, then add district-level data only when the location-to-district mapping is documented and tested. Every county with published races must include a `coverage` object with a `partial` or `complete` status, a plain-language scope and omission summary, the full official candidate-list URL, and the date that list was checked. Keep coverage `partial` whenever the guide does not contain every contest that applies countywide.

Contests go in `data/elections.json`, keyed by the county slug used in
`data/locations.json` (`franklin`, `van-wert`). Every ZIP and place name in Ohio
already resolves, so adding a county means adding its contests — not its
geography.

County Board of Elections homepages live in `data/county-boards.json`. Use the
Ohio Secretary of State's county-board directory as the source, keep all 88
county IDs in sync with `data/locations.json`, and update `meta.last_verified`
when the directory is checked. The validator rejects missing counties and
non-HTTPS links.

## Office descriptions

`data/offices.json` explains what each office on the ballot does. It is curated
by hand, and the rules are narrower than for the rest of the data:

- Describe **the office**, never a candidate, a party, or a policy position.
- Every sentence must be supported by a source listed with it — the Ohio
  Constitution, the Revised Code, or an official government page. If the
  citation does not say it, cut the sentence rather than finding a looser source.
- Prefer the section that states the duty over the section that merely names the
  office. Link the section itself, not a summary of it.
- Set `last_verified` to the date you opened each source and confirmed the text.

A contest points at a description through its `office_id`. The validator fails
on a contest whose office is missing, a description with no source, and any
source that is not HTTPS.

## Generating election schedules

Do not calculate recurring Ohio election dates by hand. Generate a year's
statutory schedule:

```bash
npm run generate:schedule -- --year=2028
```

Copy the generated `schedule_rule`, `date`, `registration_deadline`,
`early_voting_end`, and `polls` fields into a new election record, then compare
them with the Secretary of State's annual calendar before publishing. The
generator handles presidential-year March primaries and the ORC 1.14 holiday
rollovers that move registration deadlines. `npm run check` recalculates those
fields and rejects drift. Every election must name a supported `schedule_rule`;
if a local or special election does not fit an existing rule, add its rule and
tests to the generator before adding the record. The validator will not accept
an unchecked schedule.

If the annual calendar moves a deadline because an office is closed on a
one-off holiday, record that source-backed exception on the election rather
than changing the generated date silently:

```json
"schedule_exceptions": {
  "additional_closed_dates": ["2028-02-21"]
}
```

The validator includes those dates when it recomputes the deadline. See
[`docs/ELECTION_DATES.md`](docs/ELECTION_DATES.md) for the statutes and the
boundary between generated expectations and annual official verification.

## Regenerating the location data

`data/locations.json` is generated. Do not hand-edit it; re-run the script and
commit the result with the command you ran.

The source files are large and are not committed. Download them into `.cache/`,
which is ignored:

```bash
mkdir -p .cache
curl -o .cache/tab20_zcta520_county20_natl.txt \
  https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
curl -o .cache/zcta_county_rel_10.txt \
  https://www2.census.gov/geo/docs/maps-data/data/rel/zcta_county_rel_10.txt
curl -o .cache/US.zip https://download.geonames.org/export/zip/US.zip
unzip -o -d .cache .cache/US.zip US.txt
```

Then, from the repository root:

```bash
node scripts/build-locations.mjs \
  --zcta .cache/tab20_zcta520_county20_natl.txt \
  --pop .cache/zcta_county_rel_10.txt \
  --geonames .cache/US.txt
npm run check
npm test
```

Each source answers one question, and the script will not substitute one for
another:

| file | answers |
|---|---|
| 2020 ZCTA-to-county relationship | which counties a ZIP touches |
| 2010 ZCTA-to-county relationship | how many residents live in each ZIP-county part |
| GeoNames US postal file | place names, and ZIPs that have no ZCTA at all |

**List `county_ids` with the county holding most of the ZIP's residents first.**
The county picker offers the counties in that order and says nothing else about
which one is likelier, so a minority county listed first points most of the ZIP
at the wrong ballot. Residents come from `POPPT` in the 2010 file, the newest
edition that carries population. Land area is the fallback for the 71
cross-county ZIPs with no 2010 population row, and it is only a fallback: across
Ohio, ordering by land area puts the wrong county first in 26 ZIPs.

A place's counties come from its ZIPs' Census county parts, never from
GeoNames' one-county-per-ZIP column — that column files every Columbus ZIP under
Franklin, which would hide the Delaware County part of 43235.

Do not use sales-tax jurisdiction reports as a substitute for residential
geography. Check a disputed boundary against HUD's USPS residential-address
crosswalk.

## Auditing the cited URLs

Boards of elections replace dated and GUID-stamped documents rather than
updating them, so a citation that resolved last month can rot without any
change on our side. `npm run check:links` resolves every `source_url`,
`official_info_url`, supplemental source, office-description source, county
board homepage, and the Census and GeoNames files that `data/locations.json` is
generated from, one at a time, in a headless Chrome it launches itself.

**Run it by hand. Never wire it into CI or into `npm run check`.** It makes
roughly two hundred requests to live government sites, about fifty of them to
`www.boe.ohio.gov`, which hosts most of the county boards and answered
concurrency four with 429s and a maintenance page. The script is serial and
paced for that reason; `--delay` and `--slow-delay` set the pauses.

It reports four outcomes, and the distinction is the point:

| verdict | means |
|---|---|
| `ok` | the URL resolved **and** a control proved the origin discriminates |
| `broken` | the URL returned a real, non-retryable failure and that same control proved the failure is real |
| `unverified` | nothing could be concluded: the origin answered the control exactly as it answered the real URL, or it was serving a challenge or maintenance page, or it asked us to come back later |
| `error` | no response at all — a timeout or a navigation failure |

A `429` or any `5xx`, even after the script's retry, is always `unverified` and
never `broken`. The origin never served the document, so there is nothing for a
control to discriminate: an honest `404` on the control proves the origin
answers honestly, not that the unread URL is gone. `scripts/check-links.mjs`
exports `classify()` for exactly this reason, and the verdict table is pinned
in `test/check-links.test.mjs` rather than trusted to a live sweep.

Every URL is checked against a deliberately bogus sibling first. Without that
control a 403 from a site behind bot management, or a 200 from a site that
soft-404s, reads as a verdict when it is noise:

- `ohiosos.gov` and `*.boe.ohio.gov` answer **403 on every path, real or
  invented**, when they are serving the Secretary of State's maintenance page.
- `codes.ohio.gov` answers **200 for invented section numbers** and only says
  `Number Not Found` once its script has run, so the checker compares the
  rendered page, not the response.
- `vote.franklincountyohio.gov` serves `/getmedia/<guid>/<filename>` keyed on
  the GUID alone and ignores the filename, so the control changes the GUID.

**Do not change a stored URL on an `unverified` result.** Try again later, or
from another network, and change it only once a control has proved the origin
answers honestly.

Useful flags:

```bash
npm run check:links -- --only=boe.ohio.gov     # one host while debugging
npm run check:links -- --save=.cache/sources   # keep a copy of each cited PDF
```

`--save` writes every PDF it could verify into the given directory. Use it:
boards take documents down, and a saved copy is the difference between a review
that can check a candidate list and one that has to take a contributor's word
for it. `.cache/` is ignored by git, so the copies stay out of the repository.

Set `CHROME_PATH` if the script cannot find Chrome or Chromium. It checks each
known install path for an executable file and reports every path it tried, so a
Chromium-only machine or a Linux box does not need any configuration.

## Surveying which counties can be enumerated

`data/vtrapp-coverage.json` is generated. Do not hand-edit it; re-run the
script and commit the result with the command you ran.

```bash
npm run survey:vtrapp -- --election 20261103G
```

The survey asks each of Ohio's 88 counties up to the same three listing
requests the adapter opens with — fetch the listing, select the election, ask
for the precinct table — and stops there. A county not on the vendor answers
the first GET with a placeholder and costs nothing further, so the whole state
came to **232 requests** (16 placeholders plus 72 served × 3), not 88 × 3. It
never walks a ballot, so surveying the whole state costs about what ingesting
one county costs. It is still a live government source: **run it by hand, never
from CI.**

The artifact's per-county field is `enumerable`, not `ingestable`, and the
difference is load-bearing: it means the vendor served a complete precinct list
this adapter parsed in full, which is the *precondition* for an ingest. It does
not mean a full ballot walk would succeed, because the survey never attempts
one. Do not restate it as "counties we can ingest."

Useful flags: `--counties adams,van-wert` to survey a subset, `--out <path>` to
write somewhere other than `data/`, and `--delay <ms>` to change the pacing
(default 600). Each run also appends one observation to
`data/vtrapp-stamp-log.json`; pass `--log none` to keep a throwaway survey out
of the timeline the publication gate reads, or `--log <path>` to redirect it.

A county that cannot be enumerated is a finding, not a failure — the survey
records the reason and moves on, so one unservable county cannot truncate the
run into a short list that reads like a complete one. A county the survey could
not reach at all is recorded with `transport_error: true`, which is flagged
separately because it is not evidence about the county: the vendor declining to
serve a ballot stays true until a board changes something, while a timeout is
answered by running the survey again.

Only an unanswered request earns that field. The survey catches the adapter's
typed `VendorTransportError` and nothing else, so a parser regression or a bug
in the survey ends the run rather than shipping as 88 counties told to try
again — a remedy that cannot fix either one.

The reasons come from `assertEnumeration` and `requireSameStamp` in the adapter
rather than from rules restated here. That matters: a second copy of those
rules would drift, and either direction of drift is silent. A looser survey
advertises counties the adapter then refuses; a stricter one hides counties we
could publish. The stamp gate is applied at the same boundary `ingestCounty`
applies it, so a board that edits between the opening GET and the precinct-list
POST blocks the county in both places.

`npm run check` recomputes `meta.summary` from the per-county records and
refuses a file where they disagree, so the headline coverage number cannot be
edited away from the evidence beneath it. It also pins the full evidence tuple
behind every `enumerable: true`: a served response, the election offered, a
freshness stamp, parsed rows above zero and equal to the rows the vendor
listed, no skipped or unparsed rows, no blocker, and no transport error.
Checking only some of those leaves a hand-edited `true` that still validates.

## Deciding a county is settled enough to publish

A county's stamp age does not decide this; whether the stamp has stopped moving
does. The reasoning is in
[docs/BALLOT_INGESTION.md](docs/BALLOT_INGESTION.md#deciding-a-county-is-settled-enough-to-publish).
In short: the vendor's "Election data last updated" stamp only advances, so
seeing the same value twice proves no edit in between, and a county may be
published once its stamp has held across two sightings at least 48 hours apart
and the data in hand was walked at that same stamp.

See what the log currently supports:

```bash
npm run gate:vtrapp
```

The real output after the log's first two observations, which were taken
minutes apart and so settle nothing — this is the gate failing closed, not a
problem with the data:

```
unsettled (72): adams, allen, ashland, ashtabula, athens, ... williams
unobserved (16): butler, clermont, crawford, cuyahoga, franklin, ... wyandot
2 observation(s) in the log; a county needs two agreeing 48h apart to publish.
```

The 16 unobserved counties are the ones not on the vendor at all, so no survey
can ever record a stamp for them; they need their own adapters before this gate
has anything to say about them.

Gate a finished refresh bundle before reviewing its diff. This reads
`summary.json`, so it checks the stamp each county was actually walked at, and
exits nonzero naming every county that is not settled:

```bash
npm run gate:vtrapp -- --refresh .cache/vtrapp-refresh-2026-10-20
```

`--quiet-hours <n>` changes the required window and `--log <path>` reads a
different log. Lowering the window is a decision to publish on less evidence;
say so in the pull request if you do it.

`data/vtrapp-stamp-log.json` is the one generated file under `data/` that is
**not** rebuildable — last week's observation cannot be regenerated, so it is
evidence rather than output. It is append-only: the appending code refuses
out-of-order appends and another election's stamps, and `npm run check`
re-verifies the timeline. Never hand-edit it, and never reorder or drop an
observation to make a county settle.

## Ingesting county ballots

`lookup.boe.ohio.gov/vtrapp` is one application the state hosts for 72 of the
88 county boards, and it publishes real per-precinct ballots: contests,
candidates, parties, vote-for counts, and the full text of each ballot issue.
`node scripts/ingest/vtrapp.mjs --county adams --election 20261103G` writes a
**source snapshot**, not product data:

```bash
node scripts/ingest/vtrapp.mjs --county adams --election 20261103G \
  --out .cache/vtrapp-adams-20261103G.json
```

**Run it by hand. Never wire it into CI or into `npm run check`.** One county
costs roughly one request per contest per precinct — Adams is 27 precincts and
20 contests, so about 550 requests — because the accessible ballot paginates one
contest at a time behind a WebForms postback. The client is serial and paced.

The snapshot deliberately stops short of `data/elections.json`. The vendor keys
ballots by precinct split and contests genuinely differ within a county, while
the current lookup resolves only to a county; a projector owns the decision
about what a county-only guide may publish. See
[docs/BALLOT_INGESTION.md](docs/BALLOT_INGESTION.md).

The adapter fails rather than returning a partial snapshot, because a snapshot
covering fewer precincts than the county listed looks like coverage and is not.
It refuses to continue when the county is not a vendor customer, the election is
absent, enumeration finds no ballots, the parsed precinct count differs from the
listed count, a ballot walk ends before its reported contest total, a contest
cannot be represented without dropping source text, or the source's own update
stamp moves mid-run.

Four things about this source are not guessable and are pinned by tests:

- A county that does **not** use the application still answers **HTTP 200**,
  with an 861-byte `Not a Customer` page. A nonexistent slug answers 500. A
  status check alone reports success for a county that published nothing.
- The vendor slug is not our county id: it has no hyphens, so `van-wert` is
  served as `vanwert` and `van-wert` returns 500.
- The precinct table's links are **single-quoted**, so an `href="..."` pattern
  matches nothing and a populated county looks empty.
- A user agent that does not begin with `Mozilla/5.0` gets a degraded page and
  an error instead of the precinct table, so the client sends
  `Mozilla/5.0 (compatible; ohio-ballot-guide/0.1; manual ingest)`.

Each snapshot stores the vendor's `Election data last updated` stamp, resolved
to an exact instant in Ohio's time zone, plus its age in hours. Across the 72
served counties that stamp ranged from September 1 to October 13 2026, so
**successful HTTP does not mean current ballot data** and publishing an old
snapshot is an explicit review decision rather than a default.

Parser tests run against captured fixtures in `test/fixtures/vtrapp`, so
`npm test` never touches the network. Re-capture them only when the vendor's
markup changes, and say so in the commit.

## Generating statewide issue identity

County boards do not title the same statewide amendment consistently, so the
projector recognizes one by its complete ballot body as well as by its heading.
That body is generated from every county the coverage survey marks enumerable:

```bash
npm run generate:statewide-issues -- --election 20261103G
```

The command walks one ballot in every enumerable county and replaces
`data/statewide-issue-text.json` only after every county responds and prints
exactly one copy of the same body for each published statewide issue. It refuses
partial runs, transport failures, missing issues, duplicate copies, and any
one-byte disagreement. Review the generated diff and run `npm run check`; the
validator independently requires the artifact to cover the current enumerable
county set with zero failures.

## Reviewing and projecting a ballot snapshot

The projector never edits `data/elections.json`. First, create a review report
that lists content common to every enumerated precinct separately from
precinct-specific content:

```bash
npm run project:vtrapp -- \
  --snapshot .cache/vtrapp-adams-20261103G.json \
  --elections data/elections.json \
  --out .cache/vtrapp-adams-review.json
```

Review every uncertain parse and every possible statewide duplicate. A
`published_statewide_race_id` is an exact office-and-candidate match;
`possible_statewide_race_ids` are office-name matches whose candidate sets may
differ. Contest identity comes from its complete content, never its title.
Candidate and contest position may rotate between precincts, so the report's
`observed_choice_orders` and `observed_positions` retain that evidence while a
single fingerprint joins the same office across precincts. To emit a candidate
county record, pass a JSON config with an explicit freshness limit, office
mappings, and explicit overrides only where source content does not match the
generated statewide identity.
Mapping keys may be a report fingerprint or contest title; use fingerprints
when same-title contests need different statewide mappings.

```json
{
  "max_source_age_hours": 72,
  "county_name": "Adams",
  "office_mappings": {
    "For County Commissioner": {
      "office_id": "county-commissioner",
      "office": "County Commissioner"
    }
  },
  "statewide_race_mappings": {
    "For United States Senator": "us-senate"
  },
  "statewide_issue_mappings": {}
}
```

```bash
npm run project:vtrapp -- \
  --snapshot .cache/vtrapp-adams-20261103G.json \
  --elections data/elections.json \
  --config .cache/vtrapp-adams-config.json \
  --out .cache/vtrapp-adams-projection.json
```

Projection fails when the snapshot is incomplete or altered, the source is
older at review time than the accepted limit, common content has an uncertain
parse, an office lacks a mapping, or a statewide duplicate has not been
resolved explicitly. The result contains county data for review and manual
application; precinct-specific content remains only in the report.

## Refreshing reviewed counties

`config/vtrapp-<vendor-election>.json` holds the decisions a county refresh has
to reproduce, and it is a **generated** artifact. Do not hand-edit it.

```bash
npm run generate:refresh-config -- --election 20261103G
```

The generator emits one job per enumerable county, deriving each office label
from the titles `data/vtrapp-contest-survey.json` measured that county printing
and the patterns in `data/office-title-patterns.json`. For the November 2026
general that is 70 jobs with no hand-written office mappings at all — every one
of the 575 local-office instances the survey found labels without a refusal, so
onboarding a county no longer means writing its office table out.

The decisions a person still owns live in `config/decisions-<vendor-election>.json`,
which is the only part of the config a human writes:

- `max_source_age_hours`, how stale a source a refresh may publish from;
- per-county `office_mappings` for a title no curated pattern covers;
- per-county `statewide_race_mappings` and `statewide_issue_mappings`.

They are kept in a separate file deliberately. If the generator read its own
output back as input, a hand edit to a job would be carried forward and
reproduce itself, and the recomputation gate below would pass on an edited
file. A decision the patterns already derive is **refused** rather than kept:
two sources of truth for one office label is how they drift, and the stale hand
copy would keep publishing after the pattern that should own the title changed.

Two offline gates run over the tracked configs, in `npm run check` and in
`npm test`:

```bash
npm run check:refresh-config
```

The first requires every generated county already in `data/elections.json` to
have one durable job, and checks its county name, election, office mappings,
statewide mappings, and accepted source-age limit against the published data.
The second requires the config to be exactly what the generator produces from
the committed artifacts plus the decisions file. That second gate exists
because the edit worth catching is the one that stays valid — a raised
`max_source_age_hours` or an injected `office_mappings` entry passes every
check in the first gate and reads as a reviewed decision when nothing reviewed
it.

Jobs run serially so the stateful vendor application is not flooded with
concurrent ballot walks. The entry below shows the generated manifest shape,
shortened to one job.

```json
{
  "schema_version": 1,
  "meta": {
    "generated_by": "scripts/build-refresh-config.mjs",
    "generated_on": "2026-10-20",
    "note": "Generated file. Do not hand-edit; re-run npm run generate:refresh-config -- --election 20261103G. Decisions a human owns go in config/decisions-20261103G.json.",
    "election": { "id": "2026-11-03-general", "vendor_key": "20261103G" }
  },
  "jobs": [
    {
      "county": "adams",
      "election": "20261103G",
      "projection": {
        "max_source_age_hours": 168,
        "county_name": "Adams",
        "office_mappings": {},
        "statewide_race_mappings": {},
        "statewide_issue_mappings": {}
      }
    }
  ]
}
```

```bash
npm run refresh:vtrapp -- \
  --manifest config/vtrapp-20261103G.json \
  --out .cache/vtrapp-refresh-2026-10-17
```

The output directory must be new. Its `status.json` says `running`, `failed`,
or `complete`, so artifacts from an interrupted multi-county run cannot be
mistaken for a finished refresh. Successful county snapshots and projections
are retained even if a later job fails, but `elections.candidate.json` is
written only after every job succeeds and the normal data validator accepts
the candidate file. `summary.json` binds that exact validated file by SHA-256;
`gate:vtrapp` refuses a missing file, a changed byte, an incomplete summary, or
a summary that points anywhere outside the fixed candidate filename, and then
re-runs the canonical data validator against the candidate. Review
its diff against `data/elections.json`; applying that diff remains a separate
publishing decision. A county refresh preserves
the root `meta.last_reviewed` and `meta.coverage_note` values: changing either
would make a dataset-wide claim that the manifest's county jobs did not
establish.

To reproduce projection and validation without another long network walk, pass
the directory containing the saved `*-snapshot.json` files:

```bash
npm run refresh:vtrapp -- \
  --manifest config/vtrapp-20261103G.json \
  --snapshots .cache/vtrapp-refresh-2026-10-17 \
  --out .cache/vtrapp-replay-2026-10-17
```

Like the adapter, live refresh is manual and must never run in CI. Replaying
saved snapshots is offline, but freshness is recalculated at replay time and
the manifest's maximum source age still applies.

A projection decision depends on more than the manifest: the certified
statewide issue text, the curated office title patterns, and the contest survey
that bounds which titles a pattern may label. Each run copies all three into
its bundle byte for byte and records their `sha256` in `summary.inputs`, and a
replay reads them **from the bundle it is replaying** rather than from the
working tree. Without that, editing any of the three made the same saved
snapshot replay differently.

Carrying a digest is not the same as checking one. A replay loads the source
bundle's own `summary.json` first and refuses before any walk when a recorded
input is missing from the bundle, its bytes no longer match the recorded
digest, or a flag such as `--office-title-patterns` names a different file than
the one the bundle recorded. If you want to try an edited pattern set against
saved snapshots, that is a new refresh and not a replay: point `--snapshots` at
a directory holding only the `*-snapshot.json` files. Refresh bundles are
schema 3 for this reason — a schema 2 bundle recorded no input digests, so
there is nothing to verify it against and `gate:vtrapp` refuses it by version.

**The manifest is a projection input too, and is held to the same rule.** It is
where an office mapping and a maximum source age live, so replaying a complete
bundle under a different `--manifest` would republish the same snapshot under a
different office with every other check still passing. Each run records
`summary.manifest_sha256`, and a replay refuses unless both the bundle's own
`manifest.json` and the `--manifest` it was passed carry the same decisions.
That digest is taken over a key-sorted form of the manifest, so reformatting it
or reordering its keys changes nothing — only a changed decision refuses. To
project saved snapshots under different decisions, use a snapshot-only
directory, the same distinction that applies to an edited pattern set.

Projection and validation read the same input bytes. The refresh and the gate
both hand the selected issue text, patterns, and survey to
`scripts/validate-data.mjs` rather than letting it re-read the repository's
copies, so a malformed bundled input cannot drive a projection while the good
repository copy is what gets checked.

An office label derived from a surveyed title is scoped to the **county and the
election** the survey measured. A primary and a general print different
offices, so one election's survey authorizes nothing on another's ballot; the
projector falls through to its "needs mappings" refusal instead.

## Design changes

Read [`docs/DESIGN.md`](docs/DESIGN.md) before changing `styles.css` or the page
structure. It records the standard the guide builds to, including the 12px type
floor that `npm test` enforces and the rule against a red or blue brand accent
in an election context.

## Verifying a branch tip before reviewing it

Running the gate in your own checkout tells you about whatever that checkout
contains, which is not reliably the commit the author named — a fetch, another
worktree, or one uncommitted edit moves it, and the green result still reads as
evidence about the tip. Verify the commit itself:

```bash
npm run verify -- --tip 3115500
npm run verify -- --tip 3115500 --base origin/main
```

It resolves the SHA, checks out that commit alone in a throwaway worktree, and
re-reads `git rev-parse HEAD` **inside that worktree** before believing any
result from it. Then it checks the tree is clean, the signature verifies, and
the tip contains `--base`, and runs `npm run check` and `npm test` there. Your
own working tree is never touched, so it is safe to run mid-change.

The signature step asks `git verify-commit`, not whether `%G?` is `G`. The two
are different questions: `G` additionally requires the signing key to be in
*your* machine's trust store, so a perfectly good commit from the other agent
reads as `U` on your machine. Gating on `G` would reject every clean
cross-agent review. `verify-commit` accepts `G` and `U` and still rejects a bad
or absent signature, and the verdict says which of the two you got:

```
  ok   commit signature is good  signed by 38ffbaaf...; valid, but that key is
                                 not in this machine's trust store, so compare
                                 it with the author's
```

That wording is deliberate. "This commit is signed by key X" and "key X belongs
to the author" are different claims, and only the first is verifiable here.

The verdict lists all seven checks with their outcomes, including the ones that
did not run:

```
  ok   worktree HEAD is that exact commit  3115500cc10ff81...
  ok   commit signature is good  signed by 38ffbaaf...
  ?    npm test  (not run)
```

A `?` is not a pass. Printing only failures is what makes a check that silently
never ran look like one that held, which is the by-hand mistake this command
replaces. Exit is nonzero unless all seven are `ok`.

Paste the verdict block into the pull request. It is the whole of "I verified
this tip," and it names the commit it is about, so a later reader can tell
whether the review covered the tip they are looking at.
