import { mkdir, readdir, readFile, writeFile, copyFile, access, rm } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { validateBekCatalog } from "./source/seb/bek-catalog.js";

const require = createRequire(import.meta.url);
const { minify } = require("terser");
const { transform } = require("lightningcss");
const { zipSync } = require("fflate");
const root = fileURLToPath(new URL("./", import.meta.url));
const source = join(root, "source");
const output = join(root, "release");
const browsers = ["chrome", "firefox"];
// bek.json is the single editable profile source and is also the offline fallback.
const bekCatalog = await validateBekCatalog(JSON.parse(await readFile(join(root, "bek.json"), "utf8")));

for (const name of ["chrome.manifest.json", "firefox.manifest.json"]) {
  await access(join(source, name)).catch(() => {
    throw new Error(`Restore source/${name} before rebuilding.`);
  });
}

let originalBytes = 0;
let minifiedBytes = 0;
for (const browser of browsers) {
  await rm(join(output, browser), { recursive: true, force: true });
  await mkdir(join(output, browser), { recursive: true });
}
async function buildDirectory(relative = "") {
  for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) {
      await buildDirectory(path);
      continue;
    }
    if (["manifest.json", "chrome.manifest.json", "firefox.manifest.json"].includes(entry.name)) continue;
    const input = join(source, path);
    const destinations = browsers.map((browser) => join(output, browser, path));
    for (const destination of destinations) await mkdir(dirname(destination), { recursive: true });
    const extension = extname(path);
    if (![".js", ".css", ".json"].includes(extension)) {
      for (const destination of destinations) await copyFile(input, destination);
      continue;
    }
    const content = await readFile(input);
    let result;
    if (extension === ".js") {
      const module = /^(?:import|export)\s/m.test(content.toString());
      result = (await minify(content.toString(), {
        module,
        compress: true,
        mangle: true,
        format: { comments: "some" }
      })).code;
    } else if (extension === ".css") {
      result = transform({ filename: path, code: content, minify: true }).code;
    } else {
      result = JSON.stringify(JSON.parse(content));
    }
    for (const destination of destinations) await writeFile(destination, result);
    originalBytes += content.length;
    minifiedBytes += Buffer.byteLength(result);
  }
}

await buildDirectory();
for (const browser of browsers) {
  const manifest = JSON.parse(await readFile(join(source, `${browser}.manifest.json`), "utf8"));
  if (browser === "chrome" && manifest.manifest_version === 2
      && manifest.content_scripts?.some(entry => "world" in entry)) {
    throw new Error("Chrome Manifest V2 does not support content_scripts.world.");
  }
  await writeFile(join(output, browser, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(output, browser, "bek.json"), JSON.stringify(bekCatalog) + "\n");
}
console.log(`Built release/chrome and release/firefox: ${originalBytes} -> ${minifiedBytes} bytes of JavaScript and CSS per release.`);

// Archives contain manifest.json at their root, ready to extract and load.
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
async function archiveFiles(directory, relative = "", files = {}) {
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) await archiveFiles(directory, path, files);
    else files[path.replaceAll("\\", "/")] = new Uint8Array(await readFile(join(directory, path)));
  }
  return files;
}
for (const browser of browsers) {
  const files = await archiveFiles(join(output, browser));
  const name = `OEB-${packageMetadata.version}-${browser}.zip`;
  await writeFile(join(output, name), zipSync(files, { level: 9 }));
  console.log(`Packaged release/${name}`);
}
