import assert from "node:assert/strict";

export const CANDIDATE_FACTS_SCHEMA_VERSION = 1;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_TYPES = new Set(["official", "candidate-authored", "candidate-questionnaire"]);
const FACT_CATEGORIES = new Set(["role", "experience", "education"]);
const REQUIRED_FACT_CATEGORIES = ["role", "experience", "education"];
const LINK_RULES = new Map([
  ["campaign", "candidate-authored"],
  ["campaign-finance", "official"],
]);

function assertDate(value, label) {
  assert.match(value, DATE_PATTERN, `${label} must use YYYY-MM-DD`);
  assert.equal(new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10), value, `${label} must be a real date`);
}

function assertHttps(value, label) {
  assert.equal(new URL(value).protocol, "https:", `${label} must use HTTPS`);
}

function contestFor(elections, profile) {
  const election = elections.elections.find(({ id }) => id === profile.election_id);
  assert.ok(election, `${profile.name} references unknown election ${profile.election_id}`);

  const contests = [
    ...election.statewide_races,
    ...Object.values(election.counties).flatMap(({ races }) => races),
  ];
  const contest = contests.find(({ id }) => id === profile.contest_id);
  assert.ok(contest, `${profile.name} references unknown contest ${profile.contest_id}`);
  return contest;
}

export function assertCandidateFacts(data, elections) {
  assert.equal(
    data.meta.schema_version,
    CANDIDATE_FACTS_SCHEMA_VERSION,
    `candidate facts must use schema ${CANDIDATE_FACTS_SCHEMA_VERSION}`,
  );
  assertDate(data.meta.last_reviewed, "candidate facts meta.last_reviewed");
  assert.ok(data.meta.scope, "candidate facts need a scope statement");
  assert.ok(data.meta.editorial_policy, "candidate facts need an editorial policy");

  const references = new Map();
  for (const election of elections.elections) {
    const contests = [
      ...election.statewide_races,
      ...Object.values(election.counties).flatMap(({ races }) => races),
    ];
    for (const contest of contests) {
      for (const candidate of contest.candidates) {
        if (!candidate.profile_id) continue;
        assert.ok(!references.has(candidate.profile_id), `duplicate candidate profile reference ${candidate.profile_id}`);
        references.set(candidate.profile_id, { election, contest, candidate });
      }
    }
  }

  assert.deepEqual(
    [...references.keys()].sort(),
    Object.keys(data.profiles).sort(),
    "candidate profile references must exactly match candidate-facts profiles",
  );

  for (const [profileId, profile] of Object.entries(data.profiles)) {
    assert.match(profileId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${profileId} must be a stable slug`);
    assert.ok(profile.name, `${profileId} needs a name`);
    assertDate(profile.last_reviewed, `${profileId}.last_reviewed`);
    assert.ok(profile.sources && Object.keys(profile.sources).length > 0, `${profileId} needs sources`);

    const contest = contestFor(elections, profile);
    const reference = references.get(profileId);
    assert.equal(reference.election.id, profile.election_id, `${profileId} election does not match its ballot record`);
    assert.equal(reference.contest.id, profile.contest_id, `${profileId} contest does not match its ballot record`);
    assert.equal(reference.candidate.name, profile.name, `${profileId} name does not match its ballot record`);
    assert.ok(contest.candidates.some(({ profile_id }) => profile_id === profileId), `${profileId} is absent from its contest`);

    for (const [sourceId, source] of Object.entries(profile.sources)) {
      assert.match(sourceId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${profileId} source id ${sourceId} must be a slug`);
      assert.ok(source.label, `${profileId}.${sourceId} needs a label`);
      assertHttps(source.url, `${profileId}.${sourceId}.url`);
      assert.ok(SOURCE_TYPES.has(source.type), `${profileId}.${sourceId} has an invalid source type`);
      assertDate(source.last_checked, `${profileId}.${sourceId}.last_checked`);
    }

    assert.ok(Array.isArray(profile.facts), `${profileId}.facts must be an array`);
    const categories = profile.facts.map(({ category }) => category);
    assert.equal(new Set(categories).size, categories.length, `${profileId} repeats a fact category`);
    assert.deepEqual([...categories].sort(), [...REQUIRED_FACT_CATEGORIES].sort(), `${profileId} needs the same core fact categories`);
    for (const fact of profile.facts) {
      assert.ok(FACT_CATEGORIES.has(fact.category), `${profileId} has unsupported fact category ${fact.category}`);
      assert.ok(typeof fact.text === "string" && fact.text.trim(), `${profileId}.${fact.category} needs text`);
      assert.ok(Array.isArray(fact.source_ids) && fact.source_ids.length > 0, `${profileId}.${fact.category} needs a citation`);
      assert.equal(new Set(fact.source_ids).size, fact.source_ids.length, `${profileId}.${fact.category} repeats a citation`);
      for (const sourceId of fact.source_ids) {
        assert.ok(profile.sources[sourceId], `${profileId}.${fact.category} cites unknown source ${sourceId}`);
      }
    }

    assert.ok(Array.isArray(profile.links), `${profileId}.links must be an array`);
    const linkKinds = profile.links.map(({ kind }) => kind);
    assert.equal(new Set(linkKinds).size, linkKinds.length, `${profileId} repeats a link kind`);
    assert.deepEqual([...linkKinds].sort(), [...LINK_RULES.keys()].sort(), `${profileId} needs campaign and finance links`);
    for (const link of profile.links) {
      assert.equal(link.source_type, LINK_RULES.get(link.kind), `${profileId}.${link.kind} has the wrong source label`);
      assert.ok(link.label, `${profileId}.${link.kind} needs a label`);
      assertHttps(link.url, `${profileId}.${link.kind}.url`);
      assertDate(link.last_checked, `${profileId}.${link.kind}.last_checked`);
      if (link.kind === "campaign-finance") {
        assert.ok(link.search_terms, `${profileId}.campaign-finance needs search terms`);
      }
    }
  }

  return { profiles: Object.keys(data.profiles).length };
}
