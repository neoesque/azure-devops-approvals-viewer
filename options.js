const DEFAULT_CONFIG = {
  org: "",
  apiVersion: "7.1-preview"
};
const ext = typeof browser !== "undefined" ? browser : chrome;

function runtimeLastErrorMessage() {
  if (!ext || !ext.runtime || !ext.runtime.lastError) {
    return "";
  }
  return ext.runtime.lastError.message || "Unknown runtime error";
}

function storageGet(keys) {
  const storage = ext.storage.local;
  try {
    const maybePromise = storage.get(keys);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
  } catch (err) {
    console.error(err);
  }

  return new Promise((resolve, reject) => {
    storage.get(keys, (items) => {
      const err = runtimeLastErrorMessage();
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve(items || {});
    });
  });
}

function storageSet(items) {
  const storage = ext.storage.local;
  try {
    const maybePromise = storage.set(items);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
  } catch (err) {
    console.error(err);
  }

  return new Promise((resolve, reject) => {
    storage.set(items, () => {
      const err = runtimeLastErrorMessage();
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve();
    });
  });
}

function setStatus(message, isError) {
  const status = document.getElementById("statusMessage");
  if (!status) {
    return;
  }
  status.textContent = message || "";
  status.classList.toggle("error", Boolean(isError));
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

async function loadSettings() {
  const stored = await storageGet(["org", "apiVersion", "keepFailedAuthBridgeTabs"]);
  const orgInput = document.getElementById("orgInput");
  const apiVersionInput = document.getElementById("apiVersionInput");
  const keepFailedAuthBridgeTabsInput = document.getElementById("keepFailedAuthBridgeTabsInput");

  if (orgInput) {
    orgInput.value = normalizeText(stored.org) || DEFAULT_CONFIG.org;
  }
  if (apiVersionInput) {
    apiVersionInput.value = normalizeText(stored.apiVersion) || DEFAULT_CONFIG.apiVersion;
  }
  if (keepFailedAuthBridgeTabsInput) {
    keepFailedAuthBridgeTabsInput.checked = stored.keepFailedAuthBridgeTabs === true;
  }
}

async function saveSettings() {
  const orgInput = document.getElementById("orgInput");
  const apiVersionInput = document.getElementById("apiVersionInput");
  const org = normalizeText(orgInput ? orgInput.value : "");
  const apiVersion = normalizeText(apiVersionInput ? apiVersionInput.value : "");
  const keepFailedAuthBridgeTabs = Boolean(
    keepFailedAuthBridgeTabsInput && keepFailedAuthBridgeTabsInput.checked
  );

  if (!org) {
    setStatus("Organization 不能為空。", true);
    return;
  }
  if (!apiVersion) {
    setStatus("API Version 不能為空。", true);
    return;
  }

  await storageSet({ org, apiVersion, keepFailedAuthBridgeTabs });
  setStatus("已儲存。", false);
}

async function resetSettings() {
  await storageSet({
    org: DEFAULT_CONFIG.org,
    apiVersion: DEFAULT_CONFIG.apiVersion,
    keepFailedAuthBridgeTabs: false
  });
  await loadSettings();
  setStatus("已恢復預設值。", false);
}

function setupEvents() {
  const saveButton = document.getElementById("saveButton");
  const resetButton = document.getElementById("resetButton");

  if (saveButton) {
    saveButton.addEventListener("click", () => {
      saveSettings().catch((err) => setStatus(`儲存失敗: ${err.message}`, true));
    });
  }

  if (resetButton) {
    resetButton.addEventListener("click", () => {
      resetSettings().catch((err) => setStatus(`重設失敗: ${err.message}`, true));
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  loadSettings().catch((err) => setStatus(`讀取設定失敗: ${err.message}`, true));
});
