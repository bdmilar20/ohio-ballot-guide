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

## Design changes

Read [`docs/DESIGN.md`](docs/DESIGN.md) before changing `styles.css` or the page
structure. It records the standard the guide builds to, including the 12px type
floor that `npm test` enforces and the rule against a red or blue brand accent
in an election context.
