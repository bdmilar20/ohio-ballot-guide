# Candidate facts policy

Candidate profiles begin with three comparable fields: current or most recent role, professional experience, and education. Every statement in `data/candidate-facts.json` cites a dated HTTPS source. Links to each campaign and the Ohio Secretary of State campaign-finance portal appear separately.

Source labels tell readers who supplied the information:

- **Official** — a government or court record.
- **Candidate-authored** — a campaign site or other material controlled by the candidate.
- **Candidate questionnaire** — answers or a profile the candidate supplied to a host organization.

The facts-only schema excludes issue positions and endorsements. Adding those later requires a separate comparison policy and identical outreach and display rules for every candidate in a contest.

`profile_id` connects a candidate on the certified ballot to one profile. The validator refuses orphan profiles, duplicate connections, mismatched names or contests, missing citations, non-HTTPS sources, inconsistent core fields, and campaign material mislabeled as official.
