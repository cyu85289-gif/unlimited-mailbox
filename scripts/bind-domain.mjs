// 把 exmail.example.com 绑到 Worker mailbox 上（Cloudflare 自定义域名）
const TOKEN = process.env.CF_TOKEN;
const ZONE = process.env.ZONE_ID || '5b2d811b775a8b60360b5f1bbfd1d174';
const API = 'https://api.cloudflare.com/client/v4';
const HOST = process.env.HOST || 'exmail.example.com';
const SCRIPT = 'mailbox';

async function cf(pathname, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.success !== false, data, result: data.result, errors: data.errors };
}

const zone = await cf(`/zones/${ZONE}`);
const accountId = zone.result.account.id;
console.log('account:', accountId, '| zone:', zone.result.name);

/* 1. 现有 DNS 记录 */
const rec = await cf(`/zones/${ZONE}/dns_records?name=${HOST}`);
console.log(`现有 ${HOST} 记录：`, (rec.result || []).map((r) => `${r.type} ${r.content}`).join(', ') || '（无）');

/* 2. 查是否已经绑过 */
const domains = await cf(`/accounts/${accountId}/workers/domains`);
console.log(
  '已绑定的 Worker 自定义域名：',
  (domains.result || []).map((d) => `${d.hostname} → ${d.service}`).join(', ') || '（无）'
);

const existing = (domains.result || []).find((d) => d.hostname === HOST);
if (existing) {
  console.log(`✓ ${HOST} 已经绑过了（${existing.service}）`);
  process.exit(0);
}

/* 3. 创建自定义域名 */
const created = await cf(`/accounts/${accountId}/workers/domains`, {
  method: 'PUT',
  body: JSON.stringify({
    environment: 'production',
    hostname: HOST,
    service: SCRIPT,
    zone_id: ZONE,
  }),
});

if (created.ok) {
  console.log(`✓ 已创建：${created.result.hostname} → ${created.result.service}`);
  console.log('  （Cloudflare 会自动加 DNS 记录并签发证书，通常 1~3 分钟）');
} else {
  console.log('✗ 创建失败：', created.status, JSON.stringify(created.errors));
  console.log('   需要的权限：Zone → Workers Routes → Edit（或 Account → Workers Scripts → Edit 的更高权限）');
  process.exit(2);
}
