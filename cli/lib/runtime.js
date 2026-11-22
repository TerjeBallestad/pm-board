// What every command shares: the parsed arguments, the server, the token, the board and its
// config, and the HTTP transport. One process runs one command, so this is plain module state.
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';
import http from 'http';
import https from 'https';
import { parseArgs } from './args.js';

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')).version;
export const PACKAGE_DIR = join(here, '..');
export const BOARD_FILENAME = '.pm.json';
export const DEFAULT_URL = 'https://pm.godstemning.dev';

// --- Board discovery: .pm.json {"board": "<slug>"}, found by walking up from cwd ---
function findBoardFile(startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, BOARD_FILENAME))) return join(dir, BOARD_FILENAME);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

// --- Machine config: ~/.config/pm/config.json {"url": "...", "token": "..."} ---
// PM_URL and PM_TOKEN override it. XDG_CONFIG_HOME moves it, as for other tools.
export const USER_CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pm', 'config.json');
const userConfig = readJson(USER_CONFIG_PATH) || {};

const parsed = parseArgs(process.argv.slice(2));
export const subcmd = parsed.subcmd;
export const positional = parsed.positional;
export const flags = parsed.flags;

const serverFlagUrl = flags.server && flags.server !== 'true' ? flags.server : null;
export const BASE_URL = String(serverFlagUrl || process.env.PM_URL || userConfig.url || DEFAULT_URL).replace(/\/+$/, '');
const TOKEN = process.env.PM_TOKEN || userConfig.token || null;
export const BOARD = flags.board && flags.board !== 'true' ? flags.board : readJson(findBoardFile())?.board || null;

// The board's config (name, stages, entityTypes, commands, knowledgeBase) comes from the server,
// where 0.x read pm.config.json. loadConfig() fills it once per command.
export const state = { config: null };

/** A mistake in how pm was called: the message, then exit 2 (DD-025). */
export function usageError(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}

export function requireBoard() {
  if (!BOARD) {
    process.stderr.write(
      `No ${BOARD_FILENAME} found in any parent directory.\n` +
      `Run "pm init <slug>" to create a board for this repo, or pass --board <slug>.\n`
    );
    process.exit(1);
  }
}

// Flags that pick the server, the board or the output: never part of a request body.
// 0.x sent --json in a PATCH (`pm project SPRINT-001 --json`); 1.x refuses unknown fields (DD-016).
const TRANSPORT_FLAGS = new Set(['server', 'board', 'json']);
export function isRequestFlag(key) {
  return !TRANSPORT_FLAGS.has(key) && key !== 'help';
}
export function hasRequestFlags() {
  return Object.keys(flags).some(isRequestFlag);
}

// 0.x's paths are /api/items, ...; 1.x has them per board under /api/boards/{slug}/items.
export function boardPath(path) {
  if (!path.startsWith('/api/')) return path;
  return `/api/boards/${encodeURIComponent(BOARD)}/${path.slice('/api/'.length)}`;
}

// --- Request helper (HTTP to the server, with the token on every write) ---
export async function api(method, path, body, { silent = false } = {}) {
  let status, data;
  try {
    ({ status, data } = await httpJson(method, `${BASE_URL}${boardPath(path)}`, body));
  } catch (err) {
    process.stderr.write(`Failed: ${err.message}\nCannot reach the pm server at ${BASE_URL} (set PM_URL or "url" in ${USER_CONFIG_PATH}).\n`);
    process.exit(1);
  }
  if (status < 200 || status >= 300) {
    process.stderr.write(`Error ${status}: ${JSON.stringify(data)}\n`);
    if (status === 401) {
      process.stderr.write(`A write needs a token: set PM_TOKEN or "token" in ${USER_CONFIG_PATH}.\n`);
    }
    process.exit(1);
  }
  if (!silent && data !== undefined) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  return data;
}

export function httpJson(method, url, body) {
  return new Promise((resolveRequest, rejectRequest) => {
    const target = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const client = target.protocol === 'https:' ? https : http;
    const write = method !== 'GET' && method !== 'HEAD';
    const req = client.request(target, {
      method,
      headers: {
        Accept: 'application/json',
        Connection: 'close',
        'User-Agent': `pm/${VERSION}`,
        ...(write && TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      agent: false
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data;
        if (raw) {
          try { data = JSON.parse(raw); }
          catch { data = raw; }
        }
        resolveRequest({ status: res.statusCode || 0, data });
      });
    });
    req.on('error', rejectRequest);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function loadConfig() {
  if (state.config || !BOARD) return state.config;
  state.config = await api('GET', '/api/config', undefined, { silent: true });
  return state.config;
}

// Help names the board and its stages when the server answers; it never fails for want of one.
export async function loadConfigForHelp() {
  if (!BOARD || state.config) return;
  try {
    const r = await httpJson('GET', `${BASE_URL}${boardPath('/api/config')}`);
    if (r.status === 200) state.config = r.data;
  } catch { /* help works offline */ }
}

// --- Knowledge base (DD-017): the server lists the queries, this machine runs them ---
export function runKnowledgeQuery(query) {
  const kb = state.config?.knowledgeBase;
  if (!kb || !kb.command) return null;
  const escaped = query.replace(/"/g, '\\"');
  let cmd = `${kb.command} "${escaped}"`;
  if (kb.scope) cmd += ` -c ${kb.scope}`;
  try {
    return execSync(cmd, { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}
