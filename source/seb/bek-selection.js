import { DEFAULT_BUILD_VERSION } from "./browser-exam-key.js";

export function bekSettingsForVersion(version) {
  if (!["off", DEFAULT_BUILD_VERSION].includes(version)) throw new Error("Choose a supported SEB version.");
  return { enabled: version !== "off", buildVersion: DEFAULT_BUILD_VERSION, mode: "automatic", browserExamKey: "" };
}
