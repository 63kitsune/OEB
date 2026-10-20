import { calculateRequestConfigKeySync, getSebExamSalt } from "./config-key.js";
import { getBekProfile } from "./bek-catalog.js";

// Extracted from the supplied 3.10.2.920 Windows x64 application certificate.
export const CERTIFICATE_THUMBPRINT = "ECAC9DF025F5D208F6190FC4D6F9D329576598C7";
export const DEFAULT_BUILD_VERSION = "3.10.2.920";
export const DEFAULT_BEK_SETTINGS = Object.freeze({ enabled: true, buildVersion: DEFAULT_BUILD_VERSION, mode: "automatic", browserExamKey: "", schemaVersion: 2 });

export function normalizeBekSettings(settings = {}) {
  const buildVersion = String(settings.buildVersion ?? DEFAULT_BUILD_VERSION).trim();
  if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(buildVersion)) {
    throw new Error("Enter a complete SEB build version, for example 3.10.2.920.");
  }
  const mode = settings.mode === "fallback" ? "automatic" : settings.mode ?? (settings.browserExamKey ? "provided" : "automatic");
  if (!["provided", "automatic"].includes(mode)) throw new Error("Choose automatic calculation or an existing BEK.");
  const browserExamKey = String(settings.browserExamKey ?? "").trim().toLowerCase();
  if (browserExamKey && !/^[a-f\d]{64}$/.test(browserExamKey)) {
    throw new Error("The BEK must be exactly 64 hexadecimal characters. Paste one key from your quiz's allowed browser exam keys.");
  }
  return { enabled: settings.enabled !== false, buildVersion, mode, browserExamKey, schemaVersion: 2 };
}

export async function resolveBrowserExamKey(xml, configHash, settings) {
  const normalized = normalizeBekSettings(settings);
  if (!normalized.enabled) return { key: undefined, mode: "disabled" };
  if (normalized.mode === "provided") {
    return { key: normalized.browserExamKey || undefined, mode: normalized.browserExamKey ? "provided" : "missing-key" };
  }
  return { key: await calculateNativeBrowserExamKey(xml, configHash, normalized), mode: "automatic" };
}

// Native Windows flow: SHA256(installation data || CK || hexadecimal salt || integrity salt).
// The installation data is build-specific; it is not a stored BEK for a particular quiz.
export async function calculateNativeBrowserExamKey(xml, configHash, settings = {}) {
  const { buildVersion } = normalizeBekSettings(settings);
  const profile = await getBekProfile(buildVersion);
  if (!/^[a-f\d]{64}$/i.test(configHash || "")) throw new Error("Invalid configuration key.");
  const prefix = Uint8Array.from(atob(profile.prefixBase64), character => character.charCodeAt(0));
  const saltHex = Array.from(getSebExamSalt(xml), byte => byte.toString(16).padStart(2, "0")).join("");
  const suffix = new TextEncoder().encode(configHash.toLowerCase() + saltHex + profile.integritySalt);
  const input = new Uint8Array(prefix.length + suffix.length);
  input.set(prefix);
  input.set(suffix, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Matches the simplified Windows C# fallback, not the native integrity DLL.
export async function calculateFallbackBrowserExamKey(xml, configHash, settings = {}) {
  const { buildVersion } = normalizeBekSettings(settings);
  if (!/^[a-f\d]{64}$/i.test(configHash || "")) throw new Error("Invalid configuration key.");
  const salt = getSebExamSalt(xml);
  // WebCrypto rejects empty HMAC keys. A zero-filled block is equivalent to an empty key.
  const key = await crypto.subtle.importKey("raw", salt.length ? salt : new Uint8Array(64),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = new TextEncoder().encode(CERTIFICATE_THUMBPRINT + buildVersion + configHash.toLowerCase());
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function calculateRequestBrowserExamKeySync(url, browserExamKey) {
  if (!/^[a-f\d]{64}$/.test(browserExamKey || "")) throw new Error("Invalid browser exam key.");
  return calculateRequestConfigKeySync(url.split("#", 1)[0], browserExamKey);
}
