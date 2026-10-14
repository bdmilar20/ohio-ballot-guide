import {
  daysUntilElection,
  isZipQuery,
  racesForCounty,
  resolveLocation,
  upcomingElections,
} from "./src/lookup.mjs";

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
const countyChoice = document.querySelector("#county-choice");
const countyChoicePrompt = document.querySelector("#county-choice-prompt");
const countyOptions = document.querySelector("#county-options");
const issueSection = document.querySelector("#issue-section");
const issueKicker = document.querySelector("#issue-kicker");
const issuesContainer = document.querySelector("#issues");
const raceTemplate = document.querySelector("#race-template");
const toggleRaces = document.querySelector("#toggle-races");
const newSearch = document.querySelector("#new-search");
const reviewDate = document.querySelector("#review-date");
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
  for (const candidate of race.candidates) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const party = document.createElement("span");
    name.className = "candidate-name";
    party.className = "party";
    name.textContent = candidate.name;
    party.textContent = candidate.party;
    item.append(name, party);
    list.append(item);
  }

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
  const weekdayYear = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date).replace(",", " ·");
  const daysAway = daysUntilElection(activeElection.date);

  heroElectionDate.textContent = `${displayDate(activeElection.date)} · Ohio`;
  dateCardLabel.textContent = daysAway === 0 ? "Election today" : `Next election · ${daysAway} days`;
  dateMonth.textContent = month;
  dateDay.textContent = day;
  dateWeekdayYear.textContent = weekdayYear;
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

function showCounty(countyId) {
  const county = data.counties[countyId];
  const races = racesForCounty(countyId, activeElection.counties);
  countyChoice.hidden = true;
  localSection.hidden = races.length === 0;

  if (races.length === 0) {
    setNotice(
      `${county.name} coverage is not available yet.`,
      "The statewide guide is ready below. Use the official sample-ballot link for your exact local contests.",
    );
    return;
  }

  localTitle.textContent = `${county.name} contests`;
  renderRaces(localContainer, races);
  setNotice(
    "Approximate location.",
    `This match points to ${county.name}. City boundaries can cross district lines, so verify your precinct with the official sample-ballot link below.`,
  );
}

function renderCountyChoice(location) {
  const counties = location.county_ids.map((countyId) => ({
    id: countyId,
    ...data.counties[countyId],
  }));
  countyChoicePrompt.textContent = `${location.display_name} crosses county lines. Choose your county to view pilot coverage:`;
  countyOptions.replaceChildren(
    ...counties.map((county) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = county.name;
      button.addEventListener("click", () => showCounty(county.id));
      return button;
    }),
  );
  countyChoice.hidden = false;
}

function showGuide(query) {
  if (!data || !activeElection) {
    dataStatus.hidden = false;
    dataStatus.textContent = "Election data is still loading. Please try again in a moment.";
    return;
  }

  const location = resolveLocation(query, data.locations);
  const zipSearch = isZipQuery(query);
  resultKicker.textContent = location ? `${location.display_name} match` : "Statewide guide";
  resultSummary.textContent = location
    ? `Showing the next scheduled election and the coverage available for ${location.display_name}.`
    : `We do not have a local pilot match for “${query.trim()}” yet. The statewide guide is available below.`;

  countyChoice.hidden = true;
  localSection.hidden = true;

  if (!location) {
    setNotice(
      "Local coverage is still growing.",
      "The pilot currently includes Franklin, Cuyahoga, and Hamilton counties. Statewide contests apply throughout Ohio.",
    );
  } else if (zipSearch) {
    setNotice(
      "ZIP codes do not define ballot boundaries.",
      "County races stay hidden for ZIP-only searches because one ZIP can cross county lines. Use the official sample-ballot link below for your exact local contests.",
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

try {
  const response = await fetch("./data/elections.json");
  if (!response.ok) throw new Error(`Data request failed (${response.status})`);
  data = await response.json();
  scheduledElections = upcomingElections(data.elections);
  activeElection = scheduledElections[0];
  reviewDate.textContent = displayDate(data.meta.last_reviewed);

  if (!activeElection) {
    heroElectionDate.textContent = "No upcoming election published";
    dataStatus.textContent = "No upcoming election data is published yet. Check Ohio’s official voting schedule for current dates.";
  } else {
    renderElectionOverview();
    dataStatus.hidden = true;
    setControlsDisabled(false);
  }
} catch (error) {
  dataStatus.hidden = false;
  dataStatus.textContent = "Election data could not be loaded. Please try again later.";
  setControlsDisabled(true);
  console.error(error);
}
