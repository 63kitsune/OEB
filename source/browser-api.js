(function installChromePromiseFacade() {
  if (globalThis.browser?.runtime?.getBrowserInfo) {
    if (!browser.storage.session) browser.storage.session = browser.storage.local;
    return;
  }
  function invoke(owner, method, ...args) {
    return new Promise((resolve, reject) => {
      if (!owner || typeof owner[method] !== "function") {
        reject(new Error(`Chrome API ${method} is unavailable in this extension context.`));
        return;
      }
      owner[method](...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  function wrapStorage(area) {
    return {
      get(keys) { return invoke(area, "get", keys); },
      set(items) { return invoke(area, "set", items); },
      remove(keys) { return invoke(area, "remove", keys); }
    };
  }

  const sessionStorage = chrome.storage?.session || chrome.storage?.local;
  const storage = sessionStorage ? {
    session: wrapStorage(sessionStorage),
    onChanged: chrome.storage.onChanged
  } : undefined;

  globalThis.browser = {
    runtime: {
      onInstalled: chrome.runtime.onInstalled,
      onMessage: chrome.runtime.onMessage,
      getURL(path) { return chrome.runtime.getURL(path); },
      sendMessage(message) { return invoke(chrome.runtime, "sendMessage", message); }
    },
    downloads: chrome.downloads && {
      onCreated: chrome.downloads.onCreated
    },
    webRequest: chrome.webRequest,
    tabs: chrome.tabs && {
      onRemoved: chrome.tabs.onRemoved,
      onUpdated: chrome.tabs.onUpdated,
      query(queryInfo) { return invoke(chrome.tabs, "query", queryInfo); },
      get(tabId) { return invoke(chrome.tabs, "get", tabId); },
      reload(tabId, reloadProperties) { return invoke(chrome.tabs, "reload", tabId, reloadProperties); },
      remove(tabIds) { return invoke(chrome.tabs, "remove", tabIds); },
      sendMessage(tabId, message) { return invoke(chrome.tabs, "sendMessage", tabId, message); },
      update(tabId, updateProperties) { return invoke(chrome.tabs, "update", tabId, updateProperties); }
    },
    commands: chrome.commands && {
      onCommand: chrome.commands.onCommand
    },
    windows: chrome.windows && {
      onRemoved: chrome.windows.onRemoved,
      create(createData) { return invoke(chrome.windows, "create", createData); },
      update(windowId, updateInfo) { return invoke(chrome.windows, "update", windowId, updateInfo); }
    },
    storage: storage && {
      ...storage,
      local: wrapStorage(chrome.storage.local)
    },
    browserAction: chrome.browserAction
  };
})();
