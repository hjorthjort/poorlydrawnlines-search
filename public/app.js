const fieldLabels = new Map([
  ["titleText", "Title"],
  ["comicText", "Comic"],
  ["metadataText", "Metadata"]
]);

const fieldWeights = new Map([
  ["titleText", 5],
  ["comicText", 3],
  ["metadataText", 1]
]);

const queryInput = document.querySelector("#query");
const searchForm = document.querySelector("#searchForm");
const filterInputs = Array.from(document.querySelectorAll("input[name='field']"));
const resultsElement = document.querySelector("#results");
const resultCountElement = document.querySelector("#resultCount");
const indexMetaElement = document.querySelector("#indexMeta");
const resultLimitElement = document.querySelector("#resultLimit");
const sortOrderElement = document.querySelector("#sortOrder");
const paginationTopElement = document.querySelector("#paginationTop");
const paginationBottomElement = document.querySelector("#paginationBottom");
const template = document.querySelector("#resultTemplate");

let index = null;
let normalizedComics = [];
let currentPage = 1;
let lastSearchKey = "";

init();

async function init() {
  try {
    const response = await fetch("/data/search-index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Index request failed with ${response.status}`);
    index = await response.json();
    normalizedComics = index.comics.map((comic) => ({
      ...comic,
      normalized: {
        titleText: normalize(comic.titleText || comic.title),
        comicText: normalize(comic.comicText),
        metadataText: normalize(comic.metadataText)
      }
    }));
    indexMetaElement.textContent =
      `${index.totalIndexedComics.toLocaleString()} of ${index.totalArchiveComics.toLocaleString()} indexed`;
    runSearch();
  } catch (error) {
    indexMetaElement.textContent = "Index unavailable";
    resultCountElement.textContent = "No index";
    resultsElement.innerHTML = `<div class="empty">Run npm run scrape:sample first.</div>`;
    console.error(error);
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});

queryInput.addEventListener("input", debounce(() => runSearch({ resetPage: true }), 120));
resultLimitElement.addEventListener("change", () => runSearch({ resetPage: true }));
sortOrderElement.addEventListener("change", () => runSearch({ resetPage: true }));

filterInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!selectedFields().length) input.checked = true;
    runSearch({ resetPage: true });
  });
});

function runSearch({ resetPage = false } = {}) {
  if (!index) return;

  const query = queryInput.value.trim();
  const fields = selectedFields();
  const limit = Number(resultLimitElement.value);
  const sortOrder = sortOrderElement.value;
  const searchKey = JSON.stringify({ query, fields, limit, sortOrder });
  if (resetPage || searchKey !== lastSearchKey) currentPage = 1;
  lastSearchKey = searchKey;

  const parsedQuery = parseQuery(query);
  const scored = parsedQuery.clauses.length ? search(parsedQuery, fields, sortOrder) : recent(fields);
  const totalPages = limit > 0 ? Math.max(1, Math.ceil(scored.length / limit)) : 1;
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = limit > 0 ? (currentPage - 1) * limit : 0;
  const end = limit > 0 ? start + limit : scored.length;
  const visible = scored.slice(start, end);

  renderResults(visible, scored.length, parsedQuery, { start, limit, totalPages });
}

function search(parsedQuery, fields, sortOrder) {
  const results = normalizedComics
    .map((comic) => {
      const matches = new Set();
      let score = 0;
      let allClausesMatched = true;

      for (const clause of parsedQuery.clauses) {
        let clauseMatched = false;
        for (const field of fields) {
          const haystack = comic.normalized[field] || "";
          if (!haystack) continue;
          const count = countClauseOccurrences(haystack, clause);
          if (count === 0) continue;

          clauseMatched = true;
          matches.add(field);
          const fieldWeight = fieldWeights.get(field) || 1;
          const clauseWeight = clause.type === "phrase" ? 18 : 8;
          score += (clauseWeight + Math.min(count, 8) * 2) * fieldWeight;
        }

        if (!clauseMatched) {
          allClausesMatched = false;
          break;
        }
      }

      if (!allClausesMatched) return null;

      const combinedHaystack = fields.map((field) => comic.normalized[field] || "").join(" ");
      if (parsedQuery.normalized && combinedHaystack.includes(parsedQuery.normalized)) {
        score += 18 + parsedQuery.normalized.length / 6;
      }

      if (score === 0) return null;
      return {
        comic,
        score: score + recencyBoost(comic.date),
        matches: Array.from(matches)
      };
    })
    .filter(Boolean);

  if (sortOrder === "recent") {
    return results.sort((left, right) => compareDateDesc(left.comic.date, right.comic.date));
  }
  return results.sort((left, right) => right.score - left.score || compareDateDesc(left.comic.date, right.comic.date));
}

function recent(fields) {
  return normalizedComics
    .filter((comic) => fields.some((field) => comic.normalized[field]))
    .slice()
    .sort((left, right) => compareDateDesc(left.date, right.date))
    .map((comic) => ({ comic, score: 0, matches: fields.filter((field) => comic.normalized[field]) }));
}

function renderResults(results, total, parsedQuery, { start, limit, totalPages }) {
  resultsElement.replaceChildren();
  const hasQuery = Boolean(parsedQuery.normalized);
  const noun = hasQuery ? (total === 1 ? "match" : "matches") : "available";
  const totalText = `${total.toLocaleString()} ${noun}`;
  const pageText = limit > 0 && total > 0 ? `, ${start + 1}-${Math.min(start + limit, total).toLocaleString()}` : "";
  resultCountElement.textContent = `${totalText}${pageText}`;
  renderPagination(totalPages);

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = hasQuery ? "No matches" : "No indexed comics";
    resultsElement.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const result of results) {
    const node = template.content.firstElementChild.cloneNode(true);
    const image = node.querySelector("img");
    node.href = result.comic.url;
    image.src = `/${result.comic.thumbnail}`;
    image.alt = "";
    node.querySelector(".resultTitle").textContent = result.comic.title || result.comic.slug;
    node.querySelector(".resultDate").textContent = formatDate(result.comic.date, result.comic.dateLabel);
    node.querySelector(".resultSnippet").textContent = bestSnippet(result.comic, result.matches, parsedQuery);

    const badges = node.querySelector(".badges");
    badges.replaceChildren(
      ...result.matches.map((field) => {
        const badge = document.createElement("span");
        badge.className = `badge ${field}`;
        badge.textContent = fieldLabels.get(field);
        return badge;
      })
    );

    fragment.append(node);
  }
  resultsElement.append(fragment);
}

function bestSnippet(comic, matches, parsedQuery) {
  const fields = matches.length ? matches : ["comicText", "titleText", "metadataText"];
  const firstNeedle = parsedQuery.clauses[0]?.value || "";

  for (const field of fields) {
    const text = comic[field] || (field === "titleText" ? comic.title : "");
    const snippet = snippetAround(text, firstNeedle);
    if (snippet) return snippet;
  }

  return comic.comicText || comic.metadataText || comic.title || "";
}

function snippetAround(text, normalizedNeedle) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (!normalizedNeedle) return truncate(raw, 132);

  const normalizedRaw = normalize(raw);
  const index = normalizedRaw.indexOf(normalizedNeedle);
  if (index === -1) return truncate(raw, 132);

  const approxStart = Math.max(0, index - 48);
  const approxEnd = Math.min(raw.length, index + normalizedNeedle.length + 84);
  const prefix = approxStart > 0 ? "..." : "";
  const suffix = approxEnd < raw.length ? "..." : "";
  return `${prefix}${raw.slice(approxStart, approxEnd).trim()}${suffix}`;
}

function truncate(text, length) {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 3).trim()}...`;
}

function renderPagination(totalPages) {
  for (const element of [paginationTopElement, paginationBottomElement]) {
    element.replaceChildren(...(totalPages > 1 ? pageControls(currentPage, totalPages) : []));
    element.classList.toggle("visible", totalPages > 1);
  }
}

function pageControls(page, totalPages) {
  const controls = [];
  controls.push(pageButton("‹", page - 1, "Previous page", page === 1));

  for (const item of pageList(page, totalPages)) {
    if (item === "gap") {
      const gap = document.createElement("span");
      gap.className = "pageGap";
      gap.textContent = "...";
      controls.push(gap);
      continue;
    }
    controls.push(pageButton(String(item), item, `Page ${item}`, false, item === page));
  }

  controls.push(pageButton("›", page + 1, "Next page", page === totalPages));
  return controls;
}

function pageButton(label, page, ariaLabel, disabled, current = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pageButton";
  button.textContent = label;
  button.disabled = disabled;
  button.setAttribute("aria-label", ariaLabel);
  if (current) button.setAttribute("aria-current", "page");
  button.addEventListener("click", () => {
    currentPage = page;
    runSearch();
    resultsElement.scrollIntoView({ block: "start" });
  });
  return button;
}

function pageList(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const pages = new Set([1, totalPages, page, page - 1, page + 1]);
  if (page <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (page >= totalPages - 2) {
    pages.add(totalPages - 1);
    pages.add(totalPages - 2);
    pages.add(totalPages - 3);
  }

  const sorted = Array.from(pages)
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((left, right) => left - right);

  return sorted.flatMap((value, index) => {
    if (index === 0 || value === sorted[index - 1] + 1) return [value];
    return ["gap", value];
  });
}

function selectedFields() {
  return filterInputs.filter((input) => input.checked).map((input) => input.value);
}

function parseQuery(query) {
  const clauses = [];
  const quotedPattern = /"([^"]+)"/g;
  let withoutQuoted = query;
  let match = quotedPattern.exec(query);

  while (match) {
    const phrase = normalize(match[1]);
    if (phrase) clauses.push({ type: "phrase", value: phrase });
    match = quotedPattern.exec(query);
  }

  withoutQuoted = withoutQuoted.replace(quotedPattern, " ");
  for (const term of tokenize(withoutQuoted)) {
    clauses.push({ type: "term", value: term });
  }

  return {
    clauses,
    normalized: normalize(query.replace(/"/g, " "))
  };
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalize(value)
    .split(" ")
    .filter((term) => term.length > 1);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function countClauseOccurrences(haystack, clause) {
  if (clause.type === "term") return countOccurrences(haystack, clause.value);

  const paddedHaystack = ` ${haystack} `;
  const paddedNeedle = ` ${clause.value} `;
  return countOccurrences(paddedHaystack, paddedNeedle);
}

function recencyBoost(date) {
  if (!date) return 0;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? Math.max(0, year - 2011) / 100 : 0;
}

function compareDateDesc(left, right) {
  return String(right || "").localeCompare(String(left || ""));
}

function formatDate(date, fallback) {
  if (!date) return fallback || "";
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return fallback || date;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function debounce(fn, waitMs) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}
