/**
 * adg-turn-bookmarks — 宿主半边：一条同源读写路由，把每个会话的书签落在**该会话自己的目录**里。
 *
 * 为什么是会话目录（sidecar）而不是设置文件/用户根：用户明确要求"会话删掉时书签跟着消失、
 * 不留孤儿"。dsh 自己的会话目录正是这样一个"归这个会话所有、可放未来产物"的目录
 * （dsh-session-persistence-jsonl 的 format 里 sessionDir() 就是这么写的），删会话即删目录。
 *
 * 路由（前缀 /api/adg-turn-bookmarks）：
 *   GET    /<sessionId>  -> { ok, sessionId, turns }（会话目录不在时也给空列表）
 *   PUT    /<sessionId>  <- { turns: number[] }（整份替换）；目录不在 -> 409
 *   DELETE /<sessionId>  -> 删掉 sidecar
 *
 * 不注册任何工具、不写 preset，只挂一个 webServer prefix。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_TURNS,
  STORE_FILE,
  isSafeSessionId,
  normalizeTurns,
  parseStore,
  serializeStore,
  sessionDirCandidates,
} from './lib/bookmarks.mjs';

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 id。 */
export const name = 'adg-turn-bookmarks';

/** 同源路由前缀；会话 id 拼在它后面。 */
export const ROUTE_PATH = '/api/adg-turn-bookmarks';

const MAX_BODY_BYTES = 64 * 1024;

/** 同机调用方可能用的主机名（与 adg-settings 同一套同源栅栏）。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** 会话数据的根目录：优先问 sessionPersistence 后端的真实 root，拿不到再按 env 兜底。 */
export function sessionsRoot(ctx) {
  const backend = ctx.get?.('sessionPersistence');
  const root = backend === null || backend === undefined ? undefined : backend.root;
  if (typeof root === 'string' && root !== '') return root;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

/** 在 <root>/<projectSlug>/<sessionDirName> 里找这个会话的目录；找不到返回 undefined。 */
export function locateSessionDir(root, sessionId) {
  const names = sessionDirCandidates(sessionId);
  if (names.length === 0) return undefined;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const candidateName of names) {
      const candidate = path.join(root, entry.name, candidateName);
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // 不存在就换下一个候选
      }
    }
  }
  return undefined;
}

/** 读 sidecar（不存在或损坏都当空列表）。 */
function readTurns(file) {
  try {
    return parseStore(fs.readFileSync(file, 'utf8')).turns;
  } catch {
    return [];
  }
}

/** 原子写 sidecar（临时文件 + rename、0600、目录不存在先建）。 */
function writeTurns(file, turns) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, serializeStore(turns), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** 把一个 Host/Origin/Referer 值拆成 {scheme, hostname, port}，缺端口按协议补。 */
function authorityOf(value, defaultScheme) {
  const scheme = defaultScheme === undefined ? 'http' : defaultScheme;
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : scheme + '://' + value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

/**
 * 同源栅栏：connection 服务在场时以它的判定为谁，否则结构复刻
 * （Host 必须回环 / 不许 cross-site fetch / Origin 与 Referer 的 authority 必须与 Host 一致）。
 */
function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req);
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection;
      return undefined;
    } catch {
      // 抛错的 connection 服务退回结构复刻，别把每个请求都答成 500
    }
  }
  const host = authorityOf(req.headers.host);
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403;
  const fetchSite = req.headers['sec-fetch-site'];
  if (String(fetchSite === undefined ? '' : fetchSite).toLowerCase() === 'cross-site') return 403;
  const sameSiteHeaders = ['origin', 'referer'];
  for (const header of sameSiteHeaders) {
    const raw = req.headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const authority = authorityOf(raw.trim());
    if (authority === null) return 403;
    if (
      authority.scheme !== host.scheme ||
      authority.hostname !== host.hostname ||
      authority.port !== host.port
    ) {
      return 403;
    }
  }
  return undefined;
}

/** 读一个 JSON 请求体，读不出来就答 {}（与 adg-settings 同一套口径）。 */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy?.();
        finish({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
  });
}

const ERROR_TEXT = { 401: 'unauthorized', 403: 'forbidden' };

/**
 * cordis 插件入口。
 * @param {{inject?: Function, effect?: Function, get?: Function, logger?: object}} ctx
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          handler: async (req, res) => {
            const send = (status, payload) => {
              const body = JSON.stringify(payload);
              res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(body),
              });
              res.end(body);
            };

            const rejection = rejectionFor(req, ctx.get('connection'));
            if (rejection !== undefined) {
              return send(rejection === 401 ? 401 : 403, { error: ERROR_TEXT[rejection] || 'forbidden' });
            }

            const url = new URL(req.url === undefined ? '/' : req.url, 'http://localhost');
            const rest = url.pathname
              .slice(ROUTE_PATH.length)
              .replace(/^[/]+/, '')
              .replace(/[/]+$/, '');
            if (rest === '') return send(404, { error: 'session id required in path' });

            let sessionId;
            try {
              sessionId = decodeURIComponent(rest);
            } catch {
              return send(400, { error: 'bad session id' });
            }
            if (!isSafeSessionId(sessionId)) return send(400, { error: 'bad session id' });

            const dir = locateSessionDir(sessionsRoot(ctx), sessionId);
            const file = dir === undefined ? undefined : path.join(dir, STORE_FILE);
            const method = String(req.method === undefined ? 'GET' : req.method).toUpperCase();

            if (method === 'GET') {
              return send(200, { ok: true, sessionId, turns: file === undefined ? [] : readTurns(file) });
            }

            if (method === 'DELETE') {
              if (file !== undefined) {
                try {
                  fs.rmSync(file, { force: true });
                } catch (failure) {
                  ctx.logger?.warn?.('adg-turn-bookmarks: could not clear bookmarks (' + String(failure) + ')');
                  return send(500, { error: 'could not clear: ' + String(failure) });
                }
              }
              return send(200, { ok: true, sessionId, turns: [] });
            }

            if (method !== 'PUT') return send(405, { error: 'method not allowed' });

            const parsed = await readJson(req);
            const box = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
            if (box === null || !Array.isArray(box.turns)) {
              return send(400, { error: 'body must be { turns: number[] }' });
            }
            if (box.turns.length > MAX_TURNS) {
              return send(400, { error: 'too many bookmarks (max ' + MAX_TURNS + ')' });
            }
            if (dir === undefined) {
              return send(409, { error: 'session directory not found', sessionId });
            }
            const turns = normalizeTurns(box.turns);
            try {
              writeTurns(file, turns);
            } catch (failure) {
              ctx.logger?.warn?.('adg-turn-bookmarks: could not save bookmarks (' + String(failure) + ')');
              return send(500, { error: 'could not save: ' + String(failure) });
            }
            return send(200, { ok: true, sessionId, turns });
          },
        }),
      'adg-turn-bookmarks: bookmarks api',
    );
  });
}
