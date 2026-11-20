// ============================================================================
//  scripts/setup-cloudflare.mjs —— 一条命令把 example.com 的收信全部配好
//
//  做的事（幂等，可重复跑）：
//    1. 校验 API 令牌、找到 example.com 的 zone
//    2. 创建（或复用）D1 数据库 mailbox
//    3. 部署 Worker（mailbox），绑定 D1 + 域名 + 登录口令
//    4. 删掉旧的腾讯 MX，开启 Email Routing（自动加 Cloudflare MX + SPF）
//    5. 把 Catch-all 指向 Worker
//    6. 打印收件箱地址和验证结果
//
//  用法：
//    $env:CF_TOKEN="你的API令牌"; node scripts/setup-cloudflare.mjs
//  可选环境变量：
//    DOMAIN        默认 example.com
//    ACCESS_TOKEN  登录口令；不填则随机生成
// ============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';

const TOKEN = process.env.CF_TOKEN || '';
const DOMAIN = (process.env.DOMAIN || 'example.com').trim().toLowerCase();
const WORKER = 'mailbox';
const DB_NAME = 'mailbox';

// 登录口令：优先用环境变量，其次复用上次生成的，最后才新建（重跑不会把你踢下线）
const TOKEN_FILE = path.join(ROOT, 'data', 'worker-token.txt');
function resolveLoginToken() {
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  try {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* 还没有文件 */
  }
  return crypto.randomBytes(12).toString('base64url');
}
const LOGIN_TOKEN = resolveLoginToken();

if (!TOKEN) {
  console.error('缺少 CF_TOKEN。用法：$env:CF_TOKEN="你的API令牌"; node scripts/setup-cloudflare.mjs');
  process.exit(1);
}

/* ------------------------------ 工具 ------------------------------ */

const c = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

async function cfOnce(pathname, init = {}) {
  const isForm = init.body instanceof FormData;
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(isForm || !init.body ? {} : { 'content-type': 'application/json' }),
      ...(init.headers || {}),
    },
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }
  if (!res.ok || data.success === false) {
    const detail = (data.errors || []).map((e) => `${e.code} ${e.message}`).join(' | ') || `HTTP ${res.status}`;
    const err = new Error(`${pathname} → ${detail}`);
    err.httpStatus = res.status;
    err.apiErrors = data.errors || [];
    throw err;
  }
  return data.result;
}

// 网络抖动（走代理时常见）自动重试；HTTP 层面的错误不重试，直接抛出
async function cf(pathname, init = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await cfOnce(pathname, init);
    } catch (err) {
      lastErr = err;
      if (err.httpStatus) throw err;
      if (i < tries - 1) {
        const wait = 800 * (i + 1);
        console.log(`\x1b[2m   网络抖动（${err.message}），${wait}ms 后重试…\x1b[0m`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

const step = (n, text) => console.log(`\n\x1b[1m[${n}]\x1b[0m ${text}`);

/* ------------------------------ 1. 校验令牌 ------------------------------ */

step(1, '校验 API 令牌 / 查找域名');
try {
  const verify = await cf('/user/tokens/verify');
  console.log(c.ok(`令牌有效（状态：${verify.status}）`));
} catch (err) {
  console.log(c.bad(`令牌校验失败：${err.message}`));
  process.exit(1);
}

const zones = await cf(`/zones?name=${encodeURIComponent(DOMAIN)}`);
if (!zones.length) {
  console.log(c.bad(`这个令牌看不到域名 ${DOMAIN}，请检查令牌的 Zone Resources 是否包含它`));
  process.exit(1);
}
const zone = zones[0];
const ZONE_ID = zone.id;
const ACCOUNT_ID = zone.account.id;
console.log(c.ok(`域名：${zone.name}（zone ${ZONE_ID.slice(0, 8)}…，账户 ${ACCOUNT_ID.slice(0, 8)}…）`));

/* ------------------------------ 2. D1 ------------------------------ */

step(2, `准备 D1 数据库「${DB_NAME}」`);
let dbId = null;
try {
  const existing = await cf(`/accounts/${ACCOUNT_ID}/d1/database`);
  const hit = (existing || []).find((d) => d.name === DB_NAME);
  if (hit) {
    dbId = hit.uuid;
    console.log(c.ok(`已存在，直接复用（${dbId.slice(0, 8)}…）`));
  }
} catch (err) {
  console.log(c.warn(`查询数据库列表失败（继续尝试创建）：${err.message}`));
}

if (!dbId) {
  const created = await cf(`/accounts/${ACCOUNT_ID}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name: DB_NAME }),
  });
  dbId = created.uuid;
  console.log(c.ok(`已创建（${dbId.slice(0, 8)}…）`));
}

/* ------------------------------ 3. 部署 Worker ------------------------------ */

step(3, `部署 Worker「${WORKER}」`);
const code = await readFile(path.join(ROOT, 'worker.mjs'), 'utf8');
console.log(c.dim(`   worker.mjs ${(Buffer.byteLength(code) / 1024).toFixed(1)} KB`));

const metadata = {
  main_module: 'worker.mjs',
  compatibility_date: '2025-09-01',
  bindings: [
    { type: 'd1', name: 'DB', id: dbId },
    { type: 'plain_text', name: 'MAIL_DOMAIN', text: DOMAIN },
    { type: 'secret_text', name: 'ACCESS_TOKEN', text: LOGIN_TOKEN },
  ],
};

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.append('worker.mjs', new Blob([code], { type: 'application/javascript+module' }), 'worker.mjs');

try {
  await cf(`/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER}`, { method: 'PUT', body: form });
  console.log(c.ok('Worker 已上传并绑定 DB / MAIL_DOMAIN / ACCESS_TOKEN'));
} catch (err) {
  console.log(c.bad(`上传失败：${err.message}`));
  process.exit(1);
}

let workersSubdomain = '';
try {
  const sub = await cf(`/accounts/${ACCOUNT_ID}/workers/subdomain`);
  workersSubdomain = sub.subdomain || '';
} catch {
  /* 拿不到就用占位提示 */
}

/* ------------------------------ 4. 切换 MX ------------------------------ */

step(4, '切换 MX 到 Cloudflare Email Routing');

const isAuthError = (err) =>
  err.httpStatus === 403 ||
  err.httpStatus === 401 ||
  /Authentication|10000|not authorized|permission/i.test(err.message);

// 先做权限预检：读不到 Email Routing 设置就立刻退出，绝不动 DNS
let routing = null;
try {
  routing = await cf(`/zones/${ZONE_ID}/email/routing`);
  console.log(c.ok('Email Routing 权限正常'));
} catch (err) {
  if (isAuthError(err)) {
    console.log(c.bad('令牌缺少 Email Routing 需要的权限，已中止（DNS 没有任何改动）'));
    console.log(c.warn('请在令牌里加一行：Zone | Zone Settings | Edit'));
    process.exit(3);
  }
  console.log(c.warn(`读取 Email Routing 设置失败（继续）：${err.message}`));
}

// 先让 Cloudflare 加上自己的 MX（此时旧 MX 还在，邮件不会丢，只会被分到两边之一）
const enableRouting = () => cf(`/zones/${ZONE_ID}/email/routing/enable`, { method: 'POST' });

async function deleteOldMx() {
  const records = await cf(`/zones/${ZONE_ID}/dns_records?type=MX`);
  for (const r of records || []) {
    if (!String(r.content).endsWith('.mx.cloudflare.net')) {
      await cf(`/zones/${ZONE_ID}/dns_records/${r.id}`, { method: 'DELETE' });
      console.log(c.ok(`已删除旧 MX：${r.content}（优先级 ${r.priority}）`));
    }
  }
}

if (routing && routing.enabled) {
  console.log(c.ok('Email Routing 本来就已启用'));
} else {
  try {
    await enableRouting();
    console.log(c.ok('已开启 Email Routing（Cloudflare MX + SPF 已写入）'));
  } catch (err) {
    if (isAuthError(err)) {
      console.log(c.bad(`开启失败（权限不足），已中止：${err.message}`));
      process.exit(3);
    }
    console.log(c.warn(`直接开启失败，可能是旧 MX 冲突，改为先删旧 MX：${err.message}`));
    await deleteOldMx();
    try {
      await enableRouting();
      console.log(c.ok('已开启 Email Routing（Cloudflare MX + SPF 已写入）'));
    } catch (err2) {
      console.log(c.bad(`开启失败：${err2.message}`));
      console.log(c.warn('旧 MX 已被删除，正在恢复，避免收信中断…'));
      for (const w of [
        { content: 'mxbiz1.qq.com', priority: 5 },
        { content: 'mxbiz2.qq.com', priority: 10 },
      ]) {
        try {
          await cf(`/zones/${ZONE_ID}/dns_records`, {
            method: 'POST',
            body: JSON.stringify({ type: 'MX', name: DOMAIN, content: w.content, priority: w.priority, ttl: 1 }),
          });
          console.log(c.ok(`已恢复 MX：${w.priority} ${w.content}`));
        } catch (e) {
          console.log(c.bad(`恢复失败：${w.content} → ${e.message}`));
        }
      }
      process.exit(2);
    }
  }
}

// 确认 Cloudflare 的 MX 真的写进去了，再删旧记录
const mxNow = await cf(`/zones/${ZONE_ID}/dns_records?type=MX`);
const cfMx = (mxNow || []).filter((r) => String(r.content).endsWith('.mx.cloudflare.net'));
if (cfMx.length < 2) {
  console.log(c.bad(`Cloudflare MX 还没写好（当前 ${cfMx.length} 条），为安全起见先不删旧 MX`));
  process.exit(2);
}
console.log(c.dim(`   Cloudflare MX 已就绪：${cfMx.map((r) => `${r.priority} ${r.content}`).join('  ')}`));

for (const r of mxNow || []) {
  if (!String(r.content).endsWith('.mx.cloudflare.net')) {
    try {
      await cf(`/zones/${ZONE_ID}/dns_records/${r.id}`, { method: 'DELETE' });
      console.log(c.ok(`已删除旧 MX：${r.content}（优先级 ${r.priority}）`));
    } catch (err) {
      console.log(c.warn(`旧 MX 删除失败（多半已被 Cloudflare 锁定，可忽略）：${r.content} → ${err.message}`));
    }
  }
}

/* ------------------------------ 5. Catch-all → Worker ------------------------------ */

step(5, '设置 Catch-all：所有地址都交给 Worker');
try {
  await cf(`/zones/${ZONE_ID}/email/routing/rules/catch_all`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'catch-all to worker',
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [WORKER] }],
    }),
  });
  console.log(c.ok('Catch-all 已指向 Worker'));
} catch (err) {
  console.log(c.bad(`设置失败：${err.message}`));
}

/* ------------------------------ 6. 汇总 ------------------------------ */

step(6, '结果');
const workerUrl = workersSubdomain
  ? `https://${WORKER}.${workersSubdomain}.workers.dev`
  : `https://${WORKER}.<你的账户>.workers.dev`;

// 把口令存到本地，下次重跑沿用同一个
try {
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(TOKEN_FILE, LOGIN_TOKEN + '\n', 'utf8');
} catch {
  /* 忽略写入失败 */
}

console.log(`
  \x1b[1m收件箱\x1b[0m   ${workerUrl}/
  \x1b[1mroot 账号\x1b[0m admin@${DOMAIN}
  \x1b[1mroot 密码\x1b[0m ${LOGIN_TOKEN}（登录后请在账号设置里改掉）
  \x1b[1m收信地址\x1b[0m 已注册用户的地址 + 子地址（bili1@${DOMAIN} / bili-shop@${DOMAIN}）
`);

try {
  const settings = await cf(`/zones/${ZONE_ID}/email/routing`);
  console.log(`  Email Routing 状态：${settings.enabled ? '已启用 ✅' : '未启用 ❌'}  (${settings.status || 'n/a'})`);
} catch {
  /* 忽略 */
}

try {
  const rule = await cf(`/zones/${ZONE_ID}/email/routing/rules/catch_all`);
  const action = (rule.actions || [])[0] || {};
  console.log(`  Catch-all：${rule.enabled ? '已开启' : '未开启'} → ${action.type}:${(action.value || []).join(',')}`);
} catch {
  /* 忽略 */
}

const mx = await cf(`/zones/${ZONE_ID}/dns_records?type=MX`);
console.log('  当前 MX：');
for (const r of mx || []) console.log(`    ${r.priority}  ${r.content}`);

console.log(`
${c.dim('提示：DNS 生效通常 1~10 分钟，可以跑  node test/check-dns.mjs ' + DOMAIN + '  复查。')}
${c.dim('配完记得回 Cloudflare 把刚才那个 API 令牌删掉：My Profile → API Tokens → Delete。')}
`);
