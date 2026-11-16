import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);

// src/mods/mission-control-agents/backend.mjs
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// src/mods/mission-control-agents/cloud.mjs
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

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
  constructor(code, details = {}) {
    const safe = Object.hasOwn(messages, code) ? code : "REQUEST_FAILED";
    super(messages[safe]);
    this.name = "TrackerError";
    this.code = safe;
    if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) this.status = details.status;
    if (Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0) this.retryAfterMs = Math.min(details.retryAfterMs, 864e5);
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
    const name = key.toLowerCase();
    if (!["authorization", "accept", "content-type", "x-github-api-version", "user-agent"].includes(name) || !text(value, 32768)) fail2("INVALID_REQUEST");
    requestHeaders[name] = value;
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
          if (metadata) for (const name of ["link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "x-next-page"]) {
            const value = response.headers[name];
            if (value !== void 0) {
              if (!(name === "x-next-page" && value === "") && !text(value, name === "link" ? 8192 : 128)) {
                response.destroy();
                finish(new TrackerError("RESPONSE_TOO_LARGE"));
                return;
              }
              responseHeaders[name] = value;
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
var flag = (help, name) => new RegExp("^\\s*(?:-\\w,\\s*)?--" + name + "(?:[ =<]|$)", "m").test(help);
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

// src/shared/cloud-sessions.js
var CloudSessionError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CloudSessionError";
    this.code = code;
  }
};
var fail4 = (code, message) => {
  throw new CloudSessionError(code, message);
};
var SESSION_SITE = "https://claude.ai/code/";
var SESSION_ID = /^session_[A-Za-z0-9]{8,64}$/;
var REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
function parseSessionRef(value) {
  if (typeof value !== "string") fail4("INVALID_SESSION", "Enter a cloud session URL or ID.");
  let ref = value.trim();
  const link = ref.match(/^(?:https:\/\/)?claude\.ai\/code\/([^/?#\s]+)\/?(?:[?#]\S*)?$/);
  if (link) ref = link[1];
  if (ref.startsWith("cse_")) ref = "session_" + ref.slice(4);
  if (!SESSION_ID.test(ref)) fail4("INVALID_SESSION", "Enter a cloud session URL (https://claude.ai/code/session_…) or its session ID.");
  return { id: ref, url: SESSION_SITE + ref };
}
function githubRepo(value) {
  const parts = typeof value === "string" ? value.trim().split("/") : [];
  if (parts.length !== 2 || !parts.every((part) => REPO_PART.test(part) && part !== "." && part !== "..")) fail4("INVALID_REPO", "Enter the repository as owner/name, such as acme/botanic.");
  return parts.join("/");
}
var STATUS_LABELS = Object.freeze({ started: "Started", draft: "Draft", checksRunning: "Checks running", checksFailing: "Checks failing", reviewRequested: "Review requested", changesRequested: "Changes requested", approved: "Approved", merged: "Merged", closed: "Closed" });
var STATUS_COLORS = Object.freeze({ started: "working", draft: "idle", checksRunning: "working", checksFailing: "blocked", reviewRequested: "idle", changesRequested: "blocked", approved: "done", merged: "done", closed: "idle" });
var messageArgs = (id, message) => ["-p", message, "--cloud", id, "--output-format", "json"];
var MESSAGE_MAX = 4e3;
function validMessage(value) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) fail4("INVALID_MESSAGE", "Type a message first.");
  if (message.length > MESSAGE_MAX) fail4("INVALID_MESSAGE", `Messages are capped at ${MESSAGE_MAX} characters.`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(message)) fail4("INVALID_MESSAGE", "Messages can use new lines, but no tabs or other control characters.");
  return message;
}

// src/mods/mission-control-agents/cloud.mjs
var CloudError = class extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.REQUEST_FAILED);
    this.name = "CloudError";
    this.code = Object.hasOwn(MESSAGES, code) ? code : "REQUEST_FAILED";
  }
};
var MESSAGES = Object.freeze({
  INVALID_REQUEST: "The cloud session request was invalid.",
  CLAUDE_UNAVAILABLE: "Claude Code (the claude command) was not found on PATH or in ~/.local/bin.",
  NOT_SIGNED_IN: "Claude Code is not signed in with a claude.ai account. Run claude auth login in a terminal, then try again.",
  CLOUD_DISABLED: "Cloud sessions are disabled for this Claude account or organization.",
  SESSION_NOT_FOUND: "Claude Code could not find this cloud session. Check its link.",
  SESSION_ARCHIVED: "This cloud session is archived and cannot take new messages.",
  SEND_FAILED: "Claude Code could not send the message. Run the same command in a terminal to see why.",
  REQUEST_TIMEOUT: "Claude Code took longer than a minute and was stopped.",
  RESPONSE_TOO_LARGE: "The reply was larger than expected.",
  INVALID_RESPONSE: "The reply did not check out. Try again.",
  NOT_GITHUB_COM: "Cloud session pull requests are looked up on github.com; the Reviews connection points elsewhere.",
  REQUEST_FAILED: "The cloud session request failed. Try again."
});
var fail5 = (code) => {
  throw new CloudError(code);
};
var object4 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var MAX_OUTPUT = 65536;
var MESSAGE_TIMEOUT_MS = 6e4;
var MAX_LOOKUPS = 20;
var ENV_KEYS = ["HOME", "PATH", "USER", "LANG", "CLAUDE_CONFIG_DIR"];
async function resolveClaude(env = process.env) {
  const dirs = (env.PATH || "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  if (typeof env.HOME === "string" && path.isAbsolute(env.HOME)) dirs.push(path.join(env.HOME, ".local/bin"));
  for (const dir of dirs) {
    const file = path.join(dir, "claude");
    try {
      await fs.access(file, constants.X_OK);
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
    }
  }
  fail5("CLAUDE_UNAVAILABLE");
}
function execute(command, args, { spawn: spawn2 = nodeSpawn, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child, done = false, bytes = 0;
    const out = [], err = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        try {
          child?.kill("SIGKILL");
        } catch {
        }
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new CloudError("REQUEST_TIMEOUT")), timeoutMs);
    try {
      child = spawn2(command, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(new CloudError(error?.code === "ENOENT" ? "CLAUDE_UNAVAILABLE" : "SEND_FAILED"));
      return;
    }
    child.on("error", (error) => finish(new CloudError(error?.code === "ENOENT" ? "CLAUDE_UNAVAILABLE" : "SEND_FAILED")));
    const collect = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(new CloudError("RESPONSE_TOO_LARGE"));
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(out, chunk));
    child.stderr.on("data", (chunk) => collect(err, chunk));
    child.on("close", (code) => finish(null, { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}
function sendFailure(text2) {
  if (/claude auth login|claude\.ai sign-in|organization UUID|\/login/i.test(text2)) return "NOT_SIGNED_IN";
  if (/disabled by your organization|aren't available|not enabled for your account/i.test(text2)) return "CLOUD_DISABLED";
  if (/archived/i.test(text2)) return "SESSION_ARCHIVED";
  if (/session not found/i.test(text2)) return "SESSION_NOT_FOUND";
  return "SEND_FAILED";
}
async function sendMessage(input, { spawn: spawn2, env = process.env, timeoutMs = MESSAGE_TIMEOUT_MS } = {}) {
  let id, message;
  try {
    ({ id } = parseSessionRef(input.session));
    message = validMessage(input.message);
  } catch {
    fail5("INVALID_REQUEST");
  }
  if (input.session !== id) fail5("INVALID_REQUEST");
  const command = await resolveClaude(env), childEnv = Object.fromEntries(ENV_KEYS.filter((k) => typeof env[k] === "string").map((k) => [k, env[k]]));
  const result = await execute(command, messageArgs(id, message), { spawn: spawn2, env: childEnv, timeoutMs });
  let reply = null;
  try {
    reply = JSON.parse(result.stdout.trim());
  } catch {
  }
  if (object4(reply) && reply.ok === true && result.code === 0) {
    if (reply.session_id !== id || typeof reply.url !== "string" || !reply.url.startsWith("https://claude.ai/code/" + id)) fail5("INVALID_RESPONSE");
    return { session: id };
  }
  fail5(sendFailure((object4(reply) && typeof reply.error === "string" ? reply.error : "") + "\n" + result.stderr));
}
var pullQuery = (id, repo) => `is:pr in:body ${id} repo:${repo}`;
var PULL_FIELDS = "... on PullRequest { number url state isDraft updatedAt reviewDecision statusCheckRollup { state } repository { nameWithOwner } }";
function pullsDocument(count) {
  const vars = Array.from({ length: count }, (_, i) => `$q${i}: String!`).join(", ");
  const fields = Array.from({ length: count }, (_, i) => `s${i}: search(query: $q${i}, type: ISSUE, first: 10) { nodes { ${PULL_FIELDS} } }`).join("\n  ");
  return `query MissionControlCloudPulls(${vars}) {
  ${fields}
}`;
}
var REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changesRequested", REVIEW_REQUIRED: "reviewRequired" };
var CHECKS = { SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "pending", EXPECTED: "pending" };
function parsePull(node, repo) {
  if (!object4(node) || !Number.isSafeInteger(node.number) || node.number < 1 || typeof node.url !== "string" || !object4(node.repository) || typeof node.repository.nameWithOwner !== "string") fail5("INVALID_RESPONSE");
  if (node.repository.nameWithOwner.toLowerCase() !== repo.toLowerCase()) return null;
  if (node.url.toLowerCase() !== ("https://github.com/" + repo + "/pull/" + node.number).toLowerCase()) fail5("INVALID_RESPONSE");
  const state = node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : node.state === "OPEN" ? "open" : fail5("INVALID_RESPONSE");
  return { pr: { number: node.number, url: "https://github.com/" + node.repository.nameWithOwner + "/pull/" + node.number, state, draft: node.isDraft === true, checks: CHECKS[node.statusCheckRollup?.state] ?? null, review: REVIEW[node.reviewDecision] ?? null }, updated: Date.parse(node.updatedAt) || 0 };
}
function choosePull(nodes, repo) {
  const found = nodes.filter((node) => object4(node) && Object.keys(node).length).map((node) => parsePull(node, repo)).filter(Boolean);
  found.sort((a, b) => (b.pr.state === "open") - (a.pr.state === "open") || b.updated - a.updated);
  return found[0]?.pr ?? null;
}
async function findPulls(input, { request = requestJson, env = process.env, ghCommand, clock = () => Date.now(), timeoutMs = 25e3 } = {}) {
  if (!Array.isArray(input.sessions) || !input.sessions.length || input.sessions.length > MAX_LOOKUPS) fail5("INVALID_REQUEST");
  let sessions;
  try {
    sessions = input.sessions.map((s) => {
      if (!object4(s) || Object.keys(s).length !== 2) throw Error();
      const { id } = parseSessionRef(s.id);
      if (id !== s.id || githubRepo(s.repo) !== s.repo) throw Error();
      return { id, repo: s.repo };
    });
  } catch {
    fail5("INVALID_REQUEST");
  }
  let connection;
  try {
    connection = validateGithubConnection(input.connection);
  } catch {
    fail5("INVALID_REQUEST");
  }
  if (connection.site !== "https://github.com") fail5("NOT_GITHUB_COM");
  const auth = await resolveGithubAuth(connection, { env, ghCommand, timeoutMs: Math.min(8e3, timeoutMs) });
  const variables = Object.fromEntries(sessions.map((s, i) => ["q" + i, pullQuery(s.id, s.repo)]));
  const data = await request(auth.graphqlUrl, { allowedOrigin: auth.allowedOrigin, headers: auth.headers, method: "POST", body: { query: pullsDocument(sessions.length), variables }, maxRedirects: 0, timeoutMs, maxBytes: 1048576 });
  if (!object4(data) || data.errors !== void 0 && (!Array.isArray(data.errors) || data.errors.length) || !object4(data.data)) fail5("INVALID_RESPONSE");
  const found = {};
  sessions.forEach((s, i) => {
    const nodes = data.data["s" + i]?.nodes;
    if (!Array.isArray(nodes)) fail5("INVALID_RESPONSE");
    found[s.id] = choosePull(nodes, s.repo);
  });
  return { checkedAt: clock(), found };
}
async function dispatchCloud(input, options = {}) {
  try {
    if (!object4(input) || input.v !== 1) fail5("INVALID_REQUEST");
    if (input.operation === "message") return { v: 1, ok: true, operation: "message", ...await sendMessage(input, options) };
    if (input.operation === "pulls") return { v: 1, ok: true, operation: "pulls", ...await findPulls(input, options) };
    fail5("INVALID_REQUEST");
  } catch (error) {
    if (error instanceof CloudError) return { v: 1, ok: false, error: { code: error.code, message: error.message } };
    const pub = publicTrackerError(error instanceof TrackerError ? error : new TrackerError("REQUEST_FAILED"));
    return { v: 1, ok: false, error: { code: pub.code, message: pub.message } };
  }
}

// src/mods/mission-control-agents/backend.mjs
async function main(argv = process.argv.slice(2)) {
  let reply;
  try {
    if (argv.length !== 1 || Buffer.byteLength(argv[0]) > 65536) throw Error("bad request");
    reply = await dispatchCloud(JSON.parse(argv[0]));
  } catch {
    reply = { v: 1, ok: false, error: { code: "INVALID_REQUEST", message: MESSAGES.INVALID_REQUEST } };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
}
var executable = false;
try {
  executable = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
} catch {
}
if (executable) await main();
export {
  main
};
