/**
 * Claude Code cloud sessions that Mission Control follows. Claude Code has no command that lists
 * cloud sessions, so this private file is the only list: sessions started from Mission Control and
 * sessions people add by URL. Pure validation plus a CAS store; no Node, DOM or GPUI.
 */
export class CloudSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CloudSessionError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new CloudSessionError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));

export const MAX_SESSIONS = 100;
/** Shared state that tells every Mission Control copy the list changed; it holds no records. */
export const CLOUD_EVENT = 'mission-control-cloud-sessions-v1';
/** Bytes, under the 1 MiB that Herdr's readTextFile reads. */
export const MAX_STORE_BYTES = 1000000;
/** Messages sent from Mission Control, kept per session, oldest dropped first. */
export const MESSAGES_PER_SESSION = 20;
const MESSAGE_STATES = ['queued', 'failed'];
export const SESSION_SITE = 'https://claude.ai/code/';
const SESSION_ID = /^session_[A-Za-z0-9]{8,64}$/;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const RECORD_KEYS = ['id', 'url', 'repo', 'checkout', 'title', 'source', 'createdAt', 'pr', 'checkedAt', 'messages'];
const PR_KEYS = ['number', 'url', 'state', 'draft', 'checks', 'review'];
const PR_STATES = ['open', 'closed', 'merged'];
const CHECK_STATES = ['success', 'failure', 'pending'];
const REVIEW_STATES = ['approved', 'changesRequested', 'reviewRequired'];
const SOURCE_KINDS = ['shortcut', 'pr'];

/**
 * A bare id (`session_…`, or the same session's `cse_…` form) or a claude.ai/code URL, with or
 * without its scheme and query string. Returns the canonical id and URL.
 */
export function parseSessionRef(value) {
  if (typeof value !== 'string') fail('INVALID_SESSION', 'Enter a cloud session URL or ID.');
  let ref = value.trim();
  const link = ref.match(/^(?:https:\/\/)?claude\.ai\/code\/([^/?#\s]+)\/?(?:[?#]\S*)?$/);
  if (link) ref = link[1];
  if (ref.startsWith('cse_')) ref = 'session_' + ref.slice(4);
  if (!SESSION_ID.test(ref)) fail('INVALID_SESSION', 'Enter a cloud session URL (https://claude.ai/code/session_…) or its session ID.');
  return { id: ref, url: SESSION_SITE + ref };
}

/** `owner/name` of a GitHub repository, as typed (GitHub names are case-insensitive). */
export function githubRepo(value) {
  const parts = typeof value === 'string' ? value.trim().split('/') : [];
  if (parts.length !== 2 || !parts.every(part => REPO_PART.test(part) && part !== '.' && part !== '..')) fail('INVALID_REPO', 'Enter the repository as owner/name, such as acme/botanic.');
  return parts.join('/');
}

/** `owner/name` when a Git remote URL is a github.com repository, else null. */
export function repoFromRemote(url) {
  if (typeof url !== 'string') return null;
  const match = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  try { return githubRepo(match[1] + '/' + match[2]); } catch { return null; }
}

export function validatePull(value) {
  if (!exact(value, PR_KEYS)) fail('INVALID_STORE', 'A cloud session pull request is invalid.');
  if (!Number.isSafeInteger(value.number) || value.number < 1 || typeof value.url !== 'string' || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9][0-9]*$/.test(value.url) || !value.url.endsWith('/pull/' + value.number)) fail('INVALID_STORE', 'A cloud session pull request link is invalid.');
  if (!PR_STATES.includes(value.state) || typeof value.draft !== 'boolean' || value.checks !== null && !CHECK_STATES.includes(value.checks) || value.review !== null && !REVIEW_STATES.includes(value.review)) fail('INVALID_STORE', 'A cloud session pull request state is invalid.');
}

/** One record, strictly: every field present, nothing extra, no secrets. */
export function validateRecord(value) {
  if (!exact(value, RECORD_KEYS)) fail('INVALID_STORE', 'A cloud session record has missing or unknown fields.');
  const { id, url } = parseSessionRef(typeof value.id === 'string' ? value.id : '');
  if (id !== value.id || url !== value.url) fail('INVALID_STORE', 'A cloud session record has a mismatched link.');
  if (githubRepo(value.repo) !== value.repo) fail('INVALID_STORE', 'A cloud session repository is invalid.');
  if (value.checkout !== null && (!text(value.checkout, 4096) || !value.checkout.startsWith('/') || value.checkout.split('/').some(part => part === '.' || part === '..'))) fail('INVALID_STORE', 'A cloud session checkout must be an absolute folder.');
  if (!text(value.title, 200)) fail('INVALID_STORE', 'A cloud session title is invalid.');
  if (value.source !== null && (!exact(value.source, ['kind', 'key']) || !SOURCE_KINDS.includes(value.source.kind) || !text(value.source.key, 200))) fail('INVALID_STORE', 'A cloud session source is invalid.');
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) fail('INVALID_STORE', 'A cloud session time is invalid.');
  if (value.pr !== null) validatePull(value.pr);
  if (value.checkedAt !== null && (!Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0)) fail('INVALID_STORE', 'A cloud session check time is invalid.');
  validateMessages(value.messages);
  return copy(value);
}

/** What Mission Control sent: when, the text, and whether Claude Code queued it or why it failed. */
export function validateMessages(value) {
  if (!Array.isArray(value) || value.length > MESSAGES_PER_SESSION) fail('INVALID_STORE', `A cloud session keeps at most ${MESSAGES_PER_SESSION} sent messages.`);
  for (const m of value) {
    if (!exact(m, ['at', 'text', 'state', 'error']) || !Number.isSafeInteger(m.at) || m.at < 0 || !MESSAGE_STATES.includes(m.state)) fail('INVALID_STORE', 'A sent message is invalid.');
    if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MESSAGE_MAX || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(m.text)) fail('INVALID_STORE', 'A sent message text is invalid.');
    if (m.state === 'queued' ? m.error !== null : !text(m.error, 512)) fail('INVALID_STORE', 'A sent message state is invalid.');
  }
}
export function utf8Bytes(value) {
  let bytes = 0;
  for (const ch of value) { const c = ch.codePointAt(0); bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return bytes;
}

export function validateStore(value) {
  if (!exact(value, ['v', 'revision', 'sessions']) || value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.sessions)) fail('INVALID_STORE', 'The cloud session list is invalid; the original file was preserved.');
  if (value.sessions.length > MAX_SESSIONS) fail('STORE_FULL', `Mission Control follows at most ${MAX_SESSIONS} cloud sessions. Remove one first.`);
  const seen = new Set();
  const sessions = value.sessions.map(record => {
    // Records written before sent messages were kept have no messages field.
    const checked = validateRecord(object(record) && !Object.hasOwn(record, 'messages') ? { ...record, messages: [] } : record);
    if (seen.has(checked.id)) fail('INVALID_STORE', 'The cloud session list repeats a session.');
    seen.add(checked.id);
    return checked;
  });
  return { v: 1, revision: value.revision, sessions };
}

/** A new record before any pull request is known. */
export function newRecord({ ref, repo, checkout = null, title, source = null, createdAt }) {
  const { id, url } = parseSessionRef(ref);
  const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Cloud session ' + id.slice(8, 16);
  return validateRecord({ id, url, repo: githubRepo(repo), checkout, title: name, source, createdAt, pr: null, checkedAt: null, messages: [] });
}

export function cloudStorePath(io) {
  const app = typeof io.appHome === 'function' ? io.appHome() : io.appHome;
  if (typeof app !== 'string' || !app.startsWith('/')) fail('STORE_PATH', 'The Herdr app home is unavailable.');
  return app.replace(/\/+$/, '') + '/mission-control/cloud-sessions.json';
}

const conflict = error => ['STALE', 'CONFLICT', 'EAGAIN'].includes(error?.code) || /stale|snapshot|contents?.*changed|expected.*match|compare.and.set/i.test(error?.message ?? '');

/** Reads and edits the file with Herdr's compare-and-set write, so two copies never lose an edit. */
export class CloudSessionStore {
  constructor(io) { this.io = io; this.path = cloudStorePath(io); }

  async snapshot() {
    const raw = await this.io.readTextFile(this.path);
    if (raw === null) return { raw, value: { v: 1, revision: 0, sessions: [] } };
    if (typeof raw !== 'string' || utf8Bytes(raw) > MAX_STORE_BYTES) fail('INVALID_STORE', 'The cloud session list exceeds its supported size; the original file was preserved.');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('INVALID_STORE', 'The cloud session list is not valid JSON; the original file was preserved.'); }
    return { raw, value: validateStore(parsed) };
  }

  async list() { return (await this.snapshot()).value.sessions; }

  /** `change` edits the session array in place and is rerun on a fresher copy after a conflict. */
  async edit(change) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { raw, value } = await this.snapshot();
      const draft = copy(value);
      change(draft.sessions);
      draft.revision++;
      const next = validateStore(draft), body = JSON.stringify(next, null, 2) + '\n';
      if (utf8Bytes(body) > MAX_STORE_BYTES) fail('STORE_FULL', 'The cloud session list is full. Remove a session first.');
      await this.io.ensureDirectory?.(this.path.slice(0, this.path.lastIndexOf('/')));
      try {
        await this.io.writeTextFile(this.path, body, raw);
        return next.sessions;
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    fail('CONFLICT', 'The cloud session list changed repeatedly. Try again.');
  }

  add(record) {
    const checked = validateRecord(record);
    return this.edit(sessions => {
      if (sessions.some(s => s.id === checked.id)) fail('DUPLICATE', 'Mission Control already follows this cloud session.');
      sessions.push(checked);
    });
  }

  /** Forgets the record only; the cloud session itself is untouched. */
  remove(id) {
    return this.edit(sessions => {
      const index = sessions.findIndex(s => s.id === id);
      if (index >= 0) sessions.splice(index, 1);
    });
  }

  /**
   * Keeps one sent message on its session, newest last, at most MESSAGES_PER_SESSION. When the file
   * would outgrow its cap, that session keeps fewer of its oldest messages.
   */
  async recordMessage(id, entry) {
    for (let keep = MESSAGES_PER_SESSION; ; keep = Math.floor(keep / 2)) {
      try {
        return await this.edit(sessions => {
          const session = sessions.find(s => s.id === id);
          if (!session) fail('NOT_FOUND', 'Mission Control no longer follows this cloud session.');
          session.messages = [...session.messages, copy(entry)].slice(-Math.max(keep, 1));
        });
      } catch (error) {
        if (error?.code !== 'STORE_FULL' || keep <= 1) throw error;
      }
    }
  }

  /** `found` maps a session id to its pull request (or null when none is found yet). */
  recordPulls(found, checkedAt) {
    return this.edit(sessions => {
      for (const session of sessions) {
        if (!Object.hasOwn(found, session.id)) continue;
        if (found[session.id] !== null) session.pr = copy(found[session.id]);
        session.checkedAt = checkedAt;
      }
    });
  }
}

/** What the rail shows: `started` until a pull request is found, then that pull request's state. */
export function cloudStatus(record) {
  const pr = record.pr;
  if (!pr) return 'started';
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  if (pr.checks === 'failure') return 'checksFailing';
  if (pr.checks === 'pending') return 'checksRunning';
  if (pr.review === 'changesRequested') return 'changesRequested';
  if (pr.review === 'approved') return 'approved';
  return 'reviewRequested';
}
export const STATUS_LABELS = Object.freeze({ started: 'Started', draft: 'Draft', checksRunning: 'Checks running', checksFailing: 'Checks failing', reviewRequested: 'Review requested', changesRequested: 'Changes requested', approved: 'Approved', merged: 'Merged', closed: 'Closed' });
/** The theme status color each state borrows from local agents. */
export const STATUS_COLORS = Object.freeze({ started: 'working', draft: 'idle', checksRunning: 'working', checksFailing: 'blocked', reviewRequested: 'idle', changesRequested: 'blocked', approved: 'done', merged: 'done', closed: 'idle' });

/** The exact Claude Code arguments. The task text names the skill in plain words, never a slash command. */
export const createArgs = task => ['--cloud', task];
export const messageArgs = (id, message) => ['-p', message, '--cloud', id, '--output-format', 'json'];
export const teleportArgs = id => ['--teleport', id];
export const MESSAGE_MAX = 4000;
export function validMessage(value) {
  const message = typeof value === 'string' ? value.trim() : '';
  if (!message) fail('INVALID_MESSAGE', 'Type a message first.');
  if (message.length > MESSAGE_MAX) fail('INVALID_MESSAGE', `Messages are capped at ${MESSAGE_MAX} characters.`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(message)) fail('INVALID_MESSAGE', 'Messages can use new lines, but no tabs or other control characters.');
  return message;
}

/** The first claude.ai/code session link a terminal printed, or null. */
export function findSessionLink(screen) {
  if (typeof screen !== 'string') return null;
  const match = screen.match(/https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]{8,64})/);
  if (!match) return null;
  try { return parseSessionRef(match[1]); } catch { return null; }
}
