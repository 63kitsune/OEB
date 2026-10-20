export const SETTINGS_KEY = "sebInspectorSettings";
export const DEFAULT_SETTINGS = Object.freeze({
  checkDownloadsForSeb: true, closeTabOnQuit: true, showStartupAnimation: true, taskbarMode: "auto", taskbarScale: 100
});

export function normalizeSettings(saved = {}) {
  const legacyMode = typeof saved.showSebBar === "boolean" ? (saved.showSebBar ? "auto" : "hide") : "auto";
  const scale = Number(saved.taskbarScale);
  return {
    checkDownloadsForSeb: saved.checkDownloadsForSeb !== false,
    closeTabOnQuit: saved.closeTabOnQuit !== false,
    showStartupAnimation: saved.showStartupAnimation !== false,
    taskbarMode: ["auto", "show", "hide"].includes(saved.taskbarMode) ? saved.taskbarMode : legacyMode,
    taskbarScale: Number.isFinite(scale) ? Math.max(50, Math.min(300, Math.round(scale))) : 100
  };
}
