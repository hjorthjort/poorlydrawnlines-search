import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const pageDir = path.join(dataDir, "pages");
const imageDir = path.join(dataDir, "images");
const ocrInputDir = path.join(dataDir, "ocr-input");
const recordDir = path.join(dataDir, "records");
const publicDataDir = path.join(rootDir, "public", "data");
const publicThumbDir = path.join(rootDir, "public", "thumbs");

const archiveUrl = "https://poorlydrawnlines.com/archive/";
const siteOrigin = "https://poorlydrawnlines.com";
const userAgent = "Mozilla/5.0 poorlydrawnlines-search-local-indexer";

const monthNumbers = new Map(
  [
    ["jan", "01"],
    ["january", "01"],
    ["feb", "02"],
    ["february", "02"],
    ["mar", "03"],
    ["march", "03"],
    ["apr", "04"],
    ["april", "04"],
    ["may", "05"],
    ["jun", "06"],
    ["june", "06"],
    ["jul", "07"],
    ["july", "07"],
    ["aug", "08"],
    ["august", "08"],
    ["sep", "09"],
    ["sept", "09"],
    ["september", "09"],
    ["oct", "10"],
    ["october", "10"],
    ["nov", "11"],
    ["november", "11"],
    ["dec", "12"],
    ["december", "12"]
  ]
);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirs();

  const archive = await loadArchive(options);
  const selected = options.latest
    ? archive.entries.slice(-options.latest)
    : archive.entries.slice(options.offset, options.limit ? options.offset + options.limit : undefined);
  const selectedStart = options.latest ? archive.entries.length - selected.length : options.offset;

  console.log(`Archive has ${archive.entries.length} comics across ${archive.pageCount} pages. Processing ${selected.length}.`);

  if (!options.rebuildIndexOnly) {
    await runPool(selected, options.concurrency, async (entry, index) => {
      const processed = await processComic(entry, options);
      const done = selectedStart + index + 1;
      const total = options.limit ? Math.min(options.offset + options.limit, archive.entries.length) : archive.entries.length;
      console.log(
        `${String(done).padStart(5, " ")}/${total} ${processed.id} ` +
          `title:${processed.titleText.length} comic:${processed.comicText.length} meta:${processed.metadataText.length}`
      );
    });
  }

  const records = await loadRecords(archive.entries);
  await writeSearchIndex(archive, records);
  console.log(`Wrote ${records.length} indexed comics to public/data/search-index.json.`);
}

function parseArgs(args) {
  const options = {
    concurrency: 2,
    delayMs: 250,
    limit: 0,
    latest: 0,
    offset: 0,
    refreshPages: false,
    refreshImages: false,
    refreshOcr: false,
    rebuildIndexOnly: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readNumber = (name) => {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} expects a number`);
      }
      i += 1;
      return Number(value);
    };

    if (arg === "--concurrency") options.concurrency = readNumber(arg);
    else if (arg === "--delay-ms") options.delayMs = readNumber(arg);
    else if (arg === "--limit") options.limit = readNumber(arg);
    else if (arg === "--latest") options.latest = readNumber(arg);
    else if (arg === "--offset") options.offset = readNumber(arg);
    else if (arg === "--refresh-pages") options.refreshPages = true;
    else if (arg === "--refresh-images") options.refreshImages = true;
    else if (arg === "--refresh-ocr") options.refreshOcr = true;
    else if (arg === "--rebuild-index-only") options.rebuildIndexOnly = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit must be a non-negative integer");
  }
  if (!Number.isInteger(options.latest) || options.latest < 0) {
    throw new Error("--latest must be a non-negative integer");
  }
  if (options.latest && (options.limit || options.offset)) {
    throw new Error("--latest cannot be combined with --limit or --offset");
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new Error("--offset must be a non-negative integer");
  }

  return options;
}

async function ensureDirs() {
  await Promise.all(
    [dataDir, pageDir, imageDir, ocrInputDir, recordDir, publicDataDir, publicThumbDir].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );
}

async function loadArchive(options) {
  const archivePath = path.join(dataDir, "archive.json");
  if (!options.refreshPages) {
    const cached = await readJsonIfExists(archivePath);
    if (cached?.entries?.length) return cached;
  }

  const firstHtml = await loadArchivePage(1, archiveUrl, options);
  const firstPage = cheerio.load(firstHtml);
  const pageCount = parseLastArchivePage(firstPage) || 1;
  const seen = new Set();
  const newestFirst = parseArchiveEntries(firstPage, 1, seen);

  for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
    const pageUrl = new URL(`/archive/page/${pageNumber}/`, siteOrigin);
    pageUrl.searchParams.set("et_blog", "");
    const html = await loadArchivePage(pageNumber, pageUrl.toString(), options);
    newestFirst.push(...parseArchiveEntries(cheerio.load(html), pageNumber, seen));
  }

  const archive = {
    source: archiveUrl,
    fetchedAt: new Date().toISOString(),
    pageCount,
    count: newestFirst.length,
    entries: newestFirst.reverse()
  };

  await writeJsonAtomic(archivePath, archive);
  return archive;
}

async function loadArchivePage(pageNumber, url, options) {
  const pagePath = path.join(pageDir, `archive-${String(pageNumber).padStart(2, "0")}.html`);
  if (!options.refreshPages && (await exists(pagePath))) {
    return readFile(pagePath, "utf8");
  }

  const html = await fetchText(url, options);
  await writeFileAtomic(pagePath, html);
  return html;
}

function parseLastArchivePage($) {
  const pagesText = squashWhitespace($(".wp-pagenavi .pages").first().text());
  const pagesMatch = /Page\s+\d+\s+of\s+(\d+)/i.exec(pagesText);
  if (pagesMatch) return Number(pagesMatch[1]);

  const hrefPages = $(".wp-pagenavi a")
    .toArray()
    .map((element) => {
      const href = $(element).attr("href") || "";
      const match = /\/archive\/page\/(\d+)\//.exec(href);
      return match ? Number(match[1]) : 0;
    })
    .filter(Boolean);

  return hrefPages.length ? Math.max(...hrefPages) : 0;
}

function parseArchiveEntries($, archivePage, seen) {
  return $(".et_pb_ajax_pagination_container .et_pb_post")
    .toArray()
    .map((element) => parseArchiveEntry($, element, archivePage))
    .filter((entry) => {
      if (!entry || seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    });
}

function parseArchiveEntry($, element, archivePage) {
  const post = $(element);
  const link = post.find("h2 a, .entry-title a, a[href*='/comic/']").first();
  const url = absoluteUrl(link.attr("href"));
  if (!url || !new URL(url).pathname.startsWith("/comic/")) return null;

  const title = cleanTitle(link.text()) || slugTitle(url);
  const image = post.find("img").first();
  const imageUrl = bestImageUrl($, image);
  const dateLabel = squashWhitespace(post.find(".published, time, .post-meta").first().text());
  const slug = comicSlug(url);

  return {
    id: stableId(slug),
    slug,
    url,
    title,
    date: parseDisplayDate(dateLabel),
    dateLabel,
    imageUrl,
    imageAlt: squashWhitespace(image.attr("alt") || ""),
    imageTitle: squashWhitespace(image.attr("title") || ""),
    archivePage
  };
}

async function processComic(entry, options) {
  const recordPath = path.join(recordDir, `${entry.id}.json`);
  const cachedRecord = await readJsonIfExists(recordPath);
  if (cachedRecord && !options.refreshPages && !options.refreshImages && !options.refreshOcr) {
    const thumbnailPath = cachedRecord.thumbnail ? path.join(rootDir, "public", cachedRecord.thumbnail) : "";
    if (cachedRecord.imageUrl === entry.imageUrl && thumbnailPath && (await exists(thumbnailPath))) return cachedRecord;
  }

  if (!entry.imageUrl) {
    throw new Error(`No archive image found for ${entry.url}`);
  }

  const reusableImage = await reusableImageAsset(cachedRecord, entry, options);
  const image = reusableImage
    ? { path: path.join(rootDir, cachedRecord.localImage || ""), url: entry.imageUrl }
    : await downloadComicImage(entry.imageUrl, imageDir, entry.id, options);
  const comicText = reusableImage ? cachedRecord.comicText || "" : await ocrCached(entry.id, image.path, options);
  const thumbnail = reusableImage ? cachedRecord.thumbnail || "" : await writeThumbnail(entry.id, image.path);

  const record = {
    id: entry.id,
    slug: entry.slug,
    url: entry.url,
    title: entry.title,
    date: entry.date,
    dateLabel: entry.dateLabel,
    imageUrl: entry.imageUrl,
    localImage: reusableImage ? cachedRecord.localImage || "" : path.relative(rootDir, image.path),
    thumbnail,
    titleText: cleanTitle(entry.title),
    comicText,
    metadataText: cleanMetadataText([entry.imageAlt, entry.imageTitle].join(" ")),
    updatedAt: new Date().toISOString()
  };

  await writeJsonAtomic(recordPath, record);
  return record;
}

async function reusableImageAsset(cachedRecord, entry, options) {
  if (!cachedRecord || options.refreshImages || options.refreshOcr) return false;
  if (cachedRecord.imageUrl !== entry.imageUrl) return false;
  if (!cachedRecord.thumbnail) return false;
  return exists(path.join(rootDir, "public", cachedRecord.thumbnail));
}

async function downloadComicImage(url, targetDir, basename, options) {
  const extension = extensionFromUrl(url);
  const targetPath = path.join(targetDir, `${basename}${extension}`);

  if (!options.refreshImages && (await exists(targetPath))) {
    return { path: targetPath, url };
  }

  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" }
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType && !contentType.startsWith("image/")) {
    throw new Error(`Expected image for ${url}, got ${contentType}`);
  }
  if (!contentType && !isImageUrl(url)) {
    throw new Error(`Expected image for ${url}, got unknown content type`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFileAtomic(targetPath, buffer);
  return { path: targetPath, url };
}

async function ocrCached(id, imagePath, options) {
  const ocrPath = path.join(dataDir, "ocr", `${id}.txt`);
  await mkdir(path.dirname(ocrPath), { recursive: true });

  if (!options.refreshOcr && (await exists(ocrPath))) {
    return cleanOcr(await readFile(ocrPath, "utf8"));
  }

  const preparedPath = path.join(ocrInputDir, `${id}.png`);
  let text = "";
  let inputForOcr = preparedPath;
  try {
    try {
      await prepareForOcr(imagePath, preparedPath);
    } catch (error) {
      console.warn(`OCR preprocessing failed for ${id}; trying original image. ${firstErrorLine(error)}`);
      inputForOcr = imagePath;
    }
    text = cleanOcr(await runTesseract(inputForOcr));
  } catch (error) {
    console.warn(`OCR failed for ${id}; leaving comic text empty. ${firstErrorLine(error)}`);
  } finally {
    await rm(preparedPath, { force: true });
  }
  await writeFileAtomic(ocrPath, text);
  return text;
}

async function prepareForOcr(inputPath, outputPath) {
  const image = sharp(inputPath, { animated: false, limitInputPixels: false });
  const metadata = await image.metadata();
  const sourceWidth = metadata.width || 1080;
  const targetWidth = sourceWidth < 1800 ? 1800 : sourceWidth;

  await image
    .flatten({ background: "#ffffff" })
    .resize({ width: targetWidth, withoutEnlargement: sourceWidth >= 1800 })
    .grayscale()
    .normalize()
    .sharpen()
    .png({ compressionLevel: 6 })
    .toFile(outputPath);
}

async function runTesseract(imagePath) {
  const args = [
    imagePath,
    "stdout",
    "-l",
    "eng",
    "--oem",
    "1",
    "--psm",
    "11",
    "-c",
    "preserve_interword_spaces=1"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("tesseract", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tesseract exited ${code} for ${imagePath}\n${stderr}`));
    });
  });
}

async function writeThumbnail(id, imagePath) {
  const relativePath = `thumbs/${id}.webp`;
  const targetPath = path.join(rootDir, "public", relativePath);
  if (await exists(targetPath)) return relativePath;

  try {
    await sharp(imagePath, { animated: false, limitInputPixels: false })
      .flatten({ background: "#ffffff" })
      .resize({ width: 220, withoutEnlargement: true })
      .blur(1.1)
      .webp({ quality: 58, effort: 4 })
      .toFile(targetPath);
  } catch (error) {
    console.warn(`Thumbnail generation failed for ${id}; using placeholder. ${firstErrorLine(error)}`);
    await sharp({
      create: {
        width: 220,
        height: 176,
        channels: 3,
        background: "#fff3bf"
      }
    })
      .webp({ quality: 58, effort: 4 })
      .toFile(targetPath);
  }

  return relativePath;
}

async function loadRecords(entries) {
  const previousIndex = await readExistingSearchIndex();
  const previousRecords = new Map((previousIndex?.comics || []).map((comic) => [comic.id, comic]));
  const records = [];
  for (const entry of entries) {
    const record = await readJsonIfExists(path.join(recordDir, `${entry.id}.json`));
    if (record) records.push(record);
    else if (previousRecords.has(entry.id)) records.push(previousRecords.get(entry.id));
  }
  return records;
}

async function readExistingSearchIndex() {
  return (
    (await readJsonIfExists(path.join(publicDataDir, "search-index.json"))) ||
    (await readJsonIfExists(path.join(dataDir, "search-index.json")))
  );
}

async function writeSearchIndex(archive, records) {
  const index = {
    generatedAt: new Date().toISOString(),
    source: archive.source,
    totalArchiveComics: archive.entries.length,
    totalIndexedComics: records.length,
    fields: ["titleText", "comicText", "metadataText"],
    comics: records.map((record) => ({
      id: record.id,
      slug: record.slug,
      url: record.url,
      title: record.title,
      date: record.date,
      dateLabel: record.dateLabel,
      thumbnail: record.thumbnail,
      titleText: record.titleText || record.title || "",
      comicText: record.comicText || "",
      metadataText: record.metadataText || ""
    }))
  };

  await writeJsonAtomic(path.join(publicDataDir, "search-index.json"), index);
  await writeJsonAtomic(path.join(dataDir, "search-index.json"), index);
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function fetchText(url, options) {
  await sleep(options.delayMs);
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function bestImageUrl($, image) {
  const candidates = [
    image.attr("data-src"),
    image.attr("data-lazy-src"),
    image.attr("data-orig-file"),
    largestSrcsetUrl(image.attr("data-srcset") || image.attr("srcset") || ""),
    image.attr("src")
  ];

  for (const candidate of candidates) {
    const url = absoluteUrl(candidate);
    if (url && !url.startsWith("data:")) return url;
  }

  const imageLink = image.closest("a[href]").attr("href");
  const linkedUrl = absoluteUrl(imageLink);
  if (linkedUrl && isImageUrl(linkedUrl)) return linkedUrl;
  return "";
}

function largestSrcsetUrl(srcset) {
  return String(srcset || "")
    .split(",")
    .map((candidate) => {
      const [url, width] = candidate.trim().split(/\s+/, 2);
      const numericWidth = width && width.endsWith("w") ? Number(width.slice(0, -1)) : 0;
      return { url, width: numericWidth };
    })
    .filter((candidate) => candidate.url)
    .sort((left, right) => right.width - left.width)[0]?.url;
}

function cleanTitle(title) {
  return squashWhitespace(String(title || "").replace(/\s*\|\s*Poorly Drawn Lines\s*$/i, ""));
}

function cleanMetadataText(text) {
  const cleaned = squashWhitespace(text);
  if (!cleaned || /^image$/i.test(cleaned)) return "";
  return cleaned;
}

function cleanOcr(text) {
  return String(text || "")
    .replace(/\f/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function squashWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseDisplayDate(dateLabel) {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(dateLabel);
  if (!match) return "";
  const month = monthNumbers.get(match[1].toLowerCase());
  if (!month) return "";
  return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
}

function absoluteUrl(value) {
  if (!value || String(value).startsWith("data:")) return "";
  try {
    return new URL(value, siteOrigin).toString();
  } catch {
    return "";
  }
}

function comicSlug(url) {
  return new URL(url).pathname.replace(/^\/comic\//, "").replace(/\/$/, "");
}

function slugTitle(url) {
  return comicSlug(url)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extensionFromUrl(url) {
  const pathname = new URL(url).pathname;
  const extension = path.extname(pathname).toLowerCase();
  return extension && extension.length <= 6 ? extension : ".img";
}

function isImageUrl(url) {
  return /\.(avif|gif|jpe?g|png|webp)$/i.test(new URL(url).pathname);
}

function firstErrorLine(error) {
  return String(error?.message || error || "").split("\n")[0];
}

function stableId(slug) {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (safe) return safe;
  return createHash("sha1").update(slug).digest("hex").slice(0, 12);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, data) {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeFileAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, data);
  await rename(tempPath, filePath);
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
