# Candidate facts policy

Candidate profiles begin with three comparable fields: current or most recent role, professional experience, and education. Every statement in `data/candidate-facts.json` cites a dated HTTPS source. Links to each campaign and the Ohio Secretary of State campaign-finance portal appear separately.

Source labels tell readers who supplied the information:

- **Official** — a government or court record.
- **Candidate-authored** — a campaign site or other material controlled by the candidate.
- **Candidate questionnaire** — answers or a profile the candidate supplied to a host organization.

Candidate-authored and candidate-questionnaire sources also carry
`source_sha256`, the SHA-256 of the retrieved response body reviewed on
`last_checked`. This pins each claim to the content the reviewer actually saw;
re-reviewing a changed page requires checking the claim again and updating both
the digest and date. Official court and government sources remain dated and
linked but do not require a content digest.

The facts-only schema excludes issue positions and endorsements. Adding those later requires a separate comparison policy and identical outreach and display rules for every candidate in a contest.

`profile_id` connects a candidate on the certified ballot to one profile. The validator refuses orphan profiles, duplicate connections, mismatched names or contests, missing citations, non-HTTPS sources, unpinned candidate-controlled content, inconsistent core fields, and campaign material mislabeled as official.
