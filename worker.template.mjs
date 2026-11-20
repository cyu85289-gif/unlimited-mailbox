// ============================================================================
//  worker.template.mjs —— Cloudflare Worker 版（多用户 · 多域名 · 子地址归并）
//
//  · 收信：Cloudflare Email Routing 把 *@域名 交给 Worker
//  · 存储：D1（SQLite 云数据库）
//  · 账号：QQ 邮箱 + 密码（预留 QQ 互联 OAuth 接口位），绑定中国大陆手机号
//  · 收件箱：每个用户只看自己的邮件；主邮箱 + 尾部后缀子地址归并到同一个箱子
//  · 管理：root 账号可在后台管理用户 / 域名 / 配置
//
//  这个文件由 build-worker.mjs 生成 worker.mjs（把 MIME 解析器和前端资源内联进来），
//  不要直接在 Cloudflare 上粘贴这个模板文件。
// ============================================================================

/*__MIME__*/

/*__ASSETS__*/

const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS domains (
  name       TEXT PRIMARY KEY,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  nickname      TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS mailboxes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  local_part TEXT NOT NULL,
  domain     TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (domain, local_part)
);
CREATE TABLE IF NOT EXISTS subaddresses (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  local_part TEXT NOT NULL,
  domain     TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL,
  UNIQUE (domain, local_part)
);
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL DEFAULT '',
  domain      TEXT NOT NULL DEFAULT '',
  alias       TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  from_name   TEXT NOT NULL DEFAULT '',
  from_addr   TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  snippet     TEXT NOT NULL DEFAULT '',
  date        INTEGER NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  raw         BLOB,
  text_body   TEXT NOT NULL DEFAULT '',
  html_body   TEXT NOT NULL DEFAULT '',
  unread      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  ext_source  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS external_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  mailbox_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  address       TEXT NOT NULL,
  intake_local  TEXT NOT NULL,
  intake_domain TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  mail_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  cid          TEXT NOT NULL DEFAULT '',
  data         BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dropped_mail (
  id         TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  local_part TEXT NOT NULL,
  from_addr  TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  date       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  key   TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS signup_verifications (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  verified_at INTEGER,
  code        TEXT NOT NULL DEFAULT '',
  purpose     TEXT NOT NULL DEFAULT 'signup'
);
CREATE TABLE IF NOT EXISTS reset_codes (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;

// 索引放在迁移之后建，否则老库还没有 mailbox_id 列时会报错
const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_domain_date ON messages(domain, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_mailboxes_user ON mailboxes(user_id);
CREATE INDEX IF NOT EXISTS idx_subaddresses_mailbox ON subaddresses(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_external_user ON external_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_intake ON external_accounts(intake_domain, intake_local);
`;

/* ------------------------------ 结构初始化 / 迁移 ------------------------------ */

let schemaReady = false;

async function columnsOf(env, table) {
  try {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return (results || []).map((r) => r.name);
  } catch {
    return [];
  }
}

const newId = (n = 20) => crypto.randomUUID().replace(/-/g, '').slice(0, n);
const nowMs = () => Date.now();

// 6 位数字验证码（用 CSPRNG，不用 Math.random）
function sixDigitCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.exec(SCHEMA_TABLES.replace(/\n/g, ' '));

  // 老库（v1/v2）没有 users / mailbox_id：按需补列并迁移
  const aliasCols = await columnsOf(env, 'aliases');
  const msgCols = await columnsOf(env, 'messages');

  if (msgCols.length && !msgCols.includes('mailbox_id')) {
    await env.DB.exec("ALTER TABLE messages ADD COLUMN mailbox_id TEXT NOT NULL DEFAULT '';");
  }
  if (msgCols.length && !msgCols.includes('domain')) {
    const def = normalizeDomain(env.MAIL_DOMAIN || '') || '__default__';
    await env.DB.exec(`ALTER TABLE messages ADD COLUMN domain TEXT NOT NULL DEFAULT '${def}';`);
  }
  if (msgCols.length && !msgCols.includes('ext_source')) {
    // 一邮多用：记录这封信是从哪个外部邮箱转发进来的（qq / gmail / 163 …）
    await env.DB.exec("ALTER TABLE messages ADD COLUMN ext_source TEXT NOT NULL DEFAULT '';");
  }

  // 验证表升级：接上发信通道后改用 6 位验证码
  const svCols = await columnsOf(env, 'signup_verifications');
  if (svCols.length && !svCols.includes('code')) {
    await env.DB.exec("ALTER TABLE signup_verifications ADD COLUMN code TEXT NOT NULL DEFAULT '';");
  }
  if (svCols.length && !svCols.includes('purpose')) {
    await env.DB.exec("ALTER TABLE signup_verifications ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signup';");
  }

  await env.DB.exec(SCHEMA_INDEXES.replace(/\n/g, ' '));

  await migrateLegacy(env, aliasCols);
  await ensureRoot(env);

  schemaReady = true;
}

/**
 * 老数据迁移：每个历史别名变成一个「主邮箱」，全部归 root 所有；
 * 历史邮件按 (domain, alias) 认领到对应邮箱。
 */
async function migrateLegacy(env, aliasCols = []) {
  const hasAliases = aliasCols.length > 0;
  const hasDomain = aliasCols.includes('domain');
  const root = await env.DB.prepare("SELECT id FROM users WHERE role = 'root' LIMIT 1").first();
  const orphan = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ''").first();
  if (!orphan || !orphan.n) return;

  const rootId = (root && root.id) || (await ensureRoot(env)).id;
  const def = normalizeDomain(env.MAIL_DOMAIN || '') || 'localhost';

  if (hasAliases) {
    const select = hasDomain
      ? 'SELECT domain, name, note, created_at FROM aliases'
      : 'SELECT name, note, created_at FROM aliases';
    const { results } = await env.DB.prepare(select).all();
    for (const row of results || []) {
      const domain = hasDomain ? row.domain : def;
      const id = newId();
      await env.DB.prepare(
        'INSERT OR IGNORE INTO mailboxes (id, user_id, local_part, domain, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, rootId, row.name, domain, row.note || '历史别名', row.created_at || nowMs())
        .run();
      const mb = await env.DB.prepare('SELECT id FROM mailboxes WHERE domain = ? AND local_part = ?')
        .bind(domain, row.name)
        .first();
      if (mb) {
        await env.DB.prepare('UPDATE messages SET mailbox_id = ? WHERE domain = ? AND alias = ? AND mailbox_id = ?')
          .bind(mb.id, domain, row.name, '')
          .run();
      }
    }
  }

  // 仍然没有归属的邮件，全部塞给 root 的主邮箱
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ''").first();
  if (left && left.n) {
    let mb = await env.DB.prepare('SELECT id FROM mailboxes WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
      .bind(rootId)
      .first();
    if (!mb) {
      const id = newId();
      await env.DB.prepare(
        'INSERT INTO mailboxes (id, user_id, local_part, domain, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, rootId, 'admin', def, '主邮箱', nowMs())
        .run();
      mb = { id };
    }
    await env.DB.prepare("UPDATE messages SET mailbox_id = ? WHERE mailbox_id = ''").bind(mb.id).run();
  }
}

async function ensureRoot(env) {
  const root = await env.DB.prepare("SELECT * FROM users WHERE role = 'root' LIMIT 1").first();
  if (root) {
    await ensureCatchAllBoxFor(env, root);
    return root;
  }

  const id = newId();
  const def = normalizeDomain(env.MAIL_DOMAIN || '') || 'localhost';
  const email = `admin@${def}`;
  const password = String(env.ACCESS_TOKEN || '') || 'admin-' + newId(10);
  const hash = await hashPassword(password);

  await env.DB.prepare(
    `INSERT INTO users (id, email, pass_hash, phone, nickname, role, status, created_at, last_login_at)
     VALUES (?, ?, ?, '', '站长', 'root', 'active', ?, 0)
     ON CONFLICT(email) DO NOTHING`
  )
    .bind(id, email, hash, nowMs())
    .run();

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (user) {
    const exists = await env.DB.prepare('SELECT id FROM mailboxes WHERE user_id = ? LIMIT 1').bind(user.id).first();
    if (!exists) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO mailboxes (id, user_id, local_part, domain, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(newId(), user.id, 'admin', def, '主邮箱', nowMs())
        .run();
    }
    await ensureCatchAllBoxFor(env, user);
  }
  return user;
}

/* ------------------------------ 基础工具 ------------------------------ */

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });

const bad = (message, status = 400) => json({ ok: false, error: message }, status);

function equalToken(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeFilename(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 120) || 'file';
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const QQ_MAIL_RE = /^[a-z0-9._%+-]+@(qq\.com|foxmail\.com|vip\.qq\.com)$/i;
const CN_PHONE_RE = /^1[3-9]\d{9}$/;

async function readSettings(env) {
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
    const map = {};
    for (const row of results || []) map[row.key] = row.value;
    return map;
  } catch {
    return {};
  }
}

async function writeSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
    .bind(key, String(value))
    .run();
}

/* ------------------------------ 口令 / 会话 ------------------------------ */

const enc = new TextEncoder();

const b64 = (bytes) => {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
};
const unb64 = (str) => {
  const s = atob(String(str || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // Cloudflare Workers 的 WebCrypto 硬上限：PBKDF2 迭代次数不能超过 100000，
  // 超过会直接抛 NotSupportedError（本地 Node 没这个限制）。这里就用上限值。
  const iterations = 100000;
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

const storedIterations = (stored) => Number(String(stored || '').split('$')[1]) || 0;

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  // 老库里可能存着 120000 次的哈希；Workers 上限 100000，这里夹一下，
  // 这种老哈希在云端校验不过，登录接口会提示让管理员重置一次密码
  const iterations = Math.min(Number(parts[1]) || 100000, 100000);
  const salt = unb64(parts[2]);
  const expected = unb64(parts[3]);
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
  );
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomToken = (n = 32) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const SESSION_DAYS = 30;

async function createSession(env, user, request) {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = nowMs();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(
      hash,
      user.id,
      now,
      now + SESSION_DAYS * 86400_000,
      String(request.headers.get('cf-connecting-ip') || '').slice(0, 60),
      String(request.headers.get('user-agent') || '').slice(0, 200)
    )
    .run();
  return token;
}

const isSecureRequest = (request) => {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
};

function sessionCookie(token, request) {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  return `mb_sess=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookie(request) {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  return `mb_sess=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}

async function currentUser(request, env) {
  const cookies = parseCookies(request.headers.get('cookie'));
  let token = cookies.mb_sess || '';
  if (!token) {
    const auth = String(request.headers.get('authorization') || '');
    if (/^Bearer\s+/i.test(auth)) token = auth.replace(/^Bearer\s+/i, '');
  }
  if (!token) return null;
  const hash = await sha256Hex(token);
  const session = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(hash).first();
  if (!session) return null;
  if (Number(session.expires_at) < nowMs()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
  if (!user || user.status !== 'active') return null;
  return user;
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length === 11 ? s.slice(0, 3) + '****' + s.slice(7) : s;
}

function maskEmail(e) {
  const [name, domain] = String(e || '').split('@');
  if (!domain) return String(e || '');
  const head = name.slice(0, Math.min(3, name.length));
  return `${head}${name.length > 3 ? '***' : ''}@${domain}`;
}

/* ------------------------------ 发信通道（Resend） ------------------------------ */

function hasMailer(env) {
  return Boolean(env && env.RESEND_API_KEY);
}

async function sendMail(env, { to, subject, text, html, from }) {
  const key = env && env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'no-key' };
  const domain = normalizeDomain(env.MAIL_DOMAIN || '') || 'example.com';
  const sender = from || env.MAIL_FROM || `noreply@${domain}`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: sender, to: [to], subject, text, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || `HTTP ${res.status}` };
    return { ok: true, id: data.id || '' };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  phone: u.phone ? maskPhone(u.phone) : '',
  nickname: u.nickname || '',
  role: u.role,
  status: u.status,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
  isAdmin: u.role === 'root' || u.role === 'admin',
});

async function throttle(env, key, limit, windowSec) {
  const since = nowMs() - windowSec * 1000;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND ts > ?')
    .bind(key, since)
    .first();
  return (row && row.n) >= limit;
}

async function recordAttempt(env, key) {
  await env.DB.prepare('INSERT INTO login_attempts (key, ts) VALUES (?, ?)').bind(key, nowMs()).run();
  if (Math.random() < 0.1) {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ts < ?').bind(nowMs() - 86400_000).run();
  }
}

/* ------------------------------ 域名 ------------------------------ */

let defaultDomainReady = false;
async function ensureDefaultDomain(env) {
  if (defaultDomainReady) return;
  const settings = await readSettings(env);
  const def = normalizeDomain(settings.domain || env.MAIL_DOMAIN || '');
  if (def && DOMAIN_RE.test(def)) {
    await env.DB.prepare('INSERT OR IGNORE INTO domains (name, note, created_at) VALUES (?, ?, ?)')
      .bind(def, '默认域名', nowMs())
      .run();
  }
  defaultDomainReady = true;
}

async function ensureDomain(env, domain) {
  const name = normalizeDomain(domain);
  if (!DOMAIN_RE.test(name)) return false;
  await env.DB.prepare('INSERT OR IGNORE INTO domains (name, note, created_at) VALUES (?, ?, ?)')
    .bind(name, '收到第一封信时自动登记', nowMs())
    .run();
  return true;
}

async function listDomains(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.name, d.note, d.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.domain = d.name) AS total,
            (SELECT COUNT(*) FROM messages m WHERE m.domain = d.name AND m.unread = 1) AS unread,
            (SELECT MAX(m.date) FROM messages m WHERE m.domain = d.name) AS last_date,
            (SELECT COUNT(*) FROM mailboxes b WHERE b.domain = d.name) AS mailboxes
       FROM domains d
      ORDER BY d.created_at ASC`
  ).all();
  return (results || []).map((r) => ({
    name: r.name,
    note: r.note,
    createdAt: r.created_at,
    total: r.total || 0,
    unread: r.unread || 0,
    lastDate: r.last_date || 0,
    mailboxes: r.mailboxes || 0,
  }));
}

async function defaultDomain(env) {
  const settings = await readSettings(env);
  const def = normalizeDomain(settings.domain || env.MAIL_DOMAIN || '');
  return def || 'localhost';
}

/* ------------------------------ 用户 ------------------------------ */

async function createUser(env, { email, password, phone, nickname, role = 'user' }) {
  const id = newId();
  const hash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (id, email, pass_hash, phone, nickname, role, status, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0)`
  )
    .bind(id, email, hash, phone || '', nickname || '', role, nowMs())
    .run();
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

async function findUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').bind(email).first();
}

/**
 * 子地址判定：local = 主邮箱名 + （纯数字 | 分隔符 + 任意后缀）
 *   bili → bili1 / bili-2 / bili_shop / bili.taobao 都算 bili 的子地址
 *   bilibili 不算（前面没有分隔符，也不是纯数字）
 */
function isSubOf(local, main) {
  if (!local || !main || local === main) return false;
  if (!local.startsWith(main)) return false;
  const rest = local.slice(main.length);
  if (/^\d+$/.test(rest)) return true;
  return /^[-._+]/.test(rest);
}

async function resolveMailbox(env, domain, local) {
  const exact = await env.DB.prepare('SELECT * FROM mailboxes WHERE domain = ? AND local_part = ?')
    .bind(domain, local)
    .first();
  if (exact) return exact;

  const { results } = await env.DB.prepare('SELECT * FROM mailboxes WHERE domain = ?').bind(domain).all();
  let best = null;
  for (const mb of results || []) {
    if (isSubOf(local, mb.local_part)) {
      if (!best || mb.local_part.length > best.local_part.length) best = mb;
    }
  }
  return best || null;
}

/** 主邮箱名是否与已有地址冲突（不能当别人的子地址，也不能让别人的主地址变成自己的子地址） */
async function nameConflict(env, domain, local) {
  const exact = await env.DB.prepare('SELECT id FROM mailboxes WHERE domain = ? AND local_part = ?')
    .bind(domain, local)
    .first();
  if (exact) return '这个邮箱名已经被占用了';

  const { results } = await env.DB.prepare('SELECT local_part FROM mailboxes WHERE domain = ?').bind(domain).all();
  for (const row of results || []) {
    if (isSubOf(local, row.local_part)) return `这个地址会被 ${row.local_part}@${domain} 的子地址规则吞掉，换一个`;
    if (isSubOf(row.local_part, local)) return `${row.local_part}@${domain} 已经是子地址，不能用它当主邮箱名`;
  }
  return null;
}

async function createMailbox(env, userId, domain, local, label = '') {
  const id = newId();
  const createdAt = nowMs();
  await env.DB.prepare(
    'INSERT INTO mailboxes (id, user_id, local_part, domain, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, local, domain, label, createdAt)
    .run();
  return { id, user_id: userId, local_part: local, domain, label, created_at: createdAt };
}

async function listMailboxes(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.local_part, b.domain, b.label, b.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = b.id) AS total,
            (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = b.id AND m.unread = 1) AS unread,
            (SELECT MAX(m.date) FROM messages m WHERE m.mailbox_id = b.id) AS last_date
       FROM mailboxes b
      WHERE b.user_id = ?
      ORDER BY CASE WHEN b.label = '主邮箱' THEN 0 ELSE 1 END, b.created_at ASC`
  )
    .bind(userId)
    .all();

  const out = [];
  for (const row of results || []) {
    const { results: subs } = await env.DB.prepare(
      `SELECT s.local_part, s.domain, s.source, s.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.alias = s.local_part AND m.domain = s.domain) AS total,
              (SELECT COUNT(*) FROM messages m WHERE m.alias = s.local_part AND m.domain = s.domain AND m.unread = 1) AS unread,
              (SELECT MAX(m.date) FROM messages m WHERE m.alias = s.local_part AND m.domain = s.domain) AS last_date
         FROM subaddresses s
        WHERE s.mailbox_id = ? AND s.source <> 'blocked'
        ORDER BY s.created_at ASC`
    )
      .bind(row.id)
      .all();
    out.push({
      id: row.id,
      localPart: row.local_part,
      domain: row.domain,
      address: `${row.local_part}@${row.domain}`,
      label: row.label || '',
      createdAt: row.created_at,
      total: row.total || 0,
      unread: row.unread || 0,
      lastDate: row.last_date || 0,
      subs: (subs || []).map((s) => ({
        localPart: s.local_part,
        domain: s.domain,
        address: `${s.local_part}@${s.domain}`,
        source: s.source,
        total: s.total || 0,
        unread: s.unread || 0,
        lastDate: s.last_date || 0,
      })),
    });
  }
  return out;
}

/* ------------------------------ 一邮多用（外部邮箱聚合） ------------------------------ */

// 各家邮箱的「自动转发」都在设置里；这里给出对应的默认后缀和提示文案
const PROVIDERS = {
  qq: { name: 'QQ 邮箱', slug: 'qq', hint: 'QQ 邮箱 → 设置 → 账户 → 自动转发 → 添加收件人，填下面的地址；验证邮件会自动出现在这里' },
  foxmail: { name: 'Foxmail', slug: 'foxmail', hint: 'Foxmail 与 QQ 邮箱同源：设置 → 账户 → 自动转发 → 添加收件人' },
  gmail: { name: 'Gmail', slug: 'gmail', hint: 'Gmail → 设置 → 转发和 POP/IMAP → 添加转发地址 → 确认（确认信会进这里）' },
  '163': { name: '网易 163', slug: '163', hint: '163 邮箱 → 设置 → 自动转发 / 邮件转移 → 开启并填下面的地址' },
  '126': { name: '网易 126', slug: '126', hint: '126 邮箱 → 设置 → 自动转发 / 邮件转移 → 开启并填下面的地址' },
  tencent: { name: '腾讯企业邮', slug: 'tx', hint: '腾讯企业邮 → 设置 → 邮件转移 → 添加收件人' },
  outlook: { name: 'Outlook', slug: 'outlook', hint: 'Outlook → 设置 → 邮件 → 转发 → 填下面的地址并验证' },
  icloud: { name: 'iCloud 邮件', slug: 'icloud', hint: 'iCloud 邮件网页版 → 设置 → 规则 / 转发 → 填下面的地址' },
  other: { name: '其它邮箱', slug: 'mail', hint: '在你原来的邮箱里把「自动转发 / 邮件转移」指向下面的地址即可' },
};

const providerName = (key) => (PROVIDERS[key] ? PROVIDERS[key].name : '外部邮箱');

async function mainMailboxOf(env, userId) {
  const row = await env.DB.prepare(
    `SELECT * FROM mailboxes WHERE user_id = ?
      ORDER BY CASE WHEN label = '主邮箱' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`
  )
    .bind(userId)
    .first();
  return row || null;
}

async function listExternal(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM messages m WHERE m.alias = e.intake_local AND m.domain = e.intake_domain AND m.unread = 1) AS unread
       FROM external_accounts e
      WHERE e.user_id = ? AND e.status = 'active'
      ORDER BY e.created_at ASC`
  )
    .bind(userId)
    .all();
  return (results || []).map((r) => ({
    id: r.id,
    mailboxId: r.mailbox_id,
    provider: r.provider,
    providerName: providerName(r.provider),
    address: r.address,
    intake: `${r.intake_local}@${r.intake_domain}`,
    localPart: r.intake_local,
    label: r.label || '',
    status: r.status,
    mailCount: r.mail_count || 0,
    unread: r.unread || 0,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at || 0,
    hint: (PROVIDERS[r.provider] || PROVIDERS.other).hint,
  }));
}

async function createExternal(env, user, { provider, address, label }) {
  const key = String(provider || '').toLowerCase();
  if (!PROVIDERS[key]) return { error: '不支持这个邮箱类型' };
  const ext = String(address || '').trim().toLowerCase();
  if (!EMAIL_RE.test(ext)) return { error: '外部邮箱地址格式不对' };

  const main = await mainMailboxOf(env, user.id);
  if (!main) return { error: '你还没有主邮箱，先去左侧新建一个' };

  const dup = await env.DB.prepare(
    "SELECT id FROM external_accounts WHERE user_id = ? AND address = ? AND status = 'active'"
  )
    .bind(user.id, ext)
    .first();
  if (dup) return { error: '这个外部邮箱已经接进来了' };

  // 生成入口地址：主邮箱名 + 后缀，例如 bili-qq@域名；重名就 -qq2、-qq3
  const base = PROVIDERS[key].slug;
  let local = `${main.local_part}-${base}`;
  for (let i = 2; i < 50; i++) {
    const taken = await env.DB.prepare('SELECT id FROM subaddresses WHERE domain = ? AND local_part = ?')
      .bind(main.domain, local)
      .first();
    if (!taken) break;
    local = `${main.local_part}-${base}${i}`;
  }
  if (!isSubOf(local, main.local_part)) return { error: '无法生成入口地址，换个主邮箱试试' };

  const now = nowMs();
  // 之前移除过的同一个入口：清掉墓碑，重新启用
  await env.DB.prepare(
    "DELETE FROM external_accounts WHERE status = 'disabled' AND ((user_id = ? AND address = ?) OR (intake_domain = ? AND intake_local = ?))"
  )
    .bind(user.id, ext, main.domain, local)
    .run();

  await env.DB.prepare(
    'INSERT OR IGNORE INTO subaddresses (id, mailbox_id, local_part, domain, source, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(newId(), main.id, local, main.domain, 'external', now)
    .run();

  const id = newId();
  await env.DB.prepare(
    `INSERT INTO external_accounts
       (id, user_id, mailbox_id, provider, address, intake_local, intake_domain, label, status, mail_count, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, 0)`
  )
    .bind(id, user.id, main.id, key, ext, local, main.domain, String(label || '').slice(0, 24), now)
    .run();

  return { ok: true, external: (await listExternal(env, user.id)).find((e) => e.id === id) };
}

/* ------------------------------ 收信 ------------------------------ */

/**
 * 「未登记地址」收件箱：谁都没认领的地址就到这儿，归属 root。
 * 没有它的话，用户随便填一个 xxx@域名 收 ChatGPT 验证码，信会被静默丢弃。
 */
async function ensureCatchAllBoxFor(env, root) {
  if (!root) return null;
  const existing = await env.DB.prepare(
    'SELECT * FROM mailboxes WHERE user_id = ? AND label = ? LIMIT 1'
  )
    .bind(root.id, '未登记地址')
    .first();
  if (existing) return existing;

  const domain = await defaultDomain(env);
  let local = 'catchall';
  for (let i = 2; i < 20; i++) {
    const taken = await env.DB.prepare('SELECT id FROM mailboxes WHERE domain = ? AND local_part = ?')
      .bind(domain, local)
      .first();
    if (!taken) break;
    local = `catchall${i}`;
  }
  const box = {
    id: newId(),
    user_id: root.id,
    local_part: local,
    domain,
    label: '未登记地址',
    created_at: nowMs(),
  };
  await env.DB.prepare(
    'INSERT OR IGNORE INTO mailboxes (id, user_id, local_part, domain, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(box.id, box.user_id, box.local_part, box.domain, box.label, box.created_at)
    .run();
  return (
    (await env.DB.prepare('SELECT * FROM mailboxes WHERE domain = ? AND local_part = ?').bind(domain, local).first()) || null
  );
}

async function ensureCatchAllBox(env) {
  const root = await ensureRoot(env);
  return ensureCatchAllBoxFor(env, root);
}

async function recordDropped(env, { domain, local, from, subject, size, now }) {
  try {
    await env.DB.prepare(
      'INSERT INTO dropped_mail (id, domain, local_part, from_addr, subject, size, date) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(newId(), domain, local, String(from || '').slice(0, 200), String(subject || '').slice(0, 200), size || 0, now)
      .run();
  } catch {
    /* 记录失败不影响收信主流程 */
  }
}

async function storeIncoming(env, rawBytes, parsed, recipients) {
  const settings = await readSettings(env);
  const autoSub = String(settings.subAddressAuto ?? '1') !== '0';
  const now = nowMs();
  const saved = [];

  // 自动清理：keepDays > 0 时，收信时顺手删掉过期邮件（抽样触发，避免每封都扫表）
  const keepDays = Number(settings.keepDays || 0);
  if (keepDays > 0 && Math.random() < 0.2) {
    const cutoff = now - keepDays * 86400_000;
    const { results } = await env.DB.prepare('SELECT id FROM messages WHERE date < ? LIMIT 500').bind(cutoff).all();
    for (const row of results || []) {
      await env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(row.id).run();
    }
    await env.DB.prepare('DELETE FROM messages WHERE date < ?').bind(cutoff).run();
  }

  for (const rcpt of recipients) {
    const [localRaw, domainRaw] = String(rcpt || '').replace(/^<|>$/g, '').split('@');
    const local = (localRaw || '').toLowerCase().trim();
    const domain = normalizeDomain(domainRaw);
    if (!local || !DOMAIN_RE.test(domain)) continue;

    let mb = await resolveMailbox(env, domain, local);
    let isCatchAll = false;
    if (!mb) {
      // 没有归属的地址：不再静默丢弃。
      // 开关打开时落到 root 的「未登记地址」收件箱（ChatGPT 这类验证码只要发出就收得到）；
      // 关掉就记一笔到 dropped_mail，至少能在后台看见「什么地址被丢了」。
      if (String(settings.catchAll ?? '1') === '0') {
        await recordDropped(env, { domain, local, from: parsed.from.address, subject: parsed.subject, size: rawBytes.length, now });
        continue;
      }
      mb = await ensureCatchAllBox(env);
      if (!mb) {
        await recordDropped(env, { domain, local, from: parsed.from.address, subject: parsed.subject, size: rawBytes.length, now });
        continue;
      }
      isCatchAll = true;
    }

    // 一邮多用：这个收件地址是不是某个外部邮箱的转发入口？被移除的入口直接丢弃
    const ext = await env.DB.prepare(
      'SELECT id, provider, status FROM external_accounts WHERE intake_domain = ? AND intake_local = ?'
    )
      .bind(domain, local)
      .first();
    if (ext && ext.status !== 'active') continue;

    if (local !== mb.local_part && !isCatchAll) {
      const exists = await env.DB.prepare('SELECT id, source FROM subaddresses WHERE domain = ? AND local_part = ?')
        .bind(domain, local)
        .first();
      // 用户删掉的子地址会留一条 blocked 墓碑：以后寄给它的信直接丢进「被丢弃的信」
      if (exists && exists.source === 'blocked') {
        await recordDropped(env, { domain, local, from: parsed.from.address, subject: parsed.subject, size: rawBytes.length, now });
        continue;
      }
      if (!exists) {
        if (!autoSub) continue;
        await env.DB.prepare(
          'INSERT OR IGNORE INTO subaddresses (id, mailbox_id, local_part, domain, source, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(newId(), mb.id, local, domain, 'auto', now)
          .run();
      }
    }

    // 一邮多用：这个收件地址是不是某个外部邮箱的转发入口？
    const extActive = ext && ext.status === 'active' ? ext : null;

    const id = newId();
    const keepRaw = rawBytes && rawBytes.length <= 900_000 ? rawBytes : null;
    await env.DB.prepare(
      `INSERT INTO messages
         (id, mailbox_id, domain, alias, to_addr, from_name, from_addr, subject, snippet, date, size, raw,
          text_body, html_body, unread, created_at, ext_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(
        id, mb.id, domain, local, `${local}@${domain}`,
        parsed.from.name || '', parsed.from.address || '',
        parsed.subject || '', parsed.snippet || '', parsed.date || now, rawBytes.length, keepRaw,
        parsed.text || '', parsed.html || '', now, extActive ? extActive.provider : ''
      )
      .run();

    if (extActive) {
      await env.DB.prepare('UPDATE external_accounts SET last_seen_at = ?, mail_count = mail_count + 1 WHERE id = ?')
        .bind(now, extActive.id)
        .run();
    }

    let idx = 0;
    for (const att of parsed.attachments || []) {
      const data = att.data || new Uint8Array(0);
      const ok = data.length <= 900_000;
      await env.DB.prepare(
        `INSERT INTO attachments (message_id, idx, filename, content_type, size, cid, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id, idx, (att.filename || '附件') + (ok ? '' : '（过大未保存）'),
          att.contentType || 'application/octet-stream', data.length,
          att.contentId || '', ok ? data : new Uint8Array(0)
        )
        .run();
      idx++;
    }

    saved.push({
      id,
      mailbox: `${mb.local_part}@${mb.domain}`,
      address: `${local}@${domain}`,
      subject: parsed.subject,
    });
  }
  return saved;
}

/* ------------------------------ 查询 ------------------------------ */

async function listMessages(env, { userId, mailboxId = '', alias = '', q = '', limit = 60, offset = 0 }) {
  const like = `%${q}%`;
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.mailbox_id, m.domain, m.alias, m.to_addr, m.from_name, m.from_addr,
            m.subject, m.snippet, m.date, m.size, m.unread, m.ext_source,
            (SELECT COUNT(*) FROM attachments t WHERE t.message_id = m.id) AS attach_count,
            b.local_part AS mb_local
       FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE b.user_id = ?
        AND (? = '' OR m.mailbox_id = ?)
        AND (? = '' OR m.alias = ?)
        AND (? = '' OR m.subject LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ? OR m.snippet LIKE ?)
      ORDER BY m.date DESC, m.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(userId, mailboxId, mailboxId, alias, alias, q, like, like, like, like, limit, offset)
    .all();
  return (results || []).map((r) => ({
    id: r.id,
    mailboxId: r.mailbox_id,
    mailbox: r.mb_local,
    domain: r.domain,
    alias: r.alias,
    to: r.to_addr,
    from: { name: r.from_name, address: r.from_addr },
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    size: r.size,
    unread: !!r.unread,
    attachments: r.attach_count || 0,
    extSource: r.ext_source || '',
  }));
}

async function countMessages(env, { userId, mailboxId = '', alias = '' }) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE b.user_id = ? AND (? = '' OR m.mailbox_id = ?) AND (? = '' OR m.alias = ?)`
  )
    .bind(userId, mailboxId, mailboxId, alias, alias)
    .first();
  return row ? row.n : 0;
}

async function statsFor(env, userId) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?) AS mailboxes,
            (SELECT COUNT(*) FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ?) AS messages,
            (SELECT COUNT(*) FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ? AND m.unread = 1) AS unread,
            (SELECT COALESCE(SUM(m.size), 0) FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ?) AS bytes,
            (SELECT COUNT(*) FROM subaddresses s JOIN mailboxes b ON b.id = s.mailbox_id WHERE b.user_id = ?) AS subs`
  )
    .bind(userId, userId, userId, userId, userId)
    .first();
  return {
    mailboxes: row.mailboxes || 0,
    messages: row.messages || 0,
    unread: row.unread || 0,
    bytes: row.bytes || 0,
    subs: row.subs || 0,
  };
}

async function listDropped(env, limit = 10) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT domain, local_part, from_addr, subject, date FROM dropped_mail ORDER BY date DESC LIMIT ?'
    )
      .bind(limit)
      .all();
    return (results || []).map((r) => ({
      address: `${r.local_part}@${r.domain}`,
      from: r.from_addr,
      subject: r.subject,
      date: r.date,
    }));
  } catch {
    return [];
  }
}

async function adminStats(env) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
            (SELECT COUNT(*) FROM mailboxes) AS mailboxes,
            (SELECT COUNT(*) FROM subaddresses) AS subs,
            (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM messages WHERE unread = 1) AS unread,
            (SELECT COALESCE(SUM(size), 0) FROM messages) AS bytes,
            (SELECT COUNT(*) FROM domains) AS domains,
            (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS sessions,
            (SELECT COUNT(*) FROM dropped_mail) AS dropped`
  )
    .bind(nowMs())
    .first();
  return {
    users: row.users || 0,
    activeUsers: row.active_users || 0,
    mailboxes: row.mailboxes || 0,
    subs: row.subs || 0,
    messages: row.messages || 0,
    unread: row.unread || 0,
    bytes: row.bytes || 0,
    domains: row.domains || 0,
    sessions: row.sessions || 0,
    dropped: row.dropped || 0,
  };
}

/* ------------------------------ 静态资源 ------------------------------ */

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https: http:; font-src 'self' data:; " +
    "frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'",
};

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveAsset(pathname) {
  const key = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  const body = ASSETS[key];
  if (body === undefined) return null;
  const ext = key.slice(key.lastIndexOf('.'));
  return new Response(body, {
    headers: {
      'content-type': MIME_BY_EXT[ext] || 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      ...SECURITY_HEADERS,
    },
  });
}

/* ------------------------------ 主逻辑 ------------------------------ */

async function bootstrapPayload(env, user, url) {
  await ensureDefaultDomain(env);
  const boxes = await listMailboxes(env, user.id);
  const wanted = url.searchParams.get('mailbox') || '';
  const mailboxId = boxes.some((b) => b.id === wanted) ? wanted : '';
  const settings = await readSettings(env);
  const domains = await listDomains(env);
  return {
    ok: true,
    authenticated: true,
    user: publicUser(user),
    domain: await defaultDomain(env),
    domains: user.role === 'root' || user.role === 'admin' ? domains : domains.map((d) => ({ name: d.name })),
    mailboxes: boxes,
    mailbox: mailboxId,
    externals: await listExternal(env, user.id),
    messages: await listMessages(env, { userId: user.id, mailboxId, limit: 60 }),
    total: await countMessages(env, { userId: user.id, mailboxId }),
    stats: await statsFor(env, user.id),
    caps: { realtime: false, eml: false, multiUser: true, admin: user.role === 'root' || user.role === 'admin' },
    config: {
      subAddressAuto: String(settings.subAddressAuto ?? '1') !== '0',
      smsEnabled: String(settings.smsEnabled ?? '0') === '1',
      keepDays: Number(settings.keepDays || 0),
      requireQQ: String(settings.requireQQ ?? '1') !== '0',
      catchAll: String(settings.catchAll ?? '1') !== '0',
    },
  };
}

async function handleApi(request, env, url) {
  const p = url.pathname;
  const method = request.method;
  const accessToken = env.ACCESS_TOKEN || '';
  const user = await currentUser(request, env);

  /* ---------- 注册 / 登录 / 退出 ---------- */

  /* ---------- 注册前：证明这个 QQ 邮箱是你的（发 6 位验证码） ---------- */

  if (p === '/api/auth/verify/start' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const settings = await readSettings(env);
    const requireQQ = String(settings.requireQQ ?? '1') !== '0';
    if (!EMAIL_RE.test(email)) return bad('邮箱格式不对');
    if (requireQQ && !QQ_MAIL_RE.test(email)) return bad('目前只支持 QQ 邮箱（@qq.com / @foxmail.com）');
    if (await findUserByEmail(env, email)) return bad('这个邮箱已经注册过了，直接登录吧', 409);
    if (!hasMailer(env)) return bad('站点还没接上发信通道，暂时不能自助注册，请联系管理员', 503);

    const ip = String(request.headers.get('cf-connecting-ip') || 'local');
    if (await throttle(env, `verify:${ip}`, 10, 600)) return bad('操作太频繁，请 10 分钟后再试', 429);

    const domain = (await defaultDomain(env)) || normalizeDomain(env.MAIL_DOMAIN) || 'example.com';
    const token = newId(12);
    const now = nowMs();
    const code = sixDigitCode();
    const minutes = 10;

    await env.DB.prepare(
      'INSERT INTO signup_verifications (token, email, status, created_at, expires_at, code, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(token, email, 'pending', now, now + minutes * 60 * 1000, code, 'signup')
      .run();

    const sent = await sendMail(env, {
      to: email,
      subject: `【${domain}】注册验证码：${code}`,
      text:
        `你正在 ${domain} 注册邮箱账号，验证码：${code}\n\n` +
        `有效期 ${minutes} 分钟。如果不是你本人操作，忽略这封邮件即可。`,
      html:
        `<p>你正在 <b>${domain}</b> 注册邮箱账号，验证码：</p>` +
        `<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>` +
        `<p>有效期 ${minutes} 分钟。如果不是你本人操作，忽略这封邮件即可。</p>`,
    });

    if (!sent.ok) {
      await env.DB.prepare('DELETE FROM signup_verifications WHERE token = ?').bind(token).run();
      return bad('验证码发送失败，请稍后再试', 502);
    }

    return json({
      ok: true,
      mode: 'code',
      token,
      expiresIn: minutes * 60,
      sentTo: maskEmail(email),
      hint: `验证码已发到 ${maskEmail(email)}，${minutes} 分钟内有效`,
    });
  }

  if (p === '/api/auth/verify/confirm' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '').trim();
    const code = String(body.code || '').replace(/\D/g, '');
    const row = token
      ? await env.DB.prepare('SELECT token, email, status, expires_at, code FROM signup_verifications WHERE token = ?')
          .bind(token)
          .first()
      : null;
    if (!row) return bad('验证已失效，请重新获取验证码', 404);
    if (nowMs() > row.expires_at) return bad('验证码已过期，请重新获取', 410);
    if (row.status === 'verified') return json({ ok: true, verified: true, email: row.email });
    if (code !== row.code) return bad('验证码不对，再核对一下邮件', 403);
    await env.DB.prepare("UPDATE signup_verifications SET status = 'verified', verified_at = ? WHERE token = ?")
      .bind(nowMs(), token)
      .run();
    return json({ ok: true, verified: true, email: row.email });
  }

  if (p === '/api/auth/verify/status' && method === 'GET') {
    const token = String(url.searchParams.get('token') || '').trim();
    const row = token
      ? await env.DB.prepare('SELECT token, email, status, expires_at FROM signup_verifications WHERE token = ?')
          .bind(token)
          .first()
      : null;
    if (!row) return json({ ok: true, verified: false, expired: true, reason: 'token' });
    const expired = nowMs() > row.expires_at;
    return json({ ok: true, verified: row.status === 'verified', expired, email: row.email });
  }

  if (p === '/api/auth/register' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const settings = await readSettings(env);
    const requireQQ = String(settings.requireQQ ?? '1') !== '0';
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const phone = String(body.phone || '').replace(/[\s-]/g, '').replace(/^\+?86/, '');
    const nickname = String(body.nickname || '').trim().slice(0, 24);
    let local = String(body.mailbox || body.localPart || '').trim().toLowerCase();
    if (local.includes('@')) local = local.split('@')[0];

    if (!EMAIL_RE.test(email)) return bad('邮箱格式不对');
    if (requireQQ && !QQ_MAIL_RE.test(email)) return bad('目前只支持 QQ 邮箱（@qq.com / @foxmail.com）注册');
    if (password.length < 8) return bad('密码至少 8 位');
    if (phone && !CN_PHONE_RE.test(phone)) return bad('手机号要填 11 位中国大陆号码，或者留空');
    if (!LOCAL_RE.test(local)) return bad('邮箱名只能用字母、数字、点、下划线、短横线，字母或数字开头，最多 32 位');

    // 必须先证明邮箱是你的：用该 QQ 邮箱给我们发过一封确认信
    const vToken = String(body.token || '').trim();
    const verifyRow = vToken
      ? await env.DB.prepare('SELECT email, status, expires_at FROM signup_verifications WHERE token = ?').bind(vToken).first()
      : null;
    if (!verifyRow || verifyRow.status !== 'verified' || verifyRow.email !== email) {
      return bad('请先点「验证这个邮箱」，用你的 QQ 邮箱发一封确认信过来', 403);
    }
    if (nowMs() > (verifyRow.expires_at || 0)) return bad('邮箱验证已过期，请重新验证', 403);

    if (await findUserByEmail(env, email)) return bad('这个邮箱已经注册过了', 409);
    if (phone) {
      const phoneUsed = await env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first();
      if (phoneUsed) return bad('这个手机号已经绑定过账号了', 409);
    }

    await ensureDefaultDomain(env);
    const domain = normalizeDomain(body.domain) || (await defaultDomain(env));
    const known = await env.DB.prepare('SELECT name FROM domains WHERE name = ?').bind(domain).first();
    if (!known) return bad(`域名 ${domain} 还没开通，请从下拉里选一个`, 400);
    const conflict = await nameConflict(env, domain, local);
    if (conflict) return bad(conflict, 409);

    // 数据库里 mailboxes 有 UNIQUE(domain, local_part)、users 有 UNIQUE(email)，
    // 两个人同时抢同一个名字时靠这两条兜底，不会真的出现两条同地址
    let created;
    try {
      created = await createUser(env, { email, password, phone, nickname: nickname || local });
    } catch {
      return bad('这个邮箱已经注册过了，直接登录吧', 409);
    }
    try {
      await createMailbox(env, created.id, domain, local, '主邮箱');
    } catch {
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(created.id).run();
      return bad('这个邮箱名刚被人抢先了，换一个名字再试', 409);
    }
    await env.DB.prepare('DELETE FROM signup_verifications WHERE email = ?').bind(email).run();
    const token = await createSession(env, created, request);
    return json({ ok: true, user: publicUser(created) }, 200, { 'set-cookie': sessionCookie(token, request) });
  }

  if ((p === '/api/auth/login' || p === '/api/login') && method === 'POST') {
    if (!accessToken) return bad('服务端还没有配置 ACCESS_TOKEN', 500);
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const ip = String(request.headers.get('cf-connecting-ip') || 'local');
    const key = `${ip}:${email || 'anon'}`;
    if (await throttle(env, key, 20, 900)) return bad('尝试次数过多，请 15 分钟后再试', 429);

    // 应急口令：只传 password（旧调用方式），直接进 root
    if (equalToken(password, accessToken) && !email) {
      const root = await ensureRoot(env);
      const token = await createSession(env, root, request);
      return json({ ok: true, user: publicUser(root), emergency: true }, 200, {
        'set-cookie': sessionCookie(token, request),
      });
    }

    const found = email ? await findUserByEmail(env, email) : null;
    const passOk = found
      ? (await verifyPassword(password, found.pass_hash)) || equalToken(password, accessToken)
      : false;

    if (!found || !passOk) {
      await recordAttempt(env, key);
      if (found && storedIterations(found.pass_hash) > 100000) {
        return bad('这个账号的密码哈希是旧版本（迭代次数超过云端上限），请让管理员在后台重置一次密码', 409);
      }
      return bad('邮箱或密码不正确', 401);
    }
    if (found.status !== 'active') return bad('该账号已被停用，请联系管理员', 403);
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowMs(), found.id).run();
    const token = await createSession(env, found, request);
    return json({ ok: true, user: publicUser(found) }, 200, { 'set-cookie': sessionCookie(token, request) });
  }

  if (p === '/api/auth/qq' && method === 'GET') {
    // 预留：拿到 QQ 互联 APP ID / KEY 后在这里换 code → openid，再绑定到 users
    return json(
      {
        ok: false,
        error: 'QQ 一键登录待接入：需要 QQ 互联的 APP ID / APP KEY 和已备案的回调域名。现在请用 QQ 邮箱 + 密码登录。',
        code: 'QQ_OAUTH_NOT_CONFIGURED',
      },
      501
    );
  }

  if (p === '/api/auth/logout' || p === '/api/logout') {
    const cookies = parseCookies(request.headers.get('cookie'));
    if (cookies.mb_sess) {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(cookies.mb_sess)).run();
    }
    return json({ ok: true }, 200, { 'set-cookie': clearCookie(request) });
  }

  /* ---------- 忘记密码：邮箱验证码重置 ---------- */

  if (p === '/api/auth/reset/start' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return bad('邮箱格式不对');
    const ip = String(request.headers.get('cf-connecting-ip') || 'local');
    if (await throttle(env, `reset:${ip}`, 6, 600)) return bad('操作太频繁，请 10 分钟后再试', 429);
    if (!hasMailer(env)) return bad('站点还没有接上发信通道，暂时不能自助找回，请联系管理员重置', 503);

    const target = await findUserByEmail(env, email);
    if (!target) return bad('这个邮箱还没注册过', 404);
    if (target.status === 'disabled') return bad('这个账号已被停用，请联系管理员', 403);

    const code = sixDigitCode();
    const now = nowMs();
    await env.DB.prepare(
      `INSERT INTO reset_codes (email, code, expires_at, tries, created_at) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, tries = 0, created_at = excluded.created_at`
    )
      .bind(email, code, now + 10 * 60 * 1000, now)
      .run();

    const domain = normalizeDomain(env.MAIL_DOMAIN || '') || 'example.com';
    const sent = await sendMail(env, {
      to: email,
      subject: `【${domain}】找回密码验证码：${code}`,
      text: `你在 ${domain} 申请重置密码，验证码：${code}\n\n10 分钟内有效。如果不是你本人操作，忽略这封邮件，密码不会变。`,
      html:
        `<p>你在 <b>${domain}</b> 申请重置密码，验证码：</p>` +
        `<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>` +
        `<p>10 分钟内有效。如果不是你本人操作，忽略这封邮件，密码不会变。</p>`,
    });
    if (!sent.ok) return bad('验证码发送失败，请稍后再试', 502);
    return json({ ok: true, sentTo: maskEmail(email), expiresIn: 600 });
  }

  if (p === '/api/auth/reset/confirm' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').replace(/\D/g, '');
    const password = String(body.password || '');
    if (password.length < 8) return bad('新密码至少 8 位');
    const target = await findUserByEmail(env, email);
    if (!target) return bad('这个邮箱还没注册过', 404);
    const row = await env.DB.prepare('SELECT email, code, expires_at, tries FROM reset_codes WHERE email = ?')
      .bind(email)
      .first();
    if (!row) return bad('请先获取验证码', 400);
    if (nowMs() > row.expires_at) return bad('验证码已过期，请重新获取', 410);
    if (Number(row.tries) >= 5) return bad('错误次数太多，请重新获取验证码', 429);
    if (code !== row.code) {
      await env.DB.prepare('UPDATE reset_codes SET tries = tries + 1 WHERE email = ?').bind(email).run();
      return bad('验证码不对，再核对一下邮件', 403);
    }

    await env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(password), target.id).run();
    await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?').bind(email).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run();
    return json({ ok: true });
  }

  /* ---------- 未登录也能拿到的启动信息 ---------- */

  if (p === '/api/bootstrap') {
    if (!user) {
      const settings = await readSettings(env);
      return json({
        ok: true,
        authenticated: false,
        domain: await defaultDomain(env),
        config: {
          smsEnabled: String(settings.smsEnabled ?? '0') === '1',
          requireQQ: String(settings.requireQQ ?? '1') !== '0',
          mailerEnabled: hasMailer(env),
        },
      });
    }
    return json(await bootstrapPayload(env, user, url));
  }

  /* ---------- 外部投递（管理员口令，不需要登录会话） ---------- */

  if (p === '/api/ingest' && method === 'POST') {
    const headerToken = request.headers.get('x-token') || url.searchParams.get('token') || '';
    if (!equalToken(headerToken, accessToken)) return bad('未授权', 401);
    const maxBytes = 25 * 1024 * 1024;
    const ctype = String(request.headers.get('content-type') || '');
    let raw;
    let to;
    if (ctype.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      const b64raw = String(body.raw || body.rawBase64 || '');
      raw = b64raw ? unb64(b64raw) : enc.encode(String(body.text || ''));
      to = body.to || '';
    } else {
      raw = new Uint8Array(await request.arrayBuffer());
      to = new URL(request.url).searchParams.get('to') || request.headers.get('x-rcpt') || '';
    }
    if (raw.length > maxBytes) return bad('邮件太大', 413);
    const list = String(to)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!list.length || !raw.length) return bad('缺少 to 或邮件内容', 400);
    const parsed = parseMime(raw);
    return json({ ok: true, saved: await storeIncoming(env, raw, parsed, list) });
  }

  if (!user) return bad('未登录', 401);

  /* ---------- 自己的资料 ---------- */

  if (p === '/api/me' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const nickname = String(body.nickname || '').trim().slice(0, 24);
    const hasPhone = Object.prototype.hasOwnProperty.call(body, 'phone');
    const phone = hasPhone ? String(body.phone || '').replace(/[\s-]/g, '').replace(/^\+?86/, '') : user.phone;
    const password = String(body.password || '');
    const oldPassword = String(body.oldPassword || '');
    const passOk = (await verifyPassword(oldPassword, user.pass_hash)) || (oldPassword && equalToken(oldPassword, accessToken));

    if (phone && phone !== user.phone && !CN_PHONE_RE.test(phone)) return bad('手机号格式不对');
    if (phone && phone !== user.phone) {
      // 换绑手机号要先证明是本人（当前密码）
      if (!passOk) return bad('换绑手机号要先输入当前密码', 403);
      const used = await env.DB.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').bind(phone, user.id).first();
      if (used) return bad('这个手机号已经绑定过账号了', 409);
    }
    if (password) {
      if (password.length < 8) return bad('新密码至少 8 位');
      if (!passOk) return bad('原密码不正确', 403);
    }

    const nextHash = password ? await hashPassword(password) : user.pass_hash;
    await env.DB.prepare('UPDATE users SET nickname = ?, phone = ?, pass_hash = ? WHERE id = ?')
      .bind(nickname || user.nickname, phone, nextHash, user.id)
      .run();
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    return json({ ok: true, user: publicUser(fresh) });
  }

  /* ---------- 换绑登录邮箱（要验证新邮箱） ---------- */

  if (p === '/api/me/email' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const vToken = String(body.token || '').trim();
    const settings = await readSettings(env);
    const requireQQ = String(settings.requireQQ ?? '1') !== '0';

    if (!EMAIL_RE.test(email)) return bad('邮箱格式不对');
    if (requireQQ && !QQ_MAIL_RE.test(email)) return bad('目前只支持 QQ 邮箱（@qq.com / @foxmail.com）');
    if (email === user.email) return bad('这就是你现在的登录邮箱', 400);
    if (!(await verifyPassword(password, user.pass_hash)) && !(password && equalToken(password, accessToken))) {
      return bad('当前密码不正确', 403);
    }
    const other = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').bind(email, user.id).first();
    if (other) return bad('这个邮箱已经注册过账号了', 409);

    const v = vToken
      ? await env.DB.prepare('SELECT email, status, expires_at FROM signup_verifications WHERE token = ?').bind(vToken).first()
      : null;
    if (!v || v.status !== 'verified' || v.email !== email) {
      return bad('请先用新邮箱发一封确认信完成验证', 403);
    }
    if (nowMs() > (v.expires_at || 0)) return bad('邮箱验证已过期，请重新验证', 403);

    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, user.id).run();
    await env.DB.prepare('DELETE FROM signup_verifications WHERE email = ?').bind(email).run();
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    return json({ ok: true, user: publicUser(fresh) });
  }

  /* ---------- 邮箱（主邮箱 / 子地址） ---------- */

  if (p === '/api/mailboxes' && method === 'GET') {
    return json({ ok: true, mailboxes: await listMailboxes(env, user.id) });
  }

  if (p === '/api/mailboxes' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const domain = normalizeDomain(body.domain) || (await defaultDomain(env));
    let local = String(body.name || '').trim().toLowerCase();
    if (local.includes('@')) local = local.split('@')[0];
    if (!LOCAL_RE.test(local)) return bad('邮箱名格式不对（字母数字点下划线短横线，最多 32 位）');

    const owned = await env.DB.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?').bind(user.id).first();
    const isAdmin = user.role === 'root' || user.role === 'admin';
    if (!isAdmin && (owned?.n || 0) >= 1) {
      return bad('每个账号只能有 1 个主邮箱；同一个主邮箱下用 bili1、bili-shop 这样的子地址就行', 409);
    }
    const conflict = await nameConflict(env, domain, local);
    if (conflict) return bad(conflict, 409);
    try {
      await createMailbox(env, user.id, domain, local, String(body.label || '').slice(0, 24));
    } catch {
      return bad('这个邮箱地址刚刚被占用了，换一个', 409);
    }
    return json({ ok: true, mailboxes: await listMailboxes(env, user.id) });
  }

  /* ---------- 手动建子地址（子邮箱） ---------- */

  if (p === '/api/subaddresses' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const main = await mainMailboxOf(env, user.id);
    if (!main) return bad('你还没有主邮箱，先建一个', 404);

    let local = String(body.name || '').trim().toLowerCase();
    if (local.includes('@')) local = local.split('@')[0];
    if (!LOCAL_RE.test(local)) return bad('名字格式不对（字母数字点下划线短横线，最多 32 位）', 400);
    if (local === main.local_part) return bad('这就是你的主邮箱本身，换个后缀吧', 409);
    // 允许直接填 shop，自动补成 主邮箱-shop
    if (!isSubOf(local, main.local_part)) local = `${main.local_part}-${local}`;
    if (!isSubOf(local, main.local_part)) {
      return bad(`子地址要写成 ${main.local_part}-xxx（或以数字结尾），例如 ${main.local_part}-shop`, 409);
    }

    const exists = await env.DB.prepare('SELECT id, source FROM subaddresses WHERE domain = ? AND local_part = ?')
      .bind(main.domain, local)
      .first();
    if (exists) {
      // 以前自动生成的子地址：显式建一次就变成「手动」，这样它会一直显示在侧栏、也能删
      if (exists.source !== 'manual') {
        await env.DB.prepare("UPDATE subaddresses SET source = 'manual' WHERE id = ?").bind(exists.id).run();
        return json({
          ok: true,
          localPart: local,
          address: `${local}@${main.domain}`,
          existed: true,
          mailboxes: await listMailboxes(env, user.id),
        });
      }
      return bad('这个子地址已经建过了', 409);
    }

    const takenByMailbox = await env.DB.prepare('SELECT id FROM mailboxes WHERE domain = ? AND local_part = ?')
      .bind(main.domain, local)
      .first();
    if (takenByMailbox) return bad('这个地址已经是别人（或你）的主邮箱了', 409);

    await env.DB.prepare(
      'INSERT OR IGNORE INTO subaddresses (id, mailbox_id, local_part, domain, source, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(newId(), main.id, local, main.domain, 'manual', nowMs())
      .run();
    return json({ ok: true, localPart: local, address: `${local}@${main.domain}`, mailboxes: await listMailboxes(env, user.id) });
  }

  const subMatch = /^\/api\/subaddresses\/([^/]+)$/.exec(p);
  if (subMatch && method === 'DELETE') {
    let local = decodeURIComponent(subMatch[1]).toLowerCase();
    if (local.includes('@')) local = local.split('@')[0];
    const findSub = (name) =>
      env.DB.prepare(
        `SELECT s.id, s.source FROM subaddresses s JOIN mailboxes b ON b.id = s.mailbox_id
          WHERE b.user_id = ? AND s.local_part = ? AND s.source IN ('manual', 'auto')`
      )
        .bind(user.id, name)
        .first();
    let row = await findSub(local);
    if (!row) {
      const main = await mainMailboxOf(env, user.id);
      if (main && !isSubOf(local, main.local_part)) row = await findSub(`${main.local_part}-${local}`);
    }
    if (!row) return bad('这个子地址不存在（可能已经删过了）', 404);
    if (row.source === 'auto') {
      // 自动生成的不能真删（下次来信会被重新登记），改成墓碑：侧栏消失、来信直接丢弃
      await env.DB.prepare("UPDATE subaddresses SET source = 'blocked' WHERE id = ?").bind(row.id).run();
    } else {
      await env.DB.prepare('DELETE FROM subaddresses WHERE id = ?').bind(row.id).run();
    }
    return json({ ok: true, mailboxes: await listMailboxes(env, user.id) });
  }

  const mbMatch = /^\/api\/mailboxes\/([^/]+)$/.exec(p);
  if (mbMatch) {
    const id = decodeURIComponent(mbMatch[1]);
    const box = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!box) return bad('邮箱不存在', 404);
    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      await env.DB.prepare('UPDATE mailboxes SET label = ? WHERE id = ?')
        .bind(String(body.label || '').slice(0, 24), id)
        .run();
      return json({ ok: true, mailboxes: await listMailboxes(env, user.id) });
    }
    if (method === 'DELETE') {
      const { results } = await env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ?').bind(id).all();
      for (const row of results || []) {
        await env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(row.id).run();
      }
      await env.DB.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM subaddresses WHERE mailbox_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(id).run();
      return json({ ok: true, mailboxes: await listMailboxes(env, user.id), stats: await statsFor(env, user.id) });
    }
  }

  /* ---------- 一邮多用：外部邮箱转发进来 ---------- */

  if (p === '/api/external' && method === 'GET') {
    return json({
      ok: true,
      externals: await listExternal(env, user.id),
      providers: Object.entries(PROVIDERS).map(([key, v]) => ({ key, name: v.name, hint: v.hint })),
    });
  }

  if (p === '/api/external' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const out = await createExternal(env, user, {
      provider: body.provider,
      address: body.address,
      label: body.label,
    });
    if (out.error) return bad(out.error, 400);
    return json({ ok: true, external: out.external, externals: await listExternal(env, user.id) });
  }

  const extMatch = /^\/api\/external\/([^/]+)$/.exec(p);
  if (extMatch && method === 'DELETE') {
    const id = decodeURIComponent(extMatch[1]);
    const row = await env.DB.prepare('SELECT * FROM external_accounts WHERE id = ? AND user_id = ?')
      .bind(id, user.id)
      .first();
    if (!row) return bad('找不到这个外部邮箱', 404);
    // 留一个 disabled 墓碑：地址是主子地址模式，删了行还是会命中路由，靠状态来拒收
    await env.DB.prepare("UPDATE external_accounts SET status = 'disabled' WHERE id = ?").bind(id).run();
    await env.DB.prepare('DELETE FROM subaddresses WHERE domain = ? AND local_part = ? AND source = ?')
      .bind(row.intake_domain, row.intake_local, 'external')
      .run();
    return json({ ok: true, externals: await listExternal(env, user.id) });
  }

  /* ---------- 邮件 ---------- */

  if (p === '/api/messages/read-all' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const mailboxId = String(body.mailboxId || '');
    await env.DB.prepare(
      `UPDATE messages SET unread = 0
        WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ?)
          AND (? = '' OR mailbox_id = ?)`
    )
      .bind(user.id, mailboxId, mailboxId)
      .run();
    return json({ ok: true, stats: await statsFor(env, user.id) });
  }

  if (p === '/api/messages' && method === 'GET') {
    const mailboxId = String(url.searchParams.get('mailboxId') || url.searchParams.get('mailbox') || '');
    const alias = String(url.searchParams.get('alias') || '').toLowerCase();
    const q = url.searchParams.get('q') || '';
    const limit = Math.min(Number(url.searchParams.get('limit') || 60), 200);
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
    return json({
      ok: true,
      messages: await listMessages(env, { userId: user.id, mailboxId, alias, q, limit, offset }),
      total: await countMessages(env, { userId: user.id, mailboxId, alias }),
      stats: await statsFor(env, user.id),
    });
  }

  const emlMatch = /^\/api\/messages\/([^/]+)\/eml$/.exec(p);
  if (emlMatch) {
    const row = await env.DB.prepare(
      `SELECT m.* FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE m.id = ? AND b.user_id = ?`
    )
      .bind(decodeURIComponent(emlMatch[1]), user.id)
      .first();
    if (!row) return bad('邮件不存在', 404);
    let body = row.raw;
    if (!body) {
      const headers = [
        `From: ${row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr}`,
        `To: ${row.to_addr}`,
        `Subject: ${row.subject}`,
        `Date: ${new Date(Number(row.date)).toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
      ].join('\r\n');
      body = enc.encode(headers + (row.text_body || ''));
    }
    const name = safeFilename(`${row.subject || 'mail'}.eml`);
    return new Response(body, {
      headers: {
        'content-type': 'message/rfc822',
        'content-disposition': `attachment; filename="mail.eml"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'private, no-store',
      },
    });
  }

  const msgMatch = /^\/api\/messages\/([^/]+)$/.exec(p);
  if (msgMatch) {
    const id = decodeURIComponent(msgMatch[1]);
    const row = await env.DB.prepare(
      `SELECT m.* FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE m.id = ? AND b.user_id = ?`
    )
      .bind(id, user.id)
      .first();
    if (!row) return bad('邮件不存在', 404);
    if (method === 'GET') {
      await env.DB.prepare('UPDATE messages SET unread = 0 WHERE id = ?').bind(id).run();
      const { results } = await env.DB.prepare(
        'SELECT id, idx, filename, content_type, size, cid FROM attachments WHERE message_id = ? ORDER BY idx'
      )
        .bind(id)
        .all();
      return json({
        ok: true,
        message: {
          id: row.id,
          mailboxId: row.mailbox_id,
          domain: row.domain,
          alias: row.alias,
          to: row.to_addr,
          from: { name: row.from_name, address: row.from_addr },
          subject: row.subject,
          snippet: row.snippet,
          date: row.date,
          size: row.size,
          unread: false,
          extSource: row.ext_source || '',
          text: row.text_body,
          html: row.html_body,
          attachments: (results || []).map((a) => ({
            id: a.id,
            filename: a.filename,
            contentType: a.content_type,
            size: a.size,
            url: `/api/attachments/${a.id}`,
          })),
        },
      });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
      return json({ ok: true, stats: await statsFor(env, user.id) });
    }
  }

  const attMatch = /^\/api\/attachments\/(\d+)$/.exec(p);
  if (attMatch) {
    const row = await env.DB.prepare(
      `SELECT a.* FROM attachments a
         JOIN messages m ON m.id = a.message_id
         JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE a.id = ? AND b.user_id = ?`
    )
      .bind(Number(attMatch[1]), user.id)
      .first();
    if (!row) return bad('附件不存在', 404);
    const name = safeFilename(row.filename);
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    return new Response(row.data, {
      headers: {
        'content-type': row.content_type || 'application/octet-stream',
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=3600',
      },
    });
  }

  /* ---------- 管理后台 ---------- */

  const isAdmin = user.role === 'root' || user.role === 'admin';
  if (p.startsWith('/api/admin/') && !isAdmin) return bad('没有管理员权限', 403);

  if (p === '/api/admin/overview') {
    const settings = await readSettings(env);
    return json({
      ok: true,
      stats: await adminStats(env),
      domains: await listDomains(env),
      config: {
        subAddressAuto: String(settings.subAddressAuto ?? '1') !== '0',
        smsEnabled: String(settings.smsEnabled ?? '0') === '1',
        requireQQ: String(settings.requireQQ ?? '1') !== '0',
        catchAll: String(settings.catchAll ?? '1') !== '0',
        keepDays: Number(settings.keepDays || 0),
      },
      dropped: await listDropped(env),
    });
  }

  if (p === '/api/admin/users' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    const like = `%${q}%`;
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.email, u.phone, u.nickname, u.role, u.status, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM mailboxes b WHERE b.user_id = u.id) AS mailboxes,
              (SELECT COUNT(*) FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = u.id) AS messages,
              (SELECT COUNT(*) FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = u.id AND m.unread = 1) AS unread,
              (SELECT COALESCE(SUM(m.size),0) FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = u.id) AS bytes,
              (SELECT b.local_part || '@' || b.domain FROM mailboxes b WHERE b.user_id = u.id
                ORDER BY CASE WHEN b.label = '主邮箱' THEN 0 ELSE 1 END, b.created_at ASC LIMIT 1) AS main_address
         FROM users u
        WHERE (? = '' OR u.email LIKE ? OR u.phone LIKE ? OR u.nickname LIKE ?)
        ORDER BY u.created_at DESC
        LIMIT 200`
    )
      .bind(q, like, like, like)
      .all();
    return json({
      ok: true,
      users: (results || []).map((r) => ({
        id: r.id,
        email: r.email,
        phone: r.phone ? maskPhone(r.phone) : '',
        nickname: r.nickname,
        role: r.role,
        status: r.status,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
        mailboxes: r.mailboxes || 0,
        messages: r.messages || 0,
        unread: r.unread || 0,
        bytes: r.bytes || 0,
        mainAddress: r.main_address || '',
      })),
    });
  }

  const adminUserMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(p);
  if (adminUserMatch) {
    const id = decodeURIComponent(adminUserMatch[1]);
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) return bad('用户不存在', 404);
    const self = target.id === user.id;
    const targetIsRoot = target.role === 'root';

    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const patch = {};
      if (typeof body.status === 'string') {
        if (!['active', 'disabled'].includes(body.status)) return bad('状态只能是 active / disabled');
        if (self) return bad('不能停用自己');
        patch.status = body.status;
      }
      if (typeof body.role === 'string') {
        if (!['user', 'admin'].includes(body.role)) return bad('角色只能是 user / admin');
        if (targetIsRoot) return bad('不能修改 root 的角色');
        patch.role = body.role;
      }
      if (typeof body.nickname === 'string') patch.nickname = body.nickname.trim().slice(0, 24);
      if (typeof body.phone === 'string' && body.phone) {
        const phone = body.phone.replace(/[\s-]/g, '').replace(/^\+?86/, '');
        if (!CN_PHONE_RE.test(phone)) return bad('手机号格式不对');
        const used = await env.DB.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').bind(phone, id).first();
        if (used) return bad('这个手机号已经被占用', 409);
        patch.phone = phone;
      }
      const keys = Object.keys(patch);
      if (!keys.length) return bad('没有要修改的字段');
      await env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => patch[k]), id)
        .run();
      if (patch.status === 'disabled') {
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
      }
      const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      return json({ ok: true, user: publicUser(fresh) });
    }

    if (method === 'DELETE') {
      if (self) return bad('不能删除自己');
      if (targetIsRoot) return bad('不能删除 root');
      const { results } = await env.DB.prepare(
        'SELECT m.id FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ?'
      )
        .bind(id)
        .all();
      for (const row of results || []) {
        await env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(row.id).run();
      }
      await env.DB.prepare('DELETE FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ?)')
        .bind(id)
        .run();
      await env.DB.prepare('DELETE FROM subaddresses WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ?)')
        .bind(id)
        .run();
      await env.DB.prepare('DELETE FROM mailboxes WHERE user_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
      return json({ ok: true, stats: await adminStats(env) });
    }
  }

  const resetMatch = /^\/api\/admin\/users\/([^/]+)\/reset-password$/.exec(p);
  if (resetMatch && method === 'POST') {
    const id = decodeURIComponent(resetMatch[1]);
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) return bad('用户不存在', 404);
    if (target.role === 'root' && target.id !== user.id) return bad('不能重置 root 的密码');
    const temp = randomToken(9).replace(/-/g, 'x').slice(0, 10);
    await env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(temp), id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
    return json({ ok: true, password: temp });
  }

  if (p === '/api/admin/mailboxes' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.local_part, b.domain, b.created_at, u.email AS owner_email, u.id AS owner_id,
              (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = b.id) AS total,
              (SELECT COUNT(*) FROM subaddresses s WHERE s.mailbox_id = b.id) AS subs
         FROM mailboxes b JOIN users u ON u.id = b.user_id
        ORDER BY b.created_at DESC LIMIT 500`
    ).all();
    return json({
      ok: true,
      mailboxes: (results || []).map((r) => ({
        id: r.id,
        address: `${r.local_part}@${r.domain}`,
        ownerId: r.owner_id,
        ownerEmail: r.owner_email,
        createdAt: r.created_at,
        total: r.total || 0,
        subs: r.subs || 0,
      })),
    });
  }

  if (p === '/api/admin/mailboxes' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const owner = await env.DB.prepare('SELECT * FROM users WHERE id = ? OR lower(email) = lower(?)')
      .bind(String(body.userId || ''), String(body.email || ''))
      .first();
    if (!owner) return bad('找不到这个用户', 404);
    const domain = normalizeDomain(body.domain) || (await defaultDomain(env));
    const local = String(body.name || '').trim().toLowerCase().split('@')[0];
    if (!LOCAL_RE.test(local)) return bad('邮箱名格式不对');
    const conflict = await nameConflict(env, domain, local);
    if (conflict) return bad(conflict, 409);
    await createMailbox(env, owner.id, domain, local, String(body.label || '管理员分配').slice(0, 24));
    return json({ ok: true });
  }

  if (p === '/api/admin/domains' && method === 'GET') {
    return json({ ok: true, domains: await listDomains(env) });
  }

  if (p === '/api/admin/domains' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = normalizeDomain(body.name);
    if (!DOMAIN_RE.test(name)) return bad('域名格式不对，例如 mail.example.com');
    const exists = await env.DB.prepare('SELECT name FROM domains WHERE name = ?').bind(name).first();
    if (exists) return bad('这个域名已经在列表里了', 409);
    await env.DB.prepare('INSERT INTO domains (name, note, created_at) VALUES (?, ?, ?)')
      .bind(name, String(body.note || '').slice(0, 100), nowMs())
      .run();
    return json({ ok: true, domains: await listDomains(env) });
  }

  const adminDomainMatch = /^\/api\/admin\/domains\/([^/]+)$/.exec(p);
  if (adminDomainMatch) {
    const name = normalizeDomain(decodeURIComponent(adminDomainMatch[1]));
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE domain = ?)')
        .bind(name)
        .run();
      await env.DB.prepare('DELETE FROM subaddresses WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE domain = ?)')
        .bind(name)
        .run();
      await env.DB.prepare('DELETE FROM mailboxes WHERE domain = ?').bind(name).run();
      await env.DB.prepare('DELETE FROM domains WHERE name = ?').bind(name).run();
      return json({ ok: true, domains: await listDomains(env) });
    }
    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      await env.DB.prepare('UPDATE domains SET note = ? WHERE name = ?')
        .bind(String(body.note || '').slice(0, 100), name)
        .run();
      return json({ ok: true, domains: await listDomains(env) });
    }
  }

  if (p === '/api/admin/config' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (typeof body.subAddressAuto === 'boolean') {
      await writeSetting(env, 'subAddressAuto', body.subAddressAuto ? '1' : '0');
    }
    if (typeof body.requireQQ === 'boolean') {
      await writeSetting(env, 'requireQQ', body.requireQQ ? '1' : '0');
    }
    if (typeof body.smsEnabled === 'boolean') {
      await writeSetting(env, 'smsEnabled', body.smsEnabled ? '1' : '0');
    }
    if (typeof body.catchAll === 'boolean') {
      await writeSetting(env, 'catchAll', body.catchAll ? '1' : '0');
    }
    if (Number.isFinite(Number(body.keepDays))) {
      await writeSetting(env, 'keepDays', Math.max(0, Number(body.keepDays)));
    }
    return json({ ok: true });
  }

  return bad('接口不存在', 404);
}

/* ------------------------------ 入口 ------------------------------ */

export default {
  async email(message, env, ctx) {
    await ensureSchema(env);
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const parsed = parseMime(raw);
    const to = message.to || (parsed.to[0] && parsed.to[0].address) || '';
    await storeIncoming(env, raw, parsed, [to]);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    await ensureSchema(env);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return bad('服务器内部错误：' + (err && err.message ? err.message : err), 500);
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return bad('方法不支持', 405);
    const asset = serveAsset(url.pathname);
    return asset || new Response('页面不存在', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
