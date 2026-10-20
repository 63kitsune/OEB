export function bekSettingsForVersion(version, catalog) {
  const buildVersion = version === "off" ? catalog.defaultVersion : version;
  if (!catalog.versions.some(entry => entry.buildVersion === buildVersion)) {
    throw new Error("Choose an available SEB version.");
  }
  return { enabled: version !== "off", buildVersion, mode: "automatic", browserExamKey: "" };
}
