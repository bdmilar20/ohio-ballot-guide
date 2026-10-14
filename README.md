# Ohio Ballot Guide

A small, nonpartisan, open-source guide to upcoming Ohio elections. Visitors enter a city or ZIP code and receive a concise view of statewide contests, pilot county races, election dates, and links to official sources—without creating an account.

The first populated election is the November 3, 2026 general election. Statewide contest data is available throughout Ohio; countywide pilot data is available for Franklin, Cuyahoga, and Hamilton counties. A city or ZIP cannot determine an exact precinct ballot, so the guide never infers county races from a ZIP alone and always links to Ohio's official sample-ballot directory.

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

All public election data lives in [`data/elections.json`](data/elections.json). The root `elections` array can hold general, primary, special, and local elections. The site selects the nearest election whose date has not passed, so adding a future record does not require an application release.

The root county registry supplies stable county names for location matching. Each election includes a stable ID, date, type, scope, official information URL, voting deadlines, statewide contests, covered county records, and issues. Every contest must include:

- a stable ID;
- its geographic scope and office;
- candidates' ballot names and affiliations;
- an official source URL; and
- a `last_verified` date.

Candidate affiliations are labels from the official candidate lists. The project does not endorse candidates or summarize policy positions in this release. Location records use `county_ids` because a city or ZIP may cross county lines; ambiguous city matches require the voter to choose a county before any pilot county race appears.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Corrections should cite an Ohio Secretary of State or county board of elections source. Never replace sourced data with campaign or social-media claims.

## License

MIT. See [`LICENSE`](LICENSE).
