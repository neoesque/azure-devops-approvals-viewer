const DEFAULT_CONFIG = {
  org: "",
  apiVersion: "7.1-preview"
};
const STORAGE_KEYS = ["org", "apiVersion"];
const APPROVALS_CACHE_KEY = "approvalsCache";
const DEFAULT_HEADERS = { Accept: "application/json" };
const REQUEST_CONCURRENCY = 6;
const MY_APPROVALS_TAB_ID = "my-approvals";
const AUTH_BRIDGE_TAB_LOAD_TIMEOUT_MS = 15000;
const AUTH_BRIDGE_SERVICE_WORKER_WAIT_MS = 5000;
const AUTH_BRIDGE_POLL_INTERVAL_MS = 250;
const NAVIGATION_FETCH_TIMEOUT_MS = 30000;

const ext = typeof browser !== "undefined" ? browser : chrome;
let appConfig = null;
let currentUserId = null;
let currentMyApprovalUrls = [];
let renderedAt = null;
const authBridgeTabs = new Map();
let navigationFetchQueue = Promise.resolve();

function h(tag, attributes = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") {
      el.className = value;
    } else if (key.startsWith("data-")) {
      el.setAttribute(key, value);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(el.style, value);
    } else {
      el[key] = value;
    }
  }

  children.flat().forEach((child) => {
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
      return;
    }
    if (child instanceof Node) {
      el.appendChild(child);
    }
  });
  return el;
}

function normalizeValue(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

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

async function loadConfig() {
  const stored = await storageGet(STORAGE_KEYS);
  return {
    org: normalizeValue(stored.org, DEFAULT_CONFIG.org),
    apiVersion: normalizeValue(stored.apiVersion, DEFAULT_CONFIG.apiVersion)
  };
}

function isCacheForCurrentConfig(cache) {
  return Boolean(
    cache &&
      cache.org === appConfig.org &&
      cache.apiVersion === appConfig.apiVersion &&
      Number.isFinite(cache.savedAt) &&
      Array.isArray(cache.results)
  );
}

async function loadApprovalsCache() {
  const stored = await storageGet([APPROVALS_CACHE_KEY]);
  const cache = stored[APPROVALS_CACHE_KEY];
  if (!isCacheForCurrentConfig(cache)) {
    return null;
  }
  return cache;
}

async function saveApprovalsCache(results, savedAt) {
  await storageSet({
    [APPROVALS_CACHE_KEY]: {
      org: appConfig.org,
      apiVersion: appConfig.apiVersion,
      savedAt,
      results
    }
  });
}

function updateOrgLabel() {
  const label = document.getElementById("orgLabel");
  if (!label || !appConfig) {
    return;
  }
  const orgText = appConfig.org ? appConfig.org : "(not set)";
  const loadedText = renderedAt ? ` | Last: ${new Date(renderedAt).toLocaleString()}` : "";
  label.textContent = `Org: ${orgText} | API: ${appConfig.apiVersion}${loadedText}`;
}

function openOptionsPage() {
  if (ext.runtime && ext.runtime.openOptionsPage) {
    ext.runtime.openOptionsPage();
    return;
  }
  if (ext.runtime && ext.runtime.getURL) {
    window.open(ext.runtime.getURL("options.html"), "_blank");
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("Failed to copy URL:", err);
  }
}

function createBackgroundTab(url) {
  const createProperties = { url, active: false };
  if (typeof browser !== "undefined" && browser.tabs && browser.tabs.create) {
    return browser.tabs.create(createProperties);
  }

  if (ext && ext.tabs && ext.tabs.create) {
    return new Promise((resolve, reject) => {
      ext.tabs.create(createProperties, (tab) => {
        const err = runtimeLastErrorMessage();
        if (err) {
          reject(new Error(err));
          return;
        }
        resolve(tab);
      });
    });
  }

  const openedWindow = window.open(url, "_blank");
  if (!openedWindow) {
    return Promise.reject(new Error("Unable to open tab."));
  }
  return Promise.resolve(openedWindow);
}

async function openUrlsInBackground(urls) {
  let openedCount = 0;
  let errorCount = 0;

  for (const url of urls) {
    try {
      await createBackgroundTab(url);
      openedCount += 1;
    } catch (err) {
      console.error("Failed to open approval URL:", url, err);
      errorCount += 1;
    }
  }

  return { openedCount, errorCount };
}

function setOpenAllStatus(message, isError) {
  const status = document.getElementById("openAllMyApprovalsStatus");
  if (!status) {
    return;
  }
  status.textContent = message || "";
  status.classList.toggle("error", Boolean(isError));
}

function createLoginRequiredError(url) {
  const err = new Error("需要先登入 Azure DevOps。");
  err.code = "LOGIN_REQUIRED";
  err.url = url;
  return err;
}

function isLoginRequiredError(err) {
  return Boolean(err && err.code === "LOGIN_REQUIRED");
}

function createHttpError(url, response) {
  const err = new Error(`HTTP ${response.status} ${url}`);
  err.status = response.status;
  err.url = url;
  return err;
}

function isSignInRedirect(response) {
  if (!response || response.status < 300 || response.status >= 400 || !response.headers) {
    return false;
  }
  const location = response.headers.get("location") || "";
  return location.includes("_signin") || location.includes("login.microsoftonline.com");
}

function headerEntriesToFacade(entries) {
  const headers = {};
  (entries || []).forEach(([name, value]) => {
    headers[String(name).toLowerCase()] = value;
  });

  return {
    get(name) {
      return headers[String(name).toLowerCase()] || null;
    }
  };
}

function createResponseFacade(fetchResult) {
  return {
    ok: fetchResult.ok,
    status: fetchResult.status,
    url: fetchResult.url,
    headers: headerEntriesToFacade(fetchResult.headers)
  };
}

async function parseJsonResponse(url, response, bodyText) {
  if (!response.ok) {
    if (isSignInRedirect(response)) {
      throw createLoginRequiredError(url);
    }
    throw createHttpError(url, response);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const looksLikeHtml = contentType.includes("text/html") || /^\s*</.test(bodyText);
  if (looksLikeHtml) {
    throw createLoginRequiredError(url);
  }

  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch (err) {
    if (bodyText.includes("<!DOCTYPE") || bodyText.includes("<html")) {
      throw createLoginRequiredError(url);
    }
    throw new Error(`Invalid JSON response from ${url}`);
  }

  return { data, response };
}

async function fetchJsonDirect(url) {
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    credentials: "include"
  });

  const bodyText = await response.text();
  return parseJsonResponse(url, response, bodyText);
}

function isReleaseApiUrl(url) {
  const requestUrl = new URL(url);
  return (
    requestUrl.hostname === "vsrm.dev.azure.com" &&
    requestUrl.pathname.toLowerCase().includes("/_apis/release/approvals")
  );
}

function tabsCreate(createProperties) {
  if (typeof browser !== "undefined" && browser.tabs && browser.tabs.create) {
    return browser.tabs.create(createProperties);
  }

  return new Promise((resolve, reject) => {
    ext.tabs.create(createProperties, (tab) => {
      const err = runtimeLastErrorMessage();
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsRemove(tabId) {
  if (typeof browser !== "undefined" && browser.tabs && browser.tabs.remove) {
    return browser.tabs.remove(tabId).catch(() => {});
  }

  return new Promise((resolve) => {
    ext.tabs.remove(tabId, () => resolve());
  });
}

function scriptingExecute(details) {
  if (typeof browser !== "undefined" && browser.scripting && browser.scripting.executeScript) {
    return browser.scripting.executeScript(details);
  }

  return new Promise((resolve, reject) => {
    ext.scripting.executeScript(details, (results) => {
      const err = runtimeLastErrorMessage();
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve(results || []);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAuthBridgePageUrl(url) {
  const requestUrl = new URL(url);
  const encodedOrg = encodeURIComponent(appConfig.org);
  if (requestUrl.hostname === "vsrm.dev.azure.com") {
    const pathParts = requestUrl.pathname.split("/").filter(Boolean);
    const projectPath = pathParts.length > 1 ? `/${pathParts[1]}/_release` : "";
    return `https://dev.azure.com/${encodedOrg}${projectPath}`;
  }
  return `${requestUrl.origin}/${encodedOrg}/`;
}

function canUseAuthBridge() {
  return Boolean(
    ext &&
      ext.tabs &&
      ext.tabs.create &&
      ext.scripting &&
      ext.scripting.executeScript &&
      appConfig &&
      appConfig.org
  );
}

async function waitForAuthBridgeTab(tabId) {
  const deadline = Date.now() + AUTH_BRIDGE_TAB_LOAD_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const results = await scriptingExecute({
        target: { tabId },
        func: () => document.readyState
      });
      const state = results && results[0] ? results[0].result : "";
      if (state === "interactive" || state === "complete") {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(AUTH_BRIDGE_POLL_INTERVAL_MS);
  }

  throw lastError || new Error("Azure DevOps auth bridge tab did not load.");
}

async function readTabDocument(tabId) {
  const results = await scriptingExecute({
    target: { tabId },
    func: () => ({
      readyState: document.readyState,
      url: window.location.href,
      contentType: document.contentType || "",
      bodyText: document.body ? document.body.innerText : document.documentElement.innerText
    })
  });
  return results && results[0] ? results[0].result : null;
}

async function waitForReadableTab(tabId) {
  const deadline = Date.now() + NAVIGATION_FETCH_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const page = await readTabDocument(tabId);
      if (page && page.readyState === "complete") {
        return page;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(AUTH_BRIDGE_POLL_INTERVAL_MS);
  }

  throw lastError || new Error("Azure DevOps release API tab did not load.");
}

async function fetchJsonViaNavigationNow(url) {
  let tab = null;
  try {
    tab = await tabsCreate({ url, active: false });
    const page = await waitForReadableTab(tab.id);
    if (!page) {
      throw new Error(`No response from Azure DevOps release API tab for ${url}`);
    }
    if (page.url.includes("_signin") || page.url.includes("login.microsoftonline.com")) {
      throw createLoginRequiredError(url);
    }

    return parseJsonResponse(
      url,
      {
        ok: true,
        status: 200,
        url: page.url,
        headers: headerEntriesToFacade([["content-type", page.contentType]])
      },
      page.bodyText || ""
    );
  } finally {
    if (tab && tab.id !== undefined) {
      await tabsRemove(tab.id);
    }
  }
}

function fetchJsonViaNavigation(url) {
  const result = navigationFetchQueue.then(
    () => fetchJsonViaNavigationNow(url),
    () => fetchJsonViaNavigationNow(url)
  );
  navigationFetchQueue = result.catch(() => {});
  return result;
}

async function getAuthBridgeTabId(url) {
  const bridgePageUrl = getAuthBridgePageUrl(url);

  if (!authBridgeTabs.has(bridgePageUrl)) {
    authBridgeTabs.set(
      bridgePageUrl,
      tabsCreate({ url: bridgePageUrl, active: false }).then(async (tab) => {
        await waitForAuthBridgeTab(tab.id);
        return tab.id;
      })
    );
  }

  return authBridgeTabs.get(bridgePageUrl);
}

async function closeAuthBridgeTabs() {
  const tabPromises = Array.from(authBridgeTabs.values());
  authBridgeTabs.clear();
  const results = await Promise.allSettled(tabPromises);
  await Promise.all(
    results
      .filter((result) => result.status === "fulfilled")
      .map((result) => tabsRemove(result.value))
  );
}

async function fetchFromAzureDevOpsPage(url, headers, serviceWorkerWaitMs) {
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      await Promise.race([
        navigator.serviceWorker.ready.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, serviceWorkerWaitMs))
      ]);
    }

    const response = await fetch(url, {
      headers,
      credentials: "include"
    });
    const bodyText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: Array.from(response.headers.entries()),
      bodyText
    };
  } catch (err) {
    return {
      bridgeError: {
        name: err && err.name ? err.name : "Error",
        message: err && err.message ? err.message : String(err)
      }
    };
  }
}

async function fetchJsonWithAuthBridge(url) {
  if (!canUseAuthBridge()) {
    throw createLoginRequiredError(url);
  }

  // Azure DevOps now attaches auth from its own same-origin page context.
  const tabId = await getAuthBridgeTabId(url);
  const results = await scriptingExecute({
    target: { tabId },
    world: "MAIN",
    func: fetchFromAzureDevOpsPage,
    args: [url, DEFAULT_HEADERS, AUTH_BRIDGE_SERVICE_WORKER_WAIT_MS]
  });
  const fetchResult = results && results[0] ? results[0].result : null;
  if (!fetchResult) {
    throw new Error(`No response from Azure DevOps auth bridge for ${url}`);
  }
  if (fetchResult.bridgeError) {
    throw new Error(
      `Azure DevOps auth bridge fetch failed for ${url}: ${fetchResult.bridgeError.message}`
    );
  }
  return parseJsonResponse(url, createResponseFacade(fetchResult), fetchResult.bodyText);
}

async function fetchJson(url) {
  if (isReleaseApiUrl(url) && canUseAuthBridge()) {
    return fetchJsonViaNavigation(url);
  }
  if (canUseAuthBridge()) {
    return fetchJsonWithAuthBridge(url);
  }
  return fetchJsonDirect(url);
}

async function fetchCurrentUser() {
  const url = `https://dev.azure.com/${appConfig.org}/_apis/connectionData?api-version=${appConfig.apiVersion}`;
  const { data } = await fetchJson(url);
  currentUserId = data.authenticatedUser.id;
}

async function fetchAllProjects() {
  const allProjects = [];
  let continuationToken = null;

  do {
    let url = `https://dev.azure.com/${appConfig.org}/_apis/projects?stateFilter=wellFormed&$top=100&api-version=${appConfig.apiVersion}`;
    if (continuationToken) {
      url += `&continuationToken=${encodeURIComponent(continuationToken)}`;
    }

    const { data, response } = await fetchJson(url);
    allProjects.push(...(data.value || []));
    continuationToken = response.headers.get("x-ms-continuationtoken");
  } while (continuationToken);

  return allProjects;
}

function buildReleaseApprovalsUrl(projectName) {
  const encodedProject = encodeURIComponent(projectName);
  return `https://vsrm.dev.azure.com/${appConfig.org}/${encodedProject}/_apis/release/approvals?statusFilter=pending&queryOrder=createdOnDescending&api-version=${appConfig.apiVersion}`;
}

function buildMyReleaseApprovalsUrl(projectName) {
  const encodedProject = encodeURIComponent(projectName);
  return `https://vsrm.dev.azure.com/${appConfig.org}/${encodedProject}/_apis/release/approvals?statusFilter=pending&assignedToFilter=${encodeURIComponent(currentUserId)}&includeMyGroupApprovals=true&queryOrder=createdOnDescending&top=1000&api-version=${appConfig.apiVersion}`;
}

function buildPipelineApprovalsUrl(projectName) {
  const encodedProject = encodeURIComponent(projectName);
  return `https://dev.azure.com/${appConfig.org}/${encodedProject}/_apis/pipelines/approvals?state=pending&$expand=steps&api-version=${appConfig.apiVersion}`;
}

function buildMyPipelineApprovalsUrl(projectName) {
  const encodedProject = encodeURIComponent(projectName);
  return `https://dev.azure.com/${appConfig.org}/${encodedProject}/_apis/pipelines/approvals?state=pending&userIds=${encodeURIComponent(currentUserId)}&$expand=steps&top=1000&api-version=${appConfig.apiVersion}`;
}

function generateReleaseWebUrl(projectName, releaseId) {
  const encodedProject = encodeURIComponent(projectName);
  return `https://dev.azure.com/${appConfig.org}/${encodedProject}/_releaseProgress?_a=release-pipeline-progress&releaseId=${releaseId}`;
}

function getPipelineWebUrl(approval) {
  if (approval && approval._links && approval._links.web && approval._links.web.href) {
    return approval._links.web.href;
  }
  if (
    approval &&
    approval.pipeline &&
    approval.pipeline.owner &&
    approval.pipeline.owner._links &&
    approval.pipeline.owner._links.web &&
    approval.pipeline.owner._links.web.href
  ) {
    return approval.pipeline.owner._links.web.href;
  }
  return "#";
}

function filterPendingPipelineApprovals(values) {
  return values.filter((approval) => !approval.status || approval.status === "pending");
}

function normalizeApprovalId(approval) {
  if (!approval || approval.id === undefined || approval.id === null) {
    return "";
  }
  return String(approval.id);
}

function createApprovalIdSet(values) {
  const set = new Set();
  (values || []).forEach((approval) => {
    const id = normalizeApprovalId(approval);
    if (id) {
      set.add(id);
    }
  });
  return set;
}

function isMyReleaseApproval(approval, myReleaseApprovalIds) {
  const id = normalizeApprovalId(approval);
  if (id && myReleaseApprovalIds && myReleaseApprovalIds.has(id)) {
    return true;
  }
  return Boolean(
    approval &&
      approval.approver &&
      approval.approver.id &&
      approval.approver.id === currentUserId
  );
}

function isMyPipelineApproval(approval, myPipelineApprovalIds) {
  const id = normalizeApprovalId(approval);
  if (id && myPipelineApprovalIds && myPipelineApprovalIds.has(id)) {
    return true;
  }

  if (Array.isArray(approval.steps) && approval.steps.length > 0) {
    return approval.steps.some((step) => {
      const isPending = step.status === "pending";
      const isMine =
        step.assignedApprover &&
        step.assignedApprover.id &&
        step.assignedApprover.id === currentUserId;
      return isPending && isMine;
    });
  }

  if (Array.isArray(approval.blockedApprovers) && approval.blockedApprovers.length > 0) {
    return approval.blockedApprovers.some((approver) => approver.id === currentUserId);
  }

  if (approval.assignedApprover && approval.assignedApprover.id) {
    return approval.assignedApprover.id === currentUserId;
  }

  return false;
}

async function fetchProjectApprovals(project) {
  const result = {
    projectId: project.id,
    projectName: project.name,
    releaseApprovals: [],
    pipelineApprovals: [],
    errors: [],
    hasLoginError: false
  };

  const [releaseResult, pipelineResult, myReleaseResult, myPipelineResult] = await Promise.allSettled([
    fetchJson(buildReleaseApprovalsUrl(project.name)),
    fetchJson(buildPipelineApprovalsUrl(project.name)),
    fetchJson(buildMyReleaseApprovalsUrl(project.name)),
    fetchJson(buildMyPipelineApprovalsUrl(project.name))
  ]);

  let myReleaseApprovalIds = new Set();
  let myPipelineApprovalIds = new Set();

  if (releaseResult.status === "fulfilled") {
    result.releaseApprovals = releaseResult.value.data.value || [];
  } else {
    if (isLoginRequiredError(releaseResult.reason)) {
      result.hasLoginError = true;
    }
    result.errors.push(`Release approvals failed: ${releaseResult.reason.message}`);
  }

  if (pipelineResult.status === "fulfilled") {
    const pipelineValues = pipelineResult.value.data.value || [];
    result.pipelineApprovals = filterPendingPipelineApprovals(pipelineValues);
  } else {
    if (isLoginRequiredError(pipelineResult.reason)) {
      result.hasLoginError = true;
    }
    result.errors.push(`Pipeline approvals failed: ${pipelineResult.reason.message}`);
  }

  if (myReleaseResult.status === "fulfilled") {
    myReleaseApprovalIds = createApprovalIdSet(myReleaseResult.value.data.value || []);
  } else {
    if (isLoginRequiredError(myReleaseResult.reason)) {
      result.hasLoginError = true;
    }
    result.errors.push(`My release approvals failed: ${myReleaseResult.reason.message}`);
  }

  if (myPipelineResult.status === "fulfilled") {
    myPipelineApprovalIds = createApprovalIdSet(myPipelineResult.value.data.value || []);
  } else {
    if (isLoginRequiredError(myPipelineResult.reason)) {
      result.hasLoginError = true;
    }
    result.errors.push(`My pipeline approvals failed: ${myPipelineResult.reason.message}`);
  }

  result.releaseApprovals = result.releaseApprovals.map((approval) => ({
    ...approval,
    __isMine: isMyReleaseApproval(approval, myReleaseApprovalIds)
  }));
  result.pipelineApprovals = result.pipelineApprovals.map((approval) => ({
    ...approval,
    __isMine: isMyPipelineApproval(approval, myPipelineApprovalIds)
  }));

  result.count = result.releaseApprovals.length + result.pipelineApprovals.length;
  const myReleaseCount = result.releaseApprovals.filter((approval) => approval.__isMine).length;
  const myPipelineCount = result.pipelineApprovals.filter((approval) => approval.__isMine).length;
  result.myCount = myReleaseCount + myPipelineCount;
  return result;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  }

  const workers = [];
  const workerCount = Math.min(limit, items.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return results;
}

function createProjectContainer(projectId) {
  return h("div", { id: projectId, className: "project-container" });
}

function createProjectTab(projectId, projectName, count, isActive) {
  return h(
    "button",
    {
      className: isActive ? "tab-button active" : "tab-button",
      "data-project-id": projectId,
      type: "button"
    },
    `${projectName} (${count})`
  );
}

function renderReleaseRow(approval, projectName) {
  const td = (...content) => h("td", {}, ...content);
  const releaseId = approval.release ? approval.release.id : "";
  const url = generateReleaseWebUrl(projectName, releaseId);
  const isMine = approval.__isMine === true;
  const rowClassName = isMine ? "approval-row-mine" : "";

  return h(
    "tr",
    { className: rowClassName },
    td(h("span", { className: "text-blue" }, approval.releaseDefinition ? approval.releaseDefinition.name : "-")),
    td(h("span", { className: "text-underline" }, approval.release ? approval.release.name : "-")),
    td(
      approval.approver && approval.approver.imageUrl
        ? h("img", {
            src: approval.approver.imageUrl,
            width: "15",
            height: "15",
            className: "avatar"
          })
        : "",
      h("span", {}, approval.approver ? approval.approver.displayName : "-")
    ),
    td(approval.releaseEnvironment ? approval.releaseEnvironment.name : "-"),
    td(approval.approvalType || "Release"),
    td(h("a", { href: url, target: "_blank", className: "release-link" }, String(releaseId))),
    td(h("button", { type: "button", "data-action": "copy", "data-url": url }, "Copy URL"))
  );
}

function renderPipelineRow(approval) {
  const td = (...content) => h("td", {}, ...content);
  const webUrl = getPipelineWebUrl(approval);
  const owner = approval.pipeline && approval.pipeline.owner ? approval.pipeline.owner : null;
  const ownerName = owner ? owner.name : "-";
  const ownerId = owner ? owner.id : "-";
  const pipelineName = approval.pipeline ? approval.pipeline.name : "-";
  const isMine = approval.__isMine === true;
  const rowClassName = isMine ? "approval-row-mine" : "";

  return h(
    "tr",
    { className: rowClassName },
    td(h("span", { className: "text-blue" }, pipelineName)),
    td(h("span", { className: "text-underline" }, ownerName)),
    td(h("span", {}, "Pipeline")),
    td("Pipeline"),
    td("Manual"),
    td(
      webUrl === "#"
        ? h("span", {}, String(ownerId))
        : h("a", { href: webUrl, target: "_blank", className: "release-link" }, String(ownerId))
    ),
    td(
      webUrl === "#"
        ? h("span", {}, "-")
        : h("button", { type: "button", "data-action": "copy", "data-url": webUrl }, "Copy URL")
    )
  );
}

function createApprovalsTable(result) {
  const rows = [];
  result.releaseApprovals.forEach((approval) => rows.push(renderReleaseRow(approval, result.projectName)));
  result.pipelineApprovals.forEach((approval) => rows.push(renderPipelineRow(approval)));

  return h(
    "table",
    {},
    h(
      "tr",
      {},
      h("th", {}, "name"),
      h("th", {}, "release"),
      h("th", {}, "approver"),
      h("th", {}, "Env."),
      h("th", {}, "Type"),
      h("th", {}, "url"),
      h("th", {}, "copy")
    ),
    rows
  );
}

function getApprovalUrls(result) {
  const urls = [];

  result.releaseApprovals.forEach((approval) => {
    const releaseId = approval.release ? approval.release.id : "";
    urls.push(generateReleaseWebUrl(result.projectName, releaseId));
  });

  result.pipelineApprovals.forEach((approval) => {
    const webUrl = getPipelineWebUrl(approval);
    if (webUrl && webUrl !== "#") {
      urls.push(webUrl);
    }
  });

  return urls;
}

function getUniqueUrls(results) {
  const urls = [];
  const seen = new Set();

  results.forEach((result) => {
    getApprovalUrls(result).forEach((url) => {
      if (!url || seen.has(url)) {
        return;
      }
      seen.add(url);
      urls.push(url);
    });
  });

  return urls;
}

function createMyApprovalsActions(urlCount) {
  return h(
    "div",
    { className: "my-approvals-actions" },
    h(
      "button",
      {
        type: "button",
        className: "toolbar-button",
        "data-action": "open-all-my-approvals",
        disabled: urlCount === 0
      },
      `背景開啟全部 URL (${urlCount})`
    ),
    h("span", { id: "openAllMyApprovalsStatus", className: "open-all-status" }, "")
  );
}

function renderProjectContent(result) {
  const container = document.getElementById(result.projectId);
  if (!container) {
    return;
  }
  container.innerHTML = "";

  container.appendChild(
    h(
      "div",
      { className: "project-summary" },
      `${result.projectName} Total ${result.count} approvals (Your approvals: ${result.myCount}, highlighted)`
    )
  );

  if (result.errors.length > 0) {
    container.appendChild(
      h("div", { className: "error-message" }, result.errors.join(" | "))
    );
  }

  if (result.count === 0) {
    container.appendChild(h("div", { className: "status-message" }, "No pending approvals"));
    return;
  }

  container.appendChild(createApprovalsTable(result));
}

function createMyApprovalsResult(result) {
  const releaseApprovals = result.releaseApprovals.filter((approval) => approval.__isMine === true);
  const pipelineApprovals = result.pipelineApprovals.filter((approval) => approval.__isMine === true);

  return {
    ...result,
    releaseApprovals,
    pipelineApprovals,
    count: releaseApprovals.length + pipelineApprovals.length
  };
}

function renderMyApprovalsContent(results) {
  const container = document.getElementById(MY_APPROVALS_TAB_ID);
  if (!container) {
    return;
  }
  container.innerHTML = "";

  const myResults = results
    .map(createMyApprovalsResult)
    .filter((result) => result.count > 0);
  const totalCount = myResults.reduce((total, result) => total + result.count, 0);
  currentMyApprovalUrls = getUniqueUrls(myResults);

  container.appendChild(
    h("div", { className: "project-summary" }, `全部專案共有 ${totalCount} 筆等待你簽核的項目`)
  );

  if (totalCount === 0) {
    container.appendChild(h("div", { className: "status-message" }, "目前沒有等待你簽核的項目。"));
    return;
  }

  container.appendChild(createMyApprovalsActions(currentMyApprovalUrls.length));

  myResults.forEach((result) => {
    const section = h("section", { className: "my-approvals-project" });
    section.appendChild(
      h("div", { className: "project-summary" }, `${result.projectName} (${result.count})`)
    );
    section.appendChild(createApprovalsTable(result));
    container.appendChild(section);
  });
}

function activateProject(projectId) {
  document.querySelectorAll(".tab-button").forEach((btn) => btn.classList.remove("active"));
  document.querySelectorAll(".project-container").forEach((content) => content.classList.remove("active"));

  const activeButton = document.querySelector(`button[data-project-id="${projectId}"]`);
  const activeContent = document.getElementById(projectId);

  if (activeButton) {
    activeButton.classList.add("active");
  }
  if (activeContent) {
    activeContent.classList.add("active");
  }
}

function renderNoApprovalsMessage() {
  const contentContainer = document.getElementById("contentContainer");
  contentContainer.innerHTML = "";
  contentContainer.appendChild(
    h("div", { className: "status-message" }, "目前沒有 pending 的 Pipeline 或 Release。")
  );
}

function renderFatalError(message) {
  const contentContainer = document.getElementById("contentContainer");
  contentContainer.innerHTML = "";
  contentContainer.appendChild(h("div", { className: "error-message" }, message));
}

function renderLoginRequiredMessage() {
  const contentContainer = document.getElementById("contentContainer");
  contentContainer.innerHTML = "";
  const loginUrl = appConfig && appConfig.org
    ? `https://dev.azure.com/${appConfig.org}/`
    : "https://dev.azure.com/";
  const loginLink = h("a", { href: loginUrl, target: "_blank", className: "release-link" }, "登入");
  contentContainer.appendChild(
    h(
      "div",
      { className: "error-message" },
      "存取 API 錯誤，請確認權限或嘗試重新",
      loginLink
    )
  );
}

function renderLoading() {
  const tabContainer = document.getElementById("tabContainer");
  const contentContainer = document.getElementById("contentContainer");
  currentMyApprovalUrls = [];
  tabContainer.innerHTML = "";
  contentContainer.innerHTML = "";
  contentContainer.appendChild(h("div", { className: "status-message" }, "Loading approvals..."));
}

function setRefreshButtonLoading(isLoading) {
  const refreshButton = document.getElementById("refreshButton");
  if (!refreshButton) {
    return;
  }
  refreshButton.disabled = isLoading;
  refreshButton.textContent = isLoading ? "Refreshing..." : "Refresh";
}

function renderApprovalsResults(projectsWithApprovals, savedAt) {
  renderedAt = savedAt || Date.now();
  updateOrgLabel();

  if (projectsWithApprovals.length === 0) {
    renderNoApprovalsMessage();
    return;
  }

  const tabContainer = document.getElementById("tabContainer");
  const contentContainer = document.getElementById("contentContainer");
  tabContainer.innerHTML = "";
  contentContainer.innerHTML = "";

  const totalMyApprovals = projectsWithApprovals.reduce(
    (total, result) => total + result.myCount,
    0
  );
  tabContainer.appendChild(
    createProjectTab(MY_APPROVALS_TAB_ID, "等待我簽核", totalMyApprovals, true)
  );
  const myApprovalsContainer = createProjectContainer(MY_APPROVALS_TAB_ID);
  myApprovalsContainer.classList.add("active");
  contentContainer.appendChild(myApprovalsContainer);
  renderMyApprovalsContent(projectsWithApprovals);

  projectsWithApprovals.forEach((result) => {
    tabContainer.appendChild(
      createProjectTab(result.projectId, result.projectName, result.count, false)
    );
    const projectContainer = createProjectContainer(result.projectId);
    contentContainer.appendChild(projectContainer);
    renderProjectContent(result);
  });
}

async function handleOpenAllMyApprovals(button) {
  const urls = currentMyApprovalUrls.slice();
  if (urls.length === 0) {
    setOpenAllStatus("沒有可開啟的 URL。", true);
    return;
  }

  button.disabled = true;
  setOpenAllStatus(`正在背景開啟 ${urls.length} 個頁籤...`, false);

  const { openedCount, errorCount } = await openUrlsInBackground(urls);
  button.disabled = false;

  if (errorCount > 0) {
    setOpenAllStatus(`已開啟 ${openedCount} 個頁籤，${errorCount} 個失敗。`, true);
    return;
  }
  setOpenAllStatus(`已背景開啟 ${openedCount} 個頁籤。`, false);
}

function setupEvents() {
  const tabContainer = document.getElementById("tabContainer");
  const contentContainer = document.getElementById("contentContainer");
  const openOptionsButton = document.getElementById("openOptionsButton");
  const refreshButton = document.getElementById("refreshButton");

  if (openOptionsButton) {
    openOptionsButton.addEventListener("click", openOptionsPage);
  }
  if (refreshButton) {
    refreshButton.addEventListener("click", () => loadApprovals(true));
  }

  tabContainer.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (!target.matches(".tab-button")) {
      return;
    }
    activateProject(target.dataset.projectId);
  });

  contentContainer.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('button[data-action="open-all-my-approvals"]')) {
      handleOpenAllMyApprovals(target).catch((err) => {
        console.error(err);
        setOpenAllStatus(`背景開啟失敗: ${err.message}`, true);
        target.disabled = false;
      });
      return;
    }

    if (target.matches('button[data-action="copy"]')) {
      const url = target.dataset.url;
      if (url) {
        copyToClipboard(url);
      }
      return;
    }

    if (target.matches("a.release-link")) {
      e.preventDefault();
      createBackgroundTab(target.href).catch((err) => console.error("Failed to open approval URL:", err));
    }
  });
}

async function loadApprovals(forceRefresh = false) {
  try {
    appConfig = await loadConfig();
    updateOrgLabel();
    if (!appConfig.org) {
      renderFatalError("請先到 Settings 設定 Azure DevOps Organization。");
      return;
    }

    if (!forceRefresh) {
      const cache = await loadApprovalsCache();
      if (cache) {
        renderApprovalsResults(cache.results, cache.savedAt);
        return;
      }
    }

    renderLoading();
    setRefreshButtonLoading(true);

    await fetchCurrentUser();
    const projects = await fetchAllProjects();
    const results = await mapWithConcurrency(projects, REQUEST_CONCURRENCY, fetchProjectApprovals);
    const projectsWithApprovals = results.filter((result) => result.count > 0);
    const hasLoginError = results.some((result) => result.hasLoginError);

    if (projectsWithApprovals.length === 0) {
      if (hasLoginError) {
        renderLoginRequiredMessage();
        return;
      }
      const savedAt = Date.now();
      await saveApprovalsCache([], savedAt).catch((err) =>
        console.error("Failed to save approvals cache:", err)
      );
      renderApprovalsResults([], savedAt);
      return;
    }

    const savedAt = Date.now();
    await saveApprovalsCache(projectsWithApprovals, savedAt).catch((err) =>
      console.error("Failed to save approvals cache:", err)
    );
    renderApprovalsResults(projectsWithApprovals, savedAt);
  } catch (err) {
    console.error(err);
    if (isLoginRequiredError(err)) {
      renderLoginRequiredMessage();
      return;
    }
    renderFatalError(`讀取簽核資料失敗: ${err.message}`);
  } finally {
    setRefreshButtonLoading(false);
    closeAuthBridgeTabs().catch((err) => console.error("Failed to close auth bridge tabs:", err));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  loadApprovals();
});
