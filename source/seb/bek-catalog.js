// Only profile data is downloaded. Calculation algorithms remain bundled code.
export const BEK_CATALOG_URL = "https://raw.githubusercontent.com/63kitsune/OEB/refs/heads/main/bek.json";
export const BEK_CATALOG_CACHE = "oebBekCatalogCache";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const HEX64 = /^[a-f\d]{64}$/i;

export async function validateBekCatalog(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.profiles)
      || !value.profiles.length || value.profiles.length > 32) throw new Error("Unsupported BEK profile file.");
  const versions = new Set();
  const profiles = [];
  for (const entry of value.profiles) {
    if (!entry || !VERSION.test(entry.buildVersion) || versions.has(entry.buildVersion)
        || entry.platform !== "windows-x64" || entry.algorithm !== "seb-windows-native-v1") {
      throw new Error("The profile file contains an unsupported or duplicate build.");
    }
    if (typeof entry.prefixBase64 !== "string" || entry.prefixBase64.length > 1024 * 1024
        || !HEX64.test(entry.prefixSha256 || "") || !/^[a-f\d]{40}$/i.test(entry.integritySalt || "")) {
      throw new Error(`Invalid profile data for ${entry.buildVersion}.`);
    }
    let prefix;
    try { prefix = Uint8Array.from(atob(entry.prefixBase64), character => character.charCodeAt(0)); }
    catch { throw new Error(`Invalid profile encoding for ${entry.buildVersion}.`); }
    if (!prefix.length || prefix.length > 512 * 1024) throw new Error("BEK profile is too large or empty.");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", prefix)),
      byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== entry.prefixSha256.toLowerCase()) throw new Error(`Profile checksum mismatch for ${entry.buildVersion}.`);
    const label = entry.label ?? `SEB ${entry.buildVersion} · Windows`;
    if (typeof label !== "string" || label.length > 80) throw new Error("Invalid BEK profile label.");
    profiles.push(Object.freeze({ buildVersion: entry.buildVersion, platform: entry.platform,
      algorithm: entry.algorithm, label, prefixBase64: entry.prefixBase64,
      prefixSha256: hash, integritySalt: entry.integritySalt.toLowerCase() }));
    versions.add(entry.buildVersion);
  }
  if (!versions.has(value.defaultVersion)) throw new Error("The default BEK build has no profile.");
  return Object.freeze({ schemaVersion: 1, defaultVersion: value.defaultVersion, profiles: Object.freeze(profiles) });
}

async function readJson(response) {
  if (!response.ok) throw new Error(`Profile update returned HTTP ${response.status}.`);
  if (Number(response.headers?.get("content-length")) > MAX_JSON_BYTES) throw new Error("BEK profile file is too large.");
  if (!response.body) throw new Error("Empty BEK profile response.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_JSON_BYTES) throw new Error("BEK profile file is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Dependency injection keeps network/storage behavior independently verifiable.
export function createBekCatalogManager({ storage, fetcher = fetch, bundledUrl, now = Date.now }) {
  let catalog;
  let source = "bundled";
  let checkedAt = 0;
  let lastError = "";
  let initializing;
  let updating;
  async function initialize() {
    if (catalog) return;
    if (!initializing) initializing = (async () => {
      try {
        const stored = (await storage.get(BEK_CATALOG_CACHE))[BEK_CATALOG_CACHE];
        if (stored?.catalog) {
          catalog = await validateBekCatalog(stored.catalog);
          checkedAt = Math.min(now(), Number(stored.checkedAt) || 0);
          lastError = String(stored.error || "");
          source = "cached";
          return;
        }
      } catch { /* Invalid cache is replaced by the packaged profile file. */ }
      catalog = await validateBekCatalog(await readJson(await fetcher(bundledUrl)));
    })().catch(error => { initializing = undefined; throw error; });
    await initializing;
  }
  function info() {
    return { defaultVersion: catalog.defaultVersion,
      versions: catalog.profiles.map(({ buildVersion, label, platform }) => ({ buildVersion, label, platform })),
      source, checkedAt, error: lastError };
  }
  async function refresh({ force = false } = {}) {
    await initialize();
    if (updating) return updating;
    if (!force && checkedAt && now() - checkedAt < CHECK_INTERVAL) return info();
    updating = (async () => {
      checkedAt = now();
      try {
        const response = await fetcher(BEK_CATALOG_URL, { credentials: "omit", redirect: "error",
          cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        const next = await validateBekCatalog(await readJson(response));
        // Publish in memory before storage notifications reach open popups.
        // Updating this data does not recompute the active exam's request headers.
        const previous = catalog;
        const previousSource = source;
        catalog = next;
        source = "github";
        lastError = "";
        try { await storage.set({ [BEK_CATALOG_CACHE]: { catalog: next, checkedAt, error: "" } }); }
        catch (error) { catalog = previous; source = previousSource; throw error; }
      } catch (error) {
        lastError = error.message || "Could not update BEK profiles.";
        await storage.set({ [BEK_CATALOG_CACHE]: { catalog, checkedAt, error: lastError } }).catch(() => {});
      }
      return info();
    })();
    try { return await updating; } finally { updating = undefined; }
  }
  return {
    async get({ check = true } = {}) {
      await initialize();
      if (check) void refresh().catch(() => {});
      return catalog;
    },
    async info() { await this.get(); return info(); },
    refresh
  };
}

let manager;
function getManager() {
  return manager ||= createBekCatalogManager({ storage: browser.storage.local,
    bundledUrl: browser.runtime.getURL("bek.json") });
}
export async function getBekCatalogInfo() { return getManager().info(); }
export async function refreshBekCatalog() { return getManager().refresh({ force: true }); }
export async function getBekProfile(version) {
  const catalog = await getManager().get();
  const profile = catalog.profiles.find(entry => entry.buildVersion === version);
  if (!profile) throw new Error(`No verified BEK profile for ${version}. Update the available versions or choose a supported build.`);
  return profile;
}
