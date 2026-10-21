// adg 设置框架的宿主半边：把登记表（lib/schema.mjs）变成一条同源 HTTP 路由 + 一个落在
// 用户根的设置文件。
//
// 形状（与 dsh-subagent-mgm / dsh-insert-context 同一套「三件套」，本仓库不另立一套）：
//   - 页面是客户端 half（client.js）注册的 settings.section；
//   - 它读写的就是本文件的 `/api/adg-settings/settings`；
//   - 值落在 `${DSH_PROFILE_DIR|DSH_HOME|~/.dsh}/adg-settings.json`（0600、原子替换）。
//
// 消费方**不 import 本包**，只按文件契约读自己那几项（当前只有 adg-notify 读通知三项）——
// 所以「保存后立即生效、不需要重启」来自「消费方每次调用都重读一次文件」，不是热重载。
// 键名与界的真相仍在 lib/schema.mjs；本文件不写死任何一个键。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULTS,
  buildEffective,
  describeFields,
  fieldFor,
  normalizeSettings,
  refuseMessage,
  validValue,
} from './lib/schema.mjs';

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-settings';

/** 同源路由前缀；客户端 half 的 ROUTE 是它 + `/settings`。 */
const ROUTE_PATH = '/api/adg-settings';

/**
 * 设置文件名（用户根下）。这个名字是**文件契约**的一部分：
 * 读它的模块（notify/lib/user-settings.mjs）自己拼同一份，两边各有一次核对。
 */
export const STORE_NAME = 'adg-settings.json';

const MAX_BODY_BYTES = 64 * 1024;

/** 用户根的解析口径（与 notify/lib/user-settings.mjs 的 settingsFile() 必须一致）。 */
export function settingsFile() {
  const base =
    process.env.DSH_PROFILE_DIR ||
    process.env.DSH_HOME ||
    path.join(os.homedir(), '.dsh');
  return path.join(base, STORE_NAME);
}

/** 读回设置文件：只留认得的键与合法的值，坏值丢掉并在日志里说清是哪一格。 */
function readStored(file, logger) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { settings: {}, unknown: [], dropped: [] };
  }
  return normalizeSettings(raw, logger, `the settings file (${file})`);
}

/** 原子写入：崩在中间只会留下上一次的完整文件；0600 = 只有本人能读。 */
function writeStored(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, undefined, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** 同机调用方可能用的主机名。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** 把一个 Host/Origin/Referer 值拆成 {scheme, hostname, port}，缺端口按协议补。 */
function authorityOf(value, defaultScheme = 'http') {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme}://${value.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

/**
 * 本插件 HTTP 面的同源栅栏。
 *
 * 这里注册的 prefix 比内核的 `/api` 长，而 webServer 的派发是「最长前缀优先」，所以这条
 * 路由会先于 connection 服务自己的准入检查跑。两层按顺序试：composition 挂了那个服务就
 * 用它的判定，否则用一份结构等价的复刻（Host 必须回环、不许 cross-site fetch、
 * Origin/Referer 的 authority 必须与 Host 一致）。
 *
 * @returns {number|undefined} 拒绝时返回 HTTP 状态码，放行返回 `undefined`。
 */
function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req);
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection;
      return undefined;
    } catch {
      // 抛错的 connection 服务是 composition 的问题：退回结构复刻，别把每个请求都答成 500。
    }
  }
  const host = authorityOf(req.headers.host);
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403;
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403;
  for (const header of ['origin', 'referer']) {
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

/** 读一个 JSON 请求体，读不出来就答 `{}`（与插入上下文插件同一套口径）。 */
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

/**
 * cordis 插件入口。
 *
 * @param {{inject?: Function, effect?: Function, get?: Function, logger?: object}} ctx
 * @param {object} [config] 本插件行 Config：三层优先级里的中间层（页面写文件之前用它）
 */
export function apply(ctx, config = {}) {
  const { settings: configured, unknown: unknownConfig } = normalizeSettings(
    config,
    ctx.logger,
    'the plugin Config',
  );
  for (const key of unknownConfig) {
    ctx.logger?.warn?.(
      `adg-settings: ignoring unknown key "${key}" in the plugin Config (not in lib/schema.mjs)`,
    );
  }

  const file = settingsFile();

  /** 页面一次请求之后看到的东西：生效值 + 每一格的来源 + 登记表 + 落点。 */
  const describe = () => {
    const { settings: stored, unknown, dropped } = readStored(file, ctx.logger);
    const { value, origin } = buildEffective({ stored, configured, defaults: DEFAULTS });
    return {
      ok: true,
      value,
      origin,
      stored,
      configured: { ...configured },
      defaults: { ...DEFAULTS },
      unknown,
      dropped,
      fields: describeFields(),
      file,
    };
  };

  // 设置页的数据源。`webServer` 是**问**来的不是 inject 的：没有 HTTP 载体的 composition
  // 只少一页设置，插件本身照常。
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
              return send(rejection === 401 ? 401 : 403, {
                error: rejection === 401 ? 'unauthorized' : 'forbidden',
              });
            }

            const url = new URL(req.url ?? '/', 'http://localhost');
            const route = url.pathname.slice(ROUTE_PATH.length).replace(/\/+$/, '') || '/';
            if (route !== '/settings') return send(404, { error: 'not found' });

            const method = String(req.method ?? 'GET').toUpperCase();
            if (method === 'GET') return send(200, describe());

            if (method === 'DELETE') {
              try {
                fs.rmSync(file, { force: true });
              } catch (error) {
                ctx.logger?.warn?.(`adg-settings: could not clear the settings (${error?.message ?? error})`);
                return send(500, { error: `could not clear: ${error?.message ?? error}` });
              }
              ctx.logger?.info?.(
                'adg-settings: settings cleared, back to the plugin Config and the built-in defaults',
              );
              return send(200, describe());
            }

            if (method !== 'POST') return send(405, { error: 'method not allowed' });

            const patch = await readJson(req);
            const body = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
            const keys = Object.keys(body);
            if (keys.length === 0) return send(400, { error: 'no settings provided' });

            // 认不得的键是**拒**不是忽略：一个旧页面写回一个已经删掉的键，静默吞掉会让
            // 「设置怎么没生效」变成谜。
            const unknown = keys.filter((key) => fieldFor(key) === undefined);
            if (unknown.length > 0) {
              return send(400, {
                error: `unknown setting ${unknown.map((key) => `"${key}"`).join(', ')} (not in lib/schema.mjs)`,
              });
            }

            const { settings: stored } = readStored(file, ctx.logger);
            const next = { ...stored };
            for (const key of keys) {
              const field = fieldFor(key);
              const value = validValue(field, body[key]);
              if (value === undefined) return send(400, { error: refuseMessage(field), field: key });
              next[key] = value;
            }

            try {
              writeStored(file, next);
            } catch (failure) {
              ctx.logger?.warn?.(`adg-settings: could not save the settings (${failure?.message ?? failure})`);
              return send(500, { error: `could not save: ${failure?.message ?? failure}` });
            }
            ctx.logger?.info?.(`adg-settings: saved ${keys.join(', ')} to the settings file`);
            return send(200, describe());
          },
        }),
      'adg-settings: settings api',
    );
  });
}