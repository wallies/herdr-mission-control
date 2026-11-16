import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);

// src/mods/mission-control-reviews/backend.mjs
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// src/shared/tracker-transport.mjs
import https from "node:https";

// src/shared/config.js
var CONFIG_VERSION = 1;
var MAX_CONFIG_CHARACTERS = 18e4;
var ConfigError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
};
var fail = (message) => {
  throw new ConfigError("INVALID_CONFIG", message);
};
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var copy = (value) => JSON.parse(JSON.stringify(value));
var secretFields = /* @__PURE__ */ new Set(["token", "accesstoken", "refreshtoken", "apikey", "password", "secret", "authorization"]);
var forbiddenKeys = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function validateJson(value, depth = 0, envMap = false) {
  if (depth > 16) fail("Configuration nesting exceeds the supported limit.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Configuration numbers must be finite.");
    return;
  }
  if (typeof value !== "object") fail("Configuration must contain JSON values only.");
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("Configuration objects must be plain JSON objects.");
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) fail("Configuration contains a reserved object key.");
    const compact = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (!envMap && secretFields.has(compact)) fail("Store a credential environment reference, not a credential value.");
    if ((key.endsWith("Env") || envMap) && (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))) fail("Credential environment references must be environment variable names.");
    validateJson(item, depth + 1, key === "envRefs");
  }
}
function machine(value) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f]/.test(value)) fail("Machine identity is invalid.");
  return value;
}
function canonicalRepoPath(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f]/.test(value)) fail("A canonical absolute repository path is required.");
  let result = value.replaceAll("\\", "/");
  if (!result.startsWith("/") && !/^[A-Za-z]:\//.test(result)) fail("Relative repository paths cannot identify a binding.");
  if (result.split("/").some((part) => part === "." || part === "..")) fail("Repository paths must already be canonical.");
  result = result.replace(/\/+$/, "") || "/";
  if (/^[a-z]:\//.test(result)) result = result[0].toUpperCase() + result.slice(1);
  return result;
}
function bindingKey(on, repoRoot) {
  return JSON.stringify([machine(on), canonicalRepoPath(repoRoot)]);
}
function newConfig() {
  return { v: CONFIG_VERSION, revision: 0, connections: {}, bindings: {}, preferences: {}, usageSources: {} };
}
function gitlabProjectPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) fail("A GitLab project needs a valid namespace/project path.");
  const segments = value.split("/");
  if (segments.length > 21 || segments.some((segment) => !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(segment))) fail("A GitLab project needs a valid namespace/project path.");
  return value;
}
function validateGitlabSelection(value) {
  if (!Object.hasOwn(value, "connectionId") || !Object.hasOwn(value, "projectPath") || Object.keys(value).some((key) => !["connectionId", "projectPath", "status"].includes(key))) fail("A GitLab binding needs its connection and project path.");
  gitlabProjectPath(value.projectPath);
  if (value.status === void 0) return;
  const status = value.status, groups = ["todo", "inProgress", "done"];
  if (!object(status) || Object.keys(status).length !== 1 || !Object.hasOwn(status, "labels") || !object(status.labels) || Object.keys(status.labels).length !== groups.length || groups.some((group) => !Object.hasOwn(status.labels, group))) fail("GitLab workflow mapping needs To do, In progress and Done label groups.");
  const used = /* @__PURE__ */ new Set();
  for (const group of groups) {
    const labels = status.labels[group];
    if (!Array.isArray(labels) || labels.length > 100) fail("GitLab workflow label groups must be bounded lists.");
    for (const label of labels) {
      if (typeof label !== "string" || !label.trim() || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label) || used.has(label.toLowerCase())) fail("GitLab workflow labels must be valid and disjoint, ignoring case.");
      used.add(label.toLowerCase());
    }
  }
}
function validateBinding(binding, key, connections) {
  if (!object(binding)) fail("Repository bindings must be objects.");
  if (bindingKey(binding.machine, binding.repoRoot) !== key) fail("A repository binding does not match its machine/root key.");
  for (const source of ["jira", "github", "gitlab", "shortcut"]) {
    if (binding[source] === void 0) continue;
    const selected = binding[source];
    if (!object(selected) || typeof selected.connectionId !== "string" || !Object.hasOwn(connections, selected.connectionId)) fail("A tracker binding must reference an existing connection.");
    if (source === "jira" && !selected.project && !selected.jql) fail("A Jira binding needs a project or JQL filter.");
    if (source === "shortcut" && (typeof selected.owner !== "string" || !selected.owner || typeof selected.workspace !== "string" || !selected.workspace)) fail("A Shortcut binding needs its owner and workspace.");
    if (source === "github" && (typeof selected.owner !== "string" || !selected.owner || typeof selected.repo !== "string" || !selected.repo)) fail("A GitHub binding needs its owner and repository.");
    if (source === "gitlab") validateGitlabSelection(selected);
  }
  if (binding.mountedLocalPath !== void 0) canonicalRepoPath(binding.mountedLocalPath);
}
function validateConfig(value) {
  if (!object(value)) fail("Configuration must be an object.");
  if (value.v !== CONFIG_VERSION) throw new ConfigError("UNSUPPORTED_VERSION", "Unsupported configuration version; the original file has been preserved.");
  validateJson(value);
  const normalized = { ...newConfig(), ...copy(value) };
  if (!Number.isSafeInteger(normalized.revision) || normalized.revision < 0) fail("Configuration revision must be a non-negative safe integer.");
  for (const field of ["connections", "bindings", "preferences", "usageSources"]) if (!object(normalized[field])) fail(`Configuration ${field} must be an object.`);
  for (const [id, connection] of Object.entries(normalized.connections)) {
    if (!/^[a-z][a-z0-9-]{0,95}$/.test(id) || !object(connection) || connection.id !== id || typeof connection.kind !== "string") fail("Connections require a matching stable id and adapter kind.");
    if (connection.site !== void 0 && (typeof connection.site !== "string" || !/^https:\/\/[^\s/@?#]+\/?$/.test(connection.site))) fail("A tracker site must be an HTTPS origin without credentials or query parameters.");
  }
  for (const [key, binding] of Object.entries(normalized.bindings)) validateBinding(binding, key, normalized.connections);
  if (JSON.stringify(normalized).length > MAX_CONFIG_CHARACTERS) fail("Configuration exceeds the supported file size.");
  return normalized;
}

// src/shared/tracker-transport.mjs
var messages = {
  INVALID_REQUEST: "The tracker request is invalid. Reload its repository settings.",
  INVALID_CONNECTION: "The integration profile is invalid. Check its adapter and credential references.",
  INVALID_SCOPE: "The tracker result or cursor belongs to a different repository or connection. Reload this scope.",
  CANONICAL_SITE_REQUIRED: "Use the canonical Jira API base URL from serverInfo.baseUrl, rather than a custom display URL. Check the selected site and cloud ID.",
  INCOMPLETE_RESULTS: "The tracker could not confirm a complete result set. Narrow the selected scope and refresh.",
  STATUS_MAPPING_REQUIRED: "Configure the source status mapping before using this board.",
  CLI_UNAVAILABLE: "The configured tracker CLI is not installed locally. Select an installed command or another adapter.",
  ADAPTER_FAILED: "The configured tracker program failed. Check its profile and read-only JSON bridge.",
  CLAUDE_UNAVAILABLE: "Claude Code (the claude command) was not found. Install it, or enter the absolute path to claude in Set up, because the app may not search ~/.local/bin.",
  CLAUDE_FAILED: "The Claude Code run failed. Run claude in a terminal to check that it is signed in, then refresh.",
  BUDGET_EXHAUSTED: "The Claude Code run reached its $0.10 budget before the stories loaded. Narrow the saved query and refresh.",
  SHORTCUT_SIGN_IN_REQUIRED: "Claude Code is not signed in to Shortcut. In Claude Code, run /mcp and sign in to shortcut, then refresh.",
  MCP_UNAVAILABLE: "The selected MCP server is unavailable. Check its transport and credential references, then reconnect.",
  MCP_TOOL_UNAVAILABLE: "The configured MCP search tool is missing or changed. Reconnect and select its current tool mapping.",
  MCP_TOOL_NOT_READ_ONLY: "Select a read-only MCP issue-search tool before loading this board.",
  ACCOUNT_SELECTION_UNSUPPORTED: "The installed CLI cannot select this account explicitly. Use a credential environment reference or a supported CLI version.",
  INVALID_URL: "Use an explicit HTTPS URL without embedded credentials or fragments.",
  UNSUPPORTED_INTEGRATION_HOST: "CLI and stdio MCP integrations must run locally. Use a local bridge or configured HTTPS MCP endpoint for a server.",
  AUTH_REQUIRED: "Tracker authentication is unavailable. Check the selected profile and its credential environment references.",
  PERMISSION_DENIED: "The selected account cannot read this tracker resource.",
  NOT_FOUND: "The selected tracker resource was not found.",
  RATE_LIMITED: "The tracker rate limit was reached. Retry after the reported delay.",
  UPSTREAM_UNAVAILABLE: "The tracker is temporarily unavailable. Retry this connection.",
  HTTP_ERROR: "The tracker rejected the read request. Check its connection settings.",
  UNTRUSTED_ORIGIN: "The tracker response tried to leave the configured HTTPS origin. Check the endpoint.",
  REQUEST_FAILED: "The tracker could not be reached. Check its HTTPS endpoint and retry.",
  REQUEST_TIMEOUT: "The tracker read timed out. Retry this connection.",
  REQUEST_CANCELLED: "This tracker read was cancelled.",
  RESPONSE_TOO_LARGE: "The tracker response exceeds the bounded page size. Narrow its project or query.",
  INVALID_RESPONSE: "The tracker did not return valid UTF-8 JSON."
};
var object2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var text = (v, max = 8192) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
var TrackerError = class extends Error {
  constructor(code, details2 = {}) {
    const safe = Object.hasOwn(messages, code) ? code : "REQUEST_FAILED";
    super(messages[safe]);
    this.name = "TrackerError";
    this.code = safe;
    if (Number.isInteger(details2.status) && details2.status >= 100 && details2.status <= 599) this.status = details2.status;
    if (Number.isFinite(details2.retryAfterMs) && details2.retryAfterMs >= 0) this.retryAfterMs = Math.min(details2.retryAfterMs, 864e5);
  }
};
var fail2 = (code) => {
  throw new TrackerError(code);
};
function publicTrackerError(error) {
  const e = error instanceof TrackerError ? error : new TrackerError("REQUEST_FAILED");
  return { code: e.code, message: messages[e.code] || messages.REQUEST_FAILED, ...e.status !== void 0 ? { status: e.status } : {}, ...e.retryAfterMs !== void 0 ? { retryAfterMs: e.retryAfterMs } : {} };
}
function httpsUrl(value, { originOnly = false } = {}) {
  if (!text(value, 8192)) fail2("INVALID_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail2("INVALID_URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || originOnly && (url.pathname !== "/" || url.search)) fail2("INVALID_URL");
  return url;
}
var origin = (value) => httpsUrl(value, { originOnly: true }).origin;
function retryAfter(value, now) {
  if (typeof value !== "string") return void 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN, date = Number.isFinite(seconds) ? now + seconds * 1e3 : Date.parse(value);
  return Number.isFinite(date) ? Math.min(864e5, Math.max(0, date - now)) : void 0;
}
function httpError(status, headers) {
  const limited = status === 429 || status === 403 && headers["x-ratelimit-remaining"] === "0", now = Date.now(), retry = retryAfter(headers["retry-after"], now), reset = limited && /^\d+$/.test(headers["x-ratelimit-reset"] || "") ? Math.min(864e5, Math.max(0, Number(headers["x-ratelimit-reset"]) * 1e3 - now)) : void 0;
  return new TrackerError(limited ? "RATE_LIMITED" : status === 401 ? "AUTH_REQUIRED" : status === 403 ? "PERMISSION_DENIED" : status === 404 ? "NOT_FOUND" : status >= 500 ? "UPSTREAM_UNAVAILABLE" : "HTTP_ERROR", { status, retryAfterMs: retry ?? reset });
}
async function requestJson(input, { allowedOrigin, headers = {}, method = "GET", body, timeoutMs = 12e3, maxBytes = 1048576, ca, signal, metadata = false, maxRedirects = 3 } = {}) {
  const expected = origin(allowedOrigin);
  let url = httpsUrl(input);
  if (!object2(headers) || !["GET", "POST"].includes(method) || method === "GET" && body !== void 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3e4 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304 || typeof metadata !== "boolean" || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) fail2("INVALID_REQUEST");
  const requestHeaders = { accept: "application/json", "accept-encoding": "identity", "user-agent": "herdr-mission-control/0.1" };
  for (const [key, value] of Object.entries(headers)) {
    const name2 = key.toLowerCase();
    if (!["authorization", "accept", "content-type", "x-github-api-version", "user-agent"].includes(name2) || !text(value, 32768)) fail2("INVALID_REQUEST");
    requestHeaders[name2] = value;
  }
  let payload;
  if (body !== void 0) {
    try {
      payload = Buffer.from(JSON.stringify(body), "utf8");
    } catch {
      fail2("INVALID_REQUEST");
    }
    if (payload.length > 65536) fail2("INVALID_REQUEST");
    requestHeaders["content-type"] = "application/json";
    requestHeaders["content-length"] = String(payload.length);
  }
  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (url.origin !== expected) fail2("UNTRUSTED_ORIGIN");
    if (signal?.aborted) fail2("REQUEST_CANCELLED");
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail2("REQUEST_TIMEOUT");
    const result = await new Promise((resolve, reject) => {
      let settled = false, request;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        error ? reject(error) : resolve(value);
      };
      const cancel = () => {
        finish(new TrackerError("REQUEST_CANCELLED"));
        request?.destroy();
      };
      const timer = setTimeout(() => {
        finish(new TrackerError("REQUEST_TIMEOUT"));
        request?.destroy();
      }, remaining);
      try {
        request = https.request(url, { method, headers: requestHeaders, ca, rejectUnauthorized: true }, (response) => {
          const status = response.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.destroy();
            finish(null, { redirect: location, status });
            return;
          }
          if (status < 200 || status >= 300) {
            const error = httpError(status, response.headers);
            response.destroy();
            finish(error);
            return;
          }
          if (Number(response.headers["content-length"]) > maxBytes) {
            response.destroy();
            finish(new TrackerError("RESPONSE_TOO_LARGE"));
            return;
          }
          const responseHeaders = {};
          if (metadata) for (const name2 of ["link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "x-next-page"]) {
            const value = response.headers[name2];
            if (value !== void 0) {
              if (!(name2 === "x-next-page" && value === "") && !text(value, name2 === "link" ? 8192 : 128)) {
                response.destroy();
                finish(new TrackerError("RESPONSE_TOO_LARGE"));
                return;
              }
              responseHeaders[name2] = value;
            }
          }
          let length = 0;
          const chunks = [];
          response.on("data", (chunk) => {
            if (settled) return;
            length += chunk.length;
            if (length > maxBytes) {
              response.destroy();
              finish(new TrackerError("RESPONSE_TOO_LARGE"));
            } else chunks.push(chunk);
          });
          response.on("error", () => finish(new TrackerError("REQUEST_FAILED")));
          response.on("end", () => {
            if (settled) return;
            try {
              const data = status === 204 ? null : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
              finish(null, { value: metadata ? { data, status, headers: responseHeaders, url: url.href } : data });
            } catch {
              finish(new TrackerError("INVALID_RESPONSE"));
            }
          });
        });
        request.on("error", () => finish(new TrackerError("REQUEST_FAILED")));
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          return;
        }
        request.end(payload);
      } catch {
        finish(new TrackerError("REQUEST_FAILED"));
      }
    });
    if (!Object.hasOwn(result, "redirect")) return result.value;
    if (redirects === maxRedirects || typeof result.redirect !== "string" || method === "POST" && ![307, 308].includes(result.status)) fail2("UNTRUSTED_ORIGIN");
    try {
      url = httpsUrl(new URL(result.redirect, url).href);
    } catch {
      fail2("UNTRUSTED_ORIGIN");
    }
  }
  fail2("UNTRUSTED_ORIGIN");
}

// src/shared/github-auth.mjs
import { spawn } from "node:child_process";
var object3 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact = (value, required, optional = []) => object3(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
var envName = (value) => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
var fail3 = (code) => {
  throw new TrackerError(code);
};
var credential = (value) => {
  if (typeof value !== "string" || !value.length || value.length > 16384 || /[^\x21-\x7e]/.test(value)) fail3("AUTH_REQUIRED");
  return value;
};
function githubEndpoints(site) {
  const url = httpsUrl(site, { originOnly: true }), canonical = url.origin;
  if (url.hostname === "github.com") {
    if (url.port) fail3("INVALID_CONNECTION");
    return { site: canonical, apiBase: "https://api.github.com", graphqlUrl: "https://api.github.com/graphql", host: url.host };
  }
  const cloud = url.hostname.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.ghe\.com$/);
  if (cloud) {
    if (url.port) fail3("INVALID_CONNECTION");
    const api = "https://api." + url.hostname;
    return { site: canonical, apiBase: api, graphqlUrl: api + "/graphql", host: url.host };
  }
  if (url.hostname === "ghe.com" || url.hostname.endsWith(".ghe.com") || url.hostname.endsWith(".github.com")) fail3("INVALID_CONNECTION");
  return { site: canonical, apiBase: canonical + "/api/v3", graphqlUrl: canonical + "/api/graphql", host: url.host };
}
function validateGithubConnection(input) {
  try {
    validateConfig({ v: 1, preferences: { githubConnection: input } });
  } catch {
    fail3("INVALID_CONNECTION");
  }
  if (!exact(input, ["id", "kind", "site", "apiBase"], ["credentialEnv", "gh"]) || input.kind !== "github" || typeof input.id !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(input.id) || ["constructor", "prototype"].includes(input.id)) fail3("INVALID_CONNECTION");
  const endpoints = githubEndpoints(input.site), api = httpsUrl(input.apiBase);
  if (api.search || api.href.replace(/\/$/, "") !== endpoints.apiBase) fail3("INVALID_CONNECTION");
  const hasEnv = Object.hasOwn(input, "credentialEnv"), hasGh = Object.hasOwn(input, "gh");
  if (hasEnv === hasGh || hasEnv && !envName(input.credentialEnv)) fail3("INVALID_CONNECTION");
  if (hasGh && (!exact(input.gh, ["host", "account"]) || typeof input.gh.host !== "string" || input.gh.host.toLowerCase() !== endpoints.host || typeof input.gh.account !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.gh.account))) fail3("INVALID_CONNECTION");
  return { id: input.id, kind: "github", site: endpoints.site, apiBase: endpoints.apiBase, ...hasEnv ? { credentialEnv: input.credentialEnv } : { gh: { host: endpoints.host, account: input.gh.account } } };
}
function selectedEnvironment(env, host) {
  const selected = { ...env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DEBUG", "DEBUG", "GH_REPO"]) delete selected[key];
  return { ...selected, GH_HOST: host, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" };
}
function runGh(command, args, { env, signal, deadline, failureCode }) {
  if (signal?.aborted) return Promise.reject(new TrackerError("REQUEST_CANCELLED"));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new TrackerError("REQUEST_TIMEOUT"));
  return new Promise((resolve, reject) => {
    let child, reason, killTimer, timer, bytes = 0;
    const chunks = [];
    const stop = (code) => {
      if (reason) return;
      reason = new TrackerError(code);
      if (child?.pid) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      }
    };
    const cancel = () => stop("REQUEST_CANCELLED");
    try {
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch {
      reject(new TrackerError("CLI_UNAVAILABLE"));
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    timer = setTimeout(() => stop("REQUEST_TIMEOUT"), remaining);
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 65536) stop("RESPONSE_TOO_LARGE");
      else if (stdout && !reason) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.once("error", (error) => {
      reason ||= new TrackerError(["ENOENT", "EACCES"].includes(error.code) ? "CLI_UNAVAILABLE" : failureCode);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      if (reason) return reject(reason);
      if (code !== 0) return reject(new TrackerError(failureCode));
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        reject(new TrackerError(failureCode));
      }
    });
  });
}
var flag = (help, name2) => new RegExp("^\\s*(?:-\\w,\\s*)?--" + name2 + "(?:[ =<]|$)", "m").test(help);
async function resolveGithubAuth(input, { env = process.env, signal, timeoutMs = 8e3, ghCommand = "gh" } = {}) {
  const connection = validateGithubConnection(input), endpoints = githubEndpoints(connection.site);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25e3 || typeof ghCommand !== "string" || !ghCommand || ghCommand.includes("\0")) fail3("INVALID_REQUEST");
  if (signal?.aborted) fail3("REQUEST_CANCELLED");
  let token;
  if (connection.credentialEnv) token = credential(env[connection.credentialEnv]);
  else {
    const selected = selectedEnvironment(env, connection.gh.host), deadline = Date.now() + timeoutMs, options = { env: selected, signal, deadline };
    const help = await runGh(ghCommand, ["auth", "token", "--help"], { ...options, failureCode: "ACCOUNT_SELECTION_UNSUPPORTED" });
    if (!flag(help, "hostname") || !flag(help, "user")) fail3("ACCOUNT_SELECTION_UNSUPPORTED");
    const noRefresh = flag(help, "no-refresh");
    if (!noRefresh && /\brefresh(?:ed|ing)?\b/i.test(help)) fail3("ACCOUNT_SELECTION_UNSUPPORTED");
    const args = ["auth", "token", "--hostname", connection.gh.host, "--user", connection.gh.account, ...noRefresh ? ["--no-refresh"] : []];
    const output = await runGh(ghCommand, args, { ...options, failureCode: "AUTH_REQUIRED" });
    token = credential(output.replace(/\r?\n$/, ""));
  }
  const result = { connection, allowedOrigin: new URL(connection.apiBase).origin, graphqlUrl: endpoints.graphqlUrl };
  Object.defineProperty(result, "headers", { value: Object.freeze({ accept: "application/vnd.github+json", authorization: "Bearer " + token, "x-github-api-version": "2022-11-28", "user-agent": "herdr-mission-control" }), enumerable: false });
  return Object.freeze(result);
}

// src/mods/mission-control-reviews/model.js
var ReviewModelError = class extends Error {
  constructor(code, message = "The review queue returned an invalid pull request. Refresh to try again.") {
    super(message);
    this.name = "ReviewModelError";
    this.code = code;
  }
};
var fail4 = (code, message) => {
  throw new ReviewModelError(code, message);
};
var object4 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact2 = (value, keys) => object4(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
var text2 = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
var name = (value) => text2(value, 100) && /^[A-Za-z0-9_.-]+$/.test(value) && ![".", ".."].includes(value);
var lower = (value) => value.toLowerCase();
var copy2 = (value) => JSON.parse(JSON.stringify(value));
var SECTIONS = Object.freeze([["direct", "Asked of you"], ["team", "Asked of your teams"]]);
var REVIEW_STATES = ["approved", "changesRequested", "reviewRequired"];
var CHECK_STATES = ["success", "failure", "pending"];
var CONNECTION_ID = /^[a-z][a-z0-9-]{0,95}$/;
function validateReview(value) {
  if (!exact2(value, ["identity", "key", "url", "title", "author", "draft", "section", "waitingSince", "review", "checks"])) fail4("INVALID_REVIEW");
  const i = value.identity;
  if (!exact2(i, ["kind", "connectionId", "site", "owner", "repo", "number"]) || i.kind !== "github-pr" || typeof i.connectionId !== "string" || !CONNECTION_ID.test(i.connectionId) || typeof i.site !== "string" || !/^https:\/\/[^\s/@?#]+$/.test(i.site) || !name(i.owner) || !name(i.repo) || !Number.isSafeInteger(i.number) || i.number < 1) fail4("INVALID_REVIEW");
  if (value.key !== "GH-PR-" + i.number || value.url !== i.site + "/" + i.owner + "/" + i.repo + "/pull/" + i.number || !text2(value.title, 512) || typeof value.draft !== "boolean") fail4("INVALID_REVIEW");
  const a = value.author;
  if (!exact2(a, ["login", "url"]) || (a.login === null ? a.url !== null : !name(a.login) || a.url !== i.site + "/" + a.login)) fail4("INVALID_REVIEW");
  if (!SECTIONS.some(([key]) => key === value.section) || !Number.isSafeInteger(value.waitingSince) || value.waitingSince < 0) fail4("INVALID_REVIEW");
  if (value.review !== null && !REVIEW_STATES.includes(value.review) || value.checks !== null && !CHECK_STATES.includes(value.checks)) fail4("INVALID_REVIEW");
  return copy2(value);
}
function reviewKey(value) {
  const i = value.identity;
  return lower(i.owner) + "/" + lower(i.repo) + "#" + i.number;
}
function sortReviews(list) {
  return [...list].sort((a, b) => a.waitingSince - b.waitingSince || (reviewKey(a) < reviewKey(b) ? -1 : reviewKey(a) > reviewKey(b) ? 1 : 0));
}

// src/mods/mission-control-reviews/reviews.mjs
var QUERIES = Object.freeze({
  all: "is:pr is:open archived:false review-requested:@me",
  direct: "is:pr is:open archived:false user-review-requested:@me"
});
var PAGE_SIZE = 100;
var MAX_PAGES = 3;
var DETAIL_QUERY = `query MissionControlReviewDetails($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ... on PullRequest { id reviewDecision statusCheckRollup { state } } }
}`;
var object5 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var text3 = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
var fail5 = (code) => {
  throw new TrackerError(code);
};
var REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changesRequested", REVIEW_REQUIRED: "reviewRequired" };
var CHECKS = { SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "pending", EXPECTED: "pending" };
function context(options) {
  const { request = requestJson, env = process.env, ca, signal, timeoutMs = 25e3, clock = () => Date.now(), ghCommand } = options;
  if (typeof request !== "function" || typeof clock !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6e4) fail5("INVALID_REQUEST");
  const deadline = Date.now() + timeoutMs, controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) fail5("REQUEST_TIMEOUT");
    return Math.min(left, 3e4);
  };
  return {
    clock,
    cancel: () => controller.abort(),
    auth: (connection) => resolveGithubAuth(connection, { env, ghCommand, signal: combined, timeoutMs: Math.min(8e3, remaining()) }),
    async call(auth, url, body) {
      if (httpsUrl(url).origin !== auth.allowedOrigin) fail5("UNTRUSTED_ORIGIN");
      try {
        return await request(url, { allowedOrigin: auth.allowedOrigin, headers: auth.headers, method: body ? "POST" : "GET", ...body ? { body } : {}, maxRedirects: 0, timeoutMs: remaining(), maxBytes: 4194304, ca, signal: combined });
      } catch (error) {
        if (error instanceof TrackerError && error.status === 403 && error.retryAfterMs !== void 0) throw new TrackerError("RATE_LIMITED", { status: 403, retryAfterMs: error.retryAfterMs });
        throw error;
      }
    }
  };
}
function parseSearchItem(raw, connection, section) {
  if (!object5(raw) || !object5(raw.pull_request) || !Number.isSafeInteger(raw.number) || raw.number < 1 || !text3(raw.title, 512) || !text3(raw.node_id, 200) || typeof raw.repository_url !== "string") fail5("INVALID_RESPONSE");
  const prefix = connection.apiBase + "/repos/";
  if (!raw.repository_url.startsWith(prefix)) fail5("INVALID_RESPONSE");
  const parts = raw.repository_url.slice(prefix.length).split("/");
  if (parts.length !== 2) fail5("INVALID_RESPONSE");
  const [owner, repo] = parts, url = connection.site + "/" + owner + "/" + repo + "/pull/" + raw.number;
  if (raw.html_url !== url || raw.draft !== void 0 && typeof raw.draft !== "boolean") fail5("INVALID_RESPONSE");
  const updated = typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
  if (!Number.isFinite(updated)) fail5("INVALID_RESPONSE");
  let author;
  if (raw.user === null) author = { login: null, url: null };
  else {
    if (!object5(raw.user)) fail5("INVALID_RESPONSE");
    author = { login: raw.user.login, url: raw.user.html_url };
  }
  try {
    return { nodeId: raw.node_id, review: validateReview({ identity: { kind: "github-pr", connectionId: connection.id, site: connection.site, owner, repo, number: raw.number }, key: "GH-PR-" + raw.number, url, title: raw.title, author, draft: raw.draft === true, section, waitingSince: updated, review: null, checks: null }) };
  } catch {
    fail5("INVALID_RESPONSE");
  }
}
async function search(auth, query, section, ctx) {
  const rows = /* @__PURE__ */ new Map();
  let truncated = false, incomplete = false, total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(auth.connection.apiBase + "/search/issues");
    for (const [key, value] of Object.entries({ q: query, sort: "updated", order: "asc", per_page: PAGE_SIZE, page })) url.searchParams.set(key, String(value));
    const data = await ctx.call(auth, url.href);
    if (!object5(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || typeof data.incomplete_results !== "boolean" || !Array.isArray(data.items) || data.items.length > PAGE_SIZE) fail5("INVALID_RESPONSE");
    incomplete ||= data.incomplete_results;
    total = data.total_count;
    for (const raw of data.items) {
      const parsed = parseSearchItem(raw, auth.connection, section), key = reviewKey(parsed.review);
      const old = rows.get(key);
      if (old && old.nodeId !== parsed.nodeId) fail5("INVALID_RESPONSE");
      rows.set(key, parsed);
    }
    if (data.items.length < PAGE_SIZE || rows.size >= total) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { rows, truncated, incomplete };
}
async function details(auth, rows, ctx) {
  const byNode = new Map(rows.map((row) => [row.nodeId, row])), ids = [...byNode.keys()];
  for (let start = 0; start < ids.length; start += 100) {
    const data = await ctx.call(auth, auth.graphqlUrl, { query: DETAIL_QUERY, variables: { ids: ids.slice(start, start + 100) } });
    if (!object5(data) || data.errors !== void 0 && (!Array.isArray(data.errors) || data.errors.length) || !Array.isArray(data.data?.nodes)) fail5("INCOMPLETE_RESULTS");
    for (const node of data.data.nodes) {
      if (node === null) continue;
      const row = object5(node) && node.__typename === "PullRequest" ? byNode.get(node.id) : null;
      if (!row) fail5("INVALID_RESPONSE");
      row.review.review = REVIEW[node.reviewDecision] ?? null;
      row.review.checks = CHECKS[node.statusCheckRollup?.state] ?? null;
    }
  }
}
async function fetchReviewQueue(input, options = {}) {
  if (!object5(input) || input.v !== 1 || !["reviews", "probe"].includes(input.operation)) fail5("INVALID_REQUEST");
  const connection = validateGithubConnection(input.connection);
  if (!connection.gh && !connection.credentialEnv) fail5("INVALID_CONNECTION");
  const ctx = context(options);
  try {
    const auth = await ctx.auth(connection);
    if (input.operation === "probe") {
      const user = await ctx.call(auth, connection.apiBase + "/user");
      if (!object5(user) || typeof user.login !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(user.login)) fail5("INVALID_RESPONSE");
      return { login: user.login };
    }
    const all = await search(auth, QUERIES.all, "team", ctx), direct = await search(auth, QUERIES.direct, "direct", ctx);
    for (const [key, row] of direct.rows) all.rows.set(key, row);
    const rows = [...all.rows.values()];
    let detailsUnavailable = false;
    try {
      await details(auth, rows, ctx);
    } catch (error) {
      if (["REQUEST_CANCELLED", "REQUEST_TIMEOUT"].includes(error?.code)) throw error;
      detailsUnavailable = true;
      for (const row of rows) {
        row.review.review = null;
        row.review.checks = null;
      }
    }
    const reviews = rows.map((row) => row.review);
    return { fetchedAt: ctx.clock(), direct: sortReviews(reviews.filter((r) => r.section === "direct")), team: sortReviews(reviews.filter((r) => r.section === "team")), truncated: all.truncated || direct.truncated, incomplete: all.incomplete || direct.incomplete, detailsUnavailable };
  } finally {
    ctx.cancel();
  }
}

// src/mods/mission-control-reviews/backend.mjs
async function dispatchReviews(input, options = {}) {
  try {
    const result = await fetchReviewQueue(input, options);
    return input.operation === "probe" ? { v: 1, ok: true, operation: "probe", login: result.login } : { v: 1, ok: true, operation: "reviews", snapshot: result };
  } catch (error) {
    const code = error instanceof TrackerError ? error.code : ["INVALID_REVIEW"].includes(error?.code) ? "INVALID_RESPONSE" : "REQUEST_FAILED";
    return { v: 1, ok: false, error: publicTrackerError(error instanceof TrackerError ? error : new TrackerError(code)) };
  }
}
async function main(argv = process.argv.slice(2)) {
  let reply;
  try {
    if (argv.length !== 1 || Buffer.byteLength(argv[0]) > 65536) throw new TrackerError("INVALID_REQUEST");
    reply = await dispatchReviews(JSON.parse(argv[0]));
  } catch {
    reply = { v: 1, ok: false, error: publicTrackerError(new TrackerError("INVALID_REQUEST")) };
  }
  let output = JSON.stringify(reply);
  if (Buffer.byteLength(output) > 8 * 1024 * 1024) output = JSON.stringify({ v: 1, ok: false, error: publicTrackerError(new TrackerError("RESPONSE_TOO_LARGE")) });
  process.stdout.write(output + "\n");
}
var executable = false;
try {
  executable = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
} catch {
}
if (executable) await main();
export {
  dispatchReviews,
  main
};
