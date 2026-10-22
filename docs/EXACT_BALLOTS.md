# Exact ballot lookup contract

ZIP codes and city names cannot identify a voter's ballot. Precinct splits can
cross ZIP, municipal, school, and legislative boundaries, so an exact result
starts with a street address and ends with the ballot style assigned to that
precinct for one election.

The guide keeps that path in three separate records:

1. a non-personal street-range index maps a structured address to a stable
   precinct ID;
2. a precinct registry maps every enumerated precinct to a ballot content hash;
3. deduplicated ballot records carry the exact ordered races and issues.

Separating those records prevents a source-specific voter lookup from becoming
the product model. Hamilton County's official sample-ballot form currently
requires first name and last name as well as street address fields. The guide
will not ask for a name or ship registered-voter records merely because that is
how one Board exposes its lookup. An offline adapter may derive street ranges
from an official source, but its published artifact contains no voter names,
registration history, or individual voter rows.

## Browser privacy boundary

`src/exact-ballot.mjs` is a pure local resolver. It does no network I/O and
returns only the election, county, precinct, ballot ID, and ballot content. Its
result never repeats the entered address. The UI that adopts it must also keep
the full address out of URLs, analytics, logs, cookies, and browser storage.
Only the resulting precinct or ballot ID may become shareable state.

## Fail-closed publication gates

The address index and ballot bundle must name the same election and county.
Both carry an HTTPS source, exact source digest, retrieval timestamp, and review
date. Publication refuses:

- a partial precinct enumeration, skipped row, or unexplained source row;
- a partial street-range enumeration, skipped row, or unexplained source row;
- a street range that is not normalized or whose odd/even coverage overlaps
  another range;
- a range pointing to a precinct absent from the ballot bundle;
- a published precinct with no address coverage;
- a precinct pointing to a missing ballot;
- a ballot no precinct uses; or
- an index and bundle from different elections or counties.

These checks extend the existing precinct-ingestion rule: incomplete source
coverage must stop publication because omitting a precinct can only make an
incomplete result look more complete.

## Address shape

The resolver accepts structured fields: a 1-to-5-digit house number, optional
pre/post direction, street name, optional suffix, and five-digit ZIP. Source
adapters normalize these fields before publication. The first contract does not
guess at alphanumeric or fractional house numbers; it returns an invalid result
until an official source and tests define those cases.

## Sources

- [Hamilton County Board of Elections sample-ballot lookup](https://votehamiltoncountyohio.gov/sample-ballot/)
- [Hamilton County Board of Elections voter-list exports](https://votehamiltoncountyohio.gov/campaign-media/voter-lists/)
- [Hamilton County Board of Elections precinct and district tools](https://votehamiltoncountyohio.gov/campaign-media/)
- [Existing per-precinct ingestion contract](./BALLOT_INGESTION.md)
