import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStaticServer } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const html = await readFile(path.join(rootDir, "public", "index.html"), "utf8");
assert(html.includes("Poorly Drawn Lines Search"), "index.html should identify the app");
assert(html.includes("resultTemplate"), "index.html should include the result template");

const indexPath = path.join(rootDir, "public", "data", "search-index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));

assert(index.source === "https://poorlydrawnlines.com/archive/", "index source should be the PDL archive");
assert(Array.isArray(index.comics), "search-index.json must contain comics array");
assert(index.comics.length > 0, "search-index.json must contain at least one comic");
assert(index.totalArchiveComics >= index.totalIndexedComics, "archive total should cover indexed total");

for (const comic of index.comics.slice(0, 12)) {
  assert(comic.id, "comic id is required");
  assert(comic.url?.startsWith("https://poorlydrawnlines.com/comic/"), `invalid official URL for ${comic.id}`);
  assert(comic.thumbnail, `thumbnail is required for ${comic.id}`);
  await assertFile(path.join(rootDir, "public", comic.thumbnail), `thumbnail file is missing for ${comic.id}`);
  assert(typeof comic.titleText === "string", `titleText must be a string for ${comic.id}`);
  assert(typeof comic.comicText === "string", `comicText must be a string for ${comic.id}`);
  assert(typeof comic.metadataText === "string", `metadataText must be a string for ${comic.id}`);
}

const server = createStaticServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

await waitForServer(`http://127.0.0.1:${port}/`);
await waitForServer(`http://127.0.0.1:${port}/styles.css`);
await waitForServer(`http://127.0.0.1:${port}/app.js`);
await waitForServer(`http://127.0.0.1:${port}/data/search-index.json`);
server.close();

console.log(`Smoke test passed for ${index.comics.length} indexed comics.`);

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const attempt = () => {
      http
        .get(url, (response) => {
          response.resume();
          if (response.statusCode && response.statusCode < 400) {
            resolve();
            return;
          }
          retry();
        })
        .on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertFile(filePath, message) {
  try {
    const fileStat = await stat(filePath);
    assert(fileStat.isFile(), message);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(message);
    throw error;
  }
}
