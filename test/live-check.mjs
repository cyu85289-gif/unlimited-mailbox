// ============================================================================
//  test/live-check.mjs 鈥斺€?瀵圭潃宸茬粡鍚姩鐨勬湇鍔″仛涓€閬嶇鍒扮鍐掔儫妫€鏌?//  瑕嗙洊锛歈Q 娉ㄥ唽闄愬埗 / 鎵嬫満鍙锋牎楠屼笌 +86 褰掍竴 / 瀛愬湴鍧€褰掑苟 / 鐢ㄦ埛闅旂 /
//        root 鍚庡彴锛堢粺璁÷峰仠鐢烽噸缃峰垹闄わ級/ 閰嶇疆寮€鍏?/ OAuth 鍗犱綅
//  鐢ㄦ硶锛欰CCESS_TOKEN=<root 鍙ｄ护> node test/live-check.mjs [鍦板潃]
//        榛樿鍦板潃 http://127.0.0.1:8790
// ============================================================================

const API = (process.argv[2] || process.env.API_BASE || 'http://127.0.0.1:8790').replace(/\/$/, '');
const TOKEN = process.env.ACCESS_TOKEN;
if (!TOKEN) {
  console.error('鐢ㄦ硶锛欰CCESS_TOKEN=<root 鍙ｄ护> node test/live-check.mjs [鍦板潃]');
  process.exit(1);
}

let failed = 0;
let passed = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    passed++;
    console.log(`鉁?${name}`);
  } else {
    failed++;
    console.log(`鉂?${name} ${extra}`);
  }
};

async function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* 闈?JSON */
  }
  return { status: res.status, data, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

const stamp = Date.now().toString(36).slice(-6);
const domain = (await req('/api/bootstrap')).data.domain;
const qqEmail = `smoke${stamp}@qq.com`;
const phone = '139' + String(Date.now()).slice(-8);
const name = `smoke${stamp}`;

/* ---------- 1. 鍩虹 ---------- */

const boot = await req('/api/bootstrap');
check('鍖垮悕鑳芥嬁鍒板惎鍔ㄤ俊鎭?, boot.status === 200 && boot.data.authenticated === false && !!boot.data.domain, boot.text.slice(0, 120));

const oauth = await req('/api/auth/qq');
check('QQ 涓€閿櫥褰曟槸棰勭暀鍗犱綅锛?01锛?, oauth.status === 501 && oauth.data.code === 'QQ_OAUTH_NOT_CONFIGURED', oauth.text.slice(0, 120));

/* ---------- 2. 娉ㄥ唽鏍￠獙 ---------- */

const notQQ = await req('/api/auth/register', {
  method: 'POST',
  body: { email: `x${stamp}@gmail.com`, password: 'pass12345', phone, mailbox: name },
});
check('闈?QQ 閭琚嫆缁?, notQQ.status === 400 && /QQ/.test(notQQ.data.error || ''), notQQ.text);

const badPhone = await req('/api/auth/register', {
  method: 'POST',
  body: { email: qqEmail, password: 'pass12345', phone: '12345678901', mailbox: name },
});
check('闈炴硶鎵嬫満鍙疯鎷掔粷锛?[3-9] 寮€澶达級', badPhone.status === 400, badPhone.text);

const shortPass = await req('/api/auth/register', {
  method: 'POST',
  body: { email: qqEmail, password: 'short', phone, mailbox: name },
});
check('瀵嗙爜灏戜簬 8 浣嶈鎷掔粷', shortPass.status === 400, shortPass.text);

/* ---------- 3. 姝ｅ父娉ㄥ唽锛?86 鍓嶇紑搴旇褰掍竴锛?---------- */

// 鏂版祦绋嬶細娉ㄥ唽鍓嶅繀椤荤敤璇?QQ 閭缁?verify-<token>@ 鍙戜竴灏佺‘璁や俊銆?// 鑴氭湰娌℃硶鏇夸綘鍙戜俊锛屾墍浠ヨ涔堝湪娴忚鍣ㄩ噷璧颁竴閬嶆嬁 token锛岃涔堣缃幆澧冨彉閲忥細
//   VERIFY_EMAIL=xxx@qq.com  VERIFY_TOKEN=<token>
const verifyToken = process.env.VERIFY_TOKEN || '';
const verifyEmailAddr = (process.env.VERIFY_EMAIL || qqEmail).toLowerCase();

if (!verifyToken) {
  console.log('\n鈿狅笍  璺宠繃鈥滄敞鍐?+ 寤哄彿鍚庘€濈殑妫€鏌ワ細鏂版祦绋嬭姹傜敤鐪熷疄 QQ 閭鍙戠‘璁や俊銆?);
  console.log('   鎯宠窇瀹屾暣妫€鏌ワ細鍏堝湪缃戦〉涓婄偣銆岄獙璇佽繖涓偖绠便€嶅彂涓€灏佺‘璁や俊锛岀劧鍚庯細');
  console.log('   $env:VERIFY_EMAIL="浣犵殑qq@qq.com"; $env:VERIFY_TOKEN="<token>"; node test/live-check.mjs\n');
  process.exit(0);
}

const reg = await req('/api/auth/register', {
  method: 'POST',
  body: { email: verifyEmailAddr, password: 'pass12345', phone: '+86 ' + phone, mailbox: name, token: verifyToken },
});
check('娉ㄥ唽鎴愬姛骞剁洿鎺ユ嬁鍒颁細璇?Cookie', reg.status === 200 && !!reg.cookie && reg.data.user?.email === verifyEmailAddr, reg.text);
check('鎵嬫満鍙峰湪鎺ュ彛閲岃劚鏁?, reg.data.user?.phone === phone.slice(0, 3) + '****' + phone.slice(7), String(reg.data.user?.phone));

const cookieUser = reg.cookie;
const bootUser = await req('/api/bootstrap', { cookie: cookieUser });
check(
  '鏂扮敤鎴峰彧鏈変竴涓富閭銆佹病鏈夊埆浜虹殑閭欢',
  bootUser.data.mailboxes?.length === 1 &&
    bootUser.data.mailboxes[0].address === `${name}@${domain}` &&
    bootUser.data.messages?.length === 0,
  JSON.stringify({ boxes: bootUser.data.mailboxes?.map((b) => b.address), n: bootUser.data.messages?.length })
);

const dupPhone = await req('/api/auth/register', {
  method: 'POST',
  body: { email: `other${stamp}@qq.com`, password: 'pass12345', phone, mailbox: `other${stamp}` },
});
check('鍚屼竴涓墜鏈哄彿涓嶈兘缁戜袱涓处鍙?, dupPhone.status === 409, dupPhone.text);

const subName = await req('/api/auth/register', {
  method: 'POST',
  body: { email: `sub${stamp}@qq.com`, password: 'pass12345', phone: '138' + String(Date.now()).slice(-8), mailbox: name + '1' },
});
check('浼氳瀛愬湴鍧€瑙勫垯鍚炴帀鐨勫悕瀛楄鎷掔粷', subName.status === 409, subName.text);

const secondBox = await req('/api/mailboxes', { method: 'POST', cookie: cookieUser, body: { name: `${name}box` } });
check('鏅€氱敤鎴蜂笉鑳藉缓绗簩涓富閭锛堟彁绀虹敤瀛愬湴鍧€锛?, secondBox.status === 409 && /瀛愬湴鍧€/.test(secondBox.data.error || ''), secondBox.text);

/* ---------- 4. 瀛愬湴鍧€褰掑苟 + 闅旂 ---------- */

const ingest = async (to, subject, bodyText) => {
  const raw = [
    'From: Smoke <smoke@example.com>',
    `To: <${to}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText,
  ].join('\r\n');
  const res = await fetch(`${API}/api/ingest?to=${encodeURIComponent(to)}`, {
    method: 'POST',
    headers: { 'x-token': TOKEN, 'content-type': 'message/rfc822' },
    body: Buffer.from(raw, 'utf8'),
  });
  return res.json();
};

const savedMain = await ingest(`${name}@${domain}`, '涓诲湴鍧€鏉ヤ俊', 'main body');
const savedSub = await ingest(`${name}-shop@${domain}`, '瀛愬湴鍧€鏉ヤ俊', 'sub body');
check('涓诲湴鍧€涓庡瓙鍦板潃閮芥敹涓?, savedMain.ok && savedSub.ok, JSON.stringify(savedMain));
check('瀛愬湴鍧€褰掑埌鍚屼竴涓富閭', savedMain.saved?.[0]?.mailbox === `${name}@${domain}` && savedSub.saved?.[0]?.mailbox === `${name}@${domain}`, JSON.stringify([savedMain.saved, savedSub.saved]));

const bootUser2 = await req('/api/bootstrap', { cookie: cookieUser });
const box2 = bootUser2.data.mailboxes?.[0];
check('鏂扮敤鎴风湅鍒?2 灏佷俊', bootUser2.data.messages?.length === 2, String(bootUser2.data.messages?.length));
check('瀛愬湴鍧€鍑虹幇鍦ㄩ偖绠辨爲涓?, box2?.subs?.some((s) => s.localPart === `${name}-shop`), JSON.stringify(box2?.subs));

const aliasFilter = await req(`/api/messages?alias=${name}-shop`, { cookie: cookieUser });
check('鎸夊瓙鍦板潃绛涢€夊彧鍓?1 灏?, aliasFilter.data.messages?.length === 1, String(aliasFilter.data.messages?.length));

const search = await req('/api/messages?q=瀛愬湴鍧€', { cookie: cookieUser });
check('鎼滅储鑳藉懡涓鏂?涓婚', search.data.messages?.length === 1, String(search.data.messages?.length));

const msgId = aliasFilter.data.messages?.[0]?.id;
const detail = await req(`/api/messages/${msgId}`, { cookie: cookieUser });
check('鑳借姝ｆ枃', detail.data.message?.text?.includes('sub body'), JSON.stringify(detail.data.message?.text));

const eml = await fetch(`${API}/api/messages/${msgId}/eml`, { headers: { cookie: cookieUser } });
check('.eml 鑳戒笅杞?, eml.status === 200 && (eml.headers.get('content-type') || '').includes('message/rfc822'), String(eml.status));

/* ---------- 4.5 涓€閭鐢細澶栭儴閭杞彂杩涙潵 ---------- */

const extAdd = await req('/api/external', {
  method: 'POST',
  cookie: cookieUser,
  body: { provider: 'qq', address: `smoke-${Date.now()}@qq.com`, label: '鍐掔儫 QQ' },
});
check(
  '鎺ュ叆澶栭儴閭鍚庢嬁鍒颁笓鐢ㄥ叆鍙ｅ湴鍧€',
  extAdd.status === 200 && extAdd.data.external?.intake === `${name}-qq@${domain}`,
  extAdd.text
);

const extIngest = await ingest(extAdd.data.external.intake, 'QQ 杞彂鏉ヤ俊', 'from qq');
check('澶栭儴鍏ュ彛鑳芥敹淇?, extIngest.ok === true, JSON.stringify(extIngest));

const listExt = await req('/api/messages', { cookie: cookieUser });
const extMail = (listExt.data.messages || []).find((m) => m.subject === 'QQ 杞彂鏉ヤ俊');
check('鏉ヤ俊甯?QQ 鏉ユ簮鏍囩', extMail?.extSource === 'qq', JSON.stringify(extMail));

const bootExt = await req('/api/bootstrap', { cookie: cookieUser });
check(
  'bootstrap 甯﹀洖澶栭儴閭涓庣粺璁?,
  (bootExt.data.externals || []).length === 1 &&
    bootExt.data.externals[0].mailCount === 1 &&
    bootExt.data.externals[0].hint.includes('璁剧疆'),
  JSON.stringify(bootExt.data.externals)
);

const extDel = await req(`/api/external/${extAdd.data.external.id}`, { method: 'DELETE', cookie: cookieUser });
check('绉婚櫎澶栭儴閭鎴愬姛', extDel.status === 200 && (extDel.data.externals || []).length === 0, extDel.text);

await ingest(extAdd.data.external.intake, '绉婚櫎鍚庢潵淇?, 'x');
const listExt2 = await req('/api/messages', { cookie: cookieUser });
check('绉婚櫎鍚庡叆鍙ｄ笉鍐嶆敹淇?, !(listExt2.data.messages || []).some((m) => m.subject === '绉婚櫎鍚庢潵淇?));

/* ---------- 5. root 鍚庡彴 ---------- */

const rootLogin = await req('/api/auth/login', { method: 'POST', body: { email: `admin@${domain}`, password: TOKEN } });
check('root 鐢?admin@鍩熷悕 + ACCESS_TOKEN 鐧诲綍', rootLogin.status === 200 && rootLogin.data.user?.role === 'root', rootLogin.text);
const cookieRoot = rootLogin.cookie;

const overview = await req('/api/admin/overview', { cookie: cookieRoot });
check(
  '鍚庡彴缁熻鏈夌敤鎴?閭/閭欢/鍩熷悕',
  overview.status === 200 && overview.data.stats?.users >= 2 && overview.data.stats?.domains >= 1,
  JSON.stringify(overview.data.stats)
);

const users = await req('/api/admin/users?q=' + encodeURIComponent(qqEmail), { cookie: cookieRoot });
const target = users.data.users?.find((u) => u.email === qqEmail);
check('鍚庡彴鑳芥悳鍒版柊鐢ㄦ埛骞舵樉绀轰富鍦板潃', !!target && target.mainAddress === `${name}@${domain}`, JSON.stringify(users.data.users));
check('鍚庡彴閲屾墜鏈哄彿鏄劚鏁忕殑', target?.phone?.includes('****'), String(target?.phone));

const forbidden = await req('/api/admin/overview', { cookie: cookieUser });
check('鏅€氱敤鎴疯繘涓嶄簡鍚庡彴锛?03锛?, forbidden.status === 403, forbidden.text);

/* ---------- 5.5 鏈櫥璁板湴鍧€锛氫笉鍐嶉潤榛樹涪寮?---------- */

check('榛樿寮€鍚湭鐧昏鍦板潃鏀朵欢绠?, overview.data.config?.catchAll === true, JSON.stringify(overview.data.config));
const stranger = `stranger-${Date.now().toString(36)}`;
const strangerIngest = await ingest(`${stranger}@${domain}`, '闄岀敓浜哄彂鏉ョ殑淇?, 'nothing to do with any mailbox');
check('娌℃湁褰掑睘鐨勫湴鍧€涔熻兘鏀朵笅', strangerIngest.ok === true && strangerIngest.saved?.length === 1, JSON.stringify(strangerIngest));
check('闄岀敓鍦板潃钀借繘 catchall 绠?, strangerIngest.saved?.[0]?.mailbox?.startsWith('catchall@'), JSON.stringify(strangerIngest.saved));
const rootBoot = await req('/api/bootstrap', { cookie: cookieRoot });
const catchBox = (rootBoot.data.mailboxes || []).find((b) => b.label === '鏈櫥璁板湴鍧€');
check('root 鍚嶄笅鍑虹幇銆屾湭鐧昏鍦板潃銆嶆敹浠剁', !!catchBox && catchBox.total >= 1, JSON.stringify(catchBox));
const catchList = await req('/api/messages', { cookie: cookieRoot });
const strangerMsg = (catchList.data.messages || []).find((m) => m.alias === stranger);
check('闄岀敓鍦板潃鐨勪俊鑳藉湪鏀朵欢绠遍噷鐪嬪埌', !!strangerMsg && strangerMsg.to === `${stranger}@${domain}`, JSON.stringify(strangerMsg));
const otherUserSees = await req('/api/messages', { cookie: cookieUser });
check('闄岀敓鍦板潃鐨勪俊涓嶄細涓插埌鍒汉绠卞瓙閲?, !(otherUserSees.data.messages || []).some((m) => m.alias === stranger));

const disable = await req(`/api/admin/users/${target.id}`, { method: 'PATCH', cookie: cookieRoot, body: { status: 'disabled' } });
check('灏佺鐢ㄦ埛鎴愬姛', disable.status === 200 && disable.data.user?.status === 'disabled', disable.text);

const bootAfterBan = await req('/api/bootstrap', { cookie: cookieUser });
check('琚皝绂佸悗鍘熸潵鐨勪細璇濈珛鍒诲け鏁?, bootAfterBan.status === 200 && bootAfterBan.data.authenticated === false, JSON.stringify(bootAfterBan.data.authenticated));

const loginBanned = await req('/api/auth/login', { method: 'POST', body: { email: qqEmail, password: 'pass12345' } });
check('琚皝绂佸悗鐧诲綍琚嫆锛?03锛?, loginBanned.status === 403, loginBanned.text);

const selfBan = await req(`/api/admin/users/${rootLogin.data.user.id}`, { method: 'PATCH', cookie: cookieRoot, body: { status: 'disabled' } });
check('绠＄悊鍛樹笉鑳藉皝绂佽嚜宸?, selfBan.status === 400, selfBan.text);

const reset = await req(`/api/admin/users/${target.id}/reset-password`, { method: 'POST', cookie: cookieRoot });
check('閲嶇疆瀵嗙爜杩斿洖 10 浣嶄复鏃跺瘑鐮?, reset.status === 200 && String(reset.data.password || '').length === 10, reset.text);

const relogin = await req('/api/auth/login', { method: 'POST', body: { email: qqEmail, password: reset.data.password } });
check('鍋滅敤鐘舵€佷笅浠嶆嫆缁濈櫥褰?, relogin.status === 403, relogin.text);

await req(`/api/admin/users/${target.id}`, { method: 'PATCH', cookie: cookieRoot, body: { status: 'active' } });
const relogin2 = await req('/api/auth/login', { method: 'POST', body: { email: qqEmail, password: reset.data.password } });
check('鎭㈠鍚庣敤涓存椂瀵嗙爜鑳界櫥褰?, relogin2.status === 200 && !!relogin2.cookie, relogin2.text);

/* ---------- 6. 閰嶇疆寮€鍏?---------- */

const cfg = await req('/api/admin/config', { method: 'POST', cookie: cookieRoot, body: { subAddressAuto: false, smsEnabled: true } });
const anon2 = await req('/api/bootstrap');
check(
  '閰嶇疆寮€鍏崇敓鏁堬紙瀛愬湴鍧€鑷姩褰掑苟鍏炽€佺煭淇″紑鍏冲紑锛?,
  cfg.status === 200 && anon2.data.config?.smsEnabled === true,
  JSON.stringify(anon2.data.config)
);
const dropped = await ingest(`${name}-off@${domain}`, '寮€鍏冲叧闂悗鐨勫瓙鍦板潃', 'should drop');
check('鍏虫帀鑷姩褰掑苟鍚庢柊瀛愬湴鍧€涓嶅啀鏀朵俊', dropped.saved?.length === 0, JSON.stringify(dropped));
await req('/api/admin/config', { method: 'POST', cookie: cookieRoot, body: { subAddressAuto: true, smsEnabled: false } });

/* ---------- 7. 鍒犻櫎鐢ㄦ埛绾ц仈 ---------- */

const del = await req(`/api/admin/users/${target.id}`, { method: 'DELETE', cookie: cookieRoot });
check('鍒犻櫎鐢ㄦ埛鎴愬姛', del.status === 200, del.text);

const usersAfter = await req('/api/admin/users?q=' + encodeURIComponent(qqEmail), { cookie: cookieRoot });
check('鐢ㄦ埛鍒楄〃閲屾病鏈変簡', (usersAfter.data.users || []).length === 0, JSON.stringify(usersAfter.data.users));

const loginGone = await req('/api/auth/login', { method: 'POST', body: { email: qqEmail, password: reset.data.password } });
check('鍒犳帀鍚庢棤娉曠櫥褰?, loginGone.status === 401, loginGone.text);

const rootBoxes = await req('/api/bootstrap', { cookie: cookieRoot });
check('root 鐨勬暟鎹病琚壍杩?, rootBoxes.data.mailboxes?.length >= 1 && rootBoxes.data.messages?.length >= 0, JSON.stringify(rootBoxes.data.stats));

console.log(`\n${failed ? `${failed} 椤瑰け璐 : `鍏ㄩ儴 ${passed} 椤归€氳繃`}`);
process.exit(failed ? 1 : 0);
