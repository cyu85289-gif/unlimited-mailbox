// 紧急恢复：把腾讯企业邮的 MX 写回去，避免收信中断
const TOKEN = process.env.CF_TOKEN;
const ZONE = process.env.ZONE_ID;
const API = 'https://api.cloudflare.com/client/v4';

async function cf(pathname, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`${pathname} → ${(data.errors || []).map((e) => e.code + ' ' + e.message).join('; ') || res.status}`);
  }
  return data.result;
}

const current = await cf(`/zones/${ZONE}/dns_records?type=MX`);
console.log('当前 MX：', (current || []).map((r) => `${r.priority} ${r.content}`).join(', ') || '（无）');

const want = [
  { content: 'mxbiz1.qq.com', priority: 5 },
  { content: 'mxbiz2.qq.com', priority: 10 },
];

for (const w of want) {
  const exists = (current || []).some((r) => r.content === w.content);
  if (exists) {
    console.log(`已存在，跳过：${w.priority} ${w.content}`);
    continue;
  }
  const rec = await cf(`/zones/${ZONE}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'MX', name: 'example.com', content: w.content, priority: w.priority, ttl: 1 }),
  });
  console.log(`已恢复：${rec.priority} ${rec.content}`);
}

const after = await cf(`/zones/${ZONE}/dns_records?type=MX`);
console.log('恢复后 MX：', (after || []).map((r) => `${r.priority} ${r.content}`).join(', '));
