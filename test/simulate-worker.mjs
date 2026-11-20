// ============================================================================
//  test/simulate-worker.mjs —— 用本地 SQLite 模拟 Cloudflare D1，跑一遍 Worker
//  （多用户版：注册登录、收件箱隔离、子地址归并、root 后台、权限越界）
//  用法：node test/simulate-worker.mjs
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import worker from '../worker.mjs';

/* ------------------------------ D1 模拟 ------------------------------ */

const dir = mkdtempSync(path.join(tmpdir(), 'mailbox-sim-'));
const db = new DatabaseSync(path.join(dir, 'sim.db'));

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

const env = { DB: makeD1(), ACCESS_TOKEN: 'sim-token-1234567890', MAIL_DOMAIN: 'main.example.com' };
const ORIGIN = 'https://mailbox.example.workers.dev';

/* ---------------- Resend 打桩：验证码邮件不真发，塞进 outbox ---------------- */

const outbox = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url;
  if (u.includes('api.resend.com')) {
    outbox.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `stub-${outbox.length}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};
env.RESEND_API_KEY = 're_test_key';

const lastCode = () => (/(\d{6})/.exec(outbox.at(-1)?.subject || '') || [])[1];

/* ------------------------------ 造邮件 ------------------------------ */

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encWord = (s) => `=?UTF-8?B?${b64(s)}?=`;

function makeEmail({ to, from, subject, html, attachment }) {
  const boundary = '----sim' + Math.random().toString(36).slice(2);
  const parts = [`From: ${from}`, `To: <${to}>`, `Subject: ${encWord(subject)}`, 'MIME-Version: 1.0'];
  if (attachment) {
    parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
    parts.push(`--${boundary}`, 'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64', '');
    parts.push(b64(html));
    parts.push(
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      `Content-Disposition: attachment; filename="${encWord(attachment.name)}"`,
      'Content-Transfer-Encoding: base64',
      ''
    );
    parts.push(b64(attachment.content));
    parts.push(`--${boundary}--`, '');
  } else {
    parts.push('Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64', '');
    parts.push(b64(html));
  }
  return Buffer.from(parts.join('\r\n'), 'utf8');
}

async function deliver({ to, from = 'notice@example.com', subject = '测试', html = '<p>hi</p>', attachment }) {
  const raw = makeEmail({ to, from, subject, html, attachment });
  await worker.email({ raw: new Blob([raw]).stream(), to, from }, env, {});
}

/* ------------------------------ 工具 ------------------------------ */

let failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log(`✅ ${name}`);
  else {
    failed++;
    console.log(`❌ ${name} ${extra}`);
  }
};

async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(
    new Request(ORIGIN + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env
  );
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { res, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

/* ------------------------------ 用例 ------------------------------ */

await deliver({ to: 'ghost@main.example.com', subject: '没有人认领的信' });

const home = await worker.fetch(new Request(ORIGIN + '/'), env);
check('首页可访问', home.status === 200 && (await home.text()).includes('无限邮箱'));

const anon = await call('/api/bootstrap');
check('未登录 bootstrap 返回 authenticated:false', anon.data.authenticated === false);

/* ---- 注册 ---- */

// 注册前必须先证明邮箱归本人：我们发 6 位验证码到该邮箱，填对才通过
async function verifyEmail(email) {
  const start = await call('/api/auth/verify/start', { method: 'POST', body: { email } });
  if (!start.data.ok) return { token: '', start };
  const code = lastCode();
  const cf = await call('/api/auth/verify/confirm', { method: 'POST', body: { token: start.data.token, code } });
  return { token: start.data.token, verified: !!cf.data.verified, start, code };
}

const noToken = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'notoken@qq.com', password: 'password123', mailbox: 'notoken' },
});
check('没验证邮箱不能注册', noToken.res.status === 403, JSON.stringify(noToken.data));

const vA = await verifyEmail('alice@qq.com');
check('填对验证码后邮箱验证通过', vA.verified === true, JSON.stringify(vA.start?.data));

const regA = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'alice@qq.com', password: 'password123', phone: '13800000001', mailbox: 'bili', token: vA.token },
});
check('注册 A 成功', regA.data.ok === true && !!regA.cookie, JSON.stringify(regA.data));
const cookieA = regA.cookie;

const dupMail = await call('/api/auth/verify/start', { method: 'POST', body: { email: 'alice@qq.com' } });
check('已注册的邮箱不能再发起验证', dupMail.res.status === 409, JSON.stringify(dupMail.data));

const vA2 = await verifyEmail('alice2@qq.com');
const dupPhone = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'alice2@qq.com', password: 'password123', phone: '13800000001', mailbox: 'other2', token: vA2.token },
});
check('同手机号重复注册被拒', dupPhone.res.status === 409);

const noPhone = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'nophone@qq.com', password: 'password123', mailbox: 'nophone', token: (await verifyEmail('nophone@qq.com')).token },
});
check('不填手机号也能注册', noPhone.data.ok === true, JSON.stringify(noPhone.data));

const notQQ = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'alice@gmail.com', password: 'password123', phone: '13800000003', mailbox: 'gmailbox' },
});
check('非 QQ 邮箱注册被拒', notQQ.res.status === 400);

const shortPass = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'short@qq.com', password: '123', phone: '13800000004', mailbox: 'shorty' },
});
check('短密码被拒', shortPass.res.status === 400);

const badPhone = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'badphone@qq.com', password: 'password123', phone: '99999999999', mailbox: 'badphone' },
});
check('非大陆手机号被拒', badPhone.res.status === 400);

const vB = await verifyEmail('bob@qq.com');
const subName = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'bob@qq.com', password: 'password123', phone: '13800000002', mailbox: 'bili-shop', token: vB.token },
});
check('想抢 bili 的子地址当主邮箱被拒', subName.res.status === 409, JSON.stringify(subName.data));

const regB = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'bob@qq.com', password: 'password123', phone: '13800000002', mailbox: 'shop', token: vB.token },
});
check('注册 B 成功', regB.data.ok === true && !!regB.cookie);
const cookieB = regB.cookie;

/* ---- 收信与隔离 ---- */

await deliver({ to: 'bili@main.example.com', subject: '给 bili 的第一封', html: '<p>hello alice</p>' });
await deliver({ to: 'bili1@main.example.com', subject: '子地址 bili1' });
await deliver({ to: 'bili-shop@main.example.com', subject: '子地址 bili-shop' });
await deliver({
  to: 'bili@main.example.com',
  subject: '带附件的信',
  html: '<p>附件在下面</p>',
  attachment: { name: '账单.txt', content: '附件内容 OK' },
});

const listA = await call('/api/messages', { cookie: cookieA });
check('A 收到 4 封（含子地址归并）', listA.data.messages.length === 4, `got ${listA.data.messages.length}`);
check('未认领地址不会凭空建箱', !listA.data.messages.some((m) => m.alias === 'ghost'));

const boxA = await call('/api/mailboxes', { cookie: cookieA });
const subs = boxA.data.mailboxes[0].subs.map((s) => s.localPart).sort();
check('子地址 bili1 / bili-shop 自动登记', subs.join(',') === 'bili-shop,bili1', subs.join(','));

const listB = await call('/api/messages', { cookie: cookieB });
check('B 看不到 A 的邮件', listB.data.messages.length === 0);

const crossRead = await call(`/api/messages/${listA.data.messages[0].id}`, { cookie: cookieB });
check('B 按 id 越权读 A 的邮件被拒', crossRead.res.status === 404);

/* ---- 读信 / 附件 / 搜索 / 子地址筛选 / 已读 ---- */

const withAtt = listA.data.messages.find((m) => m.subject === '带附件的信');
const detail = await call(`/api/messages/${withAtt.id}`, { cookie: cookieA });
check('A 能读自己的邮件', detail.data.message.subject === '带附件的信');
check('附件列表正确', (detail.data.message.attachments || []).length === 1);

const attId = detail.data.message.attachments[0].id;
const attA = await call(`/api/attachments/${attId}`, { cookie: cookieA });
check('A 能下载自己的附件', attA.res.status === 200);
const attB = await call(`/api/attachments/${attId}`, { cookie: cookieB });
check('B 越权下载附件被拒', attB.res.status === 404);

const subFilter = await call('/api/messages?alias=bili1', { cookie: cookieA });
check('按子地址筛选只返回 1 封', subFilter.data.messages.length === 1, `got ${subFilter.data.messages.length}`);

const search = await call('/api/messages?q=附件', { cookie: cookieA });
check('搜索命中', search.data.messages.length === 1, `got ${search.data.messages.length}`);

const eml = await call(`/api/messages/${withAtt.id}/eml`, { cookie: cookieA });
check('.eml 可下载', eml.res.status === 200 && String(eml.res.headers.get('content-disposition')).includes('.eml'));

await call('/api/messages/read-all', { method: 'POST', body: {}, cookie: cookieA });
const afterRead = await call('/api/messages', { cookie: cookieA });
check('全部已读生效', afterRead.data.messages.every((m) => !m.unread));

/* ---- 一邮多用：外部邮箱转发进来 ---- */

const extBad = await call('/api/external', { method: 'POST', body: { provider: 'nope', address: 'x@qq.com' }, cookie: cookieA });
check('不支持的外部邮箱类型被拒', extBad.res.status === 400, JSON.stringify(extBad.data));

const extBadAddr = await call('/api/external', {
  method: 'POST',
  body: { provider: 'qq', address: 'not-an-email' },
  cookie: cookieA,
});
check('外部邮箱地址格式校验', extBadAddr.res.status === 400);

const extAdd = await call('/api/external', {
  method: 'POST',
  body: { provider: 'qq', address: 'alice@qq.com', label: '私人 QQ' },
  cookie: cookieA,
});
check(
  '接入 QQ 邮箱后生成专用入口地址',
  extAdd.data.ok === true && extAdd.data.external && extAdd.data.external.intake === 'bili-qq@main.example.com',
  JSON.stringify(extAdd.data)
);

const extDup = await call('/api/external', {
  method: 'POST',
  body: { provider: 'qq', address: 'alice@qq.com' },
  cookie: cookieA,
});
check('同一个外部邮箱不能重复接入', extDup.res.status === 400, JSON.stringify(extDup.data));

const extOther = await call('/api/external', {
  method: 'POST',
  body: { provider: 'gmail', address: 'alice@gmail.com' },
  cookie: cookieA,
});
check(
  '第二个外部邮箱拿到 -gmail 入口',
  extOther.data.external && extOther.data.external.intake === 'bili-gmail@main.example.com',
  JSON.stringify(extOther.data.external)
);

await deliver({ to: 'bili-qq@main.example.com', subject: 'QQ 来信', html: '<p>来自 QQ 邮箱</p>' });
const afterExt = await call('/api/messages', { cookie: cookieA });
const extMail = afterExt.data.messages.find((m) => m.subject === 'QQ 来信');
check('转发进来的信收下了', !!extMail);
check('邮件带上了来源标签 qq', extMail && extMail.extSource === 'qq', JSON.stringify(extMail && extMail.extSource));

const extList = await call('/api/external', { cookie: cookieA });
const qqRow = (extList.data.externals || []).find((e) => e.provider === 'qq');
check('外部邮箱统计到 1 封', qqRow && qqRow.mailCount === 1, JSON.stringify(qqRow));

const boxesWithExt = await call('/api/mailboxes', { cookie: cookieA });
const extSub = (boxesWithExt.data.mailboxes[0].subs || []).find((s) => s.localPart === 'bili-qq');
check('入口地址作为子地址挂在主邮箱下', !!extSub && extSub.source === 'external', JSON.stringify(extSub));

const extMailDetail = await call(`/api/messages/${extMail.id}`, { cookie: cookieA });
check('读信详情也带来源', extMailDetail.data.message.extSource === 'qq');

const extDelete = await call(`/api/external/${qqRow.id}`, { method: 'DELETE', cookie: cookieA });
check('移除外部邮箱成功', extDelete.data.ok === true && (extDelete.data.externals || []).length === 1);

await deliver({ to: 'bili-qq@main.example.com', subject: '移除后再发' });
const afterDelExt = await call('/api/messages', { cookie: cookieA });
check('移除后该入口不再收信', !afterDelExt.data.messages.some((m) => m.subject === '移除后再发'));
check('移除入口不影响已收的邮件', afterDelExt.data.messages.some((m) => m.subject === 'QQ 来信'));

// 再接入一次：墓碑清掉，还拿到同一个入口地址
const extAgain = await call('/api/external', {
  method: 'POST',
  body: { provider: 'qq', address: 'alice@qq.com' },
  cookie: cookieA,
});
check(
  '移除后还能重新接入，入口地址不变',
  extAgain.data.ok === true && extAgain.data.external.intake === 'bili-qq@main.example.com',
  JSON.stringify(extAgain.data.external || extAgain.data)
);
await deliver({ to: 'bili-qq@main.example.com', subject: '重新接入后的信' });
const afterAgain = await call('/api/messages', { cookie: cookieA });
check('重新接入后又能收信', afterAgain.data.messages.some((m) => m.subject === '重新接入后的信'));

const extForeign = await call('/api/external', { method: 'POST', body: { provider: 'qq', address: 'bob@qq.com' }, cookie: cookieB });
check('B 也能接自己的外部邮箱', extForeign.data.ok === true && extForeign.data.external.intake.startsWith('shop-qq@'), JSON.stringify(extForeign.data.external));
const extListB = await call('/api/external', { cookie: cookieB });
check('B 只看到自己的外部邮箱', (extListB.data.externals || []).length === 1 && extListB.data.externals[0].address === 'bob@qq.com');

/* ---- 权限：普通用户碰不到后台 ---- */

const forbidden = await call('/api/admin/users', { cookie: cookieA });
check('普通用户访问后台被拒', forbidden.res.status === 403);

const boxLimit = await call('/api/mailboxes', { method: 'POST', body: { name: 'second' }, cookie: cookieA });
check('普通用户不能开第二个主邮箱', boxLimit.res.status === 409, JSON.stringify(boxLimit.data));

/* ---- 子地址（子邮箱）：用户自己建、自己删 ---- */

const subNew = await call('/api/subaddresses', { method: 'POST', body: { name: 'shop' }, cookie: cookieA });
check('用户可以自己建子地址', subNew.data.ok === true && subNew.data.address.endsWith('-shop@' + (subNew.data.address.split('@')[1] || '')), JSON.stringify(subNew.data));

const subAgain = await call('/api/subaddresses', { method: 'POST', body: { name: 'shop' }, cookie: cookieA });
check('重复建同一个子地址被拒', subAgain.res.status === 409, JSON.stringify(subAgain.data));

const subList = await call('/api/mailboxes', { cookie: cookieA });
const subRow = (subList.data.mailboxes || []).flatMap((m) => m.subs || []).find((s) => s.localPart === subNew.data.localPart);
check('子地址出现在侧栏里（source=manual）', !!subRow && subRow.source === 'manual', JSON.stringify(subRow));

const subDel = await call(`/api/subaddresses/${encodeURIComponent(subNew.data.localPart)}`, { method: 'DELETE', cookie: cookieA });
const subList2 = await call('/api/mailboxes', { cookie: cookieA });
const gone = !(subList2.data.mailboxes || []).flatMap((m) => m.subs || []).some((s) => s.localPart === subNew.data.localPart);
check('子地址可以删除', subDel.data.ok === true && gone, JSON.stringify(subDel.data));

const subForeign = await call('/api/subaddresses/bob-secret', { method: 'DELETE', cookie: cookieA });
check('删不到别人的子地址', subForeign.res.status === 404);

// 自动登记的子地址也要能删：删掉后侧栏消失，再来信直接丢弃
await deliver({ to: 'bili-temp@main.example.com', subject: '临时子地址' });
const listAuto = (await call('/api/mailboxes', { cookie: cookieA })).data.mailboxes;
const subAuto = listAuto.flatMap((m) => m.subs || []).find((s) => s.localPart === 'bili-temp');
check('自动登记的子地址出现在侧栏', !!subAuto && subAuto.source === 'auto', JSON.stringify(subAuto));

const totalAfterAuto = listAuto.find((m) => m.label === '主邮箱')?.total || 0;
const delAuto = await call('/api/subaddresses/bili-temp', { method: 'DELETE', cookie: cookieA });
const listNoAuto = (await call('/api/mailboxes', { cookie: cookieA })).data.mailboxes;
check(
  '删掉自动子地址后侧栏不再显示',
  delAuto.data.ok === true && !listNoAuto.flatMap((m) => m.subs || []).some((s) => s.localPart === 'bili-temp')
);

await deliver({ to: 'bili-temp@main.example.com', subject: '删掉之后还来信' });
const listBlocked = (await call('/api/mailboxes', { cookie: cookieA })).data.mailboxes;
const totalAfterBlocked = listBlocked.find((m) => m.label === '主邮箱')?.total || 0;
check('删掉的子地址不再收信（删除前共 ' + totalAfterAuto + ' 封）', totalAfterBlocked === totalAfterAuto, String(totalAfterBlocked));

/* ---- 登录与停用 ---- */

const badLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'alice@qq.com', password: 'wrong-pass' } });
check('错误密码登录失败', badLogin.res.status === 401);

const loginB = await call('/api/auth/login', {
  method: 'POST',
  body: { email: 'bob@qq.com', password: 'password123' },
});
check('B 用密码登录成功', loginB.data.ok === true && !!loginB.cookie);

/* ---- root 后台 ---- */

const rootLogin = await call('/api/auth/login', {
  method: 'POST',
  body: { email: 'admin@main.example.com', password: env.ACCESS_TOKEN },
});
check('root 用应急口令登录成功', rootLogin.data.ok === true && rootLogin.data.user.role === 'root');
const cookieRoot = rootLogin.cookie;

const overview = await call('/api/admin/overview', { cookie: cookieRoot });
check('root 能看后台概览', overview.data.ok === true && overview.data.stats.users >= 3);
check('默认开启「未登记地址进 root 收件箱」', overview.data.config.catchAll === true, JSON.stringify(overview.data.config));

/* ---- 一邮多用 / catch-all：没人认领的地址不再静默丢弃 ---- */

const rootBoot = await call('/api/bootstrap', { cookie: cookieRoot });
const catchBox = (rootBoot.data.mailboxes || []).find((b) => b.label === '未登记地址');
check('root 名下自动出现「未登记地址」收件箱', !!catchBox, JSON.stringify(rootBoot.data.mailboxes));
const catchMsgs = await call('/api/messages', { cookie: cookieRoot });
const ghostMsg = (catchMsgs.data.messages || []).find((m) => m.alias === 'ghost');
check('发给 ghost@ 的信落进了未登记收件箱', !!ghostMsg, JSON.stringify(catchMsgs.data.messages.map((m) => m.alias)));
check('保留真实收件地址', ghostMsg && ghostMsg.to === 'ghost@main.example.com');

const offCatch = await call('/api/admin/config', { method: 'POST', body: { catchAll: false }, cookie: cookieRoot });
check('能关掉未登记收件箱', offCatch.data.ok === true);
await deliver({ to: 'nobody-home@main.example.com', subject: '关掉之后就该被丢' });
const droppedOverview = await call('/api/admin/overview', { cookie: cookieRoot });
check(
  '关掉后丢弃的信能在后台看到',
  (droppedOverview.data.dropped || []).some((d) => d.address === 'nobody-home@main.example.com'),
  JSON.stringify(droppedOverview.data.dropped)
);
const rootAfterDrop = await call('/api/messages', { cookie: cookieRoot });
check('关掉后不再进收件箱', !rootAfterDrop.data.messages.some((m) => m.alias === 'nobody-home'));
await call('/api/admin/config', { method: 'POST', body: { catchAll: true }, cookie: cookieRoot });

const users = await call('/api/admin/users', { cookie: cookieRoot });
const bob = users.data.users.find((u) => u.email === 'bob@qq.com');
check('后台用户列表含 B', !!bob && bob.mainAddress === 'shop@main.example.com');
check('后台手机号脱敏', /^\d{3}\*{4}\d{4}$/.test(bob.phone), bob.phone);

const disable = await call(`/api/admin/users/${bob.id}`, { method: 'PATCH', body: { status: 'disabled' }, cookie: cookieRoot });
check('root 能停用用户', disable.data.user.status === 'disabled');

const disabledLogin = await call('/api/auth/login', {
  method: 'POST',
  body: { email: 'bob@qq.com', password: 'password123' },
});
check('被停用的账号无法登录', disabledLogin.res.status === 403);

const reset = await call(`/api/admin/users/${bob.id}/reset-password`, { method: 'POST', cookie: cookieRoot });
check('root 能重置密码', reset.data.ok === true && typeof reset.data.password === 'string' && reset.data.password.length >= 8);

await call(`/api/admin/users/${bob.id}`, { method: 'PATCH', body: { status: 'active' }, cookie: cookieRoot });
const relogin = await call('/api/auth/login', {
  method: 'POST',
  body: { email: 'bob@qq.com', password: reset.data.password },
});
check('用临时密码可以登录', relogin.data.ok === true);

const selfDisable = await call(`/api/admin/users/${rootLogin.data.user.id}`, {
  method: 'PATCH',
  body: { status: 'disabled' },
  cookie: cookieRoot,
});
check('root 不能停用自己', selfDisable.res.status === 400);

const cfg = await call('/api/admin/config', {
  method: 'POST',
  body: { subAddressAuto: false, requireQQ: true },
  cookie: cookieRoot,
});
check('root 能改全局开关', cfg.data.ok === true);
const afterCfg = await call('/api/bootstrap', { cookie: cookieA });
check('开关落到 bootstrap', afterCfg.data.config.subAddressAuto === false);

const delUser = await call(`/api/admin/users/${bob.id}`, { method: 'DELETE', cookie: cookieRoot });
check('root 能删除用户', delUser.data.ok === true);
const users2 = await call('/api/admin/users', { cookie: cookieRoot });
check('删除后列表不再有 B', !users2.data.users.some((u) => u.email === 'bob@qq.com'));
const boxGone = db.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE local_part = 'shop'").get();
check('删除用户连带清理邮箱', boxGone.n === 0);

/* ---- 发信通道（Resend）：验证码模式 + 忘记密码 ---- */

const mailerOn = await call('/api/bootstrap');
check('接上发信通道后前端能知道', mailerOn.data.config?.mailerEnabled === true);

const vStart = await call('/api/auth/verify/start', { method: 'POST', body: { email: 'carol@qq.com' } });
check('注册改成发 6 位验证码', vStart.data.mode === 'code' && !!vStart.data.token, JSON.stringify(vStart.data).slice(0, 120));
const vCode = lastCode();
check('验证码邮件标题里带 6 位码', !!vCode, outbox.at(-1)?.subject);

const wrongCode = await call('/api/auth/verify/confirm', {
  method: 'POST',
  body: { token: vStart.data.token, code: '000000' },
});
check('验证码不对不给过', wrongCode.res.status === 403);
const rightCode = await call('/api/auth/verify/confirm', {
  method: 'POST',
  body: { token: vStart.data.token, code: vCode },
});
check('填对验证码即通过', rightCode.data.verified === true);

const regC = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'carol@qq.com', password: 'pass12345', mailbox: 'carol', token: vStart.data.token },
});
check('验证码通过后能注册', regC.data.ok === true, JSON.stringify(regC.data).slice(0, 120));

const resetStart = await call('/api/auth/reset/start', { method: 'POST', body: { email: 'carol@qq.com' } });
check('忘记密码真的发出验证码', resetStart.data.ok === true, JSON.stringify(resetStart.data).slice(0, 120));
const rCode = lastCode();
const resetBad = await call('/api/auth/reset/confirm', {
  method: 'POST',
  body: { email: 'carol@qq.com', code: '111111', password: 'newpass1234' },
});
check('重置密码时验证码错被拒', resetBad.res.status === 403);
const resetOk = await call('/api/auth/reset/confirm', {
  method: 'POST',
  body: { email: 'carol@qq.com', code: rCode, password: 'newpass1234' },
});
check('重置密码成功', resetOk.data.ok === true);
const newLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'carol@qq.com', password: 'newpass1234' } });
check('新密码能登录', newLogin.data.ok === true && !!newLogin.cookie);
const oldLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'carol@qq.com', password: 'pass12345' } });
check('旧密码已失效', oldLogin.data.ok !== true);

delete env.RESEND_API_KEY;
const noMailer = await call('/api/auth/verify/start', { method: 'POST', body: { email: 'dave@qq.com' } });
check('没接发信通道时直接说不能自助注册（不再退回发信验证）', noMailer.res.status === 503, JSON.stringify(noMailer.data));
env.RESEND_API_KEY = 're_test_key';

/* ---- 同名邮箱：两个人不能抢同一个主邮箱名 ---- */

const dupNameVerify = await verifyEmail('eve@qq.com');
const dupName = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'eve@qq.com', password: 'password123', mailbox: 'bili', token: dupNameVerify.token },
});
check('两个人不能用同一个主邮箱名（bili 已被占用）', dupName.res.status === 409, JSON.stringify(dupName.data));

const eveBox = await call('/api/auth/register', {
  method: 'POST',
  body: { email: 'eve@qq.com', password: 'password123', mailbox: 'eve', token: dupNameVerify.token },
});
check('换个名字就能注册成功', eveBox.data.ok === true, JSON.stringify(eveBox.data).slice(0, 120));

/* ---- 数据清理 ---- */

const beforeDel = await call('/api/messages', { cookie: cookieA });
await call(`/api/messages/${withAtt.id}`, { method: 'DELETE', cookie: cookieA });
const listAfterDel = await call('/api/messages', { cookie: cookieA });
check(
  '删除邮件生效',
  listAfterDel.data.messages.length === beforeDel.data.messages.length - 1,
  `${beforeDel.data.messages.length} → ${listAfterDel.data.messages.length}`
);

const logout = await call('/api/auth/logout', { method: 'POST', cookie: cookieA });
check('退出登录清 cookie', String(logout.res.headers.get('set-cookie')).includes('Max-Age=0'));
const afterLogout = await call('/api/bootstrap', { cookie: cookieA });
check('退出后 cookie 失效', afterLogout.data.authenticated === false);

console.log('');
if (failed) {
  console.log(`❌ 多用户模拟测试失败：${failed} 项`);
  process.exit(1);
}
console.log('✅ 多用户模拟测试全部通过');
