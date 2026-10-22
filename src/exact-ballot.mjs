const SCHEMA_VERSION = 1;
const ZIP_PATTERN = /^\d{5}$/;
const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PARITIES = new Set(["all", "odd", "even"]);
const DIRECTIONS = new Map([
  ["N", "N"],
  ["NORTH", "N"],
  ["S", "S"],
  ["SOUTH", "S"],
  ["E", "E"],
  ["EAST", "E"],
  ["W", "W"],
  ["WEST", "W"],
  ["NE", "NE"],
  ["NORTHEAST", "NE"],
  ["NW", "NW"],
  ["NORTHWEST", "NW"],
  ["SE", "SE"],
  ["SOUTHEAST", "SE"],
  ["SW", "SW"],
  ["SOUTHWEST", "SW"],
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireHttps(value, label) {
  const text = requireString(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  return text;
}

function requireDate(value, label) {
  const text = requireString(value, label);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (
    !DATE_PATTERN.test(text) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    throw new TypeError(`${label} must be an ISO calendar date`);
  }
  return text;
}

function requireTimestamp(value, label) {
  const text = requireString(value, label);
  if (Number.isNaN(Date.parse(text)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new TypeError(`${label} must be an ISO timestamp with a timezone`);
  }
  return text;
}

function requireSha256(value, label) {
  const text = requireString(value, label);
  if (!SHA256_PATTERN.test(text)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return text;
}

function normalizeStreetPart(value, { allowEmpty = false } = {}) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[’‘]/g, "'")
    .replace(/\./g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized && !allowEmpty) throw new TypeError("street name is required");
  if (normalized && !/^[A-Z0-9][A-Z0-9 '\-]*$/.test(normalized)) {
    throw new TypeError("street fields contain unsupported characters");
  }
  return normalized;
}

function normalizeDirection(value) {
  const normalized = normalizeStreetPart(value, { allowEmpty: true });
  if (!normalized) return "";
  const direction = DIRECTIONS.get(normalized);
  if (!direction) throw new TypeError("street direction is not recognized");
  return direction;
}

function normalizeHouseNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) throw new TypeError("house number must be 1 to 5 digits");
  const number = Number(text);
  if (number < 1) throw new TypeError("house number must be greater than zero");
  return number;
}

function normalizeZip(value) {
  const zip = String(value ?? "").trim();
  if (!ZIP_PATTERN.test(zip)) throw new TypeError("ZIP code must have 5 digits");
  return zip;
}

export function normalizeAddress(address) {
  const record = requireObject(address, "address");
  return {
    house_number: normalizeHouseNumber(record.house_number),
    pre_direction: normalizeDirection(record.pre_direction),
    street_name: normalizeStreetPart(record.street_name),
    street_suffix: normalizeStreetPart(record.street_suffix, { allowEmpty: true }),
    post_direction: normalizeDirection(record.post_direction),
    zip: normalizeZip(record.zip),
  };
}

function streetKey(record) {
  return [
    record.zip,
    record.pre_direction,
    record.street_name,
    record.street_suffix,
    record.post_direction,
  ].join("|");
}

function matchesParity(number, parity) {
  return parity === "all" || (parity === "odd" ? number % 2 === 1 : number % 2 === 0);
}

function rangeContainsParity(low, high, parity) {
  if (low > high) return false;
  if (parity === "all") return true;
  const wanted = parity === "odd" ? 1 : 0;
  return low % 2 === wanted || low + 1 <= high;
}

function rulesOverlap(left, right) {
  if (streetKey(left) !== streetKey(right)) return false;
  const low = Math.max(left.from, right.from);
  const high = Math.min(left.to, right.to);
  if (low > high) return false;
  if (left.parity === right.parity) return rangeContainsParity(low, high, left.parity);
  if (left.parity === "all") return rangeContainsParity(low, high, right.parity);
  if (right.parity === "all") return rangeContainsParity(low, high, left.parity);
  return false;
}

function assertProvenance(value, label) {
  const provenance = requireObject(value, label);
  requireHttps(provenance.source_url, `${label}.source_url`);
  requireSha256(provenance.source_sha256, `${label}.source_sha256`);
  requireTimestamp(provenance.retrieved_at, `${label}.retrieved_at`);
  requireDate(provenance.last_verified, `${label}.last_verified`);
}

function assertNormalizedRule(rule, index) {
  const label = `address_index.street_ranges[${index}]`;
  requireObject(rule, label);
  const normalized = normalizeAddress({
    house_number: rule.from,
    pre_direction: rule.pre_direction,
    street_name: rule.street_name,
    street_suffix: rule.street_suffix,
    post_direction: rule.post_direction,
    zip: rule.zip,
  });

  if (rule.pre_direction !== normalized.pre_direction) {
    throw new TypeError(`${label}.pre_direction must be normalized`);
  }
  if (rule.street_name !== normalized.street_name) {
    throw new TypeError(`${label}.street_name must be normalized`);
  }
  if (rule.street_suffix !== normalized.street_suffix) {
    throw new TypeError(`${label}.street_suffix must be normalized`);
  }
  if (rule.post_direction !== normalized.post_direction) {
    throw new TypeError(`${label}.post_direction must be normalized`);
  }
  if (rule.zip !== normalized.zip) throw new TypeError(`${label}.zip must be normalized`);

  const from = normalizeHouseNumber(rule.from);
  const to = normalizeHouseNumber(rule.to);
  if (from > to) throw new TypeError(`${label} starts after it ends`);
  if (!PARITIES.has(rule.parity)) throw new TypeError(`${label}.parity is not recognized`);
  requireString(rule.precinct_id, `${label}.precinct_id`);

  return { ...rule, from, to };
}

function assertAddressIndex(value) {
  const index = requireObject(value, "address_index");
  if (index.schema_version !== SCHEMA_VERSION) {
    throw new TypeError(`address_index.schema_version must be ${SCHEMA_VERSION}`);
  }
  requireString(index.election_id, "address_index.election_id");
  requireString(index.county_id, "address_index.county_id");
  assertProvenance(index.provenance, "address_index.provenance");
  const coverage = requireObject(index.coverage, "address_index.coverage");
  const listed = requireCount(coverage.listed_ranges, "address_index.coverage.listed_ranges");
  const parsed = requireCount(coverage.parsed_ranges, "address_index.coverage.parsed_ranges");
  requireCount(coverage.precinct_count, "address_index.coverage.precinct_count");
  if (listed === 0 || listed !== parsed) {
    throw new TypeError("address_index must preserve every listed street range");
  }
  if (!Array.isArray(coverage.skipped) || coverage.skipped.length !== 0) {
    throw new TypeError("address_index.coverage.skipped must be an empty array");
  }
  if (!Array.isArray(coverage.unexplained_rows) || coverage.unexplained_rows.length !== 0) {
    throw new TypeError("address_index.coverage.unexplained_rows must be an empty array");
  }
  if (!Array.isArray(index.street_ranges) || index.street_ranges.length === 0) {
    throw new TypeError("address_index.street_ranges must be a non-empty array");
  }
  if (parsed !== index.street_ranges.length) {
    throw new TypeError("address_index coverage does not match its street ranges");
  }

  const rules = index.street_ranges.map(assertNormalizedRule);
  const rulesByStreet = new Map();
  for (const [position, rule] of rules.entries()) {
    const key = streetKey(rule);
    const group = rulesByStreet.get(key) ?? [];
    group.push({ position, rule });
    rulesByStreet.set(key, group);
  }
  for (const group of rulesByStreet.values()) {
    group.sort((left, right) => left.rule.from - right.rule.from || left.rule.to - right.rule.to);
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        if (group[right].rule.from > group[left].rule.to) break;
        if (rulesOverlap(group[left].rule, group[right].rule)) {
          throw new TypeError(
            `address_index street ranges ${group[left].position} and ${group[right].position} overlap`,
          );
        }
      }
    }
  }

  const precinctIds = new Set(rules.map(({ precinct_id: precinctId }) => precinctId));
  if (coverage.precinct_count !== precinctIds.size) {
    throw new TypeError("address_index precinct count does not match its street ranges");
  }
  return {
    index,
    rulesByStreet: new Map(
      [...rulesByStreet].map(([key, group]) => [key, group.map(({ rule }) => rule)]),
    ),
    precinctIds,
  };
}

function assertBallotBundle(value) {
  const bundle = requireObject(value, "ballot_bundle");
  if (bundle.schema_version !== SCHEMA_VERSION) {
    throw new TypeError(`ballot_bundle.schema_version must be ${SCHEMA_VERSION}`);
  }
  requireString(bundle.election_id, "ballot_bundle.election_id");
  requireString(bundle.county_id, "ballot_bundle.county_id");
  assertProvenance(bundle.provenance, "ballot_bundle.provenance");

  const enumeration = requireObject(bundle.enumeration, "ballot_bundle.enumeration");
  const listed = requireCount(enumeration.listed_precincts, "ballot_bundle.enumeration.listed_precincts");
  const parsed = requireCount(enumeration.parsed_precincts, "ballot_bundle.enumeration.parsed_precincts");
  if (listed === 0 || listed !== parsed) {
    throw new TypeError("ballot_bundle must preserve every listed precinct");
  }
  if (!Array.isArray(enumeration.skipped) || enumeration.skipped.length !== 0) {
    throw new TypeError("ballot_bundle.enumeration.skipped must be an empty array");
  }
  if (!Array.isArray(enumeration.unexplained_rows) || enumeration.unexplained_rows.length !== 0) {
    throw new TypeError("ballot_bundle.enumeration.unexplained_rows must be an empty array");
  }
  if (!Array.isArray(bundle.precincts) || bundle.precincts.length !== listed) {
    throw new TypeError("ballot_bundle precinct count does not match its enumeration");
  }

  const ballots = requireObject(bundle.ballots, "ballot_bundle.ballots");
  const ballotIds = new Set(Object.keys(ballots));
  if (ballotIds.size === 0) throw new TypeError("ballot_bundle.ballots must not be empty");
  for (const [ballotId, ballot] of Object.entries(ballots)) {
    requireSha256(ballotId, `ballot_bundle.ballots.${ballotId}`);
    requireObject(ballot, `ballot_bundle.ballots.${ballotId}`);
    if (!Array.isArray(ballot.races) || !Array.isArray(ballot.issues)) {
      throw new TypeError(`ballot_bundle.ballots.${ballotId} must carry races and issues`);
    }
    const contestIds = new Set();
    for (const [position, race] of ballot.races.entries()) {
      const label = `ballot_bundle.ballots.${ballotId}.races[${position}]`;
      requireObject(race, label);
      const id = requireString(race.id, `${label}.id`);
      if (contestIds.has(id)) throw new TypeError(`${label} repeats contest ${id}`);
      contestIds.add(id);
      requireString(race.scope, `${label}.scope`);
      requireString(race.office, `${label}.office`);
      requireString(race.office_id, `${label}.office_id`);
      requireDate(race.last_verified, `${label}.last_verified`);
      requireHttps(race.source_url, `${label}.source_url`);
      if (!Array.isArray(race.candidates) || race.candidates.length === 0) {
        throw new TypeError(`${label}.candidates must be a non-empty array`);
      }
      for (const [candidatePosition, candidate] of race.candidates.entries()) {
        const candidateLabel = `${label}.candidates[${candidatePosition}]`;
        requireObject(candidate, candidateLabel);
        requireString(candidate.name, `${candidateLabel}.name`);
        if (candidate.party !== null && candidate.party !== undefined) {
          requireString(candidate.party, `${candidateLabel}.party`);
        }
      }
    }
    for (const [position, issue] of ballot.issues.entries()) {
      const label = `ballot_bundle.ballots.${ballotId}.issues[${position}]`;
      requireObject(issue, label);
      const id = requireString(issue.id, `${label}.id`);
      if (contestIds.has(id)) throw new TypeError(`${label} repeats contest ${id}`);
      contestIds.add(id);
      requireString(issue.title, `${label}.title`);
      requireDate(issue.last_verified, `${label}.last_verified`);
      requireHttps(issue.source_url, `${label}.source_url`);
      if (
        (typeof issue.summary !== "string" || issue.summary.trim() === "") &&
        (typeof issue.ballot_text !== "string" || issue.ballot_text.trim() === "")
      ) {
        throw new TypeError(`${label} must carry a summary or ballot text`);
      }
      if (
        issue.choices !== undefined &&
        (!Array.isArray(issue.choices) ||
          issue.choices.length === 0 ||
          issue.choices.some((choice) => typeof choice !== "string" || choice.trim() === ""))
      ) {
        throw new TypeError(`${label}.choices must be a non-empty list of strings`);
      }
    }
  }

  const precincts = new Map();
  const usedBallotIds = new Set();
  for (const [position, precinct] of bundle.precincts.entries()) {
    const label = `ballot_bundle.precincts[${position}]`;
    requireObject(precinct, label);
    const id = requireString(precinct.id, `${label}.id`);
    if (precincts.has(id)) throw new TypeError(`ballot_bundle repeats precinct ${id}`);
    requireString(precinct.name, `${label}.name`);
    const ballotId = requireString(precinct.ballot_id, `${label}.ballot_id`);
    if (!ballotIds.has(ballotId)) throw new TypeError(`${label} references a missing ballot`);
    precincts.set(id, precinct);
    usedBallotIds.add(ballotId);
  }
  if (usedBallotIds.size !== ballotIds.size) {
    throw new TypeError("ballot_bundle contains a ballot no precinct uses");
  }
  return { bundle, precincts };
}

export function assertExactBallotData(addressIndex, ballotBundle) {
  const checkedIndex = assertAddressIndex(addressIndex);
  const checkedBundle = assertBallotBundle(ballotBundle);
  if (checkedIndex.index.election_id !== checkedBundle.bundle.election_id) {
    throw new TypeError("address index and ballot bundle name different elections");
  }
  if (checkedIndex.index.county_id !== checkedBundle.bundle.county_id) {
    throw new TypeError("address index and ballot bundle name different counties");
  }
  for (const precinctId of checkedIndex.precinctIds) {
    if (!checkedBundle.precincts.has(precinctId)) {
      throw new TypeError(`address index references missing precinct ${precinctId}`);
    }
  }
  if (checkedIndex.precinctIds.size !== checkedBundle.precincts.size) {
    throw new TypeError("address index does not cover every published precinct");
  }
  return {
    rulesByStreet: checkedIndex.rulesByStreet,
    precincts: checkedBundle.precincts,
    ballots: checkedBundle.bundle.ballots,
    election_id: checkedBundle.bundle.election_id,
    county_id: checkedBundle.bundle.county_id,
  };
}

export function createExactBallotResolver({ addressIndex, ballotBundle }) {
  const data = assertExactBallotData(addressIndex, ballotBundle);

  return (address) => {
    let normalized;
    try {
      normalized = normalizeAddress(address);
    } catch (error) {
      return { status: "invalid", reason: error.message };
    }

    const key = streetKey(normalized);
    const matches = (data.rulesByStreet.get(key) ?? []).filter(
      (rule) =>
        normalized.house_number >= rule.from &&
        normalized.house_number <= rule.to &&
        matchesParity(normalized.house_number, rule.parity),
    );
    if (matches.length === 0) return { status: "unmatched" };
    if (matches.length !== 1) return { status: "ambiguous" };

    const precinct = data.precincts.get(matches[0].precinct_id);
    return {
      status: "matched",
      election_id: data.election_id,
      county_id: data.county_id,
      precinct: { id: precinct.id, name: precinct.name },
      ballot_id: precinct.ballot_id,
      ballot: data.ballots[precinct.ballot_id],
    };
  };
}
