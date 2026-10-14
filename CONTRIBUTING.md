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

Add county coverage in small, reviewable changes. Start with countywide races, then add district-level data only when the location-to-district mapping is documented and tested.

## Adding an election

Add a new dated object to the `elections` array instead of replacing an existing election. Include its `type`, `scope`, official schedule URL, registration deadline, early-voting end date, poll hours, contests, counties, and issues. The application sorts the collection and shows the nearest election that has not passed.

Use an empty array when an election has no statewide races or issues. Add county names to the root `counties` registry, and put only this election's county coverage in the election's `counties` object.

Keep city aliases and ZIP aliases in separate location records. Each ZIP record must list every county in the Census Bureau's ZCTA-to-county relationship file, cite that official file, and include the date it was verified. Check disputed boundaries against HUD's USPS residential-address crosswalk; do not use sales-tax jurisdiction reports as a substitute for residential geography. The validator rejects numeric ZIP aliases on city-wide records so a city's broader county footprint cannot leak into a ZIP result.
