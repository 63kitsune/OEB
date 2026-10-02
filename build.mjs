import { mkdir, readdir, readFile, writeFile, copyFile, access, rm } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { minify } = require("terser");
const { transform } = require("lightningcss");
const root = fileURLToPath(new URL("./", import.meta.url));
const source = join(root, "source");
const output = join(root, "release");
const browsers = ["chrome", "firefox"];

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
  await writeFile(join(output, browser, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
console.log(`Built release/chrome and release/firefox: ${originalBytes} -> ${minifiedBytes} bytes of JavaScript and CSS per release.`);
