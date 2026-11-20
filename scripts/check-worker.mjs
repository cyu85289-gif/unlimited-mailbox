// ============================================================================
//  scripts/check-worker.mjs —— 检查线上 Worker 是否正常（登录页 / 接口 / 登录）
//  用法：node scripts/check-worker.mjs [worker地址] [登录口令]
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let token = process.argv[3];
if (!token) {
  try {
    token = readFileSync(path.join(ROOT, 'data', 'worker-token.txt'), 'utf8').trim();
  } catch {
    /* 没有本地记录 */
  }
}

const base = (process.argv[2] || 'https://mailbox.your-account.workers.dev').replace(/\/$/, '');

async function hit(pathname, init, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(base + pathname, { ...init, signal: ctrl.signal });
      const text = await res.text();
      return { status: res.status, text, headers: res.headers };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;

console.log(`检查地址：${base}\n`);

const home = await hit('/');
const hasUi = home.text.includes('无限邮箱');
console.log(home.status === 200 && hasUi ? ok(`登录页正常（${home.text.length} 字节）`) : bad(`首页异常：HTTP ${home.status}`));

const boot = await hit('/api/bootstrap');
let bootJson = {};
try {
  bootJson = JSON.parse(boot.text);
} catch {
  /* ignore */
}
console.log(
  bootJson.authenticated === false
    ? ok('未登录时接口正常（authenticated:false）')
    : bad(`bootstrap 异常：${boot.text.slice(0, 120)}`)
);

if (!token) {
  console.log('\x1b[33m!\x1b[0m 没有登录口令，跳过登录检查（可用 node scripts/check-worker.mjs <地址> <口令>）');
  process.exit(0);
}

const login = await hit('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: token }),
});
const cookie = login.headers.get('set-cookie') || '';
console.log(login.status === 200 ? ok('登录口令正确') : bad(`登录失败：HTTP ${login.status} ${login.text.slice(0, 100)}`));

if (login.status === 200) {
  const auth = await hit('/api/bootstrap', { headers: { cookie: cookie.split(';')[0] } });
  const authJson = JSON.parse(auth.text || '{}');
  console.log(
    authJson.authenticated
      ? ok(`已登录：${authJson.mailboxes?.length || 0} 个邮箱 / ${authJson.messages?.length || 0} 封邮件`)
      : bad('带 Cookie 的 bootstrap 仍未登录')
  );
  if (authJson.domains) {
    const list = authJson.domains.map((d) => `${d.name}（${d.total} 封）`).join('、');
    console.log(ok(`域名 ${authJson.domains.length} 个：${list || '（无）'}`));
    console.log(`\x1b[2m   当前域名：${authJson.domain || '（无）'}｜多域名分箱：${authJson.caps?.domains ? '已启用' : '未启用'}\x1b[0m`);
  }
  console.log(`\n收件箱地址：${base}/  用 admin@你的域名 + 上面的口令登录\n`);
}
