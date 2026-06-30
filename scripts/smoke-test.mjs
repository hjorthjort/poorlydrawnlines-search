import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStaticServer } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const html = await readFile(path.join(rootDir, "public", "index.html"), "utf8");
assert(html.includes("Poorly Drawn Lines Search"), "index.html should identify the app");
assert(html.includes("https://poorlydrawnlines.com/archive/"), "index.html should link to the source archive");

const server = createStaticServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

await waitForServer(`http://127.0.0.1:${port}/`);
await waitForServer(`http://127.0.0.1:${port}/styles.css`);
server.close();

console.log("Smoke test passed for minimal Poorly Drawn Lines deploy.");

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
