// ============================================================================
//  scripts/check-inbox.mjs —— 直接查 D1，看收到哪些邮件（不依赖网页）
//  用法：$env:CF_TOKEN="令牌"; node scripts/check-inbox.mjs [数量]
// ============================================================================

const TOKEN = process.env.CF_TOKEN;
const ZONE = process.env.ZONE_ID || '5b2d811b775a8b60360b5f1bbfd1d174';
const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN) {
  console.error('缺少 CF_TOKEN');
  process.exit(1);
}

const limit = Number(process.argv[2] || 10);

const cf = async (pathname, init = {}, tries = 4) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API + pathname, {
        ...init,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
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

const zone = await cf(`/zones/${ZONE}`);
const accountId = zone.account.id;

const dbs = await cf(`/accounts/${accountId}/d1/database`);
const db = dbs.find((d) => d.name === 'mailbox');
if (!db) {
  console.error('找不到 mailbox 数据库');
  process.exit(1);
}

const query = async (sql) => {
  const res = await cf(`/accounts/${accountId}/d1/database/${db.uuid}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  // D1 的 /query 返回的是「每个语句一个结果对象」的数组
  const first = Array.isArray(res) ? res[0] : res;
  return (first && first.results) || [];
};

const tables = await query("SELECT name FROM sqlite_master WHERE type='table'");
console.log('表：', tables.map((t) => t.name).join(', ') || '（还没有表，说明还没收到过邮件）');

if (!tables.some((t) => t.name === 'messages')) {
  console.log('\n收件箱还是空的。发一封邮件到 test@example.com 之后再跑一次。');
  process.exit(0);
}

const rows = await query(
  `SELECT id, alias, to_addr, from_name, from_addr, subject, date, unread,
          (SELECT COUNT(*) FROM attachments a WHERE a.message_id = messages.id) AS atts
     FROM messages ORDER BY date DESC LIMIT ${limit}`
);

console.log(`\n共 ${rows.length} 封（最多显示 ${limit} 封）：\n`);
for (const r of rows) {
  const time = new Date(r.date).toLocaleString('zh-CN');
  console.log(`  ${r.unread ? '●' : '○'} ${time}`);
  console.log(`    收件人：${r.to_addr}   别名：${r.alias}`);
  console.log(`    发件人：${r.from_name ? r.from_name + ' ' : ''}<${r.from_addr}>`);
  console.log(`    标题：${r.subject}${r.atts ? `   [${r.atts} 个附件]` : ''}\n`);
}

if (!rows.length) console.log('  （空）');
