# Ohio Ballot Guide

A small, nonpartisan, open-source guide to upcoming Ohio elections. Visitors enter a city or ZIP code and receive a concise view of statewide contests, countywide races, election dates, and links to official sources—without creating an account.

The first populated election is the November 3, 2026 general election. Statewide contest data is available throughout Ohio, and every Ohio location resolves to a county: 1,416 ZIP codes and 1,063 place names across all 88 counties. Selected, explicitly partial countywide data is available for Franklin, Cuyahoga, Hamilton, Montgomery, and Summit counties. The official 2027 primary/special, special, and general election dates are also included as schedule-only records while their ballots are not yet certified. A city or ZIP cannot determine an exact precinct ballot, so cross-county matches require the voter to choose a county and every result links to Ohio's official sample-ballot directory.

Every county result also links directly to that county's official Board of Elections website, using the directory published by the Ohio Secretary of State.

## Run locally

No dependencies or build step are required.

```bash
python3 -m http.server 4173
```

Open <http://localhost:4173>.

## Validate

```bash
npm run check
npm test
```

Both run offline and are the gate for every change.

Separately, `npm run check:links` resolves every official URL the data cites
and reports the ones that have rotted. It drives a headless Chrome and talks to
live government sites, so it is **run by hand, never from CI**. See
[CONTRIBUTING.md](CONTRIBUTING.md#auditing-the-cited-urls).

To generate the statutory schedule for a new year before comparing it with the
Secretary of State's annual calendar:

```bash
npm run generate:schedule -- --year=2028
```

`npm run survey:vtrapp` answers the prior question — *which* counties the
vendor enumerates a complete precinct list for — and writes the answer to
`data/vtrapp-coverage.json` as a generated artifact rather than a list anyone
typed. It asks up to three listing requests per county and never walks a
ballot, so all 88 counties came to 232 requests, roughly one county's ingest.
Like the other live-source scripts it is **run by hand, never from CI**:

```bash
npm run survey:vtrapp -- --election 20261103G
```

The artifact records, per county, the vendor response, whether the election is
offered, the board's own "last updated" stamp, and the precinct-row counts —
and, for a county that cannot be enumerated, the adapter's own reason. The
field is `enumerable` rather than `ingestable` on purpose: the survey proves a
county has a complete, adapter-compatible precinct list, which is the
precondition for an ingest, not that a full ballot walk would finish. `npm run
check` recomputes its summary from its records and pins the evidence behind
every `enumerable: true`, so the headline count cannot drift from what the run
found.

`npm run ingest:vtrapp` pulls one county's real per-precinct ballots from the
application the state hosts for 72 of the 88 county boards, and writes a source
snapshot for review rather than product data. It also talks to a live
government site and is **run by hand, never from CI**:

```bash
node scripts/ingest/vtrapp.mjs --county adams --election 20261103G \
  --out .cache/vtrapp-adams-20261103G.json
```

See [CONTRIBUTING.md](CONTRIBUTING.md#ingesting-county-ballots) for how to run
it and [docs/BALLOT_INGESTION.md](docs/BALLOT_INGESTION.md) for the contract it
is built to — what the source is, where the adapter stops, and why each gate
fails closed.

The projector turns a complete snapshot into a review report without editing
published data. A reviewed config may then emit only content whose complete
normalized form appears on every enumerated precinct ballot:

```bash
npm run project:vtrapp -- --snapshot .cache/vtrapp-adams-20261103G.json \
  --elections data/elections.json --out .cache/vtrapp-adams-review.json
```

Once projection decisions have been reviewed, `npm run refresh:vtrapp` runs a
manifest of counties serially and writes a new review bundle. The bundle keeps
every source snapshot and projection, a compact change summary, and a validated
`elections.candidate.json`; it never overwrites `data/elections.json`. See
[CONTRIBUTING.md](CONTRIBUTING.md#refreshing-reviewed-counties) for the manifest
format and replay workflow.

## Data model

The data is split by how it is maintained.

[`data/elections.json`](data/elections.json) combines generated schedule fields with reviewed ballot content. Election days, registration deadlines, early-voting end dates, and poll hours are tied to a `schedule_rule`; [`scripts/build-election-schedule.mjs`](scripts/build-election-schedule.mjs) generates them from Ohio law, and `npm run check` rejects a stored value that disagrees. Candidate, issue, and coverage records remain curated and cite an official source for every claim. The root `elections` array holds the election types that have a schedule rule — general, primary, and August special. A local or off-cycle special election needs its rule added to the generator first, because the gate rejects a record whose schedule it cannot recompute. The site selects the nearest election whose date has not passed, so adding a future record does not require an application release.

[`data/locations.json`](data/locations.json) is **generated** by [`scripts/build-locations.mjs`](scripts/build-locations.mjs) and is not edited by hand. It holds Ohio's 88 counties, every ZIP code, and every place name, each mapped to the counties it falls in. Lookups are keyed by the normalized query, so resolving a location does not scan the dataset. Regenerate it rather than patching it; `npm run check` fails on a file that lost a county, miscounted its own rows, or points a ZIP at a county that is not in the registry. Its sources are the Census Bureau's ZCTA-to-county relationship files (public domain) and the GeoNames US postal file ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); every record names the source it came from.

[`data/offices.json`](data/offices.json) is **curated by hand** and says what each office on the ballot does, in plain language, with the constitutional or statutory section that supports each sentence. It describes the office only — never a candidate, a party, or a policy position.

[`data/county-boards.json`](data/county-boards.json) is the curated directory of official county Board of Elections websites. Its county IDs must match the generated location registry exactly; validation fails if any of Ohio's 88 counties is missing or a link is not HTTPS.

Each election includes a stable ID, date, type, scope, official information URL, voting deadlines, statewide contests, covered county records, and issues. County records can contain races and ballot issues. A populated county record also declares whether its coverage is `partial` or `complete`, names the included scope, states what can be missing, and links to the official source. Generated `common_to_all_precincts` coverage also records the precinct count, source update time, review time, and a fingerprint for every projected record. Every contest must include:

- a stable ID;
- its geographic scope and office;
- candidates' ballot names and affiliations;
- an official source URL;
- an `office_id` pointing at its description in `data/offices.json`; and
- a `last_verified` date.

Candidate affiliations are labels from the official candidate lists. The project does not endorse candidates or summarize policy positions in this release. A one-county match shows that county's coverage, and a cross-county match asks the voter to choose before any county race appears.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Corrections should cite an Ohio Secretary of State or county board of elections source. Never replace sourced data with campaign or social-media claims.

## License

MIT. See [`LICENSE`](LICENSE).
