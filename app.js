import {
  countiesWithContests,
  daysUntilElection,
  hasPublishedBallotDetails,
  partitionCandidates,
  racesForCounty,
  resolveLocation,
  upcomingElections,
} from "./src/lookup.mjs";

const OFFICIAL_VOTING_SCHEDULE_URL =
  "https://www.ohiosos.gov/elections/voting-schedule-text-only";

const form = document.querySelector("#location-form");
const input = document.querySelector("#location");
const submitButton = form.querySelector("button[type='submit']");
const quickPicks = [...document.querySelectorAll("[data-location]")];
const dataStatus = document.querySelector("#data-status");
const results = document.querySelector("#results");
const resultKicker = document.querySelector("#result-kicker");
const resultTitle = document.querySelector("#result-title");
const resultSummary = document.querySelector("#result-summary");
const coverageNotice = document.querySelector("#coverage-notice");
const statewideSection = document.querySelector("#statewide-section");
const statewideContainer = document.querySelector("#statewide-races");
const localContainer = document.querySelector("#local-races");
const localSection = document.querySelector("#local-section");
const localTitle = document.querySelector("#local-title");
const localCoverageSummary = document.querySelector("#local-coverage-summary");
const localSource = document.querySelector("#local-source");
const countyChoice = document.querySelector("#county-choice");
const countyChoicePrompt = document.querySelector("#county-choice-prompt");
const countyOptions = document.querySelector("#county-options");
const countyResource = document.querySelector("#county-resource");
const countyResourceLabel = document.querySelector("#county-resource-label");
const countyBoardLink = document.querySelector("#county-board-link");
const issueSection = document.querySelector("#issue-section");
const issueKicker = document.querySelector("#issue-kicker");
const issuesContainer = document.querySelector("#issues");
const raceTemplate = document.querySelector("#race-template");
const toggleRaces = document.querySelector("#toggle-races");
const newSearch = document.querySelector("#new-search");
const reviewDate = document.querySelector("#review-date");
const coverageSummary = document.querySelector("#coverage-summary");
const heroElectionDate = document.querySelector("#hero-election-date");
const dateCard = document.querySelector("#date-card");
const dateCardLabel = document.querySelector("#date-card-label");
const dateMonth = document.querySelector("#date-month");
const dateDay = document.querySelector("#date-day");
const dateWeekdayYear = document.querySelector("#date-weekday-year");
const datePolls = document.querySelector("#date-polls");
const voteDateLink = document.querySelector("#vote-date-link");
const pollHours = document.querySelector("#poll-hours");
const earlyDateLink = document.querySelector("#early-date-link");
const registrationDeadline = document.querySelector("#registration-deadline");
const laterElections = document.querySelector("#later-elections");
const laterElectionList = document.querySelector("#later-election-list");

let data;
let locations;
let offices;
let countyBoards;
let activeElection;
let scheduledElections = [];

function displayDate(value, options = {}) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
    ...options,
  }).format(new Date(`${value}T12:00:00Z`));
}

function setControlsDisabled(disabled) {
  submitButton.disabled = disabled;
  for (const quickPick of quickPicks) quickPick.disabled = disabled;
}

function setNotice(lead, copy) {
  const strong = document.createElement("strong");
  strong.textContent = lead;
  coverageNotice.replaceChildren(strong, document.createTextNode(` ${copy}`));
}

function setHttpsHref(link, value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`Unsafe source URL: ${value}`);
  link.href = url.href;
}

function candidateItem(candidate, { showParty }) {
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.className = "candidate-name";
  name.textContent = candidate.name;
  item.append(name);

  if (showParty) {
    const party = document.createElement("span");
    party.className = "party";
    party.textContent = candidate.party;
    item.append(party);
  }

  return item;
}

// Plain-language description of the office itself, collapsed by default so the
// candidate list stays the first thing a voter reads.
function renderOfficeNote(node, race) {
  const note = node.querySelector(".office-note");
  const office = offices[race.office_id];

  if (!office) return;

  note.querySelector(".office-summary").textContent = office.summary;
  note.querySelector(".office-sources").replaceChildren(
    ...office.sources.map((source) => {
      const link = document.createElement("a");
      setHttpsHref(link, source.url);
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = `${source.label} ↗`;
      return link;
    }),
  );
  note.querySelector(".office-verified").textContent =
    `Office description verified ${displayDate(office.last_verified)}`;
  note.hidden = false;
}

function renderRace(race, index = 0, collapseAfter = Number.POSITIVE_INFINITY) {
  const node = raceTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.secondary = String(index >= collapseAfter);
  node.querySelector(".race-scope").textContent = race.scope;
  node.querySelector("h3").textContent = race.office;

  const sourceGroup = node.querySelector(".race-sources");
  const source = node.querySelector(".race-source");
  setHttpsHref(source, race.source_url);
  source.setAttribute("aria-label", `Official source for ${race.office}`);
  for (const supplemental of race.supplemental_sources ?? []) {
    const link = document.createElement("a");
    link.className = "race-source";
    setHttpsHref(link, supplemental.url);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${supplemental.label} ↗`;
    sourceGroup.append(link);
  }

  const list = node.querySelector(".candidate-list");
  const { onBallot, writeIn } = partitionCandidates(race.candidates);
  for (const candidate of onBallot) {
    list.append(candidateItem(candidate, { showParty: true }));
  }

  if (writeIn.length > 0) {
    const lead = document.createElement("p");
    lead.className = "write-in-lead";
    lead.textContent =
      "Certified write-in candidates. These names are not printed on the ballot — you have to write one in.";

    const writeInList = document.createElement("ul");
    writeInList.className = "candidate-list candidate-list-write-in";
    writeInList.setAttribute("aria-label", `Certified write-in candidates for ${race.office}`);
    for (const candidate of writeIn) {
      writeInList.append(candidateItem(candidate, { showParty: false }));
    }

    list.after(lead, writeInList);
  }

  if (onBallot.length === 0) list.remove();

  renderOfficeNote(node, race);

  node.querySelector(".verified").textContent = `Verified ${displayDate(race.last_verified)}`;
  return node;
}

function renderRaces(container, races, collapseAfter = Number.POSITIVE_INFINITY) {
  container.replaceChildren(
    ...races.map((race, index) => renderRace(race, index, collapseAfter)),
  );
}

function renderIssues(issues) {
  const cards = issues.map((issue) => {
    const article = document.createElement("article");
    article.className = "issue-card";

    const heading = document.createElement("div");
    const label = document.createElement("span");
    const title = document.createElement("h3");
    label.className = "issue-label";
    label.textContent = issue.label;
    title.textContent = issue.title;
    heading.append(label, title);

    const copy = document.createElement("div");
    const description = document.createElement("p");
    const source = document.createElement("a");
    const verified = document.createElement("p");
    description.textContent = issue.summary;
    setHttpsHref(source, issue.source_url);
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = "Read the official ballot language ↗";
    verified.className = "verified";
    verified.textContent = `Verified ${displayDate(issue.last_verified)}`;
    copy.append(description, source, verified);
    article.append(heading, copy);
    return article;
  });

  issuesContainer.replaceChildren(...cards);
}

function renderElectionOverview() {
  const date = new Date(`${activeElection.date}T12:00:00Z`);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", { day: "2-digit", timeZone: "UTC" }).format(date);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(date);
  const year = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const daysAway = daysUntilElection(activeElection.date);
  const timingLabel =
    activeElection.scope === "statewide" ? "Next election" : "Next scheduled date";

  heroElectionDate.textContent = `${displayDate(activeElection.date)} · Ohio`;
  dateCardLabel.textContent =
    daysAway === 0 ? "Scheduled election date" : `${timingLabel} · ${daysAway} days`;
  dateMonth.textContent = month;
  dateDay.textContent = day;
  dateWeekdayYear.textContent = `${weekday} · ${year}`;
  datePolls.textContent = `${activeElection.polls.open}–${activeElection.polls.close}`;
  dateCard.hidden = false;

  resultTitle.textContent = activeElection.name;
  voteDateLink.textContent = displayDate(activeElection.date, {
    weekday: "long",
    year: undefined,
  });
  setHttpsHref(voteDateLink, activeElection.official_info_url);
  pollHours.textContent = `Polls: ${activeElection.polls.open}–${activeElection.polls.close}`;
  earlyDateLink.textContent = `Through ${displayDate(activeElection.early_voting_end, { year: undefined })}`;
  setHttpsHref(earlyDateLink, activeElection.official_info_url);
  registrationDeadline.textContent = displayDate(activeElection.registration_deadline, { year: undefined });
  setHttpsHref(registrationDeadline, activeElection.official_info_url);

  statewideSection.hidden = activeElection.statewide_races.length === 0;
  toggleRaces.hidden = activeElection.statewide_races.length <= 3;
  renderRaces(statewideContainer, activeElection.statewide_races, 3);
  issueSection.hidden = activeElection.issues.length === 0;
  issueKicker.textContent = activeElection.scope === "statewide" ? "On every Ohio ballot" : "Ballot questions";
  renderIssues(activeElection.issues);

  const later = scheduledElections.slice(1);
  laterElections.hidden = later.length === 0;
  laterElectionList.replaceChildren(
    ...later.map((election) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const dateText = document.createElement("span");
      name.textContent = election.name;
      dateText.textContent = displayDate(election.date);
      item.append(name, dateText);
      return item;
    }),
  );
}

function countyNames(countyIds) {
  const names = countyIds.map((countyId) => locations.counties[countyId].name.replace(/ County$/, ""));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function renderCoverageSummary() {
  const curated = countiesWithContests(activeElection);
  const counts = locations.meta.counts;
  const countyCount = Object.keys(locations.counties).length;
  const number = (value) => value.toLocaleString("en-US");

  coverageSummary.textContent = [
    `Every Ohio location resolves to a county: ${number(counts.zips)} ZIP codes and`,
    `${number(counts.places)} place names across all ${countyCount} counties.`,
    curated.length > 0
      ? `Selected countywide contests are verified for ${countyNames(curated)} so far, and statewide contests apply everywhere.`
      : "Statewide contests apply everywhere; countywide contests are not verified yet.",
    "It does not predict an exact ballot.",
  ].join(" ");
}

function showCountyResource(countyId) {
  const county = locations.counties[countyId];
  countyResourceLabel.textContent = `${county.name} election office`;
  setHttpsHref(countyBoardLink, countyBoards[countyId]);
  countyBoardLink.setAttribute("aria-label", `Open the official ${county.name} Board of Elections website`);
  countyResource.hidden = false;
}

function showCounty(countyId) {
  const county = locations.counties[countyId];
  const countyElection = activeElection.counties[countyId];
  const races = racesForCounty(countyId, activeElection.counties);
  countyChoice.hidden = true;
  showCountyResource(countyId);
  localSection.hidden = races.length === 0;

  if (races.length === 0) {
    const curated = countiesWithContests(activeElection);
    setNotice(
      `${county.name} contests are not verified yet.`,
      curated.length > 0
        ? `Selected countywide contests are verified so far for ${countyNames(curated)}. Statewide contests and the published schedule are below — use the official sample-ballot link for your exact local contests.`
        : "The published election schedule is ready below. Use the official sample-ballot link for your exact local contests.",
    );
    return;
  }

  localTitle.textContent = `${county.name} contests`;
  localCoverageSummary.textContent = `${countyElection.coverage.scope}. ${countyElection.coverage.summary}`;
  setHttpsHref(localSource, countyElection.coverage.source_url);
  localSource.setAttribute("aria-label", `Review the full official candidate list for ${county.name}`);
  renderRaces(localContainer, races);
  const hasPartialCoverage = countyElection.coverage.status === "partial";
  setNotice(
    hasPartialCoverage ? "Approximate location and partial coverage." : "Approximate location.",
    hasPartialCoverage
      ? `This match points to ${county.name}. The county section contains ${races.length} selected, verified countywide ${races.length === 1 ? "contest" : "contests"}, not a complete ballot. Verify your precinct with the official sample-ballot link below.`
      : `This match points to ${county.name}. The county section covers every verified countywide contest in the official list, but it is not a complete precinct ballot. Verify your precinct with the official sample-ballot link below.`,
  );
}

function renderCountyChoice(location, selectCounty = showCounty) {
  const counties = location.county_ids.map((countyId) => ({
    id: countyId,
    ...locations.counties[countyId],
  }));
  countyChoicePrompt.textContent =
    location.kind === "zip"
      ? `ZIP ${location.display_name} crosses county lines. Choose your county:`
      : `${location.display_name} addresses fall in more than one county. Choose your county:`;
  countyOptions.replaceChildren(
    ...counties.map((county) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = county.name;
      button.addEventListener("click", () => selectCounty(county.id));
      return button;
    }),
  );
  countyChoice.hidden = false;
}

function showGuide(query) {
  if (!data || !locations || !offices || !countyBoards) {
    dataStatus.hidden = false;
    dataStatus.textContent = "Election data is still loading. Please try again in a moment.";
    return;
  }

  if (!activeElection) {
    dataStatus.hidden = false;
    dataStatus.textContent = "No upcoming election data is published yet.";
    return;
  }

  const location = resolveLocation(query, locations);
  const hasBallotDetails = hasPublishedBallotDetails(activeElection);
  resultKicker.textContent = location ? `${location.display_name} match` : "Statewide guide";
  resultSummary.textContent = location
    ? hasBallotDetails
      ? `Showing the next scheduled election and the coverage available for ${location.display_name}.`
      : `Showing the next scheduled election for ${location.display_name}.`
    : `“${query.trim()}” is not an Ohio ZIP code or place name this guide recognizes. ${
        hasBallotDetails ? "The statewide guide" : "The published election schedule"
      } is available below.`;

  countyChoice.hidden = true;
  countyResource.hidden = true;
  localSection.hidden = true;

  if (!hasBallotDetails) {
    setNotice(
      "Ballot details are not published yet.",
      "This date applies only where an election is scheduled. Use the official sample-ballot link below to confirm whether you have an election and see your local contests.",
    );
    if (location?.county_ids.length > 1) {
      renderCountyChoice(location, (countyId) => {
        countyChoice.hidden = true;
        showCountyResource(countyId);
      });
    } else if (location) {
      showCountyResource(location.county_ids[0]);
    }
  } else if (!location) {
    setNotice(
      "No Ohio match for that search.",
      `The guide covers ${locations.meta.counts.zips.toLocaleString("en-US")} Ohio ZIP codes and ${locations.meta.counts.places.toLocaleString("en-US")} Ohio place names, so check the spelling or try your ZIP code. Published statewide contests apply throughout Ohio.`,
    );
  } else if (location.county_ids.length > 1) {
    setNotice(
      "County confirmation needed.",
      `${location.display_name} crosses county lines, so the guide will not assume which county ballot applies to you.`,
    );
    renderCountyChoice(location);
  } else {
    showCounty(location.county_ids[0]);
  }

  toggleRaces.setAttribute("aria-expanded", "false");
  toggleRaces.textContent = "Show all contests";
  statewideContainer.classList.remove("show-all");
  results.hidden = false;
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

setControlsDisabled(true);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  showGuide(input.value);
});

for (const quickPick of quickPicks) {
  quickPick.addEventListener("click", () => {
    input.value = quickPick.dataset.location;
    showGuide(input.value);
  });
}

toggleRaces.addEventListener("click", () => {
  const expanded = toggleRaces.getAttribute("aria-expanded") === "true";
  toggleRaces.setAttribute("aria-expanded", String(!expanded));
  toggleRaces.textContent = expanded ? "Show all contests" : "Show fewer contests";
  statewideContainer.classList.toggle("show-all", !expanded);
});

newSearch.addEventListener("click", () => {
  input.focus();
  window.scrollTo({
    top: Math.max(0, input.getBoundingClientRect().top + window.scrollY - 160),
    behavior: "smooth",
  });
});

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} request failed (${response.status})`);
  return response.json();
}

try {
  [data, locations, offices, countyBoards] = await Promise.all([
    loadJson("./data/elections.json"),
    loadJson("./data/locations.json"),
    loadJson("./data/offices.json").then(({ offices: entries }) => entries),
    loadJson("./data/county-boards.json").then(({ counties }) => counties),
  ]);
  scheduledElections = upcomingElections(data.elections);
  activeElection = scheduledElections[0];
  reviewDate.textContent = displayDate(data.meta.last_reviewed);

  if (!activeElection) {
    heroElectionDate.textContent = "No upcoming election published";
    const scheduleLink = document.createElement("a");
    setHttpsHref(scheduleLink, OFFICIAL_VOTING_SCHEDULE_URL);
    scheduleLink.target = "_blank";
    scheduleLink.rel = "noreferrer";
    scheduleLink.textContent = "Check Ohio’s official voting schedule";
    dataStatus.replaceChildren(
      document.createTextNode("No upcoming election data is published yet. "),
      scheduleLink,
      document.createTextNode(" for current dates."),
    );
  } else {
    renderElectionOverview();
    renderCoverageSummary();
    dataStatus.hidden = true;
    setControlsDisabled(false);
  }
} catch (error) {
  dataStatus.hidden = false;
  dataStatus.textContent = "Election data could not be loaded. Please try again later.";
  setControlsDisabled(true);
  console.error(error);
}
