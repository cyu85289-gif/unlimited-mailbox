// ============================================================================
//  app.js —— 多用户版收件箱前端
//  · 登录 / 注册（QQ 邮箱 + 密码 + 手机号）
//  · 侧栏：全部邮件 / 主邮箱 / 子地址，按用户隔离
//  · 一邮多用：把 QQ / Gmail / 163 等外部邮箱的来信转发进来，按来源打标签
//  · 管理后台：用户、域名、全局开关（仅 root / admin 可见）
// ============================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  user: null,
  config: {},
  mailboxes: [],
  mailboxId: '',
  alias: '',
  messages: [],
  current: null,
  q: '',
  stats: {},
  externals: [],
  providers: [],
  admin: { users: [], stats: {}, domains: [], config: {}, dropped: [], q: '', loaded: false },
};

const EXT_SHORT = {
  qq: 'QQ',
  foxmail: 'Foxmail',
  gmail: 'Gmail',
  '163': '163',
  '126': '126',
  tencent: '腾讯',
  outlook: 'Outlook',
  icloud: 'iCloud',
  other: '外部',
};
const extShort = (key) => EXT_SHORT[key] || '外部';

/* ------------------------------ 网络 ------------------------------ */

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------------ 小工具 ------------------------------ */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (d.getFullYear() === now.getFullYear()) return md;
  return `${d.getFullYear()}-${md}`;
}

function fmtFull(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PALETTE = ['#627BF6', '#2BA471', '#F0982E', '#E45C8B', '#7C5CE4', '#22A6B3', '#D8643C', '#4C7EE0'];
function colorFor(text) {
  const s = String(text || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
const initialOf = (s) => {
  const t = String(s || '?').trim();
  return (t[0] || '?').toUpperCase();
};

let toastTimer = 0;
let toastHideTimer = 0;
function toast(msg, kind = 'ok', ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  try {
    if (!el.matches(':popover-open')) el.showPopover();
  } catch {
    /* 老浏览器没有 popover，退回普通定位 */
  }
  el.classList.add('show');
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    toastHideTimer = setTimeout(() => {
      try {
        if (el.matches(':popover-open')) el.hidePopover();
      } catch {
        /* 忽略 */
      }
    }, 240);
  }, ms);
}

const setHint = (id, text, kind = '') => {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
};

const clearHint = (id) => setHint(id, '', '');

/** 把一组输入框清空（对话框关闭、退出登录时用） */
function resetFields(sel, { keep = [] } = {}) {
  $$(sel).forEach((el) => {
    if (keep.includes(el.id)) return;
    if (el.type === 'checkbox') el.checked = false;
    else if (el.type === 'radio') return;
    else el.value = '';
  });
}

/* ------------------------------ 登录 / 注册 ------------------------------ */

function switchTab(which) {
  $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === which));
  $('#login-form').hidden = which !== 'login';
  $('#register-form').hidden = which !== 'register';
  if (which !== 'register') stopVerifyPoll();
}

async function doLogin(ev) {
  ev.preventDefault();
  const btn = $('#login-btn');
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  if (!email || !password) {
    toast('邮箱和密码都要填', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = '登录中…';
  clearHint('#login-hint');
  try {
    await api('/api/auth/login', { method: 'POST', body: { email, password } });
    $('#login-password').value = '';
    await boot();
  } catch (err) {
    $('#login-password').value = '';
    $('#login-password').focus();
    setHint('#login-hint', err.message, 'error');
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '登 录';
  }
}

async function doRegister(ev) {
  ev.preventDefault();
  const btn = $('#register-btn');
  const email = $('#reg-email').value.trim();
  const password = $('#reg-password').value;
  const password2 = $('#reg-password2').value;
  const payload = {
    email,
    password,
    phone: $('#reg-phone').value.replace(/\s/g, ''),
    mailbox: $('#reg-mailbox').value.trim(),
    token: regVerify.token || '',
  };
  if (!regVerify.token || regVerify.email !== email.toLowerCase()) {
    toast('请先点「① 发送验证码」并填对验证码', 'error');
    setHint('#register-hint', '还没验证邮箱：点上面那个按钮，收 6 位验证码填进来。', 'error');
    return;
  }
  if (password.length < 8) {
    toast('密码至少 8 位', 'error');
    setHint('#register-hint', '密码至少 8 位', 'error');
    $('#reg-password').focus();
    return;
  }
  if (password !== password2) {
    toast('两次输入的密码不一样', 'error');
    setHint('#register-hint', '两次输入的密码不一样，重新输一次', 'error');
    $('#reg-password2').value = '';
    $('#reg-password2').focus();
    return;
  }
  if (!$('#reg-agree').checked) return setHint('#register-hint', '请先勾选同意服务条款', 'error');
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    await api('/api/auth/register', { method: 'POST', body: payload });
    regVerify = { token: '', email: '', timer: 0 };
    await boot();
    toast('账号创建成功，欢迎使用');
  } catch (err) {
    setHint('#register-hint', err.message, 'error');
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '创建账号';
  }
}

/* ---------- 注册前：证明 QQ 邮箱是你的 ---------- */

let regVerify = { token: '', email: '', timer: 0 };

function stopVerifyPoll() {
  if (regVerify.timer) clearInterval(regVerify.timer);
  regVerify.timer = 0;
}

async function startVerify() {
  const email = $('#reg-email').value.trim();
  if (!email) {
    toast('先填 QQ 邮箱', 'error');
    $('#reg-email').focus();
    return;
  }
  const btn = $('#reg-verify-btn');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const data = await api('/api/auth/verify/start', { method: 'POST', body: { email } });
    regVerify = { token: data.token, email: email.toLowerCase(), timer: 0, mode: 'code' };
    $('#reg-verify-panel').hidden = false;
    $('#reg-verify-panel').classList.remove('is-ok', 'is-expired');
    $('#reg-code-row').hidden = false;
    $('#reg-code').value = '';
    $('#reg-verify-tip').innerHTML = `验证码已经发到 <b>${esc(data.sentTo || email)}</b>，把邮件里的 <b>6 位数字</b>填进来：`;
    setHint('#reg-verify-state', '验证码 10 分钟内有效，没收到就点下面的重新发送');
    btn.hidden = true;
    clearHint('#register-hint');
    stopVerifyPoll();
    startResendCooldown();
    toast(data.hint || '验证码已发送，去查收邮件');
    $('#reg-code').focus();
  } catch (err) {
    toast(err.message, 'error');
    setHint('#register-hint', err.message, 'error');
    btn.disabled = false;
    btn.textContent = '① 发送验证码';
  }
}

/* 重发冷却：60 秒后才能再点 */
function startResendCooldown() {
  const btn = $('#reg-code-resend');
  if (!btn) return;
  let left = 60;
  btn.disabled = true;
  btn.textContent = `${left} 秒后可重新发送`;
  clearInterval(startResendCooldown.timer);
  startResendCooldown.timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(startResendCooldown.timer);
      btn.disabled = false;
      btn.textContent = '没收到？重新发送';
      return;
    }
    btn.textContent = `${left} 秒后可重新发送`;
  }, 1000);
}

/* 填验证码确认（走发信通道时用这条） */
async function confirmVerifyCode() {
  const code = $('#reg-code').value.replace(/\D/g, '');
  if (code.length !== 6) {
    toast('验证码是 6 位数字', 'error');
    $('#reg-code').focus();
    return;
  }
  try {
    const data = await api('/api/auth/verify/confirm', {
      method: 'POST',
      body: { token: regVerify.token, code },
    });
    if (data.verified) {
      stopVerifyPoll();
      $('#reg-verify-panel').classList.add('is-ok');
      $('#reg-verify-state').textContent = '✅ 邮箱已验证，继续填下面的信息';
      $('#reg-code-row').hidden = true;
      toast('邮箱验证通过');
      if ($('#reg-done')) $('#reg-done').hidden = false;
      $('#reg-password')?.focus();
    }
  } catch (err) {
    toast(err.message, 'error');
    setHint('#reg-verify-state', err.message, 'error');
  }
}

async function checkVerify() {
  if (!regVerify.token) return stopVerifyPoll();
  try {
    const data = await api(`/api/auth/verify/status?token=${encodeURIComponent(regVerify.token)}`);
    if (data.verified) {
      stopVerifyPoll();
      $('#reg-verify-panel').classList.add('is-ok');
      $('#reg-verify-state').textContent = '✅ 邮箱已验证，继续填下面的信息';
      toast('邮箱验证通过');
      $('#reg-password').focus();
    } else if (data.expired) {
      stopVerifyPoll();
      $('#reg-verify-panel').classList.add('is-expired');
      $('#reg-verify-state').textContent = '验证已过期，重新点上面的按钮再来一次';
      const btn = $('#reg-verify-btn');
      btn.hidden = false;
      btn.disabled = false;
      btn.textContent = '① 先验证这个邮箱是我的';
      regVerify = { token: '', email: '', timer: 0 };
    }
  } catch {
    /* 网络抖动：下次轮询再说 */
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* 忽略 */
  }
  state.user = null;
  state.messages = [];
  state.current = null;
  $('#app').hidden = true;
  $('#admin').hidden = true;
  $('#login').hidden = false;
  $('#login-email').value = '';
  $('#login-password').value = '';
  clearHint('#login-hint');
  clearHint('#register-hint');
  $('#reg-password').value = '';
  $('#reg-password2').value = '';
  $('#reg-code').value = '';
  switchTab('login');
  toast('已退出登录');
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  const data = await api('/api/bootstrap');
  if (!data.authenticated) {
    $('#app').hidden = true;
    $('#admin').hidden = true;
    $('#login').hidden = false;
    $('#reg-domain').textContent = `@${data.domain || 'mail.example.com'}`;
    if (data.domain) $('#hint-root').textContent = `admin@${data.domain}`;
    if (data.config) {
      $('#reg-email').placeholder = data.config.requireQQ ? 'QQ 邮箱，如 123456@qq.com' : '邮箱地址';
    }
    return;
  }
  state.user = data.user;
  state.config = data.config || {};
  state.mailboxes = data.mailboxes || [];
  state.externals = data.externals || [];
  state.messages = data.messages || [];
  state.stats = data.stats || {};
  $('#reg-domain').textContent = `@${data.domain}`;
  $('#newbox-domain').textContent = `@${data.domain}`;
  $('#login').hidden = true;
  $('#app').hidden = false;
  renderShell();
  renderMailboxes();
  renderExternals();
  renderList();
  renderStats();
  if (state.current) renderReader(null);
}

/* ------------------------------ 渲染：壳 ------------------------------ */

function renderShell() {
  const u = state.user || {};
  const main = state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0];
  $('#user-name').textContent = u.nickname || u.email || '用户';
  $('#user-mail').textContent = main ? main.address : u.email || '';
  $('#user-avatar').textContent = initialOf(u.nickname || u.email);
  $('#user-avatar').style.background = colorFor(u.email || 'u');
  $('#btn-admin').hidden = !(u.isAdmin || u.role === 'root');
  $('#reader-address').textContent = main ? main.address : '还没有主邮箱';
}

function renderMailboxes() {
  const list = $('#mailbox-list');
  const totalUnread = state.mailboxes.reduce((sum, m) => sum + (m.unread || 0), 0);
  $('#unread-all').textContent = totalUnread > 99 ? '99+' : String(totalUnread);
  $('#unread-all').classList.toggle('is-zero', totalUnread === 0);
  $('#mailbox-count').textContent = String(state.mailboxes.length);

  if (!state.mailboxes.length) {
    list.innerHTML = '<p class="side-empty">还没有邮箱，点上面的「新建邮箱」创建一个。</p>';
    return;
  }

  list.innerHTML = state.mailboxes
    .map((mb) => {
      const active = state.mailboxId === mb.id && !state.alias;
      const subs = (mb.subs || []).filter(
        (s) =>
          s.source !== 'blocked' &&
          (s.total > 0 || s.unread > 0 || s.source === 'manual' || s.source === 'external')
      );
      const subsHtml = subs.length
        ? `<div class="mb-subs">${subs
            .map(
              (s) => `<button type="button" class="sub-row${state.alias === s.localPart && state.mailboxId === mb.id ? ' active' : ''}"
                        data-mailbox="${esc(mb.id)}" data-alias="${esc(s.localPart)}">
                        <span class="sub-name">${esc(s.localPart)}<span class="sub-at">@${esc(s.domain)}</span></span>
                        ${s.unread ? `<span class="sub-badge">${s.unread > 99 ? '99+' : s.unread}</span>` : ''}
                        ${s.source === 'manual' || s.source === 'auto' ? `<span class="sub-del" data-del-sub="${esc(s.localPart)}" title="删除这个子地址">×</span>` : ''}
                      </button>`
            )
            .join('')}</div>`
        : '';

      const isCatch = mb.label === '未登记地址';
      return `<div class="mb-item${active ? ' active' : ''}${isCatch ? ' is-catchall' : ''}">
        <button type="button" class="mb-row" data-mailbox="${esc(mb.id)}" data-alias="">
          <span class="mb-avatar" style="background:${isCatch ? '#8b93a7' : colorFor(mb.address)}">${isCatch ? '<svg class="mb-catch-icon"><use href="#i-inbox"/></svg>' : esc(initialOf(mb.localPart))}</span>
          <span class="mb-body">
            <span class="mb-name">${isCatch ? '未登记地址' : `${esc(mb.localPart)}<span class="mb-at">@${esc(mb.domain)}</span>`}</span>
            <span class="mb-note">${isCatch ? '没建过的地址都进这里' : `${mb.label ? esc(mb.label) : '主邮箱'}${subs.length ? ` · ${subs.length} 个子地址` : ''}`}</span>
          </span>
          ${mb.unread ? `<span class="mb-badge">${mb.unread > 99 ? '99+' : mb.unread}</span>` : ''}
        </button>
        ${subsHtml}
      </div>`;
    })
    .join('');
}

function renderStats() {
  const s = state.stats || {};
  $('#stat-messages').textContent = String(s.messages || 0);
  $('#stat-subs').textContent = String(s.subs || 0);
  $('#stat-bytes').textContent = fmtBytes(s.bytes);
}

/* ------------------------------ 一邮多用 ------------------------------ */

function renderExternals() {
  const list = $('#ext-list');
  if (!list) return;
  if (!state.externals.length) {
    list.innerHTML = '<p class="side-empty">QQ / Gmail / 163 的来信都能转进来，点「+ 接入」。</p>';
    return;
  }
  list.innerHTML = state.externals
    .map((e) => {
      const active = state.alias === e.localPart;
      return `<div class="ext-item${active ? ' active' : ''}">
        <button type="button" class="ext-row" data-mailbox="${esc(e.mailboxId || '')}" data-alias="${esc(e.localPart)}">
          <span class="ext-badge">${esc(extShort(e.provider))}</span>
          <span class="ext-body">
            <span class="ext-addr">${esc(e.address)}</span>
            <span class="ext-note">${esc(e.label || e.providerName)}${e.unread ? ` · ${e.unread} 未读` : ''}</span>
          </span>
        </button>
        <button type="button" class="icon-btn ext-del" data-del="${esc(e.id)}" title="移除"><svg><use href="#i-trash"/></svg></button>
      </div>`;
    })
    .join('');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制：' + text);
  } catch {
    toast('复制失败，请手动选中地址', 'error');
  }
}

function renderExtRows() {
  const box = $('#ext-rows');
  if (!box) return;
  if (!state.externals.length) {
    box.innerHTML = '<p class="ext-empty">还没有接入任何外部邮箱。</p>';
    return;
  }
  box.innerHTML = state.externals
    .map(
      (e) => `<div class="ext-card">
        <div class="ext-card-head">
          <span class="ext-badge">${esc(extShort(e.provider))}</span>
          <b>${esc(e.address)}</b>
          <span class="ext-card-count">${e.mailCount} 封</span>
        </div>
        <div class="ext-card-intake">
          <code>${esc(e.intake)}</code>
          <button type="button" class="mini-btn" data-copy="${esc(e.intake)}">复制</button>
        </div>
        <p class="ext-card-hint">${esc(e.hint)}</p>
        <div class="ext-card-foot">
          <button type="button" class="mini-btn is-danger" data-del="${esc(e.id)}">移除</button>
        </div>
      </div>`
    )
    .join('');
}

async function openExternal() {
  try {
    const data = await api('/api/external');
    state.externals = data.externals || state.externals;
    state.providers = data.providers || [];
    const sel = $('#ext-provider');
    if (!$('#ext-provider').dataset.filled) {
      sel.innerHTML = state.providers.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('');
      sel.dataset.filled = '1';
    }
    $('#ext-info').textContent = '';
    $('#ext-info').className = 'dialog-info';
    $('#ext-tip').textContent = '';
    $('#btn-close-ext').focus?.();
    renderExtRows();
    renderExternals();
    $('#ext-dialog').showModal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveExternal(ev) {
  ev.preventDefault();
  const provider = $('#ext-provider').value;
  const address = $('#ext-address').value.trim();
  const label = $('#ext-label').value.trim();
  const info = $('#ext-info');
  try {
    const data = await api('/api/external', { method: 'POST', body: { provider, address, label } });
    state.externals = data.externals || state.externals;
    const e = data.external;
    $('#ext-address').value = '';
    $('#ext-label').value = '';
    info.className = 'dialog-info is-ok';
    info.innerHTML = `已生成入口地址：<code>${esc(e.intake)}</code>（已复制）`;
    $('#ext-tip').textContent = e.hint;
    copyText(e.intake);
    renderExtRows();
    renderExternals();
  } catch (err) {
    info.className = 'dialog-info is-error';
    info.textContent = err.message;
    toast(err.message, 'error');
  }
}

async function deleteExternal(id) {
  try {
    const data = await api(`/api/external/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.externals = data.externals || [];
    renderExtRows();
    renderExternals();
    toast('已移除，这个入口地址不再收信');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------ 渲染：列表 ------------------------------ */

function currentMailbox() {
  return state.mailboxes.find((m) => m.id === state.mailboxId) || null;
}

function renderList() {
  const body = $('#list-body');
  const rows = state.messages || [];
  const mb = currentMailbox();

  let title = '全部邮件';
  if (mb && state.alias) title = `${state.alias}@${mb.domain}`;
  else if (mb) title = mb.address;
  $('#list-title').textContent = state.q ? `搜索：${state.q}` : title;
  $('#list-sub').textContent = `${rows.length} 封${state.q ? '匹配' : ''}`;

  $$('.nav-item', $('#sidebar')).forEach((b) => b.classList.toggle('active', !state.mailboxId && !state.alias && !state.q));

  if (!rows.length) {
    $('#list-rows').innerHTML = '';
    const empty = $('#list-empty');
    empty.hidden = false;
    const main = state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0];
    empty.querySelector('.empty-title').textContent = state.q ? '没有匹配的邮件' : '这里还没有邮件';
    empty.querySelector('.empty-sub').textContent = state.q
      ? '换个关键词试试，发件人、主题和正文都能搜。'
      : main
        ? `收验证码不用先建邮箱：把 ${main.localPart}-随便写@${main.domain} 填进注册页，信会自动归到这里。`
        : '把收件地址填到注册表单里，验证码和通知就会出现在这里。';
    return;
  }

  $('#list-rows').innerHTML = rows
    .map((m) => {
      const fromName = m.from?.name || m.from?.address || '未知发件人';
      const active = state.current && state.current.id === m.id;
      return `<button type="button" class="msg-row${m.unread ? ' is-unread' : ''}${active ? ' is-active' : ''}" data-id="${esc(m.id)}">
        <span class="msg-avatar" style="background:${colorFor(m.from?.address || fromName)}">${esc(initialOf(fromName))}</span>
        <span class="msg-from" title="${esc(fromName)}">${esc(fromName)}</span>
        <span class="msg-body">
          <span class="msg-subject">${m.extSource ? `<span class="msg-ext">${esc(extShort(m.extSource))}</span>` : m.alias && m.mailbox && m.alias !== m.mailbox ? `<span class="msg-ext is-plain">${esc(m.alias)}</span>` : ''}${esc(m.subject || '(无主题)')}</span>
          <span class="msg-snippet">${esc(m.snippet || '')}</span>
        </span>
        <span class="msg-flags">${m.attachments ? `<svg class="flag-ico"><use href="#i-clip"/></svg>` : ''}${m.unread ? '<i class="dot"></i>' : ''}</span>
        <span class="msg-time">${fmtTime(m.date)}</span>
      </button>`;
    })
    .join('');
  $('#list-empty').hidden = true;
}

/* ------------------------------ 渲染：阅读 ------------------------------ */

function renderReader(msg) {
  const empty = $('#reader-empty');
  const article = $('#reader-article');
  state.current = msg;
  if (!msg) {
    empty.hidden = false;
    article.hidden = true;
    document.body.classList.remove('reader-open');
    renderList();
    return;
  }
  empty.hidden = true;
  article.hidden = false;
  document.body.classList.add('reader-open');

  $('#reader-subject').textContent = msg.subject || '(无主题)';
  const extTag = $('#reader-ext');
  if (msg.extSource) {
    extTag.hidden = false;
    extTag.innerHTML = `来自外部邮箱 <b>${esc(extShort(msg.extSource))}</b> 的转发`;
  } else {
    extTag.hidden = true;
    extTag.textContent = '';
  }
  $('#reader-from-name').textContent = msg.from?.name || msg.from?.address || '未知';
  $('#reader-from-addr').textContent = msg.from?.address ? `<${msg.from.address}>` : '';
  $('#reader-to').textContent = msg.to || '';
  $('#reader-date').textContent = fmtFull(msg.date);

  const atts = msg.attachments || [];
  const box = $('#attachments');
  box.hidden = !atts.length;
  box.innerHTML = atts
    .map(
      (a) => `<a class="attachment" href="${esc(a.url)}" download>
        <svg><use href="#i-clip"/></svg>
        <span class="att-name">${esc(a.filename)}</span>
        <span class="att-size">${fmtBytes(a.size)}</span>
      </a>`
    )
    .join('');

  const frame = $('#mail-frame');
  const text = $('#mail-text');
  if (msg.html) {
    frame.hidden = false;
    text.hidden = true;
    frame.srcdoc = msg.html;
  } else {
    frame.hidden = true;
    text.hidden = false;
    text.textContent = msg.text || '(这封邮件没有正文)';
  }
  renderList();
}

async function openMessage(id) {
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    renderReader(data.message);
    const row = state.messages.find((m) => m.id === id);
    if (row && row.unread) {
      row.unread = false;
      const mb = state.mailboxes.find((m) => m.id === row.mailboxId);
      if (mb && mb.unread > 0) mb.unread -= 1;
      renderMailboxes();
      renderStats();
    }
    if (window.innerWidth <= 900) document.body.classList.add('reader-open');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------ 数据操作 ------------------------------ */

async function fetchMessages() {
  const params = new URLSearchParams();
  if (state.mailboxId) params.set('mailboxId', state.mailboxId);
  if (state.alias) params.set('alias', state.alias);
  if (state.q) params.set('q', state.q);
  params.set('limit', '100');
  const data = await api(`/api/messages?${params}`);
  state.messages = data.messages || [];
  state.stats = data.stats || state.stats;
  renderList();
  renderStats();
}

async function selectMailbox(id, alias = '') {
  state.mailboxId = id || '';
  state.alias = alias || '';
  if (state.q) {
    state.q = '';
    $('#search').value = '';
  }
  renderMailboxes();
  document.body.classList.remove('sidebar-open');
  try {
    await fetchMessages();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshMailboxes() {
  const data = await api('/api/mailboxes');
  state.mailboxes = data.mailboxes || [];
  renderShell();
  renderMailboxes();
  renderStats();
}

async function refreshAll() {
  try {
    const data = await api(`/api/bootstrap${state.mailboxId ? `?mailbox=${encodeURIComponent(state.mailboxId)}` : ''}`);
    state.mailboxes = data.mailboxes || [];
    state.externals = data.externals || state.externals;
    state.stats = data.stats || {};
    state.user = data.user || state.user;
    await fetchMessages();
    renderShell();
    renderMailboxes();
    renderExternals();
    renderStats();
    toast('已刷新');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteCurrent() {
  const msg = state.current;
  if (!msg) return;
  if (!confirm('删除这封邮件？删除后无法恢复。')) return;
  try {
    await api(`/api/messages/${encodeURIComponent(msg.id)}`, { method: 'DELETE' });
    state.messages = state.messages.filter((m) => m.id !== msg.id);
    renderReader(null);
    renderList();
    const data = await api('/api/bootstrap');
    state.mailboxes = data.mailboxes || [];
    state.stats = data.stats || {};
    renderMailboxes();
    renderStats();
    toast('已删除');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function markAllRead() {
  try {
    await api('/api/messages/read-all', { method: 'POST', body: { mailboxId: state.mailboxId } });
    await fetchMessages();
    const data = await api('/api/bootstrap');
    state.mailboxes = data.mailboxes || [];
    renderMailboxes();
    toast('已全部标记为已读');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------ 账号设置 ------------------------------ */

function openSettings() {
  const u = state.user || {};
  $('#set-email').value = u.email || '';
  $('#set-nickname').value = u.nickname || '';
  $('#set-phone').value = u.phone || '';
  $('#set-old-password').value = '';
  $('#set-new-password').value = '';
  // 换绑面板每次打开都是收起的
  rebindEmail = { token: '', timer: 0, email: '' };
  stopRebindPoll();
  ['#panel-email', '#panel-phone'].forEach((sel) => {
    const el = $(sel);
    if (el) el.hidden = true;
  });
  ['#set-new-email', '#set-email-password', '#set-new-phone', '#set-phone-password', '#newemail-code'].forEach((sel) => {
    const el = $(sel);
    if (el) el.value = '';
  });
  $('#newemail-code-row').hidden = true;
  $('#btn-verify-newemail').disabled = false;
  $('#btn-verify-newemail').textContent = '① 发送验证码';
  setHint('#newemail-state', '先把验证码发到新邮箱，再填进来');
  setHint('#dialog-info', state.config.smsEnabled ? '短信验证已开启。' : '短信通道未接入，手机号目前只做格式与唯一性校验。');
  $('#settings-dialog').showModal();
}

async function saveSettings(ev) {
  ev.preventDefault();
  const body = {
    nickname: $('#set-nickname').value.trim(),
    oldPassword: $('#set-old-password').value,
    password: $('#set-new-password').value,
  };
  if (!body.password) delete body.password;
  try {
    const data = await api('/api/me', { method: 'POST', body });
    state.user = data.user;
    renderShell();
    $('#set-old-password').value = '';
    $('#set-new-password').value = '';
    setHint('#dialog-info', '已保存');
    toast('设置已保存');
    setTimeout(() => $('#settings-dialog').close(), 600);
  } catch (err) {
    setHint('#dialog-info', err.message, 'error');
    toast(err.message, 'error');
  }
}

/* ---------- 忘记密码 ---------- */

async function sendResetCode() {
  const email = $('#reset-email').value.trim();
  if (!email) {
    toast('先填登录邮箱', 'error');
    $('#reset-email').focus();
    return;
  }
  const btn = $('#reset-send');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const data = await api('/api/auth/reset/start', { method: 'POST', body: { email } });
    setHint('#reset-state', `验证码已发到 ${data.sentTo || email}，10 分钟内有效`);
    toast('验证码已发送，去查收邮件');
    $('#reset-code').focus();
  } catch (err) {
    toast(err.message, 'error');
    setHint('#reset-state', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '重新发送';
  }
}

async function submitReset(ev) {
  ev.preventDefault();
  const email = $('#reset-email').value.trim();
  const code = $('#reset-code').value.replace(/\D/g, '');
  const password = $('#reset-password').value;
  if (code.length !== 6) {
    toast('填邮件里的 6 位验证码', 'error');
    $('#reset-code').focus();
    return;
  }
  if (password.length < 8) {
    toast('新密码至少 8 位', 'error');
    $('#reset-password').focus();
    return;
  }
  try {
    await api('/api/auth/reset/confirm', { method: 'POST', body: { email, code, password } });
    $('#reset-dialog').close();
    $('#login-email').value = email;
    $('#login-password').value = '';
    $('#login-password').focus();
    clearHint('#login-hint');
    toast('密码已重设，用新密码登录');
  } catch (err) {
    toast(err.message, 'error');
    setHint('#reset-info', err.message, 'error');
  }
}

/* ---------- 换绑手机号 ---------- */

async function saveRebindPhone() {
  const phone = $('#set-new-phone').value.replace(/[\s-]/g, '').replace(/^\+?86/, '');
  const password = $('#set-phone-password').value;
  if (!password) {
    toast('请输入当前密码', 'error');
    $('#set-phone-password').focus();
    return;
  }
  try {
    const data = await api('/api/me', {
      method: 'POST',
      body: { nickname: state.user?.nickname || '', phone, oldPassword: password },
    });
    state.user = data.user;
    $('#set-phone').value = data.user.phone || '';
    $('#set-new-phone').value = '';
    $('#set-phone-password').value = '';
    $('#panel-phone').hidden = true;
    renderShell();
    toast(phone ? '手机号已换绑' : '手机号已解绑');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- 换绑登录邮箱（要验证新邮箱） ---------- */

let rebindEmail = { token: '', timer: 0, email: '' };

function stopRebindPoll() {
  if (rebindEmail.timer) clearInterval(rebindEmail.timer);
  rebindEmail.timer = 0;
}

async function startRebindEmailVerify() {
  const email = $('#set-new-email').value.trim();
  if (!email) {
    toast('先填新的 QQ 邮箱', 'error');
    $('#set-new-email').focus();
    return;
  }
  const btn = $('#btn-verify-newemail');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const data = await api('/api/auth/verify/start', { method: 'POST', body: { email } });
    rebindEmail = { token: data.token, email: email.toLowerCase(), timer: 0, mode: 'code' };
    $('#newemail-code-row').hidden = false;
    $('#newemail-code').value = '';
    setHint('#newemail-state', `验证码已发到 ${data.sentTo || email}，10 分钟内有效`);
    btn.disabled = false;
    btn.textContent = '① 重新发送验证码';
    $('#newemail-code').focus();
    toast('验证码已发送到新邮箱');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '① 发送验证码';
  }
}

async function confirmRebindCode() {
  const code = $('#newemail-code').value.replace(/\D/g, '');
  if (code.length !== 6) {
    toast('验证码是 6 位数字', 'error');
    return;
  }
  try {
    const data = await api('/api/auth/verify/confirm', {
      method: 'POST',
      body: { token: rebindEmail.token, code },
    });
    if (data.verified) {
      stopRebindPoll();
      setHint('#newemail-state', '✅ 新邮箱已验证，填当前密码后点「确认换绑」');
      $('#newemail-code-row').hidden = true;
      $('#btn-verify-newemail').textContent = '✅ 新邮箱已验证';
      toast('新邮箱验证通过');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveRebindEmail() {
  const email = $('#set-new-email').value.trim();
  const password = $('#set-email-password').value;
  if (!rebindEmail.token || rebindEmail.email !== email.toLowerCase()) {
    toast('请先点「① 验证新邮箱」完成验证', 'error');
    return;
  }
  if (!password) {
    toast('请输入当前密码', 'error');
    $('#set-email-password').focus();
    return;
  }
  try {
    const data = await api('/api/me/email', { method: 'POST', body: { email, password, token: rebindEmail.token } });
    state.user = data.user;
    $('#set-email').value = data.user.email || '';
    $('#set-new-email').value = '';
    $('#set-email-password').value = '';
    $('#panel-email').hidden = true;
    $('#newemail-code').value = '';
    $('#newemail-code-row').hidden = true;
    stopRebindPoll();
    rebindEmail = { token: '', timer: 0, email: '' };
    renderShell();
    toast('登录邮箱已换绑：' + (data.user.email || ''));
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------ 新建邮箱 ------------------------------ */

function mainMailbox() {
  return state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0] || null;
}

function newboxMode() {
  const el = document.querySelector('input[name="newbox-mode"]:checked');
  return el ? el.value : 'sub';
}

function syncNewboxMode() {
  const main = mainMailbox();
  const mode = newboxMode();
  const preview = $('#newbox-preview');
  const name = ($('#newbox-name').value || '').trim().replace(/^@+/, '');
  const domain = main ? main.domain : '';
  if (mode === 'main' || !main) {
    preview.textContent = name ? `${name}@${domain}` : `@${domain}`;
    $('#newbox-info').textContent = '主邮箱只能有 1 个，收信用它、加子地址也用它的前缀。';
  } else {
    const full = name ? (name.startsWith(main.localPart) ? name : `${main.localPart}-${name}`) : `${main.localPart}-`;
    preview.textContent = `${full}@${domain}`;
    setHint('#newbox-info', `子地址 = 主邮箱前缀 + 后缀，来信自动归到 ${main.localPart}@${main.domain}。`);
  }
  $('#newbox-dialog').classList.toggle('is-sub', mode === 'sub' && !!main);
}

function openNewbox() {
  const main = mainMailbox();
  $('#newbox-name').value = '';
  // 已经有主邮箱的用户，默认建子地址（以前这里只能建主邮箱，所以一直报“每个账号只能有 1 个主邮箱”）
  const subRadio = document.querySelector('input[name="newbox-mode"][value="sub"]');
  const mainRadio = document.querySelector('input[name="newbox-mode"][value="main"]');
  if (main) {
    if (subRadio) subRadio.checked = true;
    if (mainRadio) {
      mainRadio.disabled = true;
      mainRadio.closest('.seg-item')?.classList.add('is-off');
    }
  } else {
    if (mainRadio) mainRadio.checked = true;
    if (subRadio) {
      subRadio.disabled = true;
      subRadio.closest('.seg-item')?.classList.add('is-off');
    }
  }
  clearHint('#newbox-info');
  const dom = $('#newbox-domain');
  if (dom) dom.textContent = `@${main ? main.domain : ''}`;
  syncNewboxMode();
  $('#newbox-dialog').showModal();
  setTimeout(() => $('#newbox-name').focus(), 60);
}

async function createMailbox(ev) {
  ev.preventDefault();
  const btn = $('#newbox-submit');
  const name = $('#newbox-name').value.trim();
  const main = mainMailbox();
  const mode = main && newboxMode() === 'sub' ? 'sub' : 'main';
  if (!name) {
    setHint('#newbox-info', '先填一个名字', 'error');
    toast('请填写邮箱名', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const data =
      mode === 'sub'
        ? await api('/api/subaddresses', { method: 'POST', body: { name } })
        : await api('/api/mailboxes', { method: 'POST', body: { name } });
    state.mailboxes = data.mailboxes || [];
    renderShell();
    renderMailboxes();
    renderStats();
    $('#newbox-dialog').close();
    $('#newbox-name').value = '';
    clearHint('#newbox-info');
    toast(mode === 'sub' ? `子地址已创建：${data.address || name}` : '邮箱已创建');
    if (mode === 'sub' && main) {
      state.mailboxId = main.id;
      state.alias = null;
      await fetchMessages();
      renderStats();
    }
  } catch (err) {
    setHint('#newbox-info', err.message, 'error');
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '创建';
  }
}

/* ------------------------------ 管理后台 ------------------------------ */

async function openAdmin() {
  $('#admin').hidden = false;
  document.body.classList.add('admin-open');
  await loadAdmin();
}

function closeAdmin() {
  $('#admin').hidden = true;
  document.body.classList.remove('admin-open');
}

async function loadAdmin() {
  try {
    const [overview, users] = await Promise.all([
      api('/api/admin/overview'),
      api(`/api/admin/users?q=${encodeURIComponent(state.admin.q)}`),
    ]);
    state.admin.stats = overview.stats;
    state.admin.domains = overview.domains || [];
    state.admin.config = overview.config || {};
    state.admin.dropped = overview.dropped || [];
    state.admin.users = users.users || [];
    renderAdmin();
  } catch (err) {
    toast(err.message, 'error');
    closeAdmin();
  }
}

function renderAdmin() {
  const s = state.admin.stats || {};
  const cards = [
    ['用户', s.users, `${s.activeUsers} 个活跃`],
    ['主邮箱', s.mailboxes, `${s.subs} 个子地址`],
    ['邮件', s.messages, `${s.unread} 封未读`],
    ['占用空间', fmtBytes(s.bytes), `${s.domains} 个域名`],
  ];
  $('#admin-stats').innerHTML = cards
    .map(
      ([label, value, note]) => `<div class="stat-card">
        <span class="stat-label">${label}</span>
        <b class="stat-value">${esc(value)}</b>
        <small class="stat-note">${esc(note)}</small>
      </div>`
    )
    .join('');

  const me = state.user || {};
  $('#admin-sub').textContent = `当前身份：${me.nickname || me.email}（${me.role === 'root' ? 'root' : '管理员'}）`;

  $('#admin-user-rows').innerHTML = state.admin.users
    .map((u) => {
      const self = u.id === me.id;
      const disabled = u.status !== 'active';
      return `<tr class="${disabled ? 'is-off' : ''}">
        <td>
          <div class="admin-user">
            <span class="admin-avatar" style="background:${colorFor(u.email)}">${esc(initialOf(u.nickname || u.email))}</span>
            <span class="admin-user-meta">
              <b>${esc(u.nickname || '未命名')}</b>
              <small>${esc(u.email)}${u.role !== 'user' ? ` · <em>${esc(u.role)}</em>` : ''}</small>
            </span>
          </div>
        </td>
        <td class="mono">${esc(u.phone || '—')}</td>
        <td class="mono">${esc(u.mainAddress || '—')}</td>
        <td>${u.messages}${u.unread ? ` <span class="mini-dot">${u.unread}</span>` : ''}</td>
        <td><span class="tag ${disabled ? 'tag-off' : 'tag-on'}">${disabled ? '已停用' : '正常'}</span></td>
        <td class="mono dim">${u.lastLoginAt ? fmtFull(u.lastLoginAt) : '从未'}</td>
        <td class="ta-r">
          <div class="row-actions">
            ${self ? '<span class="dim">当前账号</span>' : `
              <button class="mini-btn" data-act="toggle" data-id="${esc(u.id)}" data-status="${disabled ? 'active' : 'disabled'}">${disabled ? '启用' : '停用'}</button>
              <button class="mini-btn" data-act="reset" data-id="${esc(u.id)}">重置密码</button>
              <button class="mini-btn danger" data-act="delete" data-id="${esc(u.id)}" data-email="${esc(u.email)}">删除</button>`}
          </div>
        </td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="7" class="admin-empty">还没有用户</td></tr>';

  $('#admin-domains').innerHTML = state.admin.domains
    .map(
      (d) => `<div class="domain-row">
        <div class="domain-name"><svg><use href="#i-globe"/></svg>${esc(d.name)}</div>
        <div class="domain-meta">${d.mailboxes} 个邮箱 · ${d.total} 封</div>
        <button class="mini-btn danger" data-act="del-domain" data-name="${esc(d.name)}">移除</button>
      </div>`
    )
    .join('') || '<p class="dim">还没有域名</p>';

  const c = state.admin.config || {};
  $('#cfg-subauto').checked = !!c.subAddressAuto;
  $('#cfg-requireqq').checked = !!c.requireQQ;
  $('#cfg-sms').checked = !!c.smsEnabled;
  $('#cfg-catchall').checked = c.catchAll !== false;
  $('#cfg-keep').value = Number(c.keepDays || 0);

  const dropped = state.admin.dropped || [];
  $('#dropped-list').hidden = !dropped.length;
  $('#dropped-count').textContent = String(state.admin.stats?.dropped ?? dropped.length);
  $('#dropped-rows').innerHTML = dropped
    .map(
      (d) => `<div class="dropped-row">
        <code>${esc(d.address)}</code>
        <span class="dropped-sub">${esc(d.subject || '(无主题)')}</span>
        <span class="dropped-from">${esc(d.from || '')}</span>
      </div>`
    )
    .join('');
}

async function adminAction(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const { act, id, status, email, name } = btn.dataset;
  try {
    if (act === 'toggle') {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { status } });
      toast(status === 'active' ? '已启用' : '已停用');
    } else if (act === 'reset') {
      const data = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
      toast(`临时密码：${data.password}（已复制）`, 'ok', 12000);
      navigator.clipboard?.writeText(data.password).catch(() => {});
    } else if (act === 'delete') {
      if (!confirm(`删除 ${email}？该用户的邮箱和邮件会一起删除，不可恢复。`)) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      toast('用户已删除');
    } else if (act === 'del-domain') {
      if (!confirm(`移除域名 ${name}？该域名下的邮箱和邮件会一起删除。`)) return;
      await api(`/api/admin/domains/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast('域名已移除');
    }
    await loadAdmin();
    const data = await api('/api/bootstrap');
    state.mailboxes = data.mailboxes || [];
    renderMailboxes();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveAdminConfig() {
  try {
    await api('/api/admin/config', {
      method: 'POST',
      body: {
        subAddressAuto: $('#cfg-subauto').checked,
        requireQQ: $('#cfg-requireqq').checked,
        smsEnabled: $('#cfg-sms').checked,
        catchAll: $('#cfg-catchall').checked,
        keepDays: Number($('#cfg-keep').value || 0),
      },
    });
    toast('开关已保存');
    await loadAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function addDomain(ev) {
  ev.preventDefault();
  const name = $('#admin-domain-input').value.trim();
  if (!name) return;
  try {
    await api('/api/admin/domains', { method: 'POST', body: { name } });
    $('#admin-domain-input').value = '';
    toast('域名已添加');
    await loadAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bind() {
  $$('.auth-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#login-form').addEventListener('submit', doLogin);
  $('#register-form').addEventListener('submit', doRegister);
  $('#reg-verify-btn').addEventListener('click', startVerify);
  $('#reg-code-resend').addEventListener('click', startVerify);
  $('#btn-logout').addEventListener('click', logout);

  $('#btn-refresh').addEventListener('click', refreshAll);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', () => $('#settings-dialog').close());
  $('#btn-cancel-settings').addEventListener('click', () => $('#settings-dialog').close());
  $('#btn-rebind-phone').addEventListener('click', () => {
    $('#panel-phone').hidden = !$('#panel-phone').hidden;
    if (!$('#panel-phone').hidden) $('#set-new-phone').focus();
  });
  $('#btn-cancel-phone').addEventListener('click', () => {
    $('#panel-phone').hidden = true;
    $('#set-new-phone').value = '';
    $('#set-phone-password').value = '';
  });
  $('#btn-save-phone').addEventListener('click', saveRebindPhone);
  $('#btn-rebind-email').addEventListener('click', () => {
    $('#panel-email').hidden = !$('#panel-email').hidden;
    if (!$('#panel-email').hidden) $('#set-new-email').focus();
  });
  $('#btn-cancel-email').addEventListener('click', () => {
    $('#panel-email').hidden = true;
    $('#set-new-email').value = '';
    $('#set-email-password').value = '';
    $('#newemail-code').value = '';
    stopRebindPoll();
    rebindEmail = { token: '', timer: 0, email: '' };
  });
  $('#btn-verify-newemail').addEventListener('click', startRebindEmailVerify);
  $('#btn-save-email').addEventListener('click', saveRebindEmail);
  $('#newemail-code-btn').addEventListener('click', confirmRebindCode);
  $('#newemail-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmRebindCode();
    }
  });

  /* ---------- 找回密码 ---------- */
  $('#btn-forgot').addEventListener('click', () => {
    $('#reset-email').value = $('#login-email').value.trim();
    $('#reset-code').value = '';
    $('#reset-password').value = '';
    setHint('#reset-state', '验证码 10 分钟内有效');
    clearHint('#reset-info');
    $('#reset-dialog').showModal();
    $('#reset-email').focus();
  });
  $('#btn-close-reset').addEventListener('click', () => $('#reset-dialog').close());
  $('#btn-cancel-reset').addEventListener('click', () => $('#reset-dialog').close());
  $('#reset-send').addEventListener('click', sendResetCode);
  $('#reset-form').addEventListener('submit', submitReset);

  $('#reg-code-btn').addEventListener('click', confirmVerifyCode);
  $('#reg-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmVerifyCode();
    }
  });
  $('#settings-dialog').addEventListener('close', () => {
    $('#set-old-password').value = '';
    $('#set-new-password').value = '';
    clearHint('#dialog-info');
  });
  $('#settings-form').addEventListener('submit', saveSettings);

  $('#btn-new-mailbox').addEventListener('click', openNewbox);
  $('#btn-close-newbox').addEventListener('click', () => $('#newbox-dialog').close());
  $('#btn-cancel-newbox').addEventListener('click', () => $('#newbox-dialog').close());
  $('#newbox-form').addEventListener('submit', createMailbox);
  $('#newbox-dialog').addEventListener('close', () => {
    $('#newbox-name').value = '';
    clearHint('#newbox-info');
  });
  $$('input[name="newbox-mode"]').forEach((r) => r.addEventListener('change', syncNewboxMode));
  $('#newbox-name').addEventListener('input', syncNewboxMode);

  $('#btn-add-external').addEventListener('click', openExternal);
  $('#btn-close-ext').addEventListener('click', () => $('#ext-dialog').close());
  $('#btn-cancel-ext').addEventListener('click', () => $('#ext-dialog').close());
  $('#ext-form').addEventListener('submit', saveExternal);
  $('#ext-rows').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return deleteExternal(del.dataset.del);
    const copy = e.target.closest('[data-copy]');
    if (copy) copyText(copy.dataset.copy);
  });
  $('#ext-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      return deleteExternal(del.dataset.del);
    }
    const row = e.target.closest('[data-mailbox], [data-alias]');
    if (row && !row.dataset.del) selectMailbox(row.dataset.mailbox || '', row.dataset.alias || '');
  });

  $('#btn-admin').addEventListener('click', openAdmin);
  $('#btn-admin-back').addEventListener('click', closeAdmin);
  $('#btn-admin-refresh').addEventListener('click', loadAdmin);
  $('#admin-user-rows').addEventListener('click', adminAction);
  $('#admin-domains').addEventListener('click', adminAction);
  $('#admin-domain-form').addEventListener('submit', addDomain);
  $('#btn-save-config').addEventListener('click', saveAdminConfig);

  let searchTimer = 0;
  $('#admin-user-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.admin.q = e.target.value.trim();
      loadAdmin();
    }, 250);
  });

  $('#all-mail').addEventListener('click', () => selectMailbox('', ''));
  $('#mailbox-list').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-sub]');
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      const local = del.dataset.delSub;
      if (!confirm(`删除子地址 ${local}？删除后发给它的新邮件会被拒收（已收到的邮件保留）。`)) return;
      try {
        await api(`/api/subaddresses/${encodeURIComponent(local)}`, { method: 'DELETE' });
        toast(`子地址 ${local} 已删除`);
        await refreshMailboxes();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const row = e.target.closest('[data-mailbox]');
    if (!row) return;
    selectMailbox(row.dataset.mailbox || '', row.dataset.alias || '');
  });

  $('#list-body').addEventListener('click', (e) => {
    const row = e.target.closest('.msg-row');
    if (row) openMessage(row.dataset.id);
  });

  $('#btn-read-all').addEventListener('click', markAllRead);
  $('#btn-delete').addEventListener('click', deleteCurrent);
  $('#btn-eml').addEventListener('click', () => {
    if (!state.current) return;
    window.location.href = `/api/messages/${encodeURIComponent(state.current.id)}/eml`;
  });
  $('#btn-copy-default').addEventListener('click', () => {
    const mb = state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0];
    if (!mb) return;
    navigator.clipboard?.writeText(mb.address).then(
      () => toast('已复制 ' + mb.address),
      () => toast('复制失败，请手动选择', 'error')
    );
  });

  let searchTimer2 = 0;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer2);
    const value = e.target.value.trim();
    searchTimer2 = setTimeout(async () => {
      state.q = value;
      try {
        await fetchMessages();
      } catch (err) {
        toast(err.message, 'error');
      }
    }, 250);
  });

  $('#btn-menu').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#btn-close-list').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  $('#btn-close-reader').addEventListener('click', () => renderReader(null));
  $('#scrim').addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
    document.body.classList.remove('reader-open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.body.classList.remove('sidebar-open');
      closeAdmin();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) document.body.classList.remove('sidebar-open');
  });
}

/* ------------------------------ 启动 ------------------------------ */

bind();
boot().catch((err) => {
  console.error(err);
  $('#login').hidden = false;
  setHint('#login-hint', '无法连接服务器：' + err.message, 'error');
});

// 每 60 秒静默同步一次（Worker 版没有 SSE）
setInterval(async () => {
  if (!state.user) return;
  if (document.hidden) return;
  try {
    const params = new URLSearchParams();
    if (state.mailboxId) params.set('mailboxId', state.mailboxId);
    params.set('limit', '100');
    const data = await api(`/api/messages?${params}`);
    state.messages = data.messages || [];
    state.stats = data.stats || state.stats;
    renderList();
    renderStats();
  } catch {
    /* 静默失败 */
  }
}, 60000);
