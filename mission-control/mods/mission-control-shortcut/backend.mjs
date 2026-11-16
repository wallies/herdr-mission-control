import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);

// src/mods/mission-control-shortcut/backend.mjs
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

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
  for (const [id3, connection] of Object.entries(normalized.connections)) {
    if (!/^[a-z][a-z0-9-]{0,95}$/.test(id3) || !object(connection) || connection.id !== id3 || typeof connection.kind !== "string") fail("Connections require a matching stable id and adapter kind.");
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
var exact = (value, required, optional = []) => object2(value) && required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => required.includes(k) || optional.includes(k));
var id = (v) => text(v, 96) && /^[a-z][a-z0-9-]*$/.test(v) && !["constructor", "prototype"].includes(v);
var envName = (v) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v);
var strings = (v, max = 96) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= 8192 && !s.includes("\0"));
var clone = (v) => JSON.parse(JSON.stringify(v));
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
function jsonData(value, code) {
  try {
    validateConfig({ v: 1, preferences: { tracker: value } });
  } catch {
    fail2(code);
  }
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
function auth(value, { optional = false, basic = true } = {}) {
  if (value === void 0 && optional) return;
  if (!object2(value) || !["bearer", ...basic ? ["basic"] : []].includes(value.kind) || !exact(value, value.kind === "basic" ? ["kind", "usernameEnv", "tokenEnv"] : ["kind", "tokenEnv"]) || !envName(value.tokenEnv) || value.kind === "basic" && !envName(value.usernameEnv)) fail2("INVALID_CONNECTION");
}
function execution(value, { stdio = false } = {}) {
  if (!exact(value, ["machine", "command", stdio ? "args" : "argsTemplate"], stdio ? ["envRefs"] : []) || value.machine !== null) {
    if (value?.machine !== void 0 && value.machine !== null) fail2("UNSUPPORTED_INTEGRATION_HOST");
    fail2("INVALID_CONNECTION");
  }
  if (!text(value.command, 4096) || !strings(value[stdio ? "args" : "argsTemplate"])) fail2("INVALID_CONNECTION");
  if (stdio && (!object2(value.envRefs) || Object.entries(value.envRefs).some(([key, ref]) => !envName(key) || !envName(ref)))) fail2("INVALID_CONNECTION");
}
function mapping(value) {
  if (!exact(value, ["issuesPath", "fields", "statusGroups"], ["nextCursorPath"]) || typeof value.issuesPath !== "string" || value.issuesPath.length > 512 || value.nextCursorPath !== void 0 && (typeof value.nextCursorPath !== "string" || value.nextCursorPath.length > 512) || !object2(value.fields) || !Object.keys(value.fields).length || Object.values(value.fields).some((v) => typeof v !== "string" || v.length > 512) || !exact(value.statusGroups, ["todo", "inProgress", "done"]) || Object.values(value.statusGroups).some((v) => !strings(v, 100))) fail2("INVALID_CONNECTION");
}
function search(value) {
  if (!exact(value, ["tool", "argsTemplate", "resultMapping"]) || !text(value.tool, 128) || !object2(value.argsTemplate)) fail2("INVALID_CONNECTION");
  mapping(value.resultMapping);
}
function validateJiraConnection(input) {
  jsonData(input, "INVALID_CONNECTION");
  if (!id(input?.id)) fail2("INVALID_CONNECTION");
  const c = clone(input);
  c.site = origin(c.site);
  switch (c.kind) {
    case "api":
      if (!exact(c, ["id", "kind", "site", "auth"], ["cloudId"]) || c.cloudId !== void 0 && !(typeof c.cloudId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.cloudId))) fail2("INVALID_CONNECTION");
      auth(c.auth);
      break;
    case "cli":
      if (!exact(c, ["id", "kind", "site", "execution", "mapping"])) fail2("INVALID_CONNECTION");
      execution(c.execution);
      mapping(c.mapping);
      break;
    case "mcp-stdio":
      if (!exact(c, ["id", "kind", "site", "execution", "search"])) fail2("INVALID_CONNECTION");
      execution(c.execution, { stdio: true });
      search(c.search);
      break;
    case "mcp-http": {
      if (!exact(c, ["id", "kind", "site", "url", "search"], ["auth"])) fail2("INVALID_CONNECTION");
      const endpoint = httpsUrl(c.url);
      if ([...endpoint.searchParams.keys()].some((key) => /^(?:access[-_]?token|api[-_]?(?:key|token)|token|auth|authorization|password|secret|x-api-key)$/i.test(key))) fail2("INVALID_CONNECTION");
      c.url = endpoint.href;
      auth(c.auth, { optional: true });
      search(c.search);
      break;
    }
    default:
      fail2("INVALID_CONNECTION");
  }
  return c;
}
var SHORTCUT_SITE = "https://app.shortcut.com";
function validateShortcutConnection(input) {
  jsonData(input, "INVALID_CONNECTION");
  if (!id(input?.id)) fail2("INVALID_CONNECTION");
  const c = clone(input);
  c.site = origin(c.site);
  if (!exact(c, ["id", "kind", "site", "execution"]) || c.kind !== "claude" || c.site !== SHORTCUT_SITE) fail2("INVALID_CONNECTION");
  if (!exact(c.execution, ["machine"], ["command"]) || c.execution.machine !== null) {
    if (c.execution?.machine !== void 0 && c.execution.machine !== null) fail2("UNSUPPORTED_INTEGRATION_HOST");
    fail2("INVALID_CONNECTION");
  }
  const command = c.execution.command;
  if (command !== void 0 && (!text(command, 4096) || command !== "claude" && !command.startsWith("/") || !/(?:^|\/)claude$/.test(command) || command.split("/").includes(".."))) fail2("INVALID_CONNECTION");
  return c;
}
function validateTrackerRequest(input, { connectionValidator = validateJiraConnection, source = "jira" } = {}) {
  const operations = { jira: ["issues", "probe"], github: ["issues", "pulls", "probe"], gitlab: ["issues", "merges", "probe"], shortcut: ["issues", "probe"] };
  jsonData(input, "INVALID_REQUEST");
  if (!exact(input, ["v", "operation", "connection", "binding"], ["cursor"]) || input.v !== 1 || !Object.hasOwn(operations, source) || !operations[source].includes(input.operation) || Buffer.byteLength(JSON.stringify(input)) > 65536 || input.cursor !== void 0 && input.cursor !== null && !text(input.cursor, 8192)) fail2("INVALID_REQUEST");
  const connection = connectionValidator(input.connection), binding = clone(input.binding);
  if (!object2(binding) || !Object.hasOwn(binding, "machine") || !(binding.machine === null || text(binding.machine, 128))) fail2("INVALID_REQUEST");
  try {
    if (canonicalRepoPath(binding.repoRoot) !== binding.repoRoot) fail2("INVALID_REQUEST");
  } catch {
    fail2("INVALID_REQUEST");
  }
  const selected = binding[source];
  if (selected !== void 0 && (selected?.connectionId !== connection.id || source === "jira" && (!text(selected.project, 256) && !text(selected.jql, 8192)) || source === "github" && (!text(selected.owner, 128) || !text(selected.repo, 128)) || source === "shortcut" && (!text(selected.owner, 128) || !text(selected.workspace, 64) || selected.query !== void 0 && !text(selected.query, 8192)))) fail2("INVALID_REQUEST");
  if (source === "gitlab" && selected !== void 0) {
    try {
      gitlabProjectPath(selected.projectPath);
    } catch {
      fail2("INVALID_REQUEST");
    }
  }
  if (input.operation !== "probe" && !selected) fail2("INVALID_REQUEST");
  return { ...clone(input), connection, binding };
}

// src/shared/tracker-model.js
var TRACKER_GROUPS = ["todo", "inProgress", "done"];
var messages2 = { INVALID_FILTER: "Choose an available board status filter.", INVALID_SCOPE: "Select a configured repository and tracker connection.", INVALID_BINDING: "The repository tracker binding is invalid.", INVALID_ISSUE: "The tracker returned an invalid issue; reload its source mapping.", INVALID_SNAPSHOT: "The tracker response does not match the requested scope.", STATUS_MAPPING_REQUIRED: "Choose an unambiguous source status mapping.", UNSUPPORTED_INTEGRATION_HOST: "CLI and stdio MCP integrations must run locally. Configure a local bridge or HTTPS MCP endpoint.", CONNECTION_CONFLICT: "This connection is already used elsewhere. Choose a new profile ID before changing it here." };
var TrackerModelError = class extends Error {
  constructor(code) {
    super(messages2[code] || messages2.INVALID_SNAPSHOT);
    this.code = Object.hasOwn(messages2, code) ? code : "INVALID_SNAPSHOT";
  }
};
var fail3 = (code) => {
  throw new TrackerModelError(code);
};
var object3 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var exact2 = (v, required, optional = []) => object3(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
var text2 = (v, max = 512) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
var id2 = (v) => text2(v, 96) && /^[a-z][a-z0-9-]*$/.test(v) && !["constructor", "prototype"].includes(v);
var machine2 = (v) => v === null || text2(v, 128);
var date = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 864e13;
var clone2 = (v) => JSON.parse(JSON.stringify(v));
var trackerSources = ["jira", "github", "github-pr", "gitlab", "gitlab-mr", "shortcut"];
var SHORTCUT_SITE2 = "https://app.shortcut.com";
var SHORTCUT_OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var SHORTCUT_WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function sourceKind(source) {
  if (!trackerSources.includes(source)) fail3("INVALID_SCOPE");
  return source === "github-pr" ? "github" : source === "gitlab-mr" ? "gitlab" : source;
}
var utf8Bytes = (value) => {
  let n = 0;
  for (const c of value) {
    const code = c.codePointAt(0);
    n += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return n;
};
function json(value, code = "INVALID_SCOPE") {
  try {
    validateConfig({ v: 1, preferences: { tracker: value } });
  } catch {
    fail3(code);
  }
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (object3(value)) return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function trackerOrigin(value) {
  if (!text2(value, 2048)) fail3("INVALID_SCOPE");
  const match = value.match(/^https:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?\/?$/);
  if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) fail3("INVALID_SCOPE");
  const host = match[1].toLowerCase();
  if (!host.startsWith("[") && host.split(".").some((part) => part.length > 63 || !part || part.startsWith("-") || part.endsWith("-"))) fail3("INVALID_SCOPE");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split(".").some((n) => Number(n) > 255)) fail3("INVALID_SCOPE");
  return "https://" + host + (match[2] && Number(match[2]) !== 443 ? ":" + Number(match[2]) : "");
}
function repoName(value) {
  return text2(value, 128) && /^[A-Za-z0-9_.-]+$/.test(value) && ![".", ".."].includes(value);
}
function list(value, { caseFold = false } = {}) {
  if (!Array.isArray(value) || value.length > 100 || value.some((v) => !text2(v, 200))) fail3("STATUS_MAPPING_REQUIRED");
  const keys = value.map((v) => caseFold ? v.toLowerCase() : v);
  if (new Set(keys).size !== keys.length) fail3("STATUS_MAPPING_REQUIRED");
  return [...value];
}
function validateStatusMapping(value) {
  if (value === void 0) return void 0;
  if (!object3(value) || Object.keys(value).length !== 1) fail3("STATUS_MAPPING_REQUIRED");
  let groups, result, caseFold = false;
  if (Object.hasOwn(value, "labels")) {
    if (!exact2(value.labels, TRACKER_GROUPS)) fail3("STATUS_MAPPING_REQUIRED");
    caseFold = true;
    groups = Object.fromEntries(TRACKER_GROUPS.map((k) => [k, list(value.labels[k], { caseFold })]));
    result = { labels: groups };
  } else if (Object.hasOwn(value, "project")) {
    const p = value.project;
    if (!exact2(p, ["owner", "number", "fieldId", "options", "unmapped"]) || !repoName(p.owner) || !Number.isSafeInteger(p.number) || p.number < 1 || !text2(p.fieldId, 200) || p.unmapped !== "error" || !exact2(p.options, TRACKER_GROUPS)) fail3("STATUS_MAPPING_REQUIRED");
    groups = Object.fromEntries(TRACKER_GROUPS.map((k) => [k, list(p.options[k])]));
    result = { project: { ...clone2(p), options: groups } };
  } else fail3("STATUS_MAPPING_REQUIRED");
  const used = /* @__PURE__ */ new Set();
  for (const values of Object.values(groups)) for (const value2 of values) {
    const key = caseFold ? value2.toLowerCase() : value2;
    if (used.has(key)) fail3("STATUS_MAPPING_REQUIRED");
    used.add(key);
  }
  return result;
}
function selection(value, source) {
  if (!object3(value) || !id2(value.connectionId)) fail3("INVALID_BINDING");
  if (source === "jira") {
    if (!exact2(value, ["connectionId"], ["project", "jql"]) || !value.project && !value.jql || value.project !== void 0 && !text2(value.project, 256) || value.jql !== void 0 && !text2(value.jql, 8192)) fail3("INVALID_BINDING");
    return { connectionId: value.connectionId, ...value.project !== void 0 ? { project: value.project.trim() } : {}, ...value.jql !== void 0 ? { jql: value.jql.trim() } : {} };
  }
  if (source === "shortcut") {
    if (!exact2(value, ["connectionId", "owner", "workspace"], ["query"]) || !SHORTCUT_OWNER.test(value.owner) || !SHORTCUT_WORKSPACE.test(value.workspace) || value.query !== void 0 && !text2(value.query, 8192)) fail3("INVALID_BINDING");
    return { connectionId: value.connectionId, owner: value.owner, workspace: value.workspace, ...value.query !== void 0 ? { query: value.query.trim() } : {} };
  }
  if (source === "gitlab") {
    if (!exact2(value, ["connectionId", "projectPath"], ["status"])) fail3("INVALID_BINDING");
    let projectPath;
    try {
      projectPath = gitlabProjectPath(value.projectPath);
    } catch {
      fail3("INVALID_BINDING");
    }
    const status = validateStatusMapping(value.status);
    if (status && !Object.hasOwn(status, "labels")) fail3("STATUS_MAPPING_REQUIRED");
    return { connectionId: value.connectionId, projectPath, ...status ? { status } : {} };
  }
  if (!exact2(value, ["connectionId", "owner", "repo"], ["status"]) || !repoName(value.owner) || !repoName(value.repo)) fail3("INVALID_BINDING");
  return { connectionId: value.connectionId, owner: value.owner, repo: value.repo, ...value.status !== void 0 ? { status: validateStatusMapping(value.status) } : {} };
}
function validateRepoBinding(value) {
  if (!exact2(value, ["machine", "repoRoot"], ["jira", "github", "gitlab", "shortcut", "mountedLocalPath"]) || !machine2(value.machine)) fail3("INVALID_BINDING");
  try {
    if (canonicalRepoPath(value.repoRoot) !== value.repoRoot || value.mountedLocalPath !== void 0 && canonicalRepoPath(value.mountedLocalPath) !== value.mountedLocalPath) fail3("INVALID_BINDING");
  } catch {
    fail3("INVALID_BINDING");
  }
  return { machine: value.machine, repoRoot: value.repoRoot, ...value.jira !== void 0 ? { jira: selection(value.jira, "jira") } : {}, ...value.github !== void 0 ? { github: selection(value.github, "github") } : {}, ...value.gitlab !== void 0 ? { gitlab: selection(value.gitlab, "gitlab") } : {}, ...value.shortcut !== void 0 ? { shortcut: selection(value.shortcut, "shortcut") } : {}, ...value.mountedLocalPath !== void 0 ? { mountedLocalPath: value.mountedLocalPath } : {} };
}
function connectionHeader(value, source) {
  json(value);
  if (!object3(value) || !id2(value.id) || !text2(value.kind, 80)) fail3("INVALID_SCOPE");
  const site = trackerOrigin(value.site);
  if (source === "jira" && !["api", "cli", "mcp-stdio", "mcp-http"].includes(value.kind) || source === "shortcut" && (value.kind !== "claude" || site !== SHORTCUT_SITE2)) fail3("INVALID_SCOPE");
  if (["cli", "mcp-stdio", "claude"].includes(value.kind) && value.execution?.machine !== null) fail3("UNSUPPORTED_INTEGRATION_HOST");
  return { ...clone2(value), site };
}
function trackerScope(source, connection, binding) {
  const kind = sourceKind(source), b = validateRepoBinding(binding), selected = b[kind], c = connectionHeader(connection, kind);
  if (!selected || selected.connectionId !== c.id) fail3("INVALID_SCOPE");
  const fingerprint = stable(c);
  if (fingerprint.length > 32e3) fail3("INVALID_SCOPE");
  return { v: 1, source, machine: b.machine, repoRoot: b.repoRoot, connectionId: c.id, site: c.site, selection: clone2(selected), fingerprint };
}
function validateTrackerScope(value) {
  if (!exact2(value, ["v", "source", "machine", "repoRoot", "connectionId", "site", "selection", "fingerprint"]) || value.v !== 1 || !trackerSources.includes(value.source) || !machine2(value.machine) || !id2(value.connectionId) || !text2(value.fingerprint, 32e3)) fail3("INVALID_SCOPE");
  try {
    if (canonicalRepoPath(value.repoRoot) !== value.repoRoot || trackerOrigin(value.site) !== value.site) fail3("INVALID_SCOPE");
  } catch {
    fail3("INVALID_SCOPE");
  }
  const selected = selection(value.selection, sourceKind(value.source));
  if (selected.connectionId !== value.connectionId || stable(selected) !== stable(value.selection)) fail3("INVALID_SCOPE");
  return clone2(value);
}
var trackerScopeKey = (scope) => stable(validateTrackerScope(scope));
function validateIssue(value, { scope } = {}) {
  if (!exact2(value, ["identity", "key", "title", "url", "body", "statusGroup", "statusName", "repoBinding"], ["priority", "updatedAt"])) fail3("INVALID_ISSUE");
  const i = value.identity;
  if (!exact2(i, ["kind", "connectionId", "site", "id"]) || !["jira", "github", "gitlab", "shortcut"].includes(i.kind) || !id2(i.connectionId) || !text2(i.id, 200) || !text2(value.key, 200) || !text2(value.title, 512) || !text2(value.statusName, 200) || !TRACKER_GROUPS.includes(value.statusGroup) || typeof value.body !== "string" || utf8Bytes(value.body) > 64e3 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.body) || value.priority !== void 0 && !text2(value.priority, 128)) fail3("INVALID_ISSUE");
  let binding, site;
  try {
    binding = validateRepoBinding(value.repoBinding);
    site = trackerOrigin(i.site);
  } catch {
    fail3("INVALID_ISSUE");
  }
  if (site !== i.site || binding[i.kind]?.connectionId !== i.connectionId || !text2(value.url, 4096)) fail3("INVALID_ISSUE");
  if (i.kind === "jira") {
    if (!/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/.test(value.key) || value.url !== site + "/browse/" + value.key) fail3("INVALID_ISSUE");
  } else if (i.kind === "shortcut") {
    if (site !== SHORTCUT_SITE2 || !/^[1-9][0-9]{0,15}$/.test(i.id) || value.key !== "sc-" + i.id || value.url !== site + "/" + binding.shortcut.workspace + "/story/" + i.id) fail3("INVALID_ISSUE");
  } else if (i.kind === "gitlab") {
    const number = value.key.match(/^GL-([1-9][0-9]*)$/);
    if (!/^[1-9][0-9]*$/.test(i.id) || !number || value.url !== site + "/" + binding.gitlab.projectPath + "/-/issues/" + number[1]) fail3("INVALID_ISSUE");
  } else {
    const prefix = site + "/" + binding.github.owner + "/" + binding.github.repo + "/issues/", parts = value.url.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/)([1-9][0-9]*)$/);
    if (!parts || parts[1].toLowerCase() !== prefix.toLowerCase()) fail3("INVALID_ISSUE");
  }
  if (value.updatedAt !== void 0 && !date(value.updatedAt)) fail3("INVALID_ISSUE");
  if (scope) {
    const s = validateTrackerScope(scope);
    if (s.source !== i.kind || s.connectionId !== i.connectionId || s.site !== site || s.machine !== binding.machine || s.repoRoot !== binding.repoRoot || stable(s.selection) !== stable(binding[i.kind])) fail3("INVALID_SNAPSHOT");
  }
  return { ...clone2(value), repoBinding: binding };
}
function issueIdentityKey(issue) {
  const i = issue.identity, b = issue.repoBinding;
  return stable([i.kind, i.connectionId, i.site, i.id, b.machine, b.repoRoot]);
}
function validateSnapshot(value, expectedScope, { validateItem = validateIssue, itemKey = issueIdentityKey, now = Date.now() } = {}) {
  const scope = validateTrackerScope(expectedScope);
  if (!exact2(value, ["data", "fetchedAt", "scope", "truncated"], ["cursor", "error"]) || !Array.isArray(value.data) || value.data.length > 1e3 || !date(value.fetchedAt) || value.fetchedAt < 0 || value.fetchedAt > now + 5e3 || typeof value.truncated !== "boolean" || value.cursor !== void 0 && value.cursor !== null && !text2(value.cursor, 8192) || trackerScopeKey(value.scope) !== trackerScopeKey(scope)) fail3("INVALID_SNAPSHOT");
  if (value.cursor && !value.truncated) fail3("INVALID_SNAPSHOT");
  if (value.error !== void 0 && (!exact2(value.error, ["code", "message"], ["retryAt"]) || !text2(value.error.code, 80) || !text2(value.error.message, 512) || value.error.retryAt !== void 0 && (!date(value.error.retryAt) || value.error.retryAt < 0))) fail3("INVALID_SNAPSHOT");
  const seen = /* @__PURE__ */ new Set(), data = value.data.map((item) => {
    const checked = validateItem(item, { scope }), key = itemKey(checked);
    if (seen.has(key)) fail3("INVALID_SNAPSHOT");
    seen.add(key);
    return checked;
  });
  const result = { ...clone2(value), data, scope };
  if (utf8Bytes(JSON.stringify(result)) > 8 * 1024 * 1024) fail3("INVALID_SNAPSHOT");
  return result;
}

// src/mods/mission-control-shortcut/claude.mjs
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
var MCP_CONFIG = JSON.stringify({ mcpServers: { shortcut: { type: "http", url: "https://mcp.shortcut.com/mcp" } } });
var SYSTEM_PROMPT = "You fetch Shortcut stories with the tools given and return them in the required JSON. Copy field values exactly from tool results.";
var SEARCH_TOOL = "mcp__shortcut__search_stories";
var WHOAMI_TOOL = "mcp__shortcut__get_whoami";
var MAX_TIMEOUT_MS = 12e4;
var MAX_STORIES = 1e3;
var MAX_STDOUT = 4194304;
var MAX_STDERR = 65536;
var ENV_KEYS = ["HOME", "PATH", "USER", "LANG"];
var OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var STORY_FIELDS = ["id", "name", "app_url", "state", "updated_at", "group"];
var GROUPS = ["todo", "inProgress"];
var object4 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var exact3 = (v, keys) => object4(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
var text3 = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
var count = (v) => Number.isSafeInteger(v) && v >= 0;
var fail4 = (code) => {
  throw new TrackerError(code);
};
var SIGN_IN = 'If the Shortcut tool is unavailable or asks you to sign in, return status "sign_in_required" and nothing else from Shortcut; otherwise return status "ok".';
var storySchema = { type: "object", additionalProperties: false, required: STORY_FIELDS, properties: { id: { type: "integer" }, name: { type: "string" }, app_url: { type: "string" }, state: { type: "string" }, updated_at: { type: ["string", "null"] }, group: { type: "string", enum: GROUPS } } };
var STORIES_SCHEMA = { type: "object", additionalProperties: false, required: ["status", "stories", "started_total", "unstarted_total"], properties: { status: { type: "string", enum: ["ok", "sign_in_required"] }, stories: { type: "array", items: storySchema }, started_total: { type: "integer", minimum: 0 }, unstarted_total: { type: "integer", minimum: 0 } } };
var WHOAMI_SCHEMA = { type: "object", additionalProperties: false, required: ["status", "mention_name", "workspace_slug"], properties: { status: { type: "string", enum: ["ok", "sign_in_required"] }, mention_name: { type: "string" }, workspace_slug: { type: "string" } } };
function shortcutQueries(selection2) {
  const base = selection2.query ?? "owner:" + selection2.owner;
  return { todo: base + " is:unstarted", inProgress: base + " is:started" };
}
function storiesPrompt(queries) {
  return "Call " + SEARCH_TOOL + ' with fields ["id","name","app_url","workflow_state","updated_at"] and limit 100 for query ' + JSON.stringify(queries.inProgress) + " (group inProgress) and for query " + JSON.stringify(queries.todo) + " (group todo), following next pages with the cursor. Return every story; state is workflow_state.name. Set started_total and unstarted_total to total_items from the first page of each query. " + SIGN_IN;
}
var WHOAMI_PROMPT = "Call " + WHOAMI_TOOL + ". Set mention_name to member.mention_name and workspace_slug to workspace.slug. " + SIGN_IN;
function claudeArgs({ tool, schema, prompt }) {
  return ["-p", "--model", "haiku", "--max-budget-usd", "0.10", "--no-session-persistence", "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", MCP_CONFIG, "--disable-slash-commands", "--system-prompt", SYSTEM_PROMPT, "--tools", tool, "--allowedTools", tool, "--output-format", "json", "--json-schema", JSON.stringify(schema), prompt];
}
async function resolveClaude(connection, env = process.env) {
  const command = connection.execution.command ?? "claude";
  const candidates = path.isAbsolute(command) ? [command] : (env.PATH || "").split(path.delimiter).filter((p) => path.isAbsolute(p)).map((p) => path.join(p, command));
  for (const file of candidates) {
    try {
      await fs.access(file, constants.X_OK);
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
    }
  }
  fail4("CLAUDE_UNAVAILABLE");
}
function execute(command, args, { spawn, cwd, env, timeoutMs, signal }) {
  if (signal?.aborted) return Promise.reject(new TrackerError("REQUEST_CANCELLED"));
  return new Promise((resolve, reject) => {
    let child, done = false, size = 0, stderrBytes = 0;
    const stdout = [];
    const kill = () => {
      if (!child) return;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
      }
    };
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) kill();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(new TrackerError("REQUEST_CANCELLED"));
    const timer = setTimeout(() => finish(new TrackerError("REQUEST_TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(new TrackerError(error?.code === "ENOENT" ? "CLAUDE_UNAVAILABLE" : "CLAUDE_FAILED"));
      return;
    }
    child.on("error", (error) => finish(new TrackerError(error?.code === "ENOENT" ? "CLAUDE_UNAVAILABLE" : "CLAUDE_FAILED")));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDOUT) finish(new TrackerError("RESPONSE_TOO_LARGE"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR) finish(new TrackerError("RESPONSE_TOO_LARGE"));
    });
    child.on("close", (code) => {
      if (done) return;
      let value;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)));
      } catch {
        finish(new TrackerError(code === 0 ? "INVALID_RESPONSE" : "CLAUDE_FAILED"));
        return;
      }
      finish(null, value);
    });
  });
}
function claudeOutput(value) {
  if (!object4(value)) fail4("INVALID_RESPONSE");
  if (value.terminal_reason === "budget_exhausted" || value.subtype === "error_max_budget_usd") fail4("BUDGET_EXHAUSTED");
  if (value.is_error !== false || value.subtype !== "success") fail4("CLAUDE_FAILED");
  const out = value.structured_output;
  if (!object4(out)) fail4("INVALID_RESPONSE");
  if (out.status === "sign_in_required") fail4("SHORTCUT_SIGN_IN_REQUIRED");
  if (out.status !== "ok") fail4("INVALID_RESPONSE");
  return out;
}
async function runClaude(connection, run, options) {
  const { env = process.env, spawn = nodeSpawn, signal, timeoutMs = MAX_TIMEOUT_MS, workRoot = os.tmpdir() } = options;
  if (typeof spawn !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || !path.isAbsolute(workRoot)) fail4("INVALID_REQUEST");
  const command = await resolveClaude(connection, env), childEnv = Object.fromEntries(ENV_KEYS.filter((k) => typeof env[k] === "string").map((k) => [k, env[k]]));
  const cwd = await fs.mkdtemp(path.join(workRoot, "mc-shortcut-claude-"));
  try {
    return claudeOutput(await execute(command, claudeArgs(run), { spawn, cwd, env: childEnv, timeoutMs, signal }));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
function request(input, operation) {
  const r = validateTrackerRequest(input, { connectionValidator: validateShortcutConnection, source: "shortcut" });
  if (r.operation !== operation || r.cursor !== void 0 && r.cursor !== null) fail4("INVALID_REQUEST");
  return r;
}
async function probeShortcutClaude(input, options = {}) {
  const r = request(input, "probe"), out = await runClaude(r.connection, { tool: WHOAMI_TOOL, schema: WHOAMI_SCHEMA, prompt: WHOAMI_PROMPT }, options);
  if (!exact3(out, ["status", "mention_name", "workspace_slug"]) || !OWNER.test(out.mention_name) || !WORKSPACE.test(out.workspace_slug)) fail4("INVALID_RESPONSE");
  return { site: SHORTCUT_SITE, owner: out.mention_name, workspace: out.workspace_slug };
}
function storyRow(story, { connection, binding, scope, workspace }) {
  if (!exact3(story, STORY_FIELDS) || !Number.isSafeInteger(story.id) || story.id < 1 || !text3(story.name, 512) || !text3(story.state, 200) || !GROUPS.includes(story.group) || story.app_url !== SHORTCUT_SITE + "/" + workspace + "/story/" + story.id || story.updated_at !== null && typeof story.updated_at !== "string") fail4("INVALID_RESPONSE");
  const id3 = String(story.id), row = { identity: { kind: "shortcut", connectionId: connection.id, site: SHORTCUT_SITE, id: id3 }, key: "sc-" + id3, title: story.name, url: story.app_url, body: "", statusGroup: story.group, statusName: story.state, repoBinding: binding };
  if (story.updated_at !== null) {
    const time = Date.parse(story.updated_at);
    if (!Number.isFinite(time) || time < 0) fail4("INVALID_RESPONSE");
    row.updatedAt = time;
  }
  try {
    return validateIssue(row, { scope });
  } catch {
    fail4("INVALID_RESPONSE");
  }
}
async function fetchShortcutClaude(input, options = {}) {
  const r = request(input, "issues"), clock = options.clock ?? (() => Date.now());
  if (typeof clock !== "function") fail4("INVALID_REQUEST");
  const scope = trackerScope("shortcut", r.connection, r.binding), selection2 = scope.selection;
  const out = await runClaude(r.connection, { tool: SEARCH_TOOL, schema: STORIES_SCHEMA, prompt: storiesPrompt(shortcutQueries(selection2)) }, options);
  if (!exact3(out, ["status", "stories", "started_total", "unstarted_total"]) || !Array.isArray(out.stories) || !count(out.started_total) || !count(out.unstarted_total)) fail4("INVALID_RESPONSE");
  const context = { connection: r.connection, binding: r.binding, scope, workspace: selection2.workspace }, ids = /* @__PURE__ */ new Set(), counts = { todo: 0, inProgress: 0 }, rows = [];
  for (const story of out.stories) {
    const row = storyRow(story, context);
    if (ids.has(row.identity.id)) fail4("INVALID_RESPONSE");
    ids.add(row.identity.id);
    counts[row.statusGroup]++;
    rows.push(row);
  }
  const incomplete = counts.inProgress !== out.started_total || counts.todo !== out.unstarted_total || rows.length > MAX_STORIES;
  const error = incomplete ? { code: "INCOMPLETE_RESULTS", message: new TrackerError("INCOMPLETE_RESULTS").message } : void 0;
  return validateSnapshot({ data: rows.slice(0, MAX_STORIES), fetchedAt: clock(), scope, truncated: incomplete, ...error ? { error } : {} }, scope, { now: clock() });
}

// src/mods/mission-control-shortcut/backend.mjs
var fail5 = (code) => {
  throw new TrackerError(code);
};
async function dispatchShortcut(input, options = {}) {
  try {
    const request2 = validateTrackerRequest(input, { connectionValidator: validateShortcutConnection, source: "shortcut" });
    request2.binding = validateRepoBinding(request2.binding);
    const clock = options.clock || (() => Date.now());
    if (typeof clock !== "function") fail5("INVALID_REQUEST");
    const adapterOptions = { ...options.claude || {}, clock, ...options.env ? { env: options.env } : {} };
    if (request2.operation === "probe") return { v: 1, ok: true, operation: "probe", connection: request2.connection, probe: await probeShortcutClaude(request2, adapterOptions) };
    const scope = trackerScope("shortcut", request2.connection, request2.binding);
    return { v: 1, ok: true, operation: "issues", snapshot: validateSnapshot(await fetchShortcutClaude(request2, adapterOptions), scope, { now: clock() }) };
  } catch (error) {
    const mapped = error instanceof TrackerModelError ? new TrackerError(["INVALID_SNAPSHOT", "INVALID_ISSUE"].includes(error.code) ? "INVALID_RESPONSE" : error.code === "INVALID_BINDING" ? "INVALID_SCOPE" : error.code) : error;
    return { v: 1, ok: false, error: publicTrackerError(mapped) };
  }
}
async function main(argv = process.argv.slice(2)) {
  let result;
  try {
    if (argv.length !== 1 || Buffer.byteLength(argv[0], "utf8") > 65536) fail5("INVALID_REQUEST");
    result = await dispatchShortcut(JSON.parse(argv[0]));
  } catch {
    result = { v: 1, ok: false, error: publicTrackerError(new TrackerError("INVALID_REQUEST")) };
  }
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {
    process.stdout.write(JSON.stringify({ v: 1, ok: false, error: publicTrackerError(new TrackerError("RESPONSE_TOO_LARGE")) }) + "\n");
    return;
  }
  process.stdout.write(serialized + "\n");
}
var executable = false;
try {
  executable = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
} catch {
}
if (executable) await main();
export {
  dispatchShortcut,
  main
};
