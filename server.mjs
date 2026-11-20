// ============================================================================
//  server.mjs —— 本地 / 自建服务器版
//
//  这一版不再自己实现一套后端，而是直接用 node:sqlite 模拟 D1，
//  把请求全部交给 worker.mjs（线上那份代码），所以本地看到的行为 = 线上行为。
//
//  · HTTP  → worker.fetch()      （页面从 public/ 目录读，改完刷新就生效）
//  · SMTP  → worker.email()      （收信、解析、入库都走同一套逻辑）
//  · 账号  → 首次启动自动建 root，邮箱 admin@<域名>，密码见启动日志里的令牌
//
//  零依赖：只用 Node 内置模块。
// ============================================================================

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createSmtpServer } from './smtp.mjs';
import worker from './worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');

/* ------------------------------ 配置 ------------------------------ */

const DEFAULT_CONFIG = {
  domain: '',
  port: 8787,
  smtpPort: 2525,
  maxSizeMB: 25,
  keepDays: 0,
  token: '',
};

function loadConfig() {
  let fileCfg = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const text = readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
      fileCfg = JSON.parse(text);
    } catch (err) {
      console.error('config.json 解析失败，已忽略：', err.message);
    }
  }
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.SMTP_PORT) cfg.smtpPort = Number(process.env.SMTP_PORT);
  if (process.env.MAIL_DOMAIN) cfg.domain = process.env.MAIL_DOMAIN;
  if (process.env.ACCESS_TOKEN) cfg.token = process.env.ACCESS_TOKEN;
  return cfg;
}

const config = loadConfig();
if (!existsSync(CONFIG_PATH)) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

mkdirSync(DATA_DIR, { recursive: true });

const DOMAIN = String(config.domain || 'localhost').toLowerCase();

/* ------------------------------ 访问口令（root 初始密码） ------------------------------ */

function initToken() {
  if (config.token) return config.token;
  for (const name of ['worker-token.txt', 'token.txt']) {
    const file = path.join(DATA_DIR, name);
    if (existsSync(file)) {
      const t = readFileSync(file, 'utf8').trim();
      if (t) return t;
    }
  }
  const t = crypto.randomBytes(12).toString('base64url');
  writeFileSync(path.join(DATA_DIR, 'worker-token.txt'), t + '\n', 'utf8');
  return t;
}
const TOKEN = initToken();

/* ------------------------------ D1 模拟 ------------------------------ */

const DB_PATH = path.join(DATA_DIR, 'mail.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = OFF;');

const normalize = (params) => params.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : p));

function makeD1() {
  const wrap = (sql) => {
    const bound = (params) => ({
      run: async () => db.prepare(sql).run(...normalize(params)),
      all: async () => ({ results: db.prepare(sql).all(...normalize(params)) }),
      first: async () => db.prepare(sql).get(...normalize(params)) ?? null,
    });
    return {
      bind: (...params) => bound(params),
      run: async () => db.prepare(sql).run(),
      all: async () => ({ results: db.prepare(sql).all() }),
      first: async () => db.prepare(sql).get() ?? null,
    };
  };
  return {
    exec: async (sql) => {
      db.exec(sql);
      return { count: 0 };
    },
    prepare: (sql) => wrap(sql),
  };
}

const env = { DB: makeD1(), ACCESS_TOKEN: TOKEN, MAIL_DOMAIN: DOMAIN };

/* ------------------------------ 静态文件 ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return null;
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const body = await readFile(file);
    return {
      status: 200,
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      },
      body,
    };
  } catch {
    return null;
  }
}

/* ------------------------------ HTTP → worker ------------------------------ */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'host',
  'content-length',
  'accept-encoding',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 30 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (!url.pathname.startsWith('/api/')) {
      const asset = await serveStatic(url.pathname);
      if (asset) {
        res.writeHead(asset.status, asset.headers);
        res.end(asset.body);
        return;
      }
      if (url.pathname !== '/' && !path.extname(url.pathname)) {
        const index = await serveStatic('/index.html');
        if (index) {
          res.writeHead(200, index.headers);
          res.end(index.body);
          return;
        }
      }
    }

    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v || HOP_BY_HOP.has(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    const request = new Request(url, { method: req.method, headers, body });
    const response = await worker.fetch(request, env, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) {
      if (k.toLowerCase() === 'set-cookie') continue;
      res.setHeader(k, v);
    }
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (cookies.length) res.setHeader('set-cookie', cookies);

    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error('HTTP 处理失败：', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('服务器错误：' + (err && err.message ? err.message : err));
  }
});

/* ------------------------------ SMTP → worker ------------------------------ */

const smtp = createSmtpServer({
  port: config.smtpPort,
  domain: DOMAIN,
  maxSize: Math.max(1, Number(config.maxSizeMB) || 25) * 1024 * 1024,
  log: (...args) => console.log('[smtp]', ...args),
  onMessage: async ({ from, recipients, raw }) => {
    for (const rcpt of recipients) {
      await worker.email(
        { raw: new Blob([raw]).stream(), to: rcpt, from },
        env,
        {}
      );
    }
    console.log(`[smtp] 已收信 ${recipients.join(', ')}（${raw.length} 字节，来自 ${from || '未知'}）`);
  },
});

/* ------------------------------ 启动 ------------------------------ */

async function main() {
  const info = await smtp.listen();
  server.listen(config.port, () => {
    const base = `http://127.0.0.1:${config.port}/`;
    console.log('');
    console.log('  无限邮箱（多用户版）已启动');
    console.log(`  网页收件箱  ${base}`);
    console.log(`  收信端口    ${config.smtpPort}（域名 @${DOMAIN}）`);
    console.log(`  数据库      ${DB_PATH}`);
    console.log('');
    console.log(`  root 账号   admin@${DOMAIN}`);
    console.log(`  root 密码   ${TOKEN}`);
    console.log('');
  });

  const shutdown = async () => {
    console.log('\n正在退出…');
    server.close();
    await smtp.close();
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
