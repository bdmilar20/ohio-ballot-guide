# Contributing

Thank you for helping make Ohio election information easier to inspect.

## Data corrections

1. Edit `data/elections.json`.
2. Link the correction to an official Ohio Secretary of State or county board of elections source.
3. Set `last_verified` to the date you checked the official source.
4. Run `npm run check` and `npm test`.
5. In the pull request, identify the changed contest and explain what the official source shows.

Keep descriptions factual and concise. Candidate campaign websites may provide useful context, but they are not authoritative for ballot status.

## Coverage additions

Add county coverage in small, reviewable changes. Start with countywide races, then add district-level data only when the location-to-district mapping is documented and tested.
