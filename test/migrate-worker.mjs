// ============================================================================
//  test/migrate-worker.mjs —— 验证从「旧单域名库」升级到「多域名库」不丢数据
//  用法：node test/migrate-worker.mjs
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-mig-'));
const db = new DatabaseSync(path.join(dir, 'old.db'));

// —— 先用旧版本（单域名）的结构建表并塞点数据 ——
db.exec(`
  CREATE TABLE aliases (
    name TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    raw BLOB,
    text_body TEXT NOT NULL DEFAULT '',
    html_body TEXT NOT NULL DEFAULT '',
    unread INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    cid TEXT NOT NULL DEFAULT '',
    data BLOB NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
db.prepare('INSERT INTO aliases (name, note, created_at, active) VALUES (?, ?, ?, 1)').run('shop', '老数据', 1700000000000);
db.prepare(
  `INSERT INTO messages (id, alias, to_addr, from_name, from_addr, subject, snippet, date, size, text_body, html_body, unread, created_at)
   VALUES ('old1', 'shop', 'shop@example.com', '老王', 'wang@example.com', '老邮件', '摘要', 1700000000000, 123, '正文', '<p>正文</p>', 1, 1700000000000)`
).run();

/* ------------------------------ D1 模拟 ------------------------------ */

const normalize = (params) => params.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : p));
const d1 = {
  exec: async (sql) => {
    db.exec(sql);
    return { count: 0 };
  },
  prepare: (sql) => {
    const bound = (params) => ({
      run: async () => db.prepare(sql).run(...normalize(params)),
      all: async () => ({ results: db.prepare(sql).all(...normalize(params)) }),
      first: async () => db.prepare(sql).get(...normalize(params)) ?? null,
    });
    return {
      bind: (...p) => bound(p),
      run: async () => db.prepare(sql).run(),
      all: async () => ({ results: db.prepare(sql).all() }),
      first: async () => db.prepare(sql).get() ?? null,
    };
  },
};

const env = { DB: d1, ACCESS_TOKEN: 'mig-token-1234567890', MAIL_DOMAIN: 'example.com' };

// 迁移必须在 worker 模块首次访问数据库时触发
const { default: worker } = await import('../worker.mjs');

const H = { 'x-token': env.ACCESS_TOKEN };

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(ok ? `✅ ${name}` : `❌ ${name} ${extra}`);
  if (!ok) failed++;
};

const call = async (path, init = {}) => {
  const res = await worker.fetch(new Request('https://x.dev' + path, init), env);
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};

// 迁移后 root 已经自动建好，用 admin@域名 + ACCESS_TOKEN 登录
const login = await call('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: env.ACCESS_TOKEN }),
});
check('root 自动创建并可登录', login.status === 200 && login.data.user?.role === 'root', JSON.stringify(login.data));
const cookie = login.cookie;

const boot = (await call('/api/bootstrap', { headers: { cookie } })).data;
const shop = (boot.mailboxes || []).find((b) => b.localPart === 'shop');
check('旧别名迁移成 root 的主邮箱', !!shop && shop.domain === 'example.com', JSON.stringify(boot.mailboxes));
check('旧邮件跟着迁移过来', shop?.total === 1, String(shop?.total));

const detail = await call('/api/messages/old1', { headers: { cookie } });
check('旧邮件正文可读', detail.data.message?.text === '正文', JSON.stringify(detail.data.message?.text));

// 子地址收信：shop1@ 应该归到 shop 这个主邮箱
const raw = Buffer.from(
  'From: new@example.com\r\nTo: <shop1@example.com>\r\nSubject: 子地址来信\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello',
  'utf8'
);
await worker.email({ raw: new Blob([raw]).stream(), to: 'shop1@example.com', from: 'new@example.com' }, env, {});

const boot2 = (await call('/api/bootstrap', { headers: { cookie } })).data;
const shop2 = (boot2.mailboxes || []).find((b) => b.localPart === 'shop');
check('子地址来信归到主邮箱', shop2?.total === 2, String(shop2?.total));
check('子地址自动登记', shop2?.subs?.some((s) => s.localPart === 'shop1'), JSON.stringify(shop2?.subs));

// 没注册过的地址：多用户版不再无限自动建箱，但也不静默丢——落到 root 的「未登记地址」箱
const before = boot2.messages.length;
await worker.email(
  {
    raw: new Blob([Buffer.from('From: x@y.z\r\nTo: <nobody@example.com>\r\nSubject: 陌生地址\r\n\r\nspam')]).stream(),
    to: 'nobody@example.com',
    from: 'x@y.z',
  },
  env,
  {}
);
const boot3 = (await call('/api/bootstrap', { headers: { cookie } })).data;
const catchBox = (boot3.mailboxes || []).find((b) => b.label === '未登记地址');
check('陌生地址进「未登记地址」收件箱', !!catchBox && catchBox.total === 1, JSON.stringify(catchBox));
check('陌生地址不会照着地址建新邮箱', !(boot3.mailboxes || []).some((b) => b.localPart === 'nobody'));
check('陌生地址的信不进别人的箱子', boot3.messages.length === before + 1 && (boot3.messages || []).every((m) => m.alias !== 'nobody' || m.mailbox === catchBox.localPart));

console.log(failed ? `\n${failed} 项失败` : '\n升级迁移测试通过');
process.exit(failed ? 1 : 0);
