export const SETTINGS_KEY = "sebInspectorSettings";
export const DEFAULT_SETTINGS = Object.freeze({
  checkDownloadsForSeb: true, afterQuit: "close-window", customQuitUrl: "", blackoutSeconds: 0,
  fullscreenOnReload: false, showCursorOnBlack: true, defaultWindowsCursor: false,
  windowsCursorAfterQuit: false,
  showStartupAnimation: true, taskbarMode: "auto", taskbarScale: 100
});

export function normalizeSettings(saved = {}) {
  const legacyMode = typeof saved.showSebBar === "boolean" ? (saved.showSebBar ? "auto" : "hide") : "auto";
  const scale = Number(saved.taskbarScale);
  return {
    checkDownloadsForSeb: saved.checkDownloadsForSeb !== false,
    afterQuit: ["close-window", "unload", "custom-page", "screenshot"].includes(saved.afterQuit)
      ? saved.afterQuit : saved.closeTabOnQuit === false ? "unload" : "close-window",
    customQuitUrl: typeof saved.customQuitUrl === "string" ? saved.customQuitUrl : "",
    blackoutSeconds: Number.isFinite(Number(saved.blackoutSeconds))
      ? Math.max(0, Math.min(3600, Number(saved.blackoutSeconds))) : 0,
    fullscreenOnReload: saved.fullscreenOnReload === true,
    showCursorOnBlack: saved.showCursorOnBlack !== false,
    defaultWindowsCursor: saved.defaultWindowsCursor === true,
    windowsCursorAfterQuit: saved.windowsCursorAfterQuit === true,
    showStartupAnimation: saved.showStartupAnimation !== false,
    taskbarMode: ["auto", "show", "hide"].includes(saved.taskbarMode) ? saved.taskbarMode : legacyMode,
    taskbarScale: Number.isFinite(scale) ? Math.max(50, Math.min(300, Math.round(scale))) : 100
  };
}
