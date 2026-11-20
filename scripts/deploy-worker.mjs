// ============================================================================
//  scripts/deploy-worker.mjs —— 只更新 Worker 代码（不动 DNS / Email Routing）
//  用法：$env:CF_TOKEN="令牌"; node scripts/deploy-worker.mjs
//  登录口令沿用 data/worker-token.txt，不会把你踢下线
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.CF_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';
const DOMAIN = (process.env.DOMAIN || 'example.com').toLowerCase();
const SCRIPT = 'mailbox';
const DB_NAME = 'mailbox';

if (!TOKEN) {
  console.error('缺少 CF_TOKEN');
  process.exit(1);
}

const loginToken = (() => {
  try {
    const t = readFileSync(path.join(ROOT, 'data', 'worker-token.txt'), 'utf8').trim();
    if (t) return t;
  } catch {
    /* 没有就新生成 */
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
})();

const cf = async (pathname, init = {}, tries = 4) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const isForm = init.body instanceof FormData;
      const res = await fetch(API + pathname, {
        ...init,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(isForm || !init.body ? {} : { 'content-type': 'application/json' }),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        const err = new Error(
          `${pathname} → ${(data.errors || []).map((e) => e.code + ' ' + e.message).join('; ') || res.status}`
        );
        err.httpStatus = res.status;
        throw err;
      }
      return data.result;
    } catch (err) {
      lastErr = err;
      if (err.httpStatus) throw err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
};

const zones = await cf(`/zones?name=${encodeURIComponent(DOMAIN)}`);
if (!zones.length) {
  console.error(`令牌看不到 ${DOMAIN}`);
  process.exit(1);
}
const accountId = zones[0].account.id;

const dbs = await cf(`/accounts/${accountId}/d1/database`);
const db = dbs.find((d) => d.name === DB_NAME);
if (!db) {
  console.error(`找不到 D1 数据库 ${DB_NAME}`);
  process.exit(1);
}

const code = readFileSync(path.join(ROOT, 'worker.mjs'), 'utf8');
const metadata = {
  main_module: 'worker.mjs',
  compatibility_date: '2025-09-01',
  bindings: [
    { type: 'd1', name: 'DB', id: db.uuid },
    { type: 'plain_text', name: 'MAIL_DOMAIN', text: DOMAIN },
    { type: 'secret_text', name: 'ACCESS_TOKEN', text: loginToken },
  ],
};

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.append('worker.mjs', new Blob([code], { type: 'application/javascript+module' }), 'worker.mjs');

await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT}`, { method: 'PUT', body: form });
console.log(`✓ 已上传 ${(Buffer.byteLength(code) / 1024).toFixed(1)} KB（Worker: ${SCRIPT}）`);

// 确保 workers.dev 子域名可用（新脚本默认关闭）
await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT}/subdomain`, {
  method: 'POST',
  body: JSON.stringify({ enabled: true, previews_enabled: false }),
}).catch((err) => console.log(`! 子域名开关：${err.message}`));

const sub = await cf(`/accounts/${accountId}/workers/subdomain`).catch(() => ({}));
const url = sub.subdomain ? `https://${SCRIPT}.${sub.subdomain}.workers.dev` : '（子域名未知）';

console.log(`✓ 地址：${url}/  用 admin@你的域名 + root 初始口令登录`);
