# Poorly Drawn Lines Search

A local, reproducible indexer and static search page for the [Poorly Drawn Lines archive](https://poorlydrawnlines.com/archive/).

The scraper reads the official archive pages, downloads each comic image, runs OCR, and writes a deployable index under `public/data/` with small local thumbnails under `public/thumbs/`.

## Requirements

- Node.js 20+
- npm
- Tesseract OCR available as `tesseract`

## Install

```sh
npm install
```

## Build the index

For a quick sanity check:

```sh
npm run scrape:sample
```

For the full archive:

```sh
npm run scrape
```

The full run is resumable. It caches fetched archive pages, downloaded images, OCR text, generated thumbnails, and the final search index under `data/`, `public/data/`, and `public/thumbs/`.

Useful options:

```sh
node scripts/build-index.mjs --limit 100
node scripts/build-index.mjs --offset 500 --limit 100
node scripts/build-index.mjs --concurrency 2 --delay-ms 300
node scripts/build-index.mjs --refresh-pages
node scripts/build-index.mjs --refresh-ocr
node scripts/build-index.mjs --rebuild-index-only
```

## Run the search page

```sh
npm run serve
```

Open the printed local URL.

## Verify

```sh
npm run smoke
```

## Cloud deployment

For the Cloudflare/GitHub Actions setup, see [docs/cloud-deployment.md](docs/cloud-deployment.md).
