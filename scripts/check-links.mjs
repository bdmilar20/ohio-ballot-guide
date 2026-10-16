// Resolves every official URL the guide cites and reports the ones that have
// rotted. Run it by hand, never from CI: it drives a real browser and it walks
// www.boe.ohio.gov, which hosts about fifty county board sites and rate-limits
// concurrent callers. See CONTRIBUTING.md.
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

// A board that serves a maintenance page for every path, real or invented,
// cannot tell us anything. These titles mean "ask again later", not "missing".
const CHALLENGE_PATTERN = /just a moment|security verification|attention required|website maintenance/i;
const NAVIGATION_TIMEOUT_MS = 30_000;
// www.boe.ohio.gov answered concurrency 4 with 429s and its maintenance page.
const SLOW_HOST_PATTERN = /(^|\.)boe\.ohio\.gov$/;

export function collectCitations(elections, offices, countyBoards, locations) {
  const citations = [];
  const cite = (url, label) => {
    if (typeof url === "string" && url.length > 0) citations.push({ url, label });
  };

  cite(elections.meta?.source_url, "elections.meta.source_url");
  for (const election of elections.elections) {
    cite(election.official_info_url, `${election.id}.official_info_url`);
    for (const race of election.statewide_races) {
      cite(race.source_url, `${race.id}.source_url`);
      for (const source of race.supplemental_sources ?? []) {
        cite(source.url, `${race.id} — ${source.label}`);
      }
    }
    for (const [countyId, county] of Object.entries(election.counties)) {
      cite(county.coverage?.source_url, `${election.id}/${countyId}.coverage.source_url`);
      for (const race of county.races) {
        cite(race.source_url, `${race.id}.source_url`);
        for (const source of race.supplemental_sources ?? []) {
          cite(source.url, `${race.id} — ${source.label}`);
        }
      }
    }
    for (const issue of election.issues) {
      cite(issue.source_url, `${issue.id}.source_url`);
    }
  }

  cite(offices.meta?.source_url, "offices.meta.source_url");
  for (const [officeId, office] of Object.entries(offices.offices)) {
    for (const source of office.sources ?? []) {
      cite(source.url, `${officeId} — ${source.label}`);
    }
  }

  cite(countyBoards.meta?.source_url, "county-boards.meta.source_url");
  for (const [countyId, url] of Object.entries(countyBoards.counties)) {
    cite(url, `county-boards.${countyId}`);
  }

  // locations.json is generated, but the Census and GeoNames files it is
  // generated from are cited in its meta and rot like anything else. Leaving
  // them out meant the build inputs were the one thing never audited.
  cite(locations?.meta?.source_url, "locations.meta.source_url");
  for (const source of locations?.meta?.sources ?? []) {
    cite(source.url, `locations — ${source.id ?? source.name}`);
  }

  const byUrl = new Map();
  for (const { url, label } of citations) {
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(label);
  }
  return byUrl;
}

// 429 and 5xx say "ask again later", not "gone". The origin never served the
// document, so nothing was read and no control can make the silence mean
// something: an honest 404 on the control proves the origin discriminates, not
// that this URL is dead. Calling these broken is the one mistake this tool
// exists to avoid.
export function isRetryableStatus(status) {
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600);
}

// Pure so the verdict table can be pinned by tests instead of by a live sweep.
export function classify({ status, failure, hasResponse, challenged, byStatus, byMime, byPage }) {
  if (failure && !hasResponse) return "error";
  if (isRetryableStatus(status)) return "unverified";
  if (challenged) return "unverified";
  if (!byStatus && !byMime && !byPage) return "unverified";
  if (typeof status === "number" && status >= 200 && status < 300) return "ok";
  return "broken";
}

// A bogus sibling of the same shape. If this resolves the way the real URL
// does, the origin is not answering questions and a 404 on the real URL would
// mean nothing.
//
// Mutating the last path segment is not always enough. Franklin County serves
// its candidate list from /getmedia/<guid>/<filename>, keyed on the GUID
// alone: change the filename and it returns the identical PDF. Where a GUID is
// present it is the only part worth changing.
const GUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_SUFFIX = "-ohio-ballot-guide-control-404";

export function controlFor(url) {
  const control = new URL(url);
  control.search = "";
  control.hash = "";
  const segments = control.pathname.split("/");

  const guidIndex = segments.findLastIndex((segment) => GUID_SEGMENT.test(segment));
  if (guidIndex !== -1) {
    const guid = segments[guidIndex];
    const last = guid.at(-1);
    segments[guidIndex] = guid.slice(0, -1) + (last === "0" ? "1" : "0");
    control.pathname = segments.join("/");
    return control.toString();
  }

  const last = segments.pop();
  // Only a real file extension moves to the end. Statute paths such as
  // section-3501.04 end in a dot segment that is part of the name.
  const extension = last.match(/\.[a-z]{2,5}$/i);
  if (last === "") {
    segments.push(CONTROL_SUFFIX.slice(1), "");
  } else if (extension) {
    segments.push(`${last.slice(0, -extension[0].length)}${CONTROL_SUFFIX}${extension[0]}`);
  } else {
    segments.push(`${last}${CONTROL_SUFFIX}`);
  }
  control.pathname = segments.join("/");
  return control.toString();
}

// `.filter(Boolean)` already dropped an unset CHROME_PATH, so picking the first
// truthy candidate would always pick the first *path* — on Linux, the macOS
// Google Chrome path that is not there. Only an executable file counts.
export async function findChrome(candidates = CHROME_CANDIDATES) {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      // X_OK on a directory only means "searchable", so it passes for /tmp.
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not installed here; try the next one.
    }
  }
  return null;
}

async function launchChrome() {
  const executablePath = await findChrome();
  if (!executablePath) {
    throw new Error(
      `No Chrome or Chromium executable found. Looked at:\n  ${CHROME_CANDIDATES.join("\n  ")}\nSet CHROME_PATH to a Chrome or Chromium binary.`,
    );
  }
  const userDataDir = await mkdtemp(join(tmpdir(), "obg-check-links-"));
  const chrome = spawn(executablePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ]);

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not report a debugging port")), 20_000);
    let buffered = "";
    chrome.stderr.on("data", (chunk) => {
      buffered += chunk;
      const match = buffered.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    // An unhandled "error" event on a child process throws, so a binary that
    // cannot be executed has to be caught here rather than left to crash.
    chrome.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${executablePath}: ${error.message}`));
    });
    chrome.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with ${code} before reporting a debugging port`));
    });
  }).catch(async (error) => {
    chrome.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  });

  return { chrome, port, userDataDir };
}

async function connect(port) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
  }).then((response) => response.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) {
      for (const listener of listeners) listener(message);
      return;
    }
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    if (message.error) settle.reject(new Error(message.error.message));
    else settle.resolve(message.result);
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  return { send, listeners, close: () => socket.close() };
}

function probeOnce(client, url) {
  return new Promise((resolve) => {
    const redirects = [];
    let documentRequestId = null;
    let response = null;
    let failure = null;

    const finish = () => {
      clearTimeout(timer);
      client.listeners.delete(listener);
      resolve({ response, redirects, failure });
    };

    const listener = (message) => {
      const { method, params } = message;
      if (method === "Network.requestWillBeSent" && params.type === "Document") {
        if (documentRequestId === null || documentRequestId === params.requestId) {
          documentRequestId = params.requestId;
          if (params.redirectResponse) {
            redirects.push({ from: params.redirectResponse.url, status: params.redirectResponse.status });
          }
        }
      }
      if (method === "Network.responseReceived" && params.requestId === documentRequestId) {
        response = {
          status: params.response.status,
          mimeType: params.response.mimeType,
          url: params.response.url,
          length: Number(params.response.headers?.["content-length"] ?? params.response.encodedDataLength ?? 0),
        };
        // A PDF with downloads denied never finishes loading; the response is
        // the answer we came for.
        if (!params.response.mimeType.startsWith("text/html")) finish();
      }
      if (method === "Network.loadingFinished" && params.requestId === documentRequestId) {
        if (response && params.encodedDataLength) response.length = params.encodedDataLength;
        finish();
      }
      if (method === "Network.loadingFailed" && params.requestId === documentRequestId) {
        if (!response) failure = params.errorText;
        finish();
      }
    };

    const timer = setTimeout(() => {
      if (!response) failure = failure ?? "timed out";
      finish();
    }, NAVIGATION_TIMEOUT_MS);

    client.listeners.add(listener);
    client.send("Page.navigate", { url }).catch((error) => {
      failure = error.message;
      finish();
    });
  });
}

// Reads the rendered page, not the raw response. Several official sites are
// single-page apps that serve the same shell for every path and only reveal
// "Number Not Found" after their script runs.
async function describe(client) {
  const evaluate = async (expression) => {
    const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
    return result.result?.value;
  };
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await evaluate("document.readyState === 'complete'")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return JSON.parse(
      (await evaluate(
        "JSON.stringify({ title: document.title, heading: document.querySelector('h1, h2')?.textContent?.trim()?.slice(0, 120) ?? null })",
      )) ?? "{}",
    );
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One retry, because a 429 says "later", not "gone".
async function probe(client, url, pause) {
  let attempt = await probeOnce(client, url);
  let page = attempt.response?.mimeType?.startsWith("text/html") ? await describe(client) : {};
  if (attempt.response?.status === 429) {
    await sleep(Math.max(pause, 1000) * 4);
    attempt = await probeOnce(client, url);
    page = attempt.response?.mimeType?.startsWith("text/html") ? await describe(client) : {};
  }
  return { ...attempt, title: page.title ?? null, heading: page.heading ?? null };
}

// Keeps a copy of a cited PDF so a later review is not hostage to the board's
// uptime. Fetched from inside a page on the same origin, which is the only way
// past bot management on several of these hosts.
async function savePdf(client, url, directory) {
  await client.send("Page.navigate", { url: new URL("/", url).toString() });
  await sleep(1500);
  const result = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));
      }
      return btoa(binary);
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const encoded = result.result?.value;
  if (!encoded) return null;
  const { host, pathname } = new URL(url);
  const segment = pathname.split("/").filter(Boolean).pop() ?? "document";
  const name = `${host}-${segment.endsWith(".pdf") ? segment : `${segment}.pdf`}`;
  const file = join(directory, name);
  await writeFile(file, Buffer.from(encoded, "base64"));
  return file;
}

function describeResult(result, controlProbe) {
  return [
    result.status ?? result.failure,
    result.mimeType,
    result.length ? `${result.length} bytes` : null,
    result.finalUrl ? `\u2192 ${result.finalUrl}` : null,
    result.control.byMime
      ? `control discriminates by content type, not status (control served ${controlProbe.response?.mimeType})`
      : null,
    result.control.byPage
      ? `control discriminates by rendered page, not status (control reads "${controlProbe.heading ?? controlProbe.title}")`
      : null,
    result.verdict === "unverified"
      ? isRetryableStatus(result.status)
        ? `origin answered ${result.status} after a retry, which means later, not gone`
        : result.challenged
          ? `origin is serving a challenge or maintenance page: ${result.title ?? controlProbe.title}`
          : `control returned ${result.control.status ?? "nothing"} with the same page`
      : null,
    result.saved ? `saved ${result.saved}` : null,
  ]
    .filter(Boolean)
    .join("  ");
}

export async function main(argv = process.argv.slice(2)) {
  const flag = (name, fallback) => {
    const match = argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : fallback;
  };
  const delayMs = Number(flag("delay", 1200));
  const slowDelayMs = Number(flag("slow-delay", 2500));
  const only = flag("only", null);
  const saveDir = flag("save", null);

  const root = new URL("..", import.meta.url);
  const read = async (name) => JSON.parse(await readFile(new URL(`data/${name}`, root), "utf8"));
  const citations = collectCitations(
    await read("elections.json"),
    await read("offices.json"),
    await read("county-boards.json"),
    await read("locations.json"),
  );

  const urls = [...citations.keys()]
    .filter((url) => (only ? url.includes(only) : true))
    .sort((a, b) => {
      const byHost = new URL(a).host.localeCompare(new URL(b).host);
      return byHost === 0 ? a.localeCompare(b) : byHost;
    });

  if (urls.length === 0) {
    console.error(only ? `No cited URL matches --only=${only}` : "No cited URLs found");
    process.exit(1);
  }

  console.log(`Checking ${urls.length} cited URL${urls.length === 1 ? "" : "s"} serially.`);
  console.log("This resolves live government sites. Do not run it from CI.\n");

  const { chrome, port, userDataDir } = await launchChrome();
  const client = await connect(port);
  await client.send("Network.enable");
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  if (saveDir) await mkdir(saveDir, { recursive: true });

  const controlResults = new Map();
  const results = [];
  let lastHost = null;

  for (const url of urls) {
    const host = new URL(url).host;
    const pause = SLOW_HOST_PATTERN.test(host) ? slowDelayMs : delayMs;

    if (host !== lastHost) {
      // Loading the origin first lets a bot-management challenge run before
      // the document we actually care about.
      await probeOnce(client, new URL("/", url).toString());
      lastHost = host;
      await sleep(pause);
    }

    const control = controlFor(url);
    if (!controlResults.has(control)) {
      controlResults.set(control, await probe(client, control, pause));
      await sleep(pause);
    }
    const controlProbe = controlResults.get(control);

    const attempt = await probe(client, url, pause);
    await sleep(pause);

    const controlStatus = controlProbe.response?.status ?? null;
    const status = attempt.response?.status ?? null;
    const challenged =
      CHALLENGE_PATTERN.test(attempt.title ?? "") || CHALLENGE_PATTERN.test(controlProbe.title ?? "");
    // A control that 404s proves the origin answers honestly. An origin that
    // serves 200 for an invented path is a soft-404 farm: the only thing left
    // that can discriminate is the rendered page.
    const byStatus = controlStatus !== null && controlStatus >= 400 && controlStatus !== status;
    // Target and control answering with different content types is the only
    // signal left for a PDF, which renders no title to compare.
    const byMime =
      !byStatus &&
      attempt.response?.mimeType != null &&
      controlProbe.response?.mimeType != null &&
      attempt.response.mimeType !== controlProbe.response.mimeType;
    const byPage =
      !byStatus &&
      !byMime &&
      controlStatus !== null &&
      attempt.title !== null &&
      controlProbe.title !== null &&
      (attempt.title !== controlProbe.title || attempt.heading !== controlProbe.heading);

    const verdict = classify({
      status,
      failure: attempt.failure,
      hasResponse: Boolean(attempt.response),
      challenged,
      byStatus,
      byMime,
      byPage,
    });

    const result = {
      url,
      labels: citations.get(url),
      verdict,
      status,
      challenged,
      mimeType: attempt.response?.mimeType ?? null,
      length: attempt.response?.length ?? null,
      finalUrl: attempt.response?.url !== url ? (attempt.response?.url ?? null) : null,
      redirects: attempt.redirects,
      control: { url: control, status: controlStatus, byStatus, byMime, byPage },
      title: attempt.title,
      failure: attempt.failure,
      saved: null,
    };

    if (saveDir && verdict === "ok" && result.mimeType === "application/pdf") {
      result.saved = await savePdf(client, url, saveDir);
      await sleep(pause);
    }

    results.push(result);
    console.log(`${verdict.padEnd(10)} ${url}\n           ${describeResult(result, controlProbe)}`);
  }

  client.close();
  chrome.kill();
  await new Promise((resolve) => chrome.once("exit", resolve));
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});

  const counts = results.reduce((totals, { verdict }) => {
    totals[verdict] = (totals[verdict] ?? 0) + 1;
    return totals;
  }, {});

  console.log("\n--- summary ---");
  for (const verdict of ["ok", "broken", "unverified", "error"]) {
    if (counts[verdict]) console.log(`${verdict.padEnd(10)} ${counts[verdict]}`);
  }

  const broken = results.filter(({ verdict }) => verdict === "broken");
  if (broken.length > 0) {
    console.log("\nBroken, with a control that proves the origin discriminates:");
    for (const result of broken) {
      console.log(`  ${result.status}  ${result.url}`);
      for (const label of result.labels) console.log(`        cited by ${label}`);
    }
  }

  const unverified = results.filter(({ verdict }) => verdict === "unverified");
  if (unverified.length > 0) {
    console.log(`\n${unverified.length} unverified. Unverified is not broken: either the origin`);
    console.log("answered the control the same way it answered the real URL, or it asked us to");
    console.log("come back later. Its status carries no information. Change nothing on that basis.");
  }

  return broken.length > 0 ? 1 : 0;
}

// Importing this file for its helpers must not drive a browser.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await main());
}
