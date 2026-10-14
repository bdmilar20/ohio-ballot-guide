import { racesForLocation, resolveLocation } from "./src/lookup.mjs";

const form = document.querySelector("#location-form");
const input = document.querySelector("#location");
const results = document.querySelector("#results");
const resultKicker = document.querySelector("#result-kicker");
const resultSummary = document.querySelector("#result-summary");
const coverageNotice = document.querySelector("#coverage-notice");
const statewideContainer = document.querySelector("#statewide-races");
const localContainer = document.querySelector("#local-races");
const localSection = document.querySelector("#local-section");
const localTitle = document.querySelector("#local-title");
const issuesContainer = document.querySelector("#issues");
const raceTemplate = document.querySelector("#race-template");
const toggleRaces = document.querySelector("#toggle-races");
const newSearch = document.querySelector("#new-search");
const reviewDate = document.querySelector("#review-date");

let data;

function displayDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function renderRace(race, index = 0) {
  const node = raceTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.secondary = String(index >= 3);
  node.querySelector(".race-scope").textContent = race.scope;
  node.querySelector("h3").textContent = race.office;

  const source = node.querySelector(".race-source");
  source.href = race.source_url;
  source.setAttribute("aria-label", `Official source for ${race.office}`);

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

function renderRaces(container, races) {
  container.replaceChildren(...races.map(renderRace));
}

function renderIssues(issues) {
  const cards = issues.map((issue) => {
    const article = document.createElement("article");
    article.className = "issue-card";

    const heading = document.createElement("div");
    heading.innerHTML = `<span class="issue-label">${issue.label}</span><h3>${issue.title}</h3>`;

    const copy = document.createElement("div");
    const description = document.createElement("p");
    const source = document.createElement("a");
    description.textContent = issue.summary;
    source.href = issue.source_url;
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = "Read the official ballot language ↗";
    copy.append(description, source);
    article.append(heading, copy);
    return article;
  });

  issuesContainer.replaceChildren(...cards);
}

function showGuide(query) {
  const location = resolveLocation(query, data.locations);
  const localRaces = racesForLocation(location, data.counties);

  resultKicker.textContent = location ? `${location.county_name} match` : "Statewide guide";
  resultSummary.textContent = location
    ? `Showing statewide contests and the countywide pilot contest for ${location.display_name}.`
    : `We do not have local pilot data for “${query.trim()}” yet, but the statewide guide is available below.`;

  coverageNotice.innerHTML = location
    ? `<strong>Approximate location.</strong> City and ZIP searches can cross district lines. This match points to ${location.county_name}; verify your precinct with the official sample-ballot link below.`
    : `<strong>Local coverage is still growing.</strong> The pilot currently includes Franklin, Cuyahoga, and Hamilton counties. Statewide contests apply throughout Ohio.`;

  renderRaces(statewideContainer, data.statewide_races);
  renderIssues(data.issues);

  localSection.hidden = localRaces.length === 0;
  if (localRaces.length > 0) {
    localTitle.textContent = `${location.county_name} contest`;
    renderRaces(localContainer, localRaces);
  }

  toggleRaces.setAttribute("aria-expanded", "false");
  toggleRaces.textContent = "Show all contests";
  statewideContainer.classList.remove("show-all");
  results.hidden = false;
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  showGuide(input.value);
});

for (const quickPick of document.querySelectorAll("[data-location]")) {
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
  window.scrollTo({ top: Math.max(0, input.getBoundingClientRect().top + window.scrollY - 160), behavior: "smooth" });
});

try {
  const response = await fetch("./data/elections.json");
  if (!response.ok) throw new Error(`Data request failed (${response.status})`);
  data = await response.json();
  reviewDate.textContent = displayDate(data.meta.last_reviewed);
} catch (error) {
  form.querySelector("button").disabled = true;
  resultSummary.textContent = "Election data could not be loaded. Please try again later.";
  console.error(error);
}
