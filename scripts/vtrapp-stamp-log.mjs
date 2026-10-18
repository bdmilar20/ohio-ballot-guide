// Decides whether a county's ballot data is settled enough to publish, from
// evidence rather than from a chosen age limit.
//
// The vendor prints an "Election data last updated" stamp per county. Its age
// cannot distinguish a board that is behind from a board that is finished:
// Ohio closes candidate filing long before November, so a September stamp is
// as likely to mean "done" as "stale". Across the 70 ingestable counties on
// 2026-10-18 the stamps spanned September 1 to October 13, so any age limit
// tight enough to catch a real staleness problem rejects most of the state.
//
// What does distinguish them is movement. The stamp only ever moves forward,
// so observing the same value twice proves no edit happened in between. A
// county whose stamp has not moved across two observations far enough apart is
// settled; one whose stamp moved is still being edited and waits.
//
// That makes this file two things: an append-only log of what the stamp was
// when we looked, and the rule that reads it. The log is the one file under
// data/ that is not rebuildable from a single run -- you cannot regenerate
// last week's observation -- so it is append-only by construction and the
// appending code refuses to rewrite history.

export const STAMP_LOG_SCHEMA_VERSION = 1;

/** The gap two agreeing observations must span before a county is settled. */
export const DEFAULT_QUIET_HOURS = 48;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function instant(value, label) {
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed), `${label} must be a parseable timestamp, not ${JSON.stringify(value)}`);
  return parsed;
}

export function emptyLog({ election }) {
  invariant(isRecord(election) && typeof election.vendor_key === "string", "a stamp log needs the election it observes");
  return {
    meta: {
      schema_version: STAMP_LOG_SCHEMA_VERSION,
      generated_by: "scripts/survey-vtrapp.mjs",
      note:
        "Append-only observation log. Each survey run appends one observation; " +
        "earlier observations are evidence of what the vendor said at the time and are never rewritten. " +
        "Do not hand-edit.",
      election: { id: election.id, vendor_key: election.vendor_key },
      observations: 0,
    },
    observations: [],
  };
}

/**
 * Reduces a coverage survey to the one thing settlement needs: the stamp each
 * county was showing, and which counties were looked at.
 *
 * A county with no stamp is recorded as surveyed but carries no stamp entry,
 * because "we looked and there was nothing to see" is the absence of evidence
 * either way. Both readings lead to the same conservative answer, so the
 * distinction is kept in the coverage artifact rather than duplicated here.
 */
export function observationFromCoverage(coverage, { observedAt }) {
  invariant(isRecord(coverage?.counties), "a coverage survey needs county records");
  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  invariant(Number.isFinite(observed.getTime()), "observedAt must be a valid timestamp");
  const stamps = {};
  for (const [countyId, record] of Object.entries(coverage.counties)) {
    if (record.source_updated_at) stamps[countyId] = record.source_updated_at;
  }
  invariant(
    typeof coverage.meta?.election?.vendor_key === "string",
    "a coverage survey needs the vendor election key it surveyed",
  );
  return {
    observed_at: observed.toISOString(),
    election: coverage.meta.election.vendor_key,
    source: coverage.meta?.generated_by ?? "scripts/survey-vtrapp.mjs",
    surveyed: Object.keys(coverage.counties),
    stamps,
  };
}

/**
 * Appends one observation, refusing anything that would corrupt the log's
 * meaning rather than its syntax.
 *
 * Out-of-order and duplicate-instant observations are rejected because the
 * settlement rule reads the list as a timeline; a log that is merely valid
 * JSON but not in order would produce negative or overstated quiet spans.
 */
export function appendObservation(log, observation) {
  invariant(isRecord(log) && Array.isArray(log.observations), "a stamp log needs an observations array");
  invariant(
    log.meta?.schema_version === STAMP_LOG_SCHEMA_VERSION,
    `stamp log must be schema ${STAMP_LOG_SCHEMA_VERSION}, not ${JSON.stringify(log.meta?.schema_version)}`,
  );
  invariant(isRecord(observation) && isRecord(observation.stamps), "an observation needs a stamps object");
  // One log is one election. Appending another election's stamps would build a
  // timeline whose "the stamp did not move" conclusion compares two different
  // ballots, which is the one way this file could be wrong and still look fine.
  invariant(
    observation.election === log.meta.election?.vendor_key,
    `this log observes election ${JSON.stringify(log.meta.election?.vendor_key)}, not ${JSON.stringify(observation.election)}`,
  );
  const observedAt = instant(observation.observed_at, "observation observed_at");
  const previous = log.observations.at(-1);
  if (previous) {
    invariant(
      observedAt > instant(previous.observed_at, "the previous observation's observed_at"),
      `an observation at ${observation.observed_at} does not follow the last one at ${previous.observed_at}`,
    );
  }
  for (const [countyId, stamp] of Object.entries(observation.stamps)) {
    instant(stamp, `${countyId}'s observed stamp`);
  }
  return {
    ...log,
    meta: { ...log.meta, observations: log.observations.length + 1 },
    observations: [...log.observations, observation],
  };
}

/** Every recorded sighting of one county's stamp, oldest first. */
function sightings(log, countyId, extra = []) {
  const recorded = log.observations
    .filter((observation) => observation.stamps[countyId])
    .map((observation) => ({
      observed_at: observation.observed_at,
      stamp: observation.stamps[countyId],
      from: observation.source ?? "survey",
    }));
  return [...recorded, ...extra].sort((a, b) => instant(a.observed_at, "observed_at") - instant(b.observed_at, "observed_at"));
}

/**
 * Decides one county, optionally counting a later sighting the caller already
 * has in hand.
 *
 * An ingest is itself an observation of the stamp, and a more authoritative
 * one than any survey because it is the stamp attached to the data that would
 * actually be published. Passing it as `alongside` closes the window between
 * the last survey and the walk, so a board that edited in that gap is caught.
 *
 * Statuses:
 *   settled      two or more agreeing sightings spanning at least quietHours
 *   unsettled    the stamp agrees but not yet across a long enough span
 *   moving       the newest sighting disagrees with the one before it
 *   seen-once    one sighting, so no evidence either way yet
 *   unobserved   no sighting carries a stamp
 *   inconsistent the stamp moved backwards, which it is not supposed to do
 *
 * "seen-once" is deliberately not folded into "moving". On a first survey run
 * every county has one sighting, and a report calling all 70 of them "moving"
 * would say every board in Ohio is mid-edit when it has told us nothing at all.
 */
export function settleCounty(log, countyId, { quietHours = DEFAULT_QUIET_HOURS, alongside = [] } = {}) {
  invariant(Number.isFinite(quietHours) && quietHours >= 0, `quietHours must be a nonnegative number, not ${JSON.stringify(quietHours)}`);
  const observed = sightings(log, countyId, alongside);
  if (observed.length === 0) {
    return { county_id: countyId, status: "unobserved", detail: "no observation recorded a stamp for this county" };
  }

  const latest = observed.at(-1);
  const latestStamp = instant(latest.stamp, `${countyId}'s newest stamp`);

  // Walk back through the agreeing run. Stopping at the first disagreement is
  // what makes the span mean "unchanged throughout" rather than "equal at both
  // ends", which a revert would otherwise satisfy.
  let first = observed.length - 1;
  while (first > 0 && observed[first - 1].stamp === latest.stamp) first -= 1;

  const earlier = observed.slice(0, first);
  const regressed = earlier.find((sighting) => instant(sighting.stamp, `${countyId}'s stamp`) > latestStamp);
  if (regressed) {
    return {
      county_id: countyId,
      status: "inconsistent",
      stamp: latest.stamp,
      detail:
        `the stamp was ${regressed.stamp} on ${regressed.observed_at} and is now the earlier ${latest.stamp}; ` +
        "a last-updated stamp is not supposed to move backwards",
      sightings: observed,
    };
  }

  const agreeing = observed.slice(first);
  // The span is measured between the sightings, not between the stamps. How
  // old the stamp is says nothing; how long we have watched it not move does.
  const spanHours = Number(
    ((instant(latest.observed_at, "observed_at") - instant(agreeing[0].observed_at, "observed_at")) / 3_600_000).toFixed(1),
  );
  const base = {
    county_id: countyId,
    stamp: latest.stamp,
    agreeing_sightings: agreeing.length,
    agreed_since: agreeing[0].observed_at,
    quiet_hours: spanHours,
    required_quiet_hours: quietHours,
    sightings: observed,
  };

  if (agreeing.length < 2) {
    return observed.length === 1
      ? {
          ...base,
          status: "seen-once",
          detail: `the stamp has been seen once, at ${latest.observed_at}; one more sighting decides it`,
        }
      : {
          ...base,
          status: "moving",
          detail: `the stamp changed to ${latest.stamp} at the newest sighting, so the board is still editing`,
        };
  }
  if (spanHours < quietHours) {
    return {
      ...base,
      status: "unsettled",
      detail: `the stamp has held for ${spanHours}h, short of the ${quietHours}h this gate requires`,
    };
  }
  return {
    ...base,
    status: "settled",
    detail: `the stamp has been ${latest.stamp} across ${agreeing.length} observations spanning ${spanHours}h`,
  };
}

/** Decides every county the log has ever surveyed. */
export function settlement(log, { quietHours = DEFAULT_QUIET_HOURS } = {}) {
  const countyIds = new Set();
  for (const observation of log.observations) {
    for (const countyId of observation.surveyed ?? Object.keys(observation.stamps)) countyIds.add(countyId);
  }
  const counties = {};
  for (const countyId of [...countyIds].sort()) {
    counties[countyId] = settleCounty(log, countyId, { quietHours });
  }
  return counties;
}

/**
 * The publication gate. Throws unless this county's stamp is settled *and* the
 * settled stamp is the one the data being published was walked at.
 *
 * Both halves are load-bearing. Settlement alone would pass a county whose
 * board edited after the walk: the new stamp can go on to settle perfectly
 * well while the data in hand is a ballot nobody publishes any more.
 *
 * The walk may sit anywhere in the timeline, not only at the end. A survey
 * taken after the walk that still reports the same stamp is evidence *for*
 * that walk, because the stamp only moves forward -- so an unchanged stamp
 * means the captured ballot is still the current one.
 */
export function assertSettled(log, { countyId, stamp, observedAt, quietHours = DEFAULT_QUIET_HOURS }) {
  invariant(typeof stamp === "string" && stamp, `${countyId} needs the stamp its data was walked at`);
  const alongside = [{ observed_at: new Date(instant(observedAt, `${countyId}'s walk time`)).toISOString(), stamp, from: "ingest" }];
  const result = settleCounty(log, countyId, { quietHours, alongside });
  invariant(result.status === "settled", `${countyId} is not settled: ${result.detail}`);
  invariant(
    result.stamp === stamp,
    `${countyId} settled at ${result.stamp}, but the data in hand was walked at the superseded ${stamp}`,
  );
  return result;
}
