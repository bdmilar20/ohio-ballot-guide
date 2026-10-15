# Ohio Ballot Guide

A small, nonpartisan, open-source guide to upcoming Ohio elections. Visitors enter a city or ZIP code and receive a concise view of statewide contests, countywide races, election dates, and links to official sources—without creating an account.

The first populated election is the November 3, 2026 general election. Statewide contest data is available throughout Ohio, and every Ohio location resolves to a county: 1,416 ZIP codes and 1,063 place names across all 88 counties. Selected, explicitly partial countywide data is available for Franklin, Cuyahoga, Hamilton, and Summit counties. The official 2027 primary/special, special, and general election dates are also included as schedule-only records while their ballots are not yet certified. A city or ZIP cannot determine an exact precinct ballot, so cross-county matches require the voter to choose a county and every result links to Ohio's official sample-ballot directory.

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

## Data model

The data is split by how it is maintained.

[`data/elections.json`](data/elections.json) is **curated by hand** and cites an official source for every claim. The root `elections` array can hold general, primary, special, and local elections. The site selects the nearest election whose date has not passed, so adding a future record does not require an application release.

[`data/locations.json`](data/locations.json) is **generated** by [`scripts/build-locations.mjs`](scripts/build-locations.mjs) and is not edited by hand. It holds Ohio's 88 counties, every ZIP code, and every place name, each mapped to the counties it falls in. Lookups are keyed by the normalized query, so resolving a location does not scan the dataset. Regenerate it rather than patching it; `npm run check` fails on a file that lost a county, miscounted its own rows, or points a ZIP at a county that is not in the registry. Its sources are the Census Bureau's ZCTA-to-county relationship files (public domain) and the GeoNames US postal file ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); every record names the source it came from.

[`data/offices.json`](data/offices.json) is **curated by hand** and says what each office on the ballot does, in plain language, with the constitutional or statutory section that supports each sentence. It describes the office only — never a candidate, a party, or a policy position.

Each election includes a stable ID, date, type, scope, official information URL, voting deadlines, statewide contests, covered county records, and issues. A populated county record also declares whether its coverage is `partial` or `complete`, names the included scope, states what can be missing, and links to the full official county candidate list. Every contest must include:

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
