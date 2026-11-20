// ============================================================================
//  worker.mjs —— 自动生成，请勿手改
//  源码：mime.mjs + worker.template.mjs + public/*（改完源码运行 node build-worker.mjs）
//  生成时间：2026-11-20T02:17:55.161Z
//  总大小：约 238.2 KB
// ============================================================================

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

// ============================================================================
//  mime.mjs —— 零依赖 MIME 邮件解析器
//  同时运行在 Node.js 与 Cloudflare Workers 中（只用 TextDecoder，不依赖 Buffer）
// ============================================================================

const LOWER = (s) => String(s).toLowerCase();

/* ------------------------------ 字节工具 ------------------------------ */

export function latin1(bytes) {
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return out;
}

export function toBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

const B64ALPHA =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64ALPHA.length; i++) t[B64ALPHA.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // base64url
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** 手工 base64 解码：跳过空白与非法字符，遇 '=' 结束 */
export function base64ToBytes(input) {
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 61 /* = */) break;
    const v = B64LOOKUP[c & 0xff];
    if (v === 255) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** quoted-printable 解码（作用于字节，正确处理软换行） */
export function qpToBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== 0x3d /* = */) {
      out[n++] = b;
      continue;
    }
    const n1 = bytes[i + 1];
    const n2 = bytes[i + 2];
    // 软换行 "=\r\n" 或 "=\n"
    if (n1 === 0x0d && n2 === 0x0a) { i += 2; continue; }
    if (n1 === 0x0a) { i += 1; continue; }
    const h1 = hexVal(n1);
    const h2 = hexVal(n2);
    if (h1 >= 0 && h2 >= 0) {
      out[n++] = (h1 << 4) | h2;
      i += 2;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

function hexVal(c) {
  if (c === undefined) return -1;
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/* ------------------------------ 字符集解码 ------------------------------ */

const utf8 = new TextDecoder('utf-8', { fatal: false });

export function bytesToText(bytes, charset = 'utf-8') {
  const cs = LOWER(charset || 'utf-8').replace(/^["']|["']$/g, '').trim();
  if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    return utf8.decode(bytes);
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    // 少数运行环境（如 Cloudflare Worker）缺少该编码表，退回 utf-8
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return latin1(bytes);
    }
  }
}

/* ------------------------------ RFC 2047 ------------------------------ */

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;

/**
 * 解码标题/发件人里的 =?UTF-8?B?...?= 编码字。
 * 相邻编码字之间的空白按规范去掉。
 */
export function decodeWords(value) {
  if (!value || value.indexOf('=?') === -1) return value || '';
  let out = '';
  let last = 0;
  let prevEnd = -1;
  let m;
  ENCODED_WORD.lastIndex = 0;
  while ((m = ENCODED_WORD.exec(value))) {
    const between = value.slice(last, m.index);
    if (prevEnd === m.index && /^\s*$/.test(between)) {
      // 相邻的两个编码字：丢弃中间的空白
    } else {
      out += between;
    }
    const charset = m[1];
    const enc = m[2].toUpperCase();
    const payload = m[3];
    const bytes =
      enc === 'B' ? base64ToBytes(payload) : qpToBytes(toBytes(payload.replace(/_/g, ' ')));
    out += bytesToText(bytes, charset);
    last = ENCODED_WORD.lastIndex;
    prevEnd = last;
  }
  out += value.slice(last);
  return out;
}

/* ------------------------------ 头部解析 ------------------------------ */

/**
 * @returns {{name:string,value:string}[]} value 已展开（去掉折叠换行）
 */
export function parseHeaderBlock(headText) {
  const lines = headText.split(/\r?\n/);
  const headers = [];
  let cur = null;
  for (const line of lines) {
    if (!line) continue;
    if ((line[0] === ' ' || line[0] === '\t') && cur) {
      cur.value += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    cur = { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    headers.push(cur);
  }
  // 用 latin1 展开后的值仍是“字节串”，这里做一次安全的 UTF-8 修正
  return headers.map((h) => ({
    name: h.name,
    value: fixMojibake(decodeWords(h.value)),
  }));
}

const isContByte = (c) => c >= 0x80 && c <= 0xbf;

/**
 * 有些客户端把 UTF-8 直接写进头部（不放 =?UTF-8?B?...?=）。
 * 读进来时会变成“每个字节一个 U+00XX 字符”，这里识别并还原。
 * 判断依据：字符流里出现合法的 UTF-8 字节序列；纯中文不会被误判（码点都 > 0xF4）。
 */
function fixMojibake(str) {
  if (!str) return '';
  let sequences = 0;
  let i = 0;
  while (i < str.length) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      i += 1;
      continue;
    }
    if (c >= 0xc2 && c <= 0xdf && isContByte(str.charCodeAt(i + 1))) {
      sequences += 1;
      i += 2;
      continue;
    }
    if (
      c >= 0xe0 && c <= 0xef &&
      isContByte(str.charCodeAt(i + 1)) &&
      isContByte(str.charCodeAt(i + 2))
    ) {
      sequences += 1;
      i += 3;
      continue;
    }
    if (
      c >= 0xf0 && c <= 0xf4 &&
      isContByte(str.charCodeAt(i + 1)) &&
      isContByte(str.charCodeAt(i + 2)) &&
      isContByte(str.charCodeAt(i + 3))
    ) {
      sequences += 1;
      i += 4;
      continue;
    }
    i += 1;
  }
  if (!sequences) return str;
  const decoded = bytesToText(toBytes(str), 'utf-8');
  return decoded.includes('\ufffd') ? str : decoded;
}

export function getHeader(headers, name) {
  const n = LOWER(name);
  const found = headers.filter((h) => LOWER(h.name) === n);
  if (!found.length) return '';
  return found.map((h) => h.value).join(', ');
}

function getRawHeader(headers, name) {
  const n = LOWER(name);
  const found = headers.filter((h) => LOWER(h.name) === n);
  return found.length ? found[found.length - 1].value : '';
}

/* ------------------------------ 参数解析 ------------------------------ */

/** 解析 `text/html; charset="utf-8"; boundary=xx` */
export function parseContentType(value) {
  const raw = value || '';
  const semi = raw.indexOf(';');
  const type = ((semi === -1 ? raw : raw.slice(0, semi)).trim() || 'text/plain').toLowerCase();
  const params = {};
  if (semi !== -1) {
    const rest = raw.slice(semi + 1);
    for (const { key, val } of splitParams(rest)) {
      params[LOWER(key)] = val;
    }
  }
  const slash = type.indexOf('/');
  return {
    type: slash === -1 ? type || 'text/plain' : type.slice(0, slash),
    subtype: slash === -1 ? '' : type.slice(slash + 1),
    fullType: type || 'text/plain',
    params,
  };
}

function splitParams(str) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && (str[i] === ';' || str[i] === ' ' || str[i] === '\t')) i++;
    let key = '';
    while (i < str.length && str[i] !== '=' && str[i] !== ';') key += str[i++];
    key = key.trim();
    if (str[i] !== '=') {
      if (key) out.push({ key, val: '' });
      continue;
    }
    i++; // skip =
    let val = '';
    if (str[i] === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\' && i + 1 < str.length) {
          val += str[i + 1];
          i += 2;
        } else {
          val += str[i++];
        }
      }
      i++; // closing quote
    } else {
      while (i < str.length && str[i] !== ';') val += str[i++];
    }
    out.push({ key, val: val.trim() });
  }
  return out;
}

/** 处理 filename 与 RFC 2231 的 filename* */
function paramName(params) {
  if (params['filename*']) {
    const v = params['filename*'];
    const m = /^([^']*)'[^']*'(.*)$/.exec(v);
    if (m) {
      try {
        return bytesToText(
          toBytes(decodeURIComponent(m[2].replace(/\+/g, ' '))),
          m[1] || 'utf-8'
        );
      } catch {
        /* 忽略非法转义，继续用 filename */
      }
    }
  }
  const plain = params.filename || params.name || '';
  return decodeWords(fixMojibake(plain));
}

/* ------------------------------ 地址解析 ------------------------------ */

const EMAIL_IN_TEXT = /[^\s<>()[\],;:"']+@[^\s<>()[\],;:"']+/g;

export function parseAddress(value) {
  const v = decodeWords(value || '').trim();
  const angle = /^(.*?)<([^>]+)>/.exec(v);
  let addr = (angle ? angle[2] : v).trim().replace(/^mailto:/i, '');
  let name = angle ? angle[1].trim() : '';
  name = name.replace(/^["']|["']$/g, '').trim();

  // 有些客户端会把整段地址写坏（例如 <GitHub <a@b.com>>），这里取最后一个像邮箱的片段
  const hits = addr.match(EMAIL_IN_TEXT);
  if (hits && hits.length) {
    addr = hits[hits.length - 1];
    if (!name && hits.length > 1) name = '';
  }
  return { name, address: addr };
}

export function parseAddressList(value) {
  if (!value) return [];
  // 逗号分隔，但引号与尖括号内的逗号不算
  const parts = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of value) {
    if (ch === '"') quote = !quote;
    else if (!quote && ch === '<') depth++;
    else if (!quote && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quote && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => parseAddress(p)).filter((a) => a.address);
}

/* ------------------------------ 主体结构 ------------------------------ */

function findHeaderEnd(bytes) {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      return { headEnd: i, bodyStart: i + 2 };
    }
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      if (bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) {
        return { headEnd: i, bodyStart: i + 4 };
      }
    }
  }
  return { headEnd: bytes.length, bodyStart: bytes.length };
}

function decodeTransfer(bytes, cte) {
  const enc = LOWER(cte || '').trim();
  if (enc === 'base64') return base64ToBytes(latin1(bytes));
  if (enc === 'quoted-printable') return qpToBytes(bytes);
  return bytes;
}

const ATTACH_HINT = /attachment|inline/i;

/**
 * 递归解析一个 MIME 部分
 * @param {Uint8Array} bytes
 * @param {{text:string[],html:string[],attachments:object[],inlineImages:object}} acc
 */
function parsePart(bytes, acc, depth = 0) {
  const { headEnd, bodyStart } = findHeaderEnd(bytes);
  const headers = parseHeaderBlock(latin1(bytes.subarray(0, headEnd)));
  const body = bytes.subarray(bodyStart);
  const ct = parseContentType(getHeader(headers, 'content-type'));
  const cte = getHeader(headers, 'content-transfer-encoding');
  const disp = getHeader(headers, 'content-disposition');
  const dispType = LOWER(disp.split(';')[0]).trim();
  const contentId = getHeader(headers, 'content-id').replace(/^<|>$/g, '').trim();

  if (depth > 12) return; // 防御变态嵌套

  if (ct.type === 'multipart') {
    const boundary = ct.params.boundary;
    if (!boundary) {
      acc.text.push(bytesToText(decodeTransfer(body, cte), ct.params.charset));
      return;
    }
    for (const chunk of splitMultipart(latin1(body), boundary)) {
      if (chunk.length) parsePart(toBytes(chunk), acc, depth + 1);
    }
    return;
  }

  if (ct.type === 'message' && ct.subtype === 'rfc822') {
    // 整封嵌套邮件：当作附件保存
    acc.attachments.push({
      filename: paramName(ct.params) || '未命名.eml',
      contentType: 'message/rfc822',
      contentId,
      data: decodeTransfer(body, cte),
    });
    return;
  }

  const decoded = decodeTransfer(body, cte);
  const filename = paramName(ct.params);

  // 带 Content-ID 的内嵌图片：直接内联进 HTML（转成 data URL），不当作附件
  if (contentId && ct.type === 'image' && dispType !== 'attachment') {
    acc.inlineImages[contentId] = { contentType: ct.fullType, data: decoded };
    return;
  }

  const isAttachment =
    dispType === 'attachment' ||
    (filename && dispType !== 'inline') ||
    (filename && !(ct.type === 'text' && (ct.subtype === 'plain' || ct.subtype === 'html')));

  if (isAttachment) {
    acc.attachments.push({
      filename: filename || '未命名附件',
      contentType: ct.fullType,
      contentId,
      data: decoded,
    });
    return;
  }

  if (ct.type === 'text' && ct.subtype === 'plain' && dispType !== 'attachment') {
    acc.text.push(bytesToText(decoded, ct.params.charset));
    return;
  }
  if (ct.type === 'text' && ct.subtype === 'html' && dispType !== 'attachment') {
    acc.html.push(bytesToText(decoded, ct.params.charset));
    return;
  }
  // 其它类型：作为附件
  if (decoded.length) {
    acc.attachments.push({
      filename: filename || `未命名.${ct.subtype || 'bin'}`,
      contentType: ct.fullType,
      contentId,
      data: decoded,
    });
  }
}

function splitMultipart(bodyText, boundary) {
  const marker = '--' + boundary;
  const chunks = [];
  let idx = bodyText.indexOf(marker);
  if (idx === -1) return chunks;
  while (idx !== -1) {
    let start = idx + marker.length;
    if (bodyText.startsWith('--', start)) break; // 结束标记
    // 跳过标记行剩余部分（含 CRLF）
    const nl = bodyText.indexOf('\n', start);
    if (nl === -1) break;
    start = nl + 1;
    const next = bodyText.indexOf(marker, start);
    if (next === -1) {
      chunks.push(trimTrailingCrlf(bodyText.slice(start)));
      break;
    }
    chunks.push(trimTrailingCrlf(bodyText.slice(start, next)));
    idx = next;
  }
  return chunks;
}

function trimTrailingCrlf(s) {
  return s.replace(/\r?\n$/, '');
}

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 解析整封邮件
 * @param {Uint8Array|ArrayBuffer|string} input
 * @returns {{subject,from,to,cc,date,messageId,text,html,attachments,snippet}}
 */
export function parseMime(input) {
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else bytes = toBytes(String(input));

  const { headEnd } = findHeaderEnd(bytes);
  const headers = parseHeaderBlock(latin1(bytes.subarray(0, headEnd)));

  const acc = { text: [], html: [], attachments: [], inlineImages: {} };
  parsePart(bytes, acc);

  let html = acc.html.join('\n').trim();
  const text = acc.text.join('\n').trim() || (html ? htmlToText(html) : '');
  if (!html && text) html = '';

  // 把 cid: 内嵌图片替换成 data URL
  if (html && Object.keys(acc.inlineImages).length) {
    html = html.replace(/cid:([^"'\s>)]+)/gi, (full, id) => {
      const key = decodeURIComponent(id);
      const img = acc.inlineImages[key] || acc.inlineImages[`<${key}>`];
      if (!img) return full;
      return `data:${img.contentType};base64,${bytesToBase64(img.data)}`;
    });
  }

  const subject = getHeader(headers, 'subject').trim();
  const from = parseAddress(getRawHeader(headers, 'from'));
  const to = parseAddressList(getRawHeader(headers, 'to'));
  const cc = parseAddressList(getRawHeader(headers, 'cc'));
  const dateRaw = getHeader(headers, 'date');
  let date = Date.parse(dateRaw);
  if (!Number.isFinite(date)) date = Date.now();

  return {
    subject: subject || '(无主题)',
    from,
    to,
    cc,
    date,
    messageId: getHeader(headers, 'message-id').replace(/^<|>$/g, '').trim(),
    text,
    html,
    inlineImages: acc.inlineImages,
    attachments: acc.attachments,
    snippet: makeSnippet(text),
  };
}

export function bytesToBase64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64ALPHA[b0 >> 2];
    out += B64ALPHA[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
    out += b1 === undefined ? '=' : B64ALPHA[((b1 & 15) << 2) | ((b2 || 0) >> 6)];
    out += b2 === undefined ? '=' : B64ALPHA[b2 & 63];
  }
  return out;
}

function makeSnippet(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 160);
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


const ASSETS = {"/index.html":"<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#EDF0F7\">\n<title>无限邮箱 · 收件箱</title>\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23627BF6'/%3E%3Cpath d='M14 24h36v20a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z' fill='none' stroke='white' stroke-width='4' stroke-linejoin='round'/%3E%3Cpath d='M14 26l18 12 18-12' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\">\n<link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n\n<svg class=\"sprite\" aria-hidden=\"true\">\n  <symbol id=\"i-inbox\" viewBox=\"0 0 24 24\"><path d=\"M3 13h4.2l1.6 2.6h6.4L16.8 13H21\"/><path d=\"M5.4 4.8h13.2l2.4 7.2V18a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18v-6z\"/></symbol>\n  <symbol id=\"i-plus\" viewBox=\"0 0 24 24\"><path d=\"M12 5.5v13M5.5 12h13\"/></symbol>\n  <symbol id=\"i-copy\" viewBox=\"0 0 24 24\"><rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\"/><path d=\"M5 15V6a2 2 0 0 1 2-2h9\"/></symbol>\n  <symbol id=\"i-trash\" viewBox=\"0 0 24 24\"><path d=\"M4 7h16M9.5 7V5h5v2M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12\"/></symbol>\n  <symbol id=\"i-clip\" viewBox=\"0 0 24 24\"><path d=\"M20 11.5l-7.6 7.6a4.5 4.5 0 0 1-6.4-6.4l7.5-7.5a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.1-2.1l6.9-6.9\"/></symbol>\n  <symbol id=\"i-refresh\" viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.4-5.7\"/><path d=\"M20 4.5v4.2h-4.2\"/></symbol>\n  <symbol id=\"i-search\" viewBox=\"0 0 24 24\"><circle cx=\"11\" cy=\"11\" r=\"6.2\"/><path d=\"M20 20l-4.4-4.4\"/></symbol>\n  <symbol id=\"i-settings\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z\"/></symbol>\n  <symbol id=\"i-logout\" viewBox=\"0 0 24 24\"><path d=\"M14.5 16.8l4.5-4.8-4.5-4.8\"/><path d=\"M19 12H9.2\"/><path d=\"M12 19.2H6.4A2.4 2.4 0 0 1 4 16.8V7.2a2.4 2.4 0 0 1 2.4-2.4H12\"/></symbol>\n  <symbol id=\"i-download\" viewBox=\"0 0 24 24\"><path d=\"M12 4v10.6\"/><path d=\"M8.2 11l3.8 3.8L15.8 11\"/><path d=\"M5 19.5h14\"/></symbol>\n  <symbol id=\"i-check\" viewBox=\"0 0 24 24\"><path d=\"M5 12.8l4.2 4.2L19 6.5\"/></symbol>\n  <symbol id=\"i-mail\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"M3.6 6.8l8.4 6 8.4-6\"/></symbol>\n  <symbol id=\"i-x\" viewBox=\"0 0 24 24\"><path d=\"M6 6l12 12M18 6L6 18\"/></symbol>\n  <symbol id=\"i-menu\" viewBox=\"0 0 24 24\"><path d=\"M4 7h16M4 12h16M4 17h16\"/></symbol>\n  <symbol id=\"i-lock\" viewBox=\"0 0 24 24\"><rect x=\"4.8\" y=\"10.5\" width=\"14.4\" height=\"9.7\" rx=\"2.2\"/><path d=\"M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5\"/></symbol>\n  <symbol id=\"i-pen\" viewBox=\"0 0 24 24\"><path d=\"M4 20h4.2L19 9.2a2.1 2.1 0 0 0 0-3l-1.2-1.2a2.1 2.1 0 0 0-3 0L4 15.8z\"/></symbol>\n  <symbol id=\"i-chevron\" viewBox=\"0 0 24 24\"><path d=\"M9 6l6 6-6 6\"/></symbol>\n  <symbol id=\"i-phone\" viewBox=\"0 0 24 24\"><rect x=\"6.5\" y=\"2.8\" width=\"11\" height=\"18.4\" rx=\"2.4\"/><path d=\"M10.8 18.4h2.4\"/></symbol>\n  <symbol id=\"i-users\" viewBox=\"0 0 24 24\"><circle cx=\"9\" cy=\"8\" r=\"3.4\"/><path d=\"M3.4 20a5.6 5.6 0 0 1 11.2 0\"/><path d=\"M16.4 5.2a3.4 3.4 0 0 1 0 6.6\"/><path d=\"M16.6 13.4a5.6 5.6 0 0 1 4 6.6\"/></symbol>\n  <symbol id=\"i-shield\" viewBox=\"0 0 24 24\"><path d=\"M12 3l7 3v5.4c0 4.3-2.9 7.9-7 9.6-4.1-1.7-7-5.3-7-9.6V6z\"/><path d=\"M9.2 12.2l2 2 3.6-3.8\"/></symbol>\n  <symbol id=\"i-globe\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.6\"/><path d=\"M3.4 12h17.2\"/><path d=\"M12 3.4c2.3 2.3 3.5 5.4 3.5 8.6S14.3 18.3 12 20.6c-2.3-2.3-3.5-5.4-3.5-8.6S9.7 5.7 12 3.4z\"/></symbol>\n</svg>\n\n<!-- ============================ 登录 / 注册 ============================ -->\n<div id=\"login\" class=\"login\" hidden>\n  <div class=\"login-wrap\">\n    <aside class=\"login-hero\">\n      <div class=\"hero-top\">\n        <span class=\"logo-mark\">∞</span>\n        <span class=\"hero-brand\">无限邮箱</span>\n      </div>\n      <div class=\"hero-body\">\n        <p class=\"hero-eyebrow\">一个域名 · 无限个收件地址</p>\n        <h1>一个账号，<br>管住所有注册邮件</h1>\n        <p class=\"hero-desc\">每个账号只占一个主邮箱名，后面用 <b>bili1</b>、<b>bili-shop</b> 这样的子地址就能无限收信，全部归到同一个收件箱。</p>\n        <ul class=\"hero-list\">\n          <li><span class=\"hero-tick\"><svg><use href=\"#i-check\"/></svg></span>主邮箱 + 子地址归并，不再一堆账号</li>\n          <li><span class=\"hero-tick\"><svg><use href=\"#i-check\"/></svg></span>账号之间完全隔离，互不可见</li>\n          <li><span class=\"hero-tick\"><svg><use href=\"#i-check\"/></svg></span>手机号绑定，一人一号</li>\n        </ul>\n      </div>\n      <p class=\"hero-foot\">只收不发 · 数据自持 · 零依赖部署</p>\n    </aside>\n\n    <div class=\"login-card\">\n      <span class=\"logo-mark sm\">∞</span>\n      <div class=\"auth-tabs\">\n        <button type=\"button\" class=\"auth-tab active\" data-tab=\"login\">登录</button>\n        <button type=\"button\" class=\"auth-tab\" data-tab=\"register\">注册</button>\n      </div>\n\n      <form id=\"login-form\" class=\"auth-form\" autocomplete=\"on\">\n        <label class=\"inputbox\">\n          <svg class=\"inputbox-icon\"><use href=\"#i-mail\"/></svg>\n          <input id=\"login-email\" type=\"email\" placeholder=\"QQ 邮箱\" autocomplete=\"username\" required>\n        </label>\n        <label class=\"inputbox\">\n          <svg class=\"inputbox-icon\"><use href=\"#i-lock\"/></svg>\n          <input id=\"login-password\" type=\"password\" placeholder=\"密码\" autocomplete=\"current-password\" required>\n        </label>\n        <button type=\"submit\" class=\"btn btn-primary btn-block\" id=\"login-btn\">登 录</button>\n        <button type=\"button\" class=\"auth-link\" id=\"btn-forgot\">忘记密码？用邮箱验证码找回</button>\n        <p class=\"login-hint\" id=\"login-hint\">首次登录：root 账号是 <code id=\"hint-root\">admin</code>，密码是部署时设置的 <code>ACCESS_TOKEN</code>。</p>\n      </form>\n\n      <form id=\"register-form\" class=\"auth-form\" autocomplete=\"on\" hidden>\n        <label class=\"inputbox\">\n          <svg class=\"inputbox-icon\"><use href=\"#i-mail\"/></svg>\n          <input id=\"reg-email\" type=\"email\" placeholder=\"QQ 邮箱，如 123456@qq.com\" autocomplete=\"username\" required>\n        </label>\n        <div class=\"verify-block\">\n          <button type=\"button\" class=\"btn btn-ghost btn-block\" id=\"reg-verify-btn\">① 发送验证码</button>\n          <div class=\"verify-panel\" id=\"reg-verify-panel\" hidden>\n            <p class=\"verify-tip\" id=\"reg-verify-tip\">验证码已发到你的邮箱，把邮件里的 <b>6 位数字</b>填进来：</p>\n            <div class=\"verify-code-row\" id=\"reg-code-row\">\n              <input id=\"reg-code\" inputmode=\"numeric\" maxlength=\"6\" placeholder=\"6 位验证码\" autocomplete=\"one-time-code\">\n              <button type=\"button\" class=\"btn btn-primary btn-sm\" id=\"reg-code-btn\">确认</button>\n            </div>\n            <p class=\"verify-state\" id=\"reg-verify-state\">验证码 10 分钟内有效</p>\n            <button type=\"button\" class=\"btn btn-ghost btn-sm\" id=\"reg-code-resend\">没收到？重新发送</button>\n          </div>\n        </div>\n        <label class=\"inputbox\">\n          <svg class=\"inputbox-icon\"><use href=\"#i-lock\"/></svg>\n          <input id=\"reg-password\" type=\"password\" placeholder=\"密码（至少 8 位）\" autocomplete=\"new-password\" required>\n        </label>\n        <label class=\"inputbox\">\n          <svg class=\"inputbox-icon\"><use href=\"#i-lock\"/></svg>\n          <input id=\"reg-password2\" type=\"password\" placeholder=\"再输一次密码\" autocomplete=\"new-password\" required>\n        </label>\n        <label class=\"inputbox mailbox-box\">\n          <input id=\"reg-mailbox\" placeholder=\"想要的邮箱名，如 bili\" autocomplete=\"off\" required>\n          <span class=\"inputbox-suffix\" id=\"reg-domain\">@example.com</span>\n        </label>\n        <label class=\"inputbox\">\n          <svg class=\"inputbox-icon\"><use href=\"#i-phone\"/></svg>\n          <input id=\"reg-phone\" inputmode=\"numeric\" placeholder=\"手机号（可选，11 位）\" autocomplete=\"tel\">\n        </label>\n        <label class=\"agree\"><input type=\"checkbox\" id=\"reg-agree\"> 我已阅读并同意服务条款与隐私政策</label>\n        <button type=\"submit\" class=\"btn btn-primary btn-block\" id=\"register-btn\">创建账号</button>\n        <p class=\"login-hint\" id=\"register-hint\">注册后这个邮箱名就是你的主邮箱；bili1、bili-shop 等子地址自动归到它下面。</p>\n      </form>\n    </div>\n  </div>\n</div>\n\n<!-- ============================ 找回密码 ============================ -->\n<dialog id=\"reset-dialog\" class=\"dialog\">\n  <form id=\"reset-form\">\n    <div class=\"dialog-head\">\n      <h3>找回密码</h3>\n      <button type=\"button\" class=\"icon-btn\" id=\"btn-close-reset\"><svg><use href=\"#i-x\"/></svg></button>\n    </div>\n    <div class=\"dialog-body\">\n      <label class=\"field\">\n        <span>登录邮箱</span>\n        <input id=\"reset-email\" type=\"email\" placeholder=\"注册时用的 QQ 邮箱\" autocomplete=\"username\">\n      </label>\n      <div class=\"rebind-line\">\n        <button type=\"button\" class=\"btn btn-ghost btn-sm\" id=\"reset-send\">发送验证码</button>\n        <span class=\"verify-state\" id=\"reset-state\">验证码 10 分钟内有效</span>\n      </div>\n      <label class=\"field\">\n        <span>验证码</span>\n        <input id=\"reset-code\" inputmode=\"numeric\" maxlength=\"6\" placeholder=\"邮件里的 6 位数字\" autocomplete=\"one-time-code\">\n      </label>\n      <label class=\"field\">\n        <span>新密码</span>\n        <input id=\"reset-password\" type=\"password\" placeholder=\"至少 8 位\" autocomplete=\"new-password\">\n      </label>\n      <div class=\"dialog-info\" id=\"reset-info\"></div>\n    </div>\n    <div class=\"dialog-foot\">\n      <button type=\"button\" class=\"btn btn-ghost\" id=\"btn-cancel-reset\">取消</button>\n      <button type=\"submit\" class=\"btn btn-primary\" id=\"reset-submit\">重设密码</button>\n    </div>\n  </form>\n</dialog>\n\n<!-- ============================ 主界面 ============================ -->\n<div id=\"app\" class=\"app\" hidden>\n  <header class=\"topbar\">\n    <button class=\"icon-btn only-mobile\" id=\"btn-menu\" title=\"邮箱列表\"><svg><use href=\"#i-menu\"/></svg></button>\n\n    <div class=\"brand\">\n      <span class=\"brand-mark\">∞</span>\n      <span class=\"brand-name\">无限邮箱</span>\n    </div>\n\n    <div class=\"account\">\n      <span class=\"user-chip\" id=\"user-chip\">\n        <span class=\"user-avatar\" id=\"user-avatar\">U</span>\n        <span class=\"user-meta\">\n          <b id=\"user-name\">—</b>\n          <small id=\"user-mail\">—</small>\n        </span>\n      </span>\n    </div>\n\n    <div class=\"topbar-right\">\n      <div class=\"searchbox\">\n        <svg class=\"searchbox-icon\"><use href=\"#i-search\"/></svg>\n        <input id=\"search\" type=\"search\" placeholder=\"搜索发件人、主题、内容\" autocomplete=\"off\">\n      </div>\n      <div class=\"topbar-actions\">\n        <button class=\"icon-btn\" id=\"btn-admin\" title=\"管理后台\" hidden><svg><use href=\"#i-shield\"/></svg></button>\n        <button class=\"icon-btn\" id=\"btn-refresh\" title=\"刷新\"><svg><use href=\"#i-refresh\"/></svg></button>\n        <button class=\"icon-btn\" id=\"btn-settings\" title=\"账号设置\"><svg><use href=\"#i-settings\"/></svg></button>\n        <button class=\"icon-btn\" id=\"btn-logout\" title=\"退出登录\"><svg><use href=\"#i-logout\"/></svg></button>\n      </div>\n    </div>\n  </header>\n\n  <div class=\"shell\">\n    <aside class=\"sidebar\" id=\"sidebar\">\n      <button class=\"side-cta\" id=\"btn-new-mailbox\" type=\"button\">\n        <svg><use href=\"#i-plus\"/></svg>\n        <span>新建邮箱</span>\n      </button>\n\n      <nav class=\"side-nav\">\n        <button class=\"nav-item active\" id=\"all-mail\" data-mailbox=\"\">\n          <svg class=\"nav-ico\"><use href=\"#i-inbox\"/></svg>\n          <span class=\"nav-label\">全部邮件</span>\n          <span class=\"nav-count\" id=\"unread-all\">0</span>\n        </button>\n      </nav>\n\n      <div class=\"side-section\">\n        <div class=\"side-section-head\">\n          <span>我的邮箱</span>\n          <span class=\"pill\" id=\"mailbox-count\">0</span>\n        </div>\n        <div class=\"mailbox-list\" id=\"mailbox-list\"></div>\n      </div>\n\n      <div class=\"side-section side-section--ext\" id=\"ext-section\">\n        <div class=\"side-section-head\">\n          <span>一邮多用</span>\n          <button class=\"link-btn\" id=\"btn-add-external\" type=\"button\">+ 接入</button>\n        </div>\n        <div class=\"ext-list\" id=\"ext-list\"></div>\n      </div>\n\n      <div class=\"sidebar-foot\">\n        <div class=\"foot-row\"><span>邮件总数</span><b id=\"stat-messages\">0</b></div>\n        <div class=\"foot-row\"><span>子地址</span><b id=\"stat-subs\">0</b></div>\n        <div class=\"foot-row\"><span>占用空间</span><b id=\"stat-bytes\">0 B</b></div>\n      </div>\n    </aside>\n\n    <main class=\"workspace\">\n      <div class=\"panes\">\n        <section class=\"list\" id=\"list\">\n          <div class=\"list-head\">\n            <div class=\"list-title-wrap\">\n              <h2 id=\"list-title\">全部邮件</h2>\n              <span class=\"list-sub\" id=\"list-sub\">0 封</span>\n            </div>\n            <div class=\"list-head-actions\">\n              <button class=\"tool-btn\" id=\"btn-read-all\">全部已读</button>\n              <button class=\"tool-btn only-mobile\" id=\"btn-close-list\">关闭</button>\n            </div>\n          </div>\n          <div class=\"list-body\" id=\"list-body\">\n            <div id=\"list-rows\"></div>\n            <div class=\"empty\" id=\"list-empty\" hidden>\n              <div class=\"empty-art\">\n                <svg><use href=\"#i-mail\"/></svg>\n              </div>\n              <p class=\"empty-title\">这里还没有邮件</p>\n              <p class=\"empty-sub\">把收件地址填到注册表单里，验证码和通知就会出现在这里。</p>\n            </div>\n          </div>\n        </section>\n\n        <section class=\"reader\" id=\"reader\">\n          <div class=\"reader-empty\" id=\"reader-empty\">\n            <div class=\"reader-empty-art\">\n              <svg><use href=\"#i-mail\"/></svg>\n            </div>\n            <h2>选择一封邮件开始阅读</h2>\n            <p>邮件收到后会自动出现在左侧列表，并通过浏览器实时推送，无需手动刷新。</p>\n            <div class=\"reader-address\" id=\"reader-address-box\">\n              <code id=\"reader-address\">未设置邮箱</code>\n              <button class=\"btn btn-ghost btn-sm\" id=\"btn-copy-default\"><svg><use href=\"#i-copy\"/></svg> 复制</button>\n            </div>\n            <ol class=\"reader-steps\">\n              <li>账号自带一个主邮箱，例如 <code>bili@example.com</code>。</li>\n              <li>任意 <code>bili1@</code> / <code>bili-shop@</code> 也会投递到同一个收件箱，自动记为子地址。</li>\n              <li>验证码、登录链接、订阅通知都进这里，子地址随时可以删。</li>\n            </ol>\n          </div>\n\n          <article class=\"reader-article\" id=\"reader-article\" hidden>\n            <div class=\"reader-toolbar\">\n              <button class=\"tool-btn\" id=\"btn-eml\" title=\"下载原始邮件 .eml\"><svg><use href=\"#i-download\"/></svg>下载 .eml</button>\n              <button class=\"tool-btn is-danger\" id=\"btn-delete\" title=\"删除这封邮件\"><svg><use href=\"#i-trash\"/></svg>删除</button>\n              <span class=\"tool-spacer\"></span>\n              <button class=\"tool-btn only-mobile\" id=\"btn-close-reader\"><svg><use href=\"#i-x\"/></svg>关闭</button>\n            </div>\n\n            <header class=\"reader-head\">\n              <h2 class=\"reader-subject\" id=\"reader-subject\"></h2>\n              <div class=\"reader-ext\" id=\"reader-ext\" hidden></div>\n              <div class=\"meta-rows\">\n                <div class=\"meta-row\">\n                  <span class=\"meta-label\">发件人</span>\n                  <span class=\"meta-value\"><b id=\"reader-from-name\"></b><span class=\"meta-addr\" id=\"reader-from-addr\"></span></span>\n                </div>\n                <div class=\"meta-row\">\n                  <span class=\"meta-label\">收件人</span>\n                  <span class=\"meta-value\"><span id=\"reader-to\"></span></span>\n                </div>\n                <div class=\"meta-row\">\n                  <span class=\"meta-label\">时间</span>\n                  <span class=\"meta-value\"><span id=\"reader-date\"></span></span>\n                </div>\n              </div>\n            </header>\n\n            <div class=\"attachments\" id=\"attachments\" hidden></div>\n\n            <div class=\"reader-body\" id=\"reader-body\">\n              <iframe id=\"mail-frame\" class=\"mail-frame\" sandbox=\"allow-popups allow-popups-to-escape-sandbox\" referrerpolicy=\"no-referrer\" title=\"邮件内容\"></iframe>\n              <pre id=\"mail-text\" class=\"mail-text\" hidden></pre>\n            </div>\n          </article>\n        </section>\n      </div>\n    </main>\n  </div>\n</div>\n\n<!-- ============================ 管理后台 ============================ -->\n<div id=\"admin\" class=\"admin\" hidden>\n  <header class=\"admin-head\">\n    <div class=\"admin-title\">\n      <span class=\"admin-badge\"><svg><use href=\"#i-shield\"/></svg></span>\n      <div>\n        <h1>管理后台</h1>\n        <p id=\"admin-sub\">用户、邮箱、域名与全局开关</p>\n      </div>\n    </div>\n    <div class=\"admin-head-actions\">\n      <button class=\"btn btn-ghost\" id=\"btn-admin-refresh\"><svg><use href=\"#i-refresh\"/></svg>刷新</button>\n      <button class=\"btn btn-ghost\" id=\"btn-admin-back\"><svg><use href=\"#i-x\"/></svg>返回收件箱</button>\n    </div>\n  </header>\n\n  <div class=\"admin-body\">\n    <div class=\"stat-grid\" id=\"admin-stats\"></div>\n\n    <section class=\"admin-card\">\n      <div class=\"admin-card-head\">\n        <h2>用户</h2>\n        <div class=\"admin-search\">\n          <svg><use href=\"#i-search\"/></svg>\n          <input id=\"admin-user-search\" placeholder=\"搜邮箱 / 手机号 / 昵称\" autocomplete=\"off\">\n        </div>\n      </div>\n      <div class=\"admin-table-wrap\">\n        <table class=\"admin-table\" id=\"admin-users\">\n          <thead>\n            <tr>\n              <th>用户</th><th>手机号</th><th>主邮箱</th><th>邮件</th><th>状态</th><th>最后登录</th><th class=\"ta-r\">操作</th>\n            </tr>\n          </thead>\n          <tbody id=\"admin-user-rows\"></tbody>\n        </table>\n      </div>\n    </section>\n\n    <div class=\"admin-two\">\n      <section class=\"admin-card\">\n        <div class=\"admin-card-head\"><h2>域名</h2></div>\n        <div id=\"admin-domains\" class=\"admin-domains\"></div>\n        <form class=\"domain-add\" id=\"admin-domain-form\">\n          <input id=\"admin-domain-input\" placeholder=\"加一个域名，如 mail.example.com\" autocomplete=\"off\">\n          <button class=\"btn btn-ghost btn-sm\" type=\"submit\">添加</button>\n        </form>\n      </section>\n\n      <section class=\"admin-card\">\n        <div class=\"admin-card-head\"><h2>全局开关</h2></div>\n        <div class=\"switch-list\">\n          <label class=\"switch-row\">\n            <span><b>子地址自动创建</b><small>收到 bili-shop@ 时自动登记成子地址</small></span>\n            <input type=\"checkbox\" id=\"cfg-subauto\">\n          </label>\n          <label class=\"switch-row\">\n            <span><b>仅允许 QQ 邮箱注册</b><small>关闭后任意邮箱都能注册</small></span>\n            <input type=\"checkbox\" id=\"cfg-requireqq\">\n          </label>\n          <label class=\"switch-row\">\n            <span><b>未登记地址进 root 收件箱</b><small>任何人发到 xxx@域名（没建过的地址）都进 root 的「未登记地址」箱，不会被静默丢掉</small></span>\n            <input type=\"checkbox\" id=\"cfg-catchall\">\n          </label>\n          <label class=\"switch-row\">\n            <span><b>手机号短信验证</b><small>短信通道未接入，开启后注册仍需人工审核</small></span>\n            <input type=\"checkbox\" id=\"cfg-sms\">\n          </label>\n          <label class=\"switch-row\">\n            <span><b>自动清理天数</b><small>0 表示永久保留</small></span>\n            <input type=\"number\" id=\"cfg-keep\" min=\"0\" max=\"3650\" step=\"1\" class=\"num-input\">\n          </label>\n        </div>\n        <div class=\"admin-card-foot\">\n          <button class=\"btn btn-primary btn-sm\" id=\"btn-save-config\">保存开关</button>\n        </div>\n        <div class=\"dropped-list\" id=\"dropped-list\" hidden>\n          <div class=\"dropped-head\">被丢弃的信（关掉上面的开关才会有）<span class=\"pill\" id=\"dropped-count\">0</span></div>\n          <div id=\"dropped-rows\"></div>\n        </div>\n      </section>\n    </div>\n  </div>\n</div>\n\n<!-- ============================ 账号设置 ============================ -->\n<dialog id=\"settings-dialog\" class=\"dialog\">\n  <form id=\"settings-form\">\n    <div class=\"dialog-head\">\n      <h3>账号设置</h3>\n      <button type=\"button\" class=\"icon-btn\" id=\"btn-close-settings\"><svg><use href=\"#i-x\"/></svg></button>\n    </div>\n\n    <div class=\"dialog-body\">\n      <div class=\"field\">\n        <span>登录邮箱</span>\n        <div class=\"bind-row\">\n          <input id=\"set-email\" disabled>\n          <button type=\"button\" class=\"btn btn-ghost btn-sm\" id=\"btn-rebind-email\">换绑</button>\n        </div>\n        <small>换绑要先用新邮箱发一封确认信，防止填错别人的地址。</small>\n        <div class=\"rebind-panel\" id=\"panel-email\" hidden>\n          <input id=\"set-new-email\" type=\"email\" placeholder=\"新的 QQ 邮箱\" autocomplete=\"off\">\n          <div class=\"rebind-line\">\n            <button type=\"button\" class=\"btn btn-ghost btn-sm\" id=\"btn-verify-newemail\">① 发送验证码</button>\n          </div>\n          <div class=\"verify-code-row\" id=\"newemail-code-row\">\n            <input id=\"newemail-code\" inputmode=\"numeric\" maxlength=\"6\" placeholder=\"邮件里的 6 位验证码\" autocomplete=\"one-time-code\">\n            <button type=\"button\" class=\"btn btn-primary btn-sm\" id=\"newemail-code-btn\">确认验证码</button>\n          </div>\n          <p class=\"verify-state\" id=\"newemail-state\">先把验证码发到新邮箱，再填进来</p>\n          <input id=\"set-email-password\" type=\"password\" placeholder=\"当前密码，确认是本人\" autocomplete=\"current-password\">\n          <div class=\"rebind-line\">\n            <button type=\"button\" class=\"btn btn-primary btn-sm\" id=\"btn-save-email\">确认换绑</button>\n            <button type=\"button\" class=\"btn btn-ghost btn-sm\" id=\"btn-cancel-email\">取消</button>\n          </div>\n        </div>\n      </div>\n      <label class=\"field\">\n        <span>昵称</span>\n        <input id=\"set-nickname\" maxlength=\"24\" placeholder=\"显示在左上角的名字\">\n      </label>\n      <div class=\"field\">\n        <span>手机号</span>\n        <div class=\"bind-row\">\n          <input id=\"set-phone\" disabled placeholder=\"未绑定\">\n          <button type=\"button\" class=\"btn btn-ghost btn-sm\" id=\"btn-rebind-phone\">换绑</button>\n        </div>\n        <small>一人一号，用于找回账号；短信验证通道接通后会改为验证码校验。</small>\n        <div class=\"rebind-panel\" id=\"panel-phone\" hidden>\n          <input id=\"set-new-phone\" inputmode=\"numeric\" placeholder=\"新的 11 位手机号（留空 = 解绑）\" autocomplete=\"off\">\n          <input id=\"set-phone-password\" type=\"password\" placeholder=\"当前密码，确认是本人\" autocomplete=\"current-password\">\n          <div class=\"rebind-line\">\n            <button type=\"button\" class=\"btn btn-primary btn-sm\" id=\"btn-save-phone\">确认换绑</button>\n            <button type=\"button\" class=\"btn btn-ghost btn-sm\" id=\"btn-cancel-phone\">取消</button>\n          </div>\n        </div>\n      </div>\n      <div class=\"field\">\n        <span>修改密码（不改就留空）</span>\n        <input id=\"set-old-password\" type=\"password\" placeholder=\"原密码\" autocomplete=\"current-password\">\n        <input id=\"set-new-password\" type=\"password\" placeholder=\"新密码，至少 8 位\" autocomplete=\"new-password\" style=\"margin-top:8px\">\n      </div>\n      <div class=\"dialog-info\" id=\"dialog-info\"></div>\n    </div>\n\n    <div class=\"dialog-foot\">\n      <button type=\"button\" class=\"btn btn-ghost\" id=\"btn-cancel-settings\">取消</button>\n      <button type=\"submit\" class=\"btn btn-primary\">保存</button>\n    </div>\n  </form>\n</dialog>\n\n<!-- 新建邮箱 -->\n<dialog id=\"newbox-dialog\" class=\"dialog\">\n  <form id=\"newbox-form\">\n    <div class=\"dialog-head\">\n      <h3>新建邮箱</h3>\n      <button type=\"button\" class=\"icon-btn\" id=\"btn-close-newbox\"><svg><use href=\"#i-x\"/></svg></button>\n    </div>\n    <div class=\"dialog-body\">\n      <div class=\"seg\" role=\"radiogroup\" aria-label=\"类型\">\n        <label class=\"seg-item\"><input type=\"radio\" name=\"newbox-mode\" value=\"sub\" checked><span>子地址</span></label>\n        <label class=\"seg-item\"><input type=\"radio\" name=\"newbox-mode\" value=\"main\"><span>主邮箱</span></label>\n      </div>\n      <label class=\"field\">\n        <span>名字</span>\n        <div class=\"inputbox\">\n          <input id=\"newbox-name\" placeholder=\"例如 shop\" autocomplete=\"off\">\n          <span class=\"inputbox-suffix\" id=\"newbox-domain\">@example.com</span>\n        </div>\n        <div class=\"addr-preview\">完整地址：<b id=\"newbox-preview\">—</b></div>\n        <small class=\"field-hint\" id=\"newbox-hint\">子地址会自动归到主邮箱的收件箱；填 <code>shop</code> 就是 <code>bili-shop@example.com</code>。</small>\n      </label>\n      <div class=\"dialog-info\" id=\"newbox-info\"></div>\n    </div>\n    <div class=\"dialog-foot\">\n      <button type=\"button\" class=\"btn btn-ghost\" id=\"btn-cancel-newbox\">取消</button>\n      <button type=\"submit\" class=\"btn btn-primary\" id=\"newbox-submit\">创建</button>\n    </div>\n  </form>\n</dialog>\n\n<div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\" popover=\"manual\"></div>\n<div class=\"scrim\" id=\"scrim\" hidden></div>\n\n<!-- 一邮多用：把 QQ / Gmail / 163 等外部邮箱的来信转发进来 -->\n<dialog id=\"ext-dialog\" class=\"dialog\">\n  <form id=\"ext-form\">\n    <div class=\"dialog-head\">\n      <h3>接入外部邮箱</h3>\n      <button type=\"button\" class=\"icon-btn\" id=\"btn-close-ext\"><svg><use href=\"#i-x\"/></svg></button>\n    </div>\n    <div class=\"dialog-body\">\n      <div class=\"ext-intro\">\n        在你的 QQ 邮箱 / Gmail / 163 里打开「自动转发」，把地址指向下面生成的专用收件地址，\n        它们的来信就会和本站邮件一起躺在这一个收件箱里，按来源打标签。\n      </div>\n      <label class=\"field\">\n        <span>邮箱类型</span>\n        <select id=\"ext-provider\" class=\"select\"></select>\n      </label>\n      <label class=\"field\">\n        <span>外部邮箱地址</span>\n        <input id=\"ext-address\" type=\"email\" placeholder=\"例如 123456@qq.com\" autocomplete=\"off\">\n      </label>\n      <label class=\"field\">\n        <span>备注（可选）</span>\n        <input id=\"ext-label\" maxlength=\"24\" placeholder=\"例如 私人 QQ、公司邮箱\">\n      </label>\n      <div class=\"dialog-info\" id=\"ext-info\"></div>\n      <div class=\"ext-tip\" id=\"ext-tip\"></div>\n      <div class=\"ext-existing\">\n        <div class=\"ext-existing-head\">已接入</div>\n        <div id=\"ext-rows\"></div>\n      </div>\n    </div>\n    <div class=\"dialog-foot\">\n      <button type=\"button\" class=\"btn btn-ghost\" id=\"btn-cancel-ext\">关闭</button>\n      <button type=\"submit\" class=\"btn btn-primary\">生成收件地址</button>\n    </div>\n  </form>\n</dialog>\n\n<script type=\"module\" src=\"app.js\"></script>\n</body>\n</html>\n","/app.js":"// ============================================================================\n//  app.js —— 多用户版收件箱前端\n//  · 登录 / 注册（QQ 邮箱 + 密码 + 手机号）\n//  · 侧栏：全部邮件 / 主邮箱 / 子地址，按用户隔离\n//  · 一邮多用：把 QQ / Gmail / 163 等外部邮箱的来信转发进来，按来源打标签\n//  · 管理后台：用户、域名、全局开关（仅 root / admin 可见）\n// ============================================================================\n\nconst $ = (sel, root = document) => root.querySelector(sel);\nconst $$ = (sel, root = document) => [...root.querySelectorAll(sel)];\n\nconst state = {\n  user: null,\n  config: {},\n  mailboxes: [],\n  mailboxId: '',\n  alias: '',\n  messages: [],\n  current: null,\n  q: '',\n  stats: {},\n  externals: [],\n  providers: [],\n  admin: { users: [], stats: {}, domains: [], config: {}, dropped: [], q: '', loaded: false },\n};\n\nconst EXT_SHORT = {\n  qq: 'QQ',\n  foxmail: 'Foxmail',\n  gmail: 'Gmail',\n  '163': '163',\n  '126': '126',\n  tencent: '腾讯',\n  outlook: 'Outlook',\n  icloud: 'iCloud',\n  other: '外部',\n};\nconst extShort = (key) => EXT_SHORT[key] || '外部';\n\n/* ------------------------------ 网络 ------------------------------ */\n\nasync function api(path, { method = 'GET', body, raw = false } = {}) {\n  const res = await fetch(path, {\n    method,\n    credentials: 'same-origin',\n    headers: body ? { 'content-type': 'application/json' } : undefined,\n    body: body ? JSON.stringify(body) : undefined,\n  });\n  if (raw) return res;\n  const data = await res.json().catch(() => ({}));\n  if (!res.ok || data.ok === false) {\n    const err = new Error(data.error || `请求失败（${res.status}）`);\n    err.status = res.status;\n    throw err;\n  }\n  return data;\n}\n\n/* ------------------------------ 小工具 ------------------------------ */\n\nconst esc = (s) =>\n  String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n\nfunction fmtBytes(n) {\n  const v = Number(n) || 0;\n  if (v < 1024) return `${v} B`;\n  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;\n  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;\n  return `${(v / 1024 ** 3).toFixed(2)} GB`;\n}\n\nfunction fmtTime(ts) {\n  if (!ts) return '';\n  const d = new Date(Number(ts));\n  const now = new Date();\n  const sameDay = d.toDateString() === now.toDateString();\n  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;\n  if (sameDay) return hm;\n  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;\n  if (d.getFullYear() === now.getFullYear()) return md;\n  return `${d.getFullYear()}-${md}`;\n}\n\nfunction fmtFull(ts) {\n  if (!ts) return '';\n  const d = new Date(Number(ts));\n  const p = (n) => String(n).padStart(2, '0');\n  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;\n}\n\nconst PALETTE = ['#627BF6', '#2BA471', '#F0982E', '#E45C8B', '#7C5CE4', '#22A6B3', '#D8643C', '#4C7EE0'];\nfunction colorFor(text) {\n  const s = String(text || '?');\n  let h = 0;\n  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;\n  return PALETTE[Math.abs(h) % PALETTE.length];\n}\nconst initialOf = (s) => {\n  const t = String(s || '?').trim();\n  return (t[0] || '?').toUpperCase();\n};\n\nlet toastTimer = 0;\nlet toastHideTimer = 0;\nfunction toast(msg, kind = 'ok', ms = 3200) {\n  const el = $('#toast');\n  el.textContent = msg;\n  el.dataset.kind = kind;\n  clearTimeout(toastTimer);\n  clearTimeout(toastHideTimer);\n  try {\n    if (!el.matches(':popover-open')) el.showPopover();\n  } catch {\n    /* 老浏览器没有 popover，退回普通定位 */\n  }\n  el.classList.add('show');\n  toastTimer = setTimeout(() => {\n    el.classList.remove('show');\n    toastHideTimer = setTimeout(() => {\n      try {\n        if (el.matches(':popover-open')) el.hidePopover();\n      } catch {\n        /* 忽略 */\n      }\n    }, 240);\n  }, ms);\n}\n\nconst setHint = (id, text, kind = '') => {\n  const el = $(id);\n  if (!el) return;\n  el.textContent = text;\n  el.dataset.kind = kind;\n};\n\nconst clearHint = (id) => setHint(id, '', '');\n\n/** 把一组输入框清空（对话框关闭、退出登录时用） */\nfunction resetFields(sel, { keep = [] } = {}) {\n  $$(sel).forEach((el) => {\n    if (keep.includes(el.id)) return;\n    if (el.type === 'checkbox') el.checked = false;\n    else if (el.type === 'radio') return;\n    else el.value = '';\n  });\n}\n\n/* ------------------------------ 登录 / 注册 ------------------------------ */\n\nfunction switchTab(which) {\n  $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === which));\n  $('#login-form').hidden = which !== 'login';\n  $('#register-form').hidden = which !== 'register';\n  if (which !== 'register') stopVerifyPoll();\n}\n\nasync function doLogin(ev) {\n  ev.preventDefault();\n  const btn = $('#login-btn');\n  const email = $('#login-email').value.trim();\n  const password = $('#login-password').value;\n  if (!email || !password) {\n    toast('邮箱和密码都要填', 'error');\n    return;\n  }\n  btn.disabled = true;\n  btn.textContent = '登录中…';\n  clearHint('#login-hint');\n  try {\n    await api('/api/auth/login', { method: 'POST', body: { email, password } });\n    $('#login-password').value = '';\n    await boot();\n  } catch (err) {\n    $('#login-password').value = '';\n    $('#login-password').focus();\n    setHint('#login-hint', err.message, 'error');\n    toast(err.message, 'error');\n  } finally {\n    btn.disabled = false;\n    btn.textContent = '登 录';\n  }\n}\n\nasync function doRegister(ev) {\n  ev.preventDefault();\n  const btn = $('#register-btn');\n  const email = $('#reg-email').value.trim();\n  const password = $('#reg-password').value;\n  const password2 = $('#reg-password2').value;\n  const payload = {\n    email,\n    password,\n    phone: $('#reg-phone').value.replace(/\\s/g, ''),\n    mailbox: $('#reg-mailbox').value.trim(),\n    token: regVerify.token || '',\n  };\n  if (!regVerify.token || regVerify.email !== email.toLowerCase()) {\n    toast('请先点「① 发送验证码」并填对验证码', 'error');\n    setHint('#register-hint', '还没验证邮箱：点上面那个按钮，收 6 位验证码填进来。', 'error');\n    return;\n  }\n  if (password.length < 8) {\n    toast('密码至少 8 位', 'error');\n    setHint('#register-hint', '密码至少 8 位', 'error');\n    $('#reg-password').focus();\n    return;\n  }\n  if (password !== password2) {\n    toast('两次输入的密码不一样', 'error');\n    setHint('#register-hint', '两次输入的密码不一样，重新输一次', 'error');\n    $('#reg-password2').value = '';\n    $('#reg-password2').focus();\n    return;\n  }\n  if (!$('#reg-agree').checked) return setHint('#register-hint', '请先勾选同意服务条款', 'error');\n  btn.disabled = true;\n  btn.textContent = '创建中…';\n  try {\n    await api('/api/auth/register', { method: 'POST', body: payload });\n    regVerify = { token: '', email: '', timer: 0 };\n    await boot();\n    toast('账号创建成功，欢迎使用');\n  } catch (err) {\n    setHint('#register-hint', err.message, 'error');\n    toast(err.message, 'error');\n  } finally {\n    btn.disabled = false;\n    btn.textContent = '创建账号';\n  }\n}\n\n/* ---------- 注册前：证明 QQ 邮箱是你的 ---------- */\n\nlet regVerify = { token: '', email: '', timer: 0 };\n\nfunction stopVerifyPoll() {\n  if (regVerify.timer) clearInterval(regVerify.timer);\n  regVerify.timer = 0;\n}\n\nasync function startVerify() {\n  const email = $('#reg-email').value.trim();\n  if (!email) {\n    toast('先填 QQ 邮箱', 'error');\n    $('#reg-email').focus();\n    return;\n  }\n  const btn = $('#reg-verify-btn');\n  btn.disabled = true;\n  btn.textContent = '发送中…';\n  try {\n    const data = await api('/api/auth/verify/start', { method: 'POST', body: { email } });\n    regVerify = { token: data.token, email: email.toLowerCase(), timer: 0, mode: 'code' };\n    $('#reg-verify-panel').hidden = false;\n    $('#reg-verify-panel').classList.remove('is-ok', 'is-expired');\n    $('#reg-code-row').hidden = false;\n    $('#reg-code').value = '';\n    $('#reg-verify-tip').innerHTML = `验证码已经发到 <b>${esc(data.sentTo || email)}</b>，把邮件里的 <b>6 位数字</b>填进来：`;\n    setHint('#reg-verify-state', '验证码 10 分钟内有效，没收到就点下面的重新发送');\n    btn.hidden = true;\n    clearHint('#register-hint');\n    stopVerifyPoll();\n    startResendCooldown();\n    toast(data.hint || '验证码已发送，去查收邮件');\n    $('#reg-code').focus();\n  } catch (err) {\n    toast(err.message, 'error');\n    setHint('#register-hint', err.message, 'error');\n    btn.disabled = false;\n    btn.textContent = '① 发送验证码';\n  }\n}\n\n/* 重发冷却：60 秒后才能再点 */\nfunction startResendCooldown() {\n  const btn = $('#reg-code-resend');\n  if (!btn) return;\n  let left = 60;\n  btn.disabled = true;\n  btn.textContent = `${left} 秒后可重新发送`;\n  clearInterval(startResendCooldown.timer);\n  startResendCooldown.timer = setInterval(() => {\n    left -= 1;\n    if (left <= 0) {\n      clearInterval(startResendCooldown.timer);\n      btn.disabled = false;\n      btn.textContent = '没收到？重新发送';\n      return;\n    }\n    btn.textContent = `${left} 秒后可重新发送`;\n  }, 1000);\n}\n\n/* 填验证码确认（走发信通道时用这条） */\nasync function confirmVerifyCode() {\n  const code = $('#reg-code').value.replace(/\\D/g, '');\n  if (code.length !== 6) {\n    toast('验证码是 6 位数字', 'error');\n    $('#reg-code').focus();\n    return;\n  }\n  try {\n    const data = await api('/api/auth/verify/confirm', {\n      method: 'POST',\n      body: { token: regVerify.token, code },\n    });\n    if (data.verified) {\n      stopVerifyPoll();\n      $('#reg-verify-panel').classList.add('is-ok');\n      $('#reg-verify-state').textContent = '✅ 邮箱已验证，继续填下面的信息';\n      $('#reg-code-row').hidden = true;\n      toast('邮箱验证通过');\n      if ($('#reg-done')) $('#reg-done').hidden = false;\n      $('#reg-password')?.focus();\n    }\n  } catch (err) {\n    toast(err.message, 'error');\n    setHint('#reg-verify-state', err.message, 'error');\n  }\n}\n\nasync function checkVerify() {\n  if (!regVerify.token) return stopVerifyPoll();\n  try {\n    const data = await api(`/api/auth/verify/status?token=${encodeURIComponent(regVerify.token)}`);\n    if (data.verified) {\n      stopVerifyPoll();\n      $('#reg-verify-panel').classList.add('is-ok');\n      $('#reg-verify-state').textContent = '✅ 邮箱已验证，继续填下面的信息';\n      toast('邮箱验证通过');\n      $('#reg-password').focus();\n    } else if (data.expired) {\n      stopVerifyPoll();\n      $('#reg-verify-panel').classList.add('is-expired');\n      $('#reg-verify-state').textContent = '验证已过期，重新点上面的按钮再来一次';\n      const btn = $('#reg-verify-btn');\n      btn.hidden = false;\n      btn.disabled = false;\n      btn.textContent = '① 先验证这个邮箱是我的';\n      regVerify = { token: '', email: '', timer: 0 };\n    }\n  } catch {\n    /* 网络抖动：下次轮询再说 */\n  }\n}\n\nasync function logout() {\n  try {\n    await api('/api/auth/logout', { method: 'POST' });\n  } catch {\n    /* 忽略 */\n  }\n  state.user = null;\n  state.messages = [];\n  state.current = null;\n  $('#app').hidden = true;\n  $('#admin').hidden = true;\n  $('#login').hidden = false;\n  $('#login-email').value = '';\n  $('#login-password').value = '';\n  clearHint('#login-hint');\n  clearHint('#register-hint');\n  $('#reg-password').value = '';\n  $('#reg-password2').value = '';\n  $('#reg-code').value = '';\n  switchTab('login');\n  toast('已退出登录');\n}\n\n/* ------------------------------ 启动 ------------------------------ */\n\nasync function boot() {\n  const data = await api('/api/bootstrap');\n  if (!data.authenticated) {\n    $('#app').hidden = true;\n    $('#admin').hidden = true;\n    $('#login').hidden = false;\n    $('#reg-domain').textContent = `@${data.domain || 'mail.example.com'}`;\n    if (data.domain) $('#hint-root').textContent = `admin@${data.domain}`;\n    if (data.config) {\n      $('#reg-email').placeholder = data.config.requireQQ ? 'QQ 邮箱，如 123456@qq.com' : '邮箱地址';\n    }\n    return;\n  }\n  state.user = data.user;\n  state.config = data.config || {};\n  state.mailboxes = data.mailboxes || [];\n  state.externals = data.externals || [];\n  state.messages = data.messages || [];\n  state.stats = data.stats || {};\n  $('#reg-domain').textContent = `@${data.domain}`;\n  $('#newbox-domain').textContent = `@${data.domain}`;\n  $('#login').hidden = true;\n  $('#app').hidden = false;\n  renderShell();\n  renderMailboxes();\n  renderExternals();\n  renderList();\n  renderStats();\n  if (state.current) renderReader(null);\n}\n\n/* ------------------------------ 渲染：壳 ------------------------------ */\n\nfunction renderShell() {\n  const u = state.user || {};\n  const main = state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0];\n  $('#user-name').textContent = u.nickname || u.email || '用户';\n  $('#user-mail').textContent = main ? main.address : u.email || '';\n  $('#user-avatar').textContent = initialOf(u.nickname || u.email);\n  $('#user-avatar').style.background = colorFor(u.email || 'u');\n  $('#btn-admin').hidden = !(u.isAdmin || u.role === 'root');\n  $('#reader-address').textContent = main ? main.address : '还没有主邮箱';\n}\n\nfunction renderMailboxes() {\n  const list = $('#mailbox-list');\n  const totalUnread = state.mailboxes.reduce((sum, m) => sum + (m.unread || 0), 0);\n  $('#unread-all').textContent = totalUnread > 99 ? '99+' : String(totalUnread);\n  $('#unread-all').classList.toggle('is-zero', totalUnread === 0);\n  $('#mailbox-count').textContent = String(state.mailboxes.length);\n\n  if (!state.mailboxes.length) {\n    list.innerHTML = '<p class=\"side-empty\">还没有邮箱，点上面的「新建邮箱」创建一个。</p>';\n    return;\n  }\n\n  list.innerHTML = state.mailboxes\n    .map((mb) => {\n      const active = state.mailboxId === mb.id && !state.alias;\n      const subs = (mb.subs || []).filter(\n        (s) =>\n          s.source !== 'blocked' &&\n          (s.total > 0 || s.unread > 0 || s.source === 'manual' || s.source === 'external')\n      );\n      const subsHtml = subs.length\n        ? `<div class=\"mb-subs\">${subs\n            .map(\n              (s) => `<button type=\"button\" class=\"sub-row${state.alias === s.localPart && state.mailboxId === mb.id ? ' active' : ''}\"\n                        data-mailbox=\"${esc(mb.id)}\" data-alias=\"${esc(s.localPart)}\">\n                        <span class=\"sub-name\">${esc(s.localPart)}<span class=\"sub-at\">@${esc(s.domain)}</span></span>\n                        ${s.unread ? `<span class=\"sub-badge\">${s.unread > 99 ? '99+' : s.unread}</span>` : ''}\n                        ${s.source === 'manual' || s.source === 'auto' ? `<span class=\"sub-del\" data-del-sub=\"${esc(s.localPart)}\" title=\"删除这个子地址\">×</span>` : ''}\n                      </button>`\n            )\n            .join('')}</div>`\n        : '';\n\n      const isCatch = mb.label === '未登记地址';\n      return `<div class=\"mb-item${active ? ' active' : ''}${isCatch ? ' is-catchall' : ''}\">\n        <button type=\"button\" class=\"mb-row\" data-mailbox=\"${esc(mb.id)}\" data-alias=\"\">\n          <span class=\"mb-avatar\" style=\"background:${isCatch ? '#8b93a7' : colorFor(mb.address)}\">${isCatch ? '<svg class=\"mb-catch-icon\"><use href=\"#i-inbox\"/></svg>' : esc(initialOf(mb.localPart))}</span>\n          <span class=\"mb-body\">\n            <span class=\"mb-name\">${isCatch ? '未登记地址' : `${esc(mb.localPart)}<span class=\"mb-at\">@${esc(mb.domain)}</span>`}</span>\n            <span class=\"mb-note\">${isCatch ? '没建过的地址都进这里' : `${mb.label ? esc(mb.label) : '主邮箱'}${subs.length ? ` · ${subs.length} 个子地址` : ''}`}</span>\n          </span>\n          ${mb.unread ? `<span class=\"mb-badge\">${mb.unread > 99 ? '99+' : mb.unread}</span>` : ''}\n        </button>\n        ${subsHtml}\n      </div>`;\n    })\n    .join('');\n}\n\nfunction renderStats() {\n  const s = state.stats || {};\n  $('#stat-messages').textContent = String(s.messages || 0);\n  $('#stat-subs').textContent = String(s.subs || 0);\n  $('#stat-bytes').textContent = fmtBytes(s.bytes);\n}\n\n/* ------------------------------ 一邮多用 ------------------------------ */\n\nfunction renderExternals() {\n  const list = $('#ext-list');\n  if (!list) return;\n  if (!state.externals.length) {\n    list.innerHTML = '<p class=\"side-empty\">QQ / Gmail / 163 的来信都能转进来，点「+ 接入」。</p>';\n    return;\n  }\n  list.innerHTML = state.externals\n    .map((e) => {\n      const active = state.alias === e.localPart;\n      return `<div class=\"ext-item${active ? ' active' : ''}\">\n        <button type=\"button\" class=\"ext-row\" data-mailbox=\"${esc(e.mailboxId || '')}\" data-alias=\"${esc(e.localPart)}\">\n          <span class=\"ext-badge\">${esc(extShort(e.provider))}</span>\n          <span class=\"ext-body\">\n            <span class=\"ext-addr\">${esc(e.address)}</span>\n            <span class=\"ext-note\">${esc(e.label || e.providerName)}${e.unread ? ` · ${e.unread} 未读` : ''}</span>\n          </span>\n        </button>\n        <button type=\"button\" class=\"icon-btn ext-del\" data-del=\"${esc(e.id)}\" title=\"移除\"><svg><use href=\"#i-trash\"/></svg></button>\n      </div>`;\n    })\n    .join('');\n}\n\nasync function copyText(text) {\n  try {\n    await navigator.clipboard.writeText(text);\n    toast('已复制：' + text);\n  } catch {\n    toast('复制失败，请手动选中地址', 'error');\n  }\n}\n\nfunction renderExtRows() {\n  const box = $('#ext-rows');\n  if (!box) return;\n  if (!state.externals.length) {\n    box.innerHTML = '<p class=\"ext-empty\">还没有接入任何外部邮箱。</p>';\n    return;\n  }\n  box.innerHTML = state.externals\n    .map(\n      (e) => `<div class=\"ext-card\">\n        <div class=\"ext-card-head\">\n          <span class=\"ext-badge\">${esc(extShort(e.provider))}</span>\n          <b>${esc(e.address)}</b>\n          <span class=\"ext-card-count\">${e.mailCount} 封</span>\n        </div>\n        <div class=\"ext-card-intake\">\n          <code>${esc(e.intake)}</code>\n          <button type=\"button\" class=\"mini-btn\" data-copy=\"${esc(e.intake)}\">复制</button>\n        </div>\n        <p class=\"ext-card-hint\">${esc(e.hint)}</p>\n        <div class=\"ext-card-foot\">\n          <button type=\"button\" class=\"mini-btn is-danger\" data-del=\"${esc(e.id)}\">移除</button>\n        </div>\n      </div>`\n    )\n    .join('');\n}\n\nasync function openExternal() {\n  try {\n    const data = await api('/api/external');\n    state.externals = data.externals || state.externals;\n    state.providers = data.providers || [];\n    const sel = $('#ext-provider');\n    if (!$('#ext-provider').dataset.filled) {\n      sel.innerHTML = state.providers.map((p) => `<option value=\"${esc(p.key)}\">${esc(p.name)}</option>`).join('');\n      sel.dataset.filled = '1';\n    }\n    $('#ext-info').textContent = '';\n    $('#ext-info').className = 'dialog-info';\n    $('#ext-tip').textContent = '';\n    $('#btn-close-ext').focus?.();\n    renderExtRows();\n    renderExternals();\n    $('#ext-dialog').showModal();\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\nasync function saveExternal(ev) {\n  ev.preventDefault();\n  const provider = $('#ext-provider').value;\n  const address = $('#ext-address').value.trim();\n  const label = $('#ext-label').value.trim();\n  const info = $('#ext-info');\n  try {\n    const data = await api('/api/external', { method: 'POST', body: { provider, address, label } });\n    state.externals = data.externals || state.externals;\n    const e = data.external;\n    $('#ext-address').value = '';\n    $('#ext-label').value = '';\n    info.className = 'dialog-info is-ok';\n    info.innerHTML = `已生成入口地址：<code>${esc(e.intake)}</code>（已复制）`;\n    $('#ext-tip').textContent = e.hint;\n    copyText(e.intake);\n    renderExtRows();\n    renderExternals();\n  } catch (err) {\n    info.className = 'dialog-info is-error';\n    info.textContent = err.message;\n    toast(err.message, 'error');\n  }\n}\n\nasync function deleteExternal(id) {\n  try {\n    const data = await api(`/api/external/${encodeURIComponent(id)}`, { method: 'DELETE' });\n    state.externals = data.externals || [];\n    renderExtRows();\n    renderExternals();\n    toast('已移除，这个入口地址不再收信');\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\n/* ------------------------------ 渲染：列表 ------------------------------ */\n\nfunction currentMailbox() {\n  return state.mailboxes.find((m) => m.id === state.mailboxId) || null;\n}\n\nfunction renderList() {\n  const body = $('#list-body');\n  const rows = state.messages || [];\n  const mb = currentMailbox();\n\n  let title = '全部邮件';\n  if (mb && state.alias) title = `${state.alias}@${mb.domain}`;\n  else if (mb) title = mb.address;\n  $('#list-title').textContent = state.q ? `搜索：${state.q}` : title;\n  $('#list-sub').textContent = `${rows.length} 封${state.q ? '匹配' : ''}`;\n\n  $$('.nav-item', $('#sidebar')).forEach((b) => b.classList.toggle('active', !state.mailboxId && !state.alias && !state.q));\n\n  if (!rows.length) {\n    $('#list-rows').innerHTML = '';\n    const empty = $('#list-empty');\n    empty.hidden = false;\n    const main = state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0];\n    empty.querySelector('.empty-title').textContent = state.q ? '没有匹配的邮件' : '这里还没有邮件';\n    empty.querySelector('.empty-sub').textContent = state.q\n      ? '换个关键词试试，发件人、主题和正文都能搜。'\n      : main\n        ? `收验证码不用先建邮箱：把 ${main.localPart}-随便写@${main.domain} 填进注册页，信会自动归到这里。`\n        : '把收件地址填到注册表单里，验证码和通知就会出现在这里。';\n    return;\n  }\n\n  $('#list-rows').innerHTML = rows\n    .map((m) => {\n      const fromName = m.from?.name || m.from?.address || '未知发件人';\n      const active = state.current && state.current.id === m.id;\n      return `<button type=\"button\" class=\"msg-row${m.unread ? ' is-unread' : ''}${active ? ' is-active' : ''}\" data-id=\"${esc(m.id)}\">\n        <span class=\"msg-avatar\" style=\"background:${colorFor(m.from?.address || fromName)}\">${esc(initialOf(fromName))}</span>\n        <span class=\"msg-from\" title=\"${esc(fromName)}\">${esc(fromName)}</span>\n        <span class=\"msg-body\">\n          <span class=\"msg-subject\">${m.extSource ? `<span class=\"msg-ext\">${esc(extShort(m.extSource))}</span>` : m.alias && m.mailbox && m.alias !== m.mailbox ? `<span class=\"msg-ext is-plain\">${esc(m.alias)}</span>` : ''}${esc(m.subject || '(无主题)')}</span>\n          <span class=\"msg-snippet\">${esc(m.snippet || '')}</span>\n        </span>\n        <span class=\"msg-flags\">${m.attachments ? `<svg class=\"flag-ico\"><use href=\"#i-clip\"/></svg>` : ''}${m.unread ? '<i class=\"dot\"></i>' : ''}</span>\n        <span class=\"msg-time\">${fmtTime(m.date)}</span>\n      </button>`;\n    })\n    .join('');\n  $('#list-empty').hidden = true;\n}\n\n/* ------------------------------ 渲染：阅读 ------------------------------ */\n\nfunction renderReader(msg) {\n  const empty = $('#reader-empty');\n  const article = $('#reader-article');\n  state.current = msg;\n  if (!msg) {\n    empty.hidden = false;\n    article.hidden = true;\n    document.body.classList.remove('reader-open');\n    renderList();\n    return;\n  }\n  empty.hidden = true;\n  article.hidden = false;\n  document.body.classList.add('reader-open');\n\n  $('#reader-subject').textContent = msg.subject || '(无主题)';\n  const extTag = $('#reader-ext');\n  if (msg.extSource) {\n    extTag.hidden = false;\n    extTag.innerHTML = `来自外部邮箱 <b>${esc(extShort(msg.extSource))}</b> 的转发`;\n  } else {\n    extTag.hidden = true;\n    extTag.textContent = '';\n  }\n  $('#reader-from-name').textContent = msg.from?.name || msg.from?.address || '未知';\n  $('#reader-from-addr').textContent = msg.from?.address ? `<${msg.from.address}>` : '';\n  $('#reader-to').textContent = msg.to || '';\n  $('#reader-date').textContent = fmtFull(msg.date);\n\n  const atts = msg.attachments || [];\n  const box = $('#attachments');\n  box.hidden = !atts.length;\n  box.innerHTML = atts\n    .map(\n      (a) => `<a class=\"attachment\" href=\"${esc(a.url)}\" download>\n        <svg><use href=\"#i-clip\"/></svg>\n        <span class=\"att-name\">${esc(a.filename)}</span>\n        <span class=\"att-size\">${fmtBytes(a.size)}</span>\n      </a>`\n    )\n    .join('');\n\n  const frame = $('#mail-frame');\n  const text = $('#mail-text');\n  if (msg.html) {\n    frame.hidden = false;\n    text.hidden = true;\n    frame.srcdoc = msg.html;\n  } else {\n    frame.hidden = true;\n    text.hidden = false;\n    text.textContent = msg.text || '(这封邮件没有正文)';\n  }\n  renderList();\n}\n\nasync function openMessage(id) {\n  try {\n    const data = await api(`/api/messages/${encodeURIComponent(id)}`);\n    renderReader(data.message);\n    const row = state.messages.find((m) => m.id === id);\n    if (row && row.unread) {\n      row.unread = false;\n      const mb = state.mailboxes.find((m) => m.id === row.mailboxId);\n      if (mb && mb.unread > 0) mb.unread -= 1;\n      renderMailboxes();\n      renderStats();\n    }\n    if (window.innerWidth <= 900) document.body.classList.add('reader-open');\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\n/* ------------------------------ 数据操作 ------------------------------ */\n\nasync function fetchMessages() {\n  const params = new URLSearchParams();\n  if (state.mailboxId) params.set('mailboxId', state.mailboxId);\n  if (state.alias) params.set('alias', state.alias);\n  if (state.q) params.set('q', state.q);\n  params.set('limit', '100');\n  const data = await api(`/api/messages?${params}`);\n  state.messages = data.messages || [];\n  state.stats = data.stats || state.stats;\n  renderList();\n  renderStats();\n}\n\nasync function selectMailbox(id, alias = '') {\n  state.mailboxId = id || '';\n  state.alias = alias || '';\n  if (state.q) {\n    state.q = '';\n    $('#search').value = '';\n  }\n  renderMailboxes();\n  document.body.classList.remove('sidebar-open');\n  try {\n    await fetchMessages();\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\nasync function refreshMailboxes() {\n  const data = await api('/api/mailboxes');\n  state.mailboxes = data.mailboxes || [];\n  renderShell();\n  renderMailboxes();\n  renderStats();\n}\n\nasync function refreshAll() {\n  try {\n    const data = await api(`/api/bootstrap${state.mailboxId ? `?mailbox=${encodeURIComponent(state.mailboxId)}` : ''}`);\n    state.mailboxes = data.mailboxes || [];\n    state.externals = data.externals || state.externals;\n    state.stats = data.stats || {};\n    state.user = data.user || state.user;\n    await fetchMessages();\n    renderShell();\n    renderMailboxes();\n    renderExternals();\n    renderStats();\n    toast('已刷新');\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\nasync function deleteCurrent() {\n  const msg = state.current;\n  if (!msg) return;\n  if (!confirm('删除这封邮件？删除后无法恢复。')) return;\n  try {\n    await api(`/api/messages/${encodeURIComponent(msg.id)}`, { method: 'DELETE' });\n    state.messages = state.messages.filter((m) => m.id !== msg.id);\n    renderReader(null);\n    renderList();\n    const data = await api('/api/bootstrap');\n    state.mailboxes = data.mailboxes || [];\n    state.stats = data.stats || {};\n    renderMailboxes();\n    renderStats();\n    toast('已删除');\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\nasync function markAllRead() {\n  try {\n    await api('/api/messages/read-all', { method: 'POST', body: { mailboxId: state.mailboxId } });\n    await fetchMessages();\n    const data = await api('/api/bootstrap');\n    state.mailboxes = data.mailboxes || [];\n    renderMailboxes();\n    toast('已全部标记为已读');\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\n/* ------------------------------ 账号设置 ------------------------------ */\n\nfunction openSettings() {\n  const u = state.user || {};\n  $('#set-email').value = u.email || '';\n  $('#set-nickname').value = u.nickname || '';\n  $('#set-phone').value = u.phone || '';\n  $('#set-old-password').value = '';\n  $('#set-new-password').value = '';\n  // 换绑面板每次打开都是收起的\n  rebindEmail = { token: '', timer: 0, email: '' };\n  stopRebindPoll();\n  ['#panel-email', '#panel-phone'].forEach((sel) => {\n    const el = $(sel);\n    if (el) el.hidden = true;\n  });\n  ['#set-new-email', '#set-email-password', '#set-new-phone', '#set-phone-password', '#newemail-code'].forEach((sel) => {\n    const el = $(sel);\n    if (el) el.value = '';\n  });\n  $('#newemail-code-row').hidden = true;\n  $('#btn-verify-newemail').disabled = false;\n  $('#btn-verify-newemail').textContent = '① 发送验证码';\n  setHint('#newemail-state', '先把验证码发到新邮箱，再填进来');\n  setHint('#dialog-info', state.config.smsEnabled ? '短信验证已开启。' : '短信通道未接入，手机号目前只做格式与唯一性校验。');\n  $('#settings-dialog').showModal();\n}\n\nasync function saveSettings(ev) {\n  ev.preventDefault();\n  const body = {\n    nickname: $('#set-nickname').value.trim(),\n    oldPassword: $('#set-old-password').value,\n    password: $('#set-new-password').value,\n  };\n  if (!body.password) delete body.password;\n  try {\n    const data = await api('/api/me', { method: 'POST', body });\n    state.user = data.user;\n    renderShell();\n    $('#set-old-password').value = '';\n    $('#set-new-password').value = '';\n    setHint('#dialog-info', '已保存');\n    toast('设置已保存');\n    setTimeout(() => $('#settings-dialog').close(), 600);\n  } catch (err) {\n    setHint('#dialog-info', err.message, 'error');\n    toast(err.message, 'error');\n  }\n}\n\n/* ---------- 忘记密码 ---------- */\n\nasync function sendResetCode() {\n  const email = $('#reset-email').value.trim();\n  if (!email) {\n    toast('先填登录邮箱', 'error');\n    $('#reset-email').focus();\n    return;\n  }\n  const btn = $('#reset-send');\n  btn.disabled = true;\n  btn.textContent = '发送中…';\n  try {\n    const data = await api('/api/auth/reset/start', { method: 'POST', body: { email } });\n    setHint('#reset-state', `验证码已发到 ${data.sentTo || email}，10 分钟内有效`);\n    toast('验证码已发送，去查收邮件');\n    $('#reset-code').focus();\n  } catch (err) {\n    toast(err.message, 'error');\n    setHint('#reset-state', err.message, 'error');\n  } finally {\n    btn.disabled = false;\n    btn.textContent = '重新发送';\n  }\n}\n\nasync function submitReset(ev) {\n  ev.preventDefault();\n  const email = $('#reset-email').value.trim();\n  const code = $('#reset-code').value.replace(/\\D/g, '');\n  const password = $('#reset-password').value;\n  if (code.length !== 6) {\n    toast('填邮件里的 6 位验证码', 'error');\n    $('#reset-code').focus();\n    return;\n  }\n  if (password.length < 8) {\n    toast('新密码至少 8 位', 'error');\n    $('#reset-password').focus();\n    return;\n  }\n  try {\n    await api('/api/auth/reset/confirm', { method: 'POST', body: { email, code, password } });\n    $('#reset-dialog').close();\n    $('#login-email').value = email;\n    $('#login-password').value = '';\n    $('#login-password').focus();\n    clearHint('#login-hint');\n    toast('密码已重设，用新密码登录');\n  } catch (err) {\n    toast(err.message, 'error');\n    setHint('#reset-info', err.message, 'error');\n  }\n}\n\n/* ---------- 换绑手机号 ---------- */\n\nasync function saveRebindPhone() {\n  const phone = $('#set-new-phone').value.replace(/[\\s-]/g, '').replace(/^\\+?86/, '');\n  const password = $('#set-phone-password').value;\n  if (!password) {\n    toast('请输入当前密码', 'error');\n    $('#set-phone-password').focus();\n    return;\n  }\n  try {\n    const data = await api('/api/me', {\n      method: 'POST',\n      body: { nickname: state.user?.nickname || '', phone, oldPassword: password },\n    });\n    state.user = data.user;\n    $('#set-phone').value = data.user.phone || '';\n    $('#set-new-phone').value = '';\n    $('#set-phone-password').value = '';\n    $('#panel-phone').hidden = true;\n    renderShell();\n    toast(phone ? '手机号已换绑' : '手机号已解绑');\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\n/* ---------- 换绑登录邮箱（要验证新邮箱） ---------- */\n\nlet rebindEmail = { token: '', timer: 0, email: '' };\n\nfunction stopRebindPoll() {\n  if (rebindEmail.timer) clearInterval(rebindEmail.timer);\n  rebindEmail.timer = 0;\n}\n\nasync function startRebindEmailVerify() {\n  const email = $('#set-new-email').value.trim();\n  if (!email) {\n    toast('先填新的 QQ 邮箱', 'error');\n    $('#set-new-email').focus();\n    return;\n  }\n  const btn = $('#btn-verify-newemail');\n  btn.disabled = true;\n  btn.textContent = '发送中…';\n  try {\n    const data = await api('/api/auth/verify/start', { method: 'POST', body: { email } });\n    rebindEmail = { token: data.token, email: email.toLowerCase(), timer: 0, mode: 'code' };\n    $('#newemail-code-row').hidden = false;\n    $('#newemail-code').value = '';\n    setHint('#newemail-state', `验证码已发到 ${data.sentTo || email}，10 分钟内有效`);\n    btn.disabled = false;\n    btn.textContent = '① 重新发送验证码';\n    $('#newemail-code').focus();\n    toast('验证码已发送到新邮箱');\n  } catch (err) {\n    toast(err.message, 'error');\n    btn.disabled = false;\n    btn.textContent = '① 发送验证码';\n  }\n}\n\nasync function confirmRebindCode() {\n  const code = $('#newemail-code').value.replace(/\\D/g, '');\n  if (code.length !== 6) {\n    toast('验证码是 6 位数字', 'error');\n    return;\n  }\n  try {\n    const data = await api('/api/auth/verify/confirm', {\n      method: 'POST',\n      body: { token: rebindEmail.token, code },\n    });\n    if (data.verified) {\n      stopRebindPoll();\n      setHint('#newemail-state', '✅ 新邮箱已验证，填当前密码后点「确认换绑」');\n      $('#newemail-code-row').hidden = true;\n      $('#btn-verify-newemail').textContent = '✅ 新邮箱已验证';\n      toast('新邮箱验证通过');\n    }\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\nasync function saveRebindEmail() {\n  const email = $('#set-new-email').value.trim();\n  const password = $('#set-email-password').value;\n  if (!rebindEmail.token || rebindEmail.email !== email.toLowerCase()) {\n    toast('请先点「① 验证新邮箱」完成验证', 'error');\n    return;\n  }\n  if (!password) {\n    toast('请输入当前密码', 'error');\n    $('#set-email-password').focus();\n    return;\n  }\n  try {\n    const data = await api('/api/me/email', { method: 'POST', body: { email, password, token: rebindEmail.token } });\n    state.user = data.user;\n    $('#set-email').value = data.user.email || '';\n    $('#set-new-email').value = '';\n    $('#set-email-password').value = '';\n    $('#panel-email').hidden = true;\n    $('#newemail-code').value = '';\n    $('#newemail-code-row').hidden = true;\n    stopRebindPoll();\n    rebindEmail = { token: '', timer: 0, email: '' };\n    renderShell();\n    toast('登录邮箱已换绑：' + (data.user.email || ''));\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\n/* ------------------------------ 新建邮箱 ------------------------------ */\n\nfunction mainMailbox() {\n  return state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0] || null;\n}\n\nfunction newboxMode() {\n  const el = document.querySelector('input[name=\"newbox-mode\"]:checked');\n  return el ? el.value : 'sub';\n}\n\nfunction syncNewboxMode() {\n  const main = mainMailbox();\n  const mode = newboxMode();\n  const preview = $('#newbox-preview');\n  const name = ($('#newbox-name').value || '').trim().replace(/^@+/, '');\n  const domain = main ? main.domain : '';\n  if (mode === 'main' || !main) {\n    preview.textContent = name ? `${name}@${domain}` : `@${domain}`;\n    $('#newbox-info').textContent = '主邮箱只能有 1 个，收信用它、加子地址也用它的前缀。';\n  } else {\n    const full = name ? (name.startsWith(main.localPart) ? name : `${main.localPart}-${name}`) : `${main.localPart}-`;\n    preview.textContent = `${full}@${domain}`;\n    setHint('#newbox-info', `子地址 = 主邮箱前缀 + 后缀，来信自动归到 ${main.localPart}@${main.domain}。`);\n  }\n  $('#newbox-dialog').classList.toggle('is-sub', mode === 'sub' && !!main);\n}\n\nfunction openNewbox() {\n  const main = mainMailbox();\n  $('#newbox-name').value = '';\n  // 已经有主邮箱的用户，默认建子地址（以前这里只能建主邮箱，所以一直报“每个账号只能有 1 个主邮箱”）\n  const subRadio = document.querySelector('input[name=\"newbox-mode\"][value=\"sub\"]');\n  const mainRadio = document.querySelector('input[name=\"newbox-mode\"][value=\"main\"]');\n  if (main) {\n    if (subRadio) subRadio.checked = true;\n    if (mainRadio) {\n      mainRadio.disabled = true;\n      mainRadio.closest('.seg-item')?.classList.add('is-off');\n    }\n  } else {\n    if (mainRadio) mainRadio.checked = true;\n    if (subRadio) {\n      subRadio.disabled = true;\n      subRadio.closest('.seg-item')?.classList.add('is-off');\n    }\n  }\n  clearHint('#newbox-info');\n  const dom = $('#newbox-domain');\n  if (dom) dom.textContent = `@${main ? main.domain : ''}`;\n  syncNewboxMode();\n  $('#newbox-dialog').showModal();\n  setTimeout(() => $('#newbox-name').focus(), 60);\n}\n\nasync function createMailbox(ev) {\n  ev.preventDefault();\n  const btn = $('#newbox-submit');\n  const name = $('#newbox-name').value.trim();\n  const main = mainMailbox();\n  const mode = main && newboxMode() === 'sub' ? 'sub' : 'main';\n  if (!name) {\n    setHint('#newbox-info', '先填一个名字', 'error');\n    toast('请填写邮箱名', 'error');\n    return;\n  }\n  btn.disabled = true;\n  btn.textContent = '创建中…';\n  try {\n    const data =\n      mode === 'sub'\n        ? await api('/api/subaddresses', { method: 'POST', body: { name } })\n        : await api('/api/mailboxes', { method: 'POST', body: { name } });\n    state.mailboxes = data.mailboxes || [];\n    renderShell();\n    renderMailboxes();\n    renderStats();\n    $('#newbox-dialog').close();\n    $('#newbox-name').value = '';\n    clearHint('#newbox-info');\n    toast(mode === 'sub' ? `子地址已创建：${data.address || name}` : '邮箱已创建');\n    if (mode === 'sub' && main) {\n      state.mailboxId = main.id;\n      state.alias = null;\n      await fetchMessages();\n      renderStats();\n    }\n  } catch (err) {\n    setHint('#newbox-info', err.message, 'error');\n    toast(err.message, 'error');\n  } finally {\n    btn.disabled = false;\n    btn.textContent = '创建';\n  }\n}\n\n/* ------------------------------ 管理后台 ------------------------------ */\n\nasync function openAdmin() {\n  $('#admin').hidden = false;\n  document.body.classList.add('admin-open');\n  await loadAdmin();\n}\n\nfunction closeAdmin() {\n  $('#admin').hidden = true;\n  document.body.classList.remove('admin-open');\n}\n\nasync function loadAdmin() {\n  try {\n    const [overview, users] = await Promise.all([\n      api('/api/admin/overview'),\n      api(`/api/admin/users?q=${encodeURIComponent(state.admin.q)}`),\n    ]);\n    state.admin.stats = overview.stats;\n    state.admin.domains = overview.domains || [];\n    state.admin.config = overview.config || {};\n    state.admin.dropped = overview.dropped || [];\n    state.admin.users = users.users || [];\n    renderAdmin();\n  } catch (err) {\n    toast(err.message, 'error');\n    closeAdmin();\n  }\n}\n\nfunction renderAdmin() {\n  const s = state.admin.stats || {};\n  const cards = [\n    ['用户', s.users, `${s.activeUsers} 个活跃`],\n    ['主邮箱', s.mailboxes, `${s.subs} 个子地址`],\n    ['邮件', s.messages, `${s.unread} 封未读`],\n    ['占用空间', fmtBytes(s.bytes), `${s.domains} 个域名`],\n  ];\n  $('#admin-stats').innerHTML = cards\n    .map(\n      ([label, value, note]) => `<div class=\"stat-card\">\n        <span class=\"stat-label\">${label}</span>\n        <b class=\"stat-value\">${esc(value)}</b>\n        <small class=\"stat-note\">${esc(note)}</small>\n      </div>`\n    )\n    .join('');\n\n  const me = state.user || {};\n  $('#admin-sub').textContent = `当前身份：${me.nickname || me.email}（${me.role === 'root' ? 'root' : '管理员'}）`;\n\n  $('#admin-user-rows').innerHTML = state.admin.users\n    .map((u) => {\n      const self = u.id === me.id;\n      const disabled = u.status !== 'active';\n      return `<tr class=\"${disabled ? 'is-off' : ''}\">\n        <td>\n          <div class=\"admin-user\">\n            <span class=\"admin-avatar\" style=\"background:${colorFor(u.email)}\">${esc(initialOf(u.nickname || u.email))}</span>\n            <span class=\"admin-user-meta\">\n              <b>${esc(u.nickname || '未命名')}</b>\n              <small>${esc(u.email)}${u.role !== 'user' ? ` · <em>${esc(u.role)}</em>` : ''}</small>\n            </span>\n          </div>\n        </td>\n        <td class=\"mono\">${esc(u.phone || '—')}</td>\n        <td class=\"mono\">${esc(u.mainAddress || '—')}</td>\n        <td>${u.messages}${u.unread ? ` <span class=\"mini-dot\">${u.unread}</span>` : ''}</td>\n        <td><span class=\"tag ${disabled ? 'tag-off' : 'tag-on'}\">${disabled ? '已停用' : '正常'}</span></td>\n        <td class=\"mono dim\">${u.lastLoginAt ? fmtFull(u.lastLoginAt) : '从未'}</td>\n        <td class=\"ta-r\">\n          <div class=\"row-actions\">\n            ${self ? '<span class=\"dim\">当前账号</span>' : `\n              <button class=\"mini-btn\" data-act=\"toggle\" data-id=\"${esc(u.id)}\" data-status=\"${disabled ? 'active' : 'disabled'}\">${disabled ? '启用' : '停用'}</button>\n              <button class=\"mini-btn\" data-act=\"reset\" data-id=\"${esc(u.id)}\">重置密码</button>\n              <button class=\"mini-btn danger\" data-act=\"delete\" data-id=\"${esc(u.id)}\" data-email=\"${esc(u.email)}\">删除</button>`}\n          </div>\n        </td>\n      </tr>`;\n    })\n    .join('') || '<tr><td colspan=\"7\" class=\"admin-empty\">还没有用户</td></tr>';\n\n  $('#admin-domains').innerHTML = state.admin.domains\n    .map(\n      (d) => `<div class=\"domain-row\">\n        <div class=\"domain-name\"><svg><use href=\"#i-globe\"/></svg>${esc(d.name)}</div>\n        <div class=\"domain-meta\">${d.mailboxes} 个邮箱 · ${d.total} 封</div>\n        <button class=\"mini-btn danger\" data-act=\"del-domain\" data-name=\"${esc(d.name)}\">移除</button>\n      </div>`\n    )\n    .join('') || '<p class=\"dim\">还没有域名</p>';\n\n  const c = state.admin.config || {};\n  $('#cfg-subauto').checked = !!c.subAddressAuto;\n  $('#cfg-requireqq').checked = !!c.requireQQ;\n  $('#cfg-sms').checked = !!c.smsEnabled;\n  $('#cfg-catchall').checked = c.catchAll !== false;\n  $('#cfg-keep').value = Number(c.keepDays || 0);\n\n  const dropped = state.admin.dropped || [];\n  $('#dropped-list').hidden = !dropped.length;\n  $('#dropped-count').textContent = String(state.admin.stats?.dropped ?? dropped.length);\n  $('#dropped-rows').innerHTML = dropped\n    .map(\n      (d) => `<div class=\"dropped-row\">\n        <code>${esc(d.address)}</code>\n        <span class=\"dropped-sub\">${esc(d.subject || '(无主题)')}</span>\n        <span class=\"dropped-from\">${esc(d.from || '')}</span>\n      </div>`\n    )\n    .join('');\n}\n\nasync function adminAction(ev) {\n  const btn = ev.target.closest('[data-act]');\n  if (!btn) return;\n  const { act, id, status, email, name } = btn.dataset;\n  try {\n    if (act === 'toggle') {\n      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { status } });\n      toast(status === 'active' ? '已启用' : '已停用');\n    } else if (act === 'reset') {\n      const data = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });\n      toast(`临时密码：${data.password}（已复制）`, 'ok', 12000);\n      navigator.clipboard?.writeText(data.password).catch(() => {});\n    } else if (act === 'delete') {\n      if (!confirm(`删除 ${email}？该用户的邮箱和邮件会一起删除，不可恢复。`)) return;\n      await api(`/api/admin/users/${id}`, { method: 'DELETE' });\n      toast('用户已删除');\n    } else if (act === 'del-domain') {\n      if (!confirm(`移除域名 ${name}？该域名下的邮箱和邮件会一起删除。`)) return;\n      await api(`/api/admin/domains/${encodeURIComponent(name)}`, { method: 'DELETE' });\n      toast('域名已移除');\n    }\n    await loadAdmin();\n    const data = await api('/api/bootstrap');\n    state.mailboxes = data.mailboxes || [];\n    renderMailboxes();\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\nasync function saveAdminConfig() {\n  try {\n    await api('/api/admin/config', {\n      method: 'POST',\n      body: {\n        subAddressAuto: $('#cfg-subauto').checked,\n        requireQQ: $('#cfg-requireqq').checked,\n        smsEnabled: $('#cfg-sms').checked,\n        catchAll: $('#cfg-catchall').checked,\n        keepDays: Number($('#cfg-keep').value || 0),\n      },\n    });\n    toast('开关已保存');\n    await loadAdmin();\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\nasync function addDomain(ev) {\n  ev.preventDefault();\n  const name = $('#admin-domain-input').value.trim();\n  if (!name) return;\n  try {\n    await api('/api/admin/domains', { method: 'POST', body: { name } });\n    $('#admin-domain-input').value = '';\n    toast('域名已添加');\n    await loadAdmin();\n  } catch (err) {\n    toast(err.message, 'error');\n  }\n}\n\n/* ------------------------------ 事件绑定 ------------------------------ */\n\nfunction bind() {\n  $$('.auth-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));\n  $('#login-form').addEventListener('submit', doLogin);\n  $('#register-form').addEventListener('submit', doRegister);\n  $('#reg-verify-btn').addEventListener('click', startVerify);\n  $('#reg-code-resend').addEventListener('click', startVerify);\n  $('#btn-logout').addEventListener('click', logout);\n\n  $('#btn-refresh').addEventListener('click', refreshAll);\n  $('#btn-settings').addEventListener('click', openSettings);\n  $('#btn-close-settings').addEventListener('click', () => $('#settings-dialog').close());\n  $('#btn-cancel-settings').addEventListener('click', () => $('#settings-dialog').close());\n  $('#btn-rebind-phone').addEventListener('click', () => {\n    $('#panel-phone').hidden = !$('#panel-phone').hidden;\n    if (!$('#panel-phone').hidden) $('#set-new-phone').focus();\n  });\n  $('#btn-cancel-phone').addEventListener('click', () => {\n    $('#panel-phone').hidden = true;\n    $('#set-new-phone').value = '';\n    $('#set-phone-password').value = '';\n  });\n  $('#btn-save-phone').addEventListener('click', saveRebindPhone);\n  $('#btn-rebind-email').addEventListener('click', () => {\n    $('#panel-email').hidden = !$('#panel-email').hidden;\n    if (!$('#panel-email').hidden) $('#set-new-email').focus();\n  });\n  $('#btn-cancel-email').addEventListener('click', () => {\n    $('#panel-email').hidden = true;\n    $('#set-new-email').value = '';\n    $('#set-email-password').value = '';\n    $('#newemail-code').value = '';\n    stopRebindPoll();\n    rebindEmail = { token: '', timer: 0, email: '' };\n  });\n  $('#btn-verify-newemail').addEventListener('click', startRebindEmailVerify);\n  $('#btn-save-email').addEventListener('click', saveRebindEmail);\n  $('#newemail-code-btn').addEventListener('click', confirmRebindCode);\n  $('#newemail-code').addEventListener('keydown', (e) => {\n    if (e.key === 'Enter') {\n      e.preventDefault();\n      confirmRebindCode();\n    }\n  });\n\n  /* ---------- 找回密码 ---------- */\n  $('#btn-forgot').addEventListener('click', () => {\n    $('#reset-email').value = $('#login-email').value.trim();\n    $('#reset-code').value = '';\n    $('#reset-password').value = '';\n    setHint('#reset-state', '验证码 10 分钟内有效');\n    clearHint('#reset-info');\n    $('#reset-dialog').showModal();\n    $('#reset-email').focus();\n  });\n  $('#btn-close-reset').addEventListener('click', () => $('#reset-dialog').close());\n  $('#btn-cancel-reset').addEventListener('click', () => $('#reset-dialog').close());\n  $('#reset-send').addEventListener('click', sendResetCode);\n  $('#reset-form').addEventListener('submit', submitReset);\n\n  $('#reg-code-btn').addEventListener('click', confirmVerifyCode);\n  $('#reg-code').addEventListener('keydown', (e) => {\n    if (e.key === 'Enter') {\n      e.preventDefault();\n      confirmVerifyCode();\n    }\n  });\n  $('#settings-dialog').addEventListener('close', () => {\n    $('#set-old-password').value = '';\n    $('#set-new-password').value = '';\n    clearHint('#dialog-info');\n  });\n  $('#settings-form').addEventListener('submit', saveSettings);\n\n  $('#btn-new-mailbox').addEventListener('click', openNewbox);\n  $('#btn-close-newbox').addEventListener('click', () => $('#newbox-dialog').close());\n  $('#btn-cancel-newbox').addEventListener('click', () => $('#newbox-dialog').close());\n  $('#newbox-form').addEventListener('submit', createMailbox);\n  $('#newbox-dialog').addEventListener('close', () => {\n    $('#newbox-name').value = '';\n    clearHint('#newbox-info');\n  });\n  $$('input[name=\"newbox-mode\"]').forEach((r) => r.addEventListener('change', syncNewboxMode));\n  $('#newbox-name').addEventListener('input', syncNewboxMode);\n\n  $('#btn-add-external').addEventListener('click', openExternal);\n  $('#btn-close-ext').addEventListener('click', () => $('#ext-dialog').close());\n  $('#btn-cancel-ext').addEventListener('click', () => $('#ext-dialog').close());\n  $('#ext-form').addEventListener('submit', saveExternal);\n  $('#ext-rows').addEventListener('click', (e) => {\n    const del = e.target.closest('[data-del]');\n    if (del) return deleteExternal(del.dataset.del);\n    const copy = e.target.closest('[data-copy]');\n    if (copy) copyText(copy.dataset.copy);\n  });\n  $('#ext-list').addEventListener('click', (e) => {\n    const del = e.target.closest('[data-del]');\n    if (del) {\n      e.stopPropagation();\n      return deleteExternal(del.dataset.del);\n    }\n    const row = e.target.closest('[data-mailbox], [data-alias]');\n    if (row && !row.dataset.del) selectMailbox(row.dataset.mailbox || '', row.dataset.alias || '');\n  });\n\n  $('#btn-admin').addEventListener('click', openAdmin);\n  $('#btn-admin-back').addEventListener('click', closeAdmin);\n  $('#btn-admin-refresh').addEventListener('click', loadAdmin);\n  $('#admin-user-rows').addEventListener('click', adminAction);\n  $('#admin-domains').addEventListener('click', adminAction);\n  $('#admin-domain-form').addEventListener('submit', addDomain);\n  $('#btn-save-config').addEventListener('click', saveAdminConfig);\n\n  let searchTimer = 0;\n  $('#admin-user-search').addEventListener('input', (e) => {\n    clearTimeout(searchTimer);\n    searchTimer = setTimeout(() => {\n      state.admin.q = e.target.value.trim();\n      loadAdmin();\n    }, 250);\n  });\n\n  $('#all-mail').addEventListener('click', () => selectMailbox('', ''));\n  $('#mailbox-list').addEventListener('click', async (e) => {\n    const del = e.target.closest('[data-del-sub]');\n    if (del) {\n      e.preventDefault();\n      e.stopPropagation();\n      const local = del.dataset.delSub;\n      if (!confirm(`删除子地址 ${local}？删除后发给它的新邮件会被拒收（已收到的邮件保留）。`)) return;\n      try {\n        await api(`/api/subaddresses/${encodeURIComponent(local)}`, { method: 'DELETE' });\n        toast(`子地址 ${local} 已删除`);\n        await refreshMailboxes();\n      } catch (err) {\n        toast(err.message, 'error');\n      }\n      return;\n    }\n    const row = e.target.closest('[data-mailbox]');\n    if (!row) return;\n    selectMailbox(row.dataset.mailbox || '', row.dataset.alias || '');\n  });\n\n  $('#list-body').addEventListener('click', (e) => {\n    const row = e.target.closest('.msg-row');\n    if (row) openMessage(row.dataset.id);\n  });\n\n  $('#btn-read-all').addEventListener('click', markAllRead);\n  $('#btn-delete').addEventListener('click', deleteCurrent);\n  $('#btn-eml').addEventListener('click', () => {\n    if (!state.current) return;\n    window.location.href = `/api/messages/${encodeURIComponent(state.current.id)}/eml`;\n  });\n  $('#btn-copy-default').addEventListener('click', () => {\n    const mb = state.mailboxes.find((m) => m.label === '主邮箱') || state.mailboxes[0];\n    if (!mb) return;\n    navigator.clipboard?.writeText(mb.address).then(\n      () => toast('已复制 ' + mb.address),\n      () => toast('复制失败，请手动选择', 'error')\n    );\n  });\n\n  let searchTimer2 = 0;\n  $('#search').addEventListener('input', (e) => {\n    clearTimeout(searchTimer2);\n    const value = e.target.value.trim();\n    searchTimer2 = setTimeout(async () => {\n      state.q = value;\n      try {\n        await fetchMessages();\n      } catch (err) {\n        toast(err.message, 'error');\n      }\n    }, 250);\n  });\n\n  $('#btn-menu').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));\n  $('#btn-close-list').addEventListener('click', () => document.body.classList.remove('sidebar-open'));\n  $('#btn-close-reader').addEventListener('click', () => renderReader(null));\n  $('#scrim').addEventListener('click', () => {\n    document.body.classList.remove('sidebar-open');\n    document.body.classList.remove('reader-open');\n  });\n  document.addEventListener('keydown', (e) => {\n    if (e.key === 'Escape') {\n      document.body.classList.remove('sidebar-open');\n      closeAdmin();\n    }\n  });\n\n  window.addEventListener('resize', () => {\n    if (window.innerWidth > 900) document.body.classList.remove('sidebar-open');\n  });\n}\n\n/* ------------------------------ 启动 ------------------------------ */\n\nbind();\nboot().catch((err) => {\n  console.error(err);\n  $('#login').hidden = false;\n  setHint('#login-hint', '无法连接服务器：' + err.message, 'error');\n});\n\n// 每 60 秒静默同步一次（Worker 版没有 SSE）\nsetInterval(async () => {\n  if (!state.user) return;\n  if (document.hidden) return;\n  try {\n    const params = new URLSearchParams();\n    if (state.mailboxId) params.set('mailboxId', state.mailboxId);\n    params.set('limit', '100');\n    const data = await api(`/api/messages?${params}`);\n    state.messages = data.messages || [];\n    state.stats = data.stats || state.stats;\n    renderList();\n    renderStats();\n  } catch {\n    /* 静默失败 */\n  }\n}, 60000);\n","/style.css":"/* ============================================================================\n   无限邮箱 · 收件箱样式\n   视觉参照 2925 邮箱（2026 版）：\n     主色 #627BF6 / 深主色 #4D67E4 / 浅主色 rgba(98,123,246,.1)\n     外壳底色 #EDF0F7，内容区纯白 + 左上 16px 圆角\n     分割线 #E2E5EF，正文 #222428，次要 #52575F，弱化 #9EA1B0\n     字体 PingFang SC / 14px，列表行 36–44px\n   ============================================================================ */\n\n:root {\n  --brand: #627bf6;\n  --brand-deep: #4d67e4;\n  --brand-soft: rgba(98, 123, 246, 0.1);\n  --brand-soft-2: #f1f1fe;\n  --bg: #edf0f7;\n  --bg-hover: #e4e8f2;\n  --panel: #ffffff;\n  --panel-2: #f7f8fc;\n  --border: #e2e5ef;\n  --border-strong: #d3d8e6;\n  --text: #222428;\n  --text-2: #52575f;\n  --muted: #9ea1b0;\n  --danger: #f54040;\n  --danger-soft: #fff1f1;\n  --ok: #00a870;\n  --warn: #e89f36;\n  --radius: 16px;\n  --radius-sm: 4px;\n  --topbar-h: 68px;\n  --rail-w: 239px;\n  --list-w: 520px;\n  --shadow-card: 0 10px 40px rgba(34, 36, 40, 0.08);\n  --shadow-pop: 0 12px 32px rgba(34, 36, 40, 0.14);\n}\n\n* { box-sizing: border-box; }\n\n[hidden] { display: none !important; }\n\nhtml, body {\n  height: 100%;\n  margin: 0;\n}\n\nbody {\n  background: var(--bg);\n  color: var(--text);\n  font-family: \"PingFang SC\", \"PingFangSC-Regular\", -apple-system, BlinkMacSystemFont,\n    \"Microsoft YaHei\", \"Segoe UI\", \"Hiragino Sans GB\", \"Noto Sans SC\", sans-serif;\n  font-size: 14px;\n  line-height: 1.55;\n  -webkit-font-smoothing: antialiased;\n  overflow: hidden;\n}\n\n.sprite { display: none; }\n\nsvg {\n  width: 16px;\n  height: 16px;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.7;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n  flex: 0 0 auto;\n}\n\ncode {\n  font-family: ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace;\n  font-size: 0.92em;\n  background: var(--panel-2);\n  border: 1px solid var(--border);\n  color: var(--text-2);\n  padding: 0 5px;\n  border-radius: 3px;\n}\n\n/* ------------------------------ 通用按钮 ------------------------------ */\n\n.btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  border: 1px solid transparent;\n  border-radius: var(--radius-sm);\n  padding: 7px 14px;\n  font-size: 13px;\n  font-weight: 400;\n  font-family: inherit;\n  color: var(--text);\n  background: var(--panel);\n  cursor: pointer;\n  transition: background 0.15s, border-color 0.15s, color 0.15s;\n  white-space: nowrap;\n}\n.btn svg { width: 14px; height: 14px; }\n\n.btn-primary {\n  background: var(--brand);\n  color: #fff;\n  font-size: 15px;\n}\n.btn-primary:hover { background: var(--brand-deep); }\n\n.btn-ghost {\n  background: var(--panel);\n  border-color: var(--border);\n  color: var(--text-2);\n}\n.btn-ghost:hover { border-color: var(--brand); color: var(--brand); }\n\n.btn-block { width: 100%; height: 45px; font-size: 15px; letter-spacing: 1px; }\n.btn-sm { padding: 4px 10px; font-size: 12px; }\n\n.icon-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  border: 0;\n  border-radius: var(--radius-sm);\n  background: transparent;\n  color: var(--text-2);\n  cursor: pointer;\n  transition: background 0.15s, color 0.15s;\n}\n.icon-btn svg { width: 17px; height: 17px; }\n.icon-btn:hover { background: rgba(98, 123, 246, 0.12); color: var(--brand); }\n.icon-btn.icon-danger:hover { background: var(--danger-soft); color: var(--danger); }\n\n/* 文字型工具按钮（2925 的「删除 / 回复 / 全部已读」） */\n.tool-btn {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  height: 28px;\n  padding: 0 10px;\n  border: 0;\n  border-radius: var(--radius-sm);\n  background: transparent;\n  color: var(--text-2);\n  font: inherit;\n  font-size: 13px;\n  cursor: pointer;\n  transition: background 0.15s, color 0.15s;\n}\n.tool-btn:hover { background: var(--panel-2); color: var(--text); }\n.tool-btn.is-danger:hover { background: var(--danger-soft); color: var(--danger); }\n\n.only-mobile { display: none !important; }\n\n/* ------------------------------ 登录页 ------------------------------ */\n\n.login {\n  position: fixed;\n  inset: 0;\n  display: grid;\n  place-items: center;\n  padding: 24px;\n  background: #f3f4fa;\n  z-index: 20;\n  overflow: auto;\n}\n\n.login-wrap {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) 420px;\n  width: min(1040px, 100%);\n  min-height: 620px;\n  background: var(--panel);\n  border-radius: var(--radius);\n  box-shadow: var(--shadow-card);\n  overflow: hidden;\n}\n\n.login-hero {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  padding: 44px 48px;\n  color: #fff;\n  background:\n    radial-gradient(560px 420px at 108% -12%, rgba(255, 255, 255, 0.26), transparent 62%),\n    radial-gradient(420px 320px at -12% 108%, rgba(255, 255, 255, 0.18), transparent 60%),\n    linear-gradient(150deg, #7489f8 0%, #627bf6 48%, #4d67e4 100%);\n  overflow: hidden;\n}\n.login-hero::after {\n  content: \"\";\n  position: absolute;\n  right: -120px;\n  bottom: -160px;\n  width: 420px;\n  height: 420px;\n  border: 1px solid rgba(255, 255, 255, 0.18);\n  border-radius: 50%;\n  box-shadow: 0 0 0 38px rgba(255, 255, 255, 0.06), 0 0 0 76px rgba(255, 255, 255, 0.04);\n}\n\n.hero-top { display: flex; align-items: center; gap: 10px; position: relative; z-index: 1; }\n.hero-brand { font-size: 17px; font-weight: 600; letter-spacing: 0.04em; }\n\n.logo-mark {\n  width: 36px;\n  height: 36px;\n  border-radius: 10px;\n  display: grid;\n  place-items: center;\n  font-size: 22px;\n  line-height: 1;\n  color: #fff;\n  background: rgba(255, 255, 255, 0.2);\n  border: 1px solid rgba(255, 255, 255, 0.34);\n}\n.logo-mark.sm {\n  width: 44px;\n  height: 44px;\n  margin: 0 auto 14px;\n  font-size: 26px;\n  border-radius: 12px;\n  color: var(--brand);\n  background: var(--brand-soft-2);\n  border: 1px solid #dfe4ff;\n}\n\n.hero-body { margin-top: auto; margin-bottom: auto; padding: 40px 0 30px; position: relative; z-index: 1; }\n.hero-eyebrow {\n  margin: 0 0 14px;\n  font-size: 13px;\n  letter-spacing: 0.08em;\n  color: rgba(255, 255, 255, 0.78);\n}\n.hero-body h1 {\n  margin: 0 0 16px;\n  font-size: 34px;\n  line-height: 1.38;\n  font-weight: 600;\n  letter-spacing: 0.01em;\n}\n.hero-desc {\n  margin: 0 0 28px;\n  max-width: 430px;\n  font-size: 14px;\n  line-height: 1.9;\n  color: rgba(255, 255, 255, 0.82);\n}\n.hero-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }\n.hero-list li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: rgba(255, 255, 255, 0.9); }\n.hero-tick {\n  width: 18px;\n  height: 18px;\n  border-radius: 50%;\n  display: grid;\n  place-items: center;\n  background: rgba(255, 255, 255, 0.18);\n}\n.hero-tick svg { width: 11px; height: 11px; stroke-width: 2.6; }\n\n.hero-foot {\n  position: relative;\n  z-index: 1;\n  margin: 0;\n  font-size: 12px;\n  letter-spacing: 0.04em;\n  color: rgba(255, 255, 255, 0.55);\n}\n\n.login-card {\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n  padding: 40px 44px;\n  background: var(--panel);\n  overflow: auto;\n}\n.login-card h2 { margin: 0 0 6px; text-align: center; font-size: 21px; font-weight: 600; }\n.login-sub { margin: 0 0 26px; text-align: center; font-size: 13px; color: var(--muted); }\n\n.inputbox {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  height: 44px;\n  padding: 0 12px;\n  border: 2px solid var(--border);\n  border-radius: 5px;\n  background: var(--panel);\n  transition: border-color 0.15s;\n  margin-bottom: 14px;\n}\n.inputbox:focus-within { border-color: var(--brand); }\n.inputbox-icon { color: var(--muted); }\n.inputbox input {\n  flex: 1;\n  min-width: 0;\n  height: 100%;\n  border: 0;\n  outline: none;\n  background: transparent;\n  color: var(--text);\n  font: inherit;\n  font-size: 14px;\n}\n.inputbox input::placeholder { color: #bfc4d2; }\n\n.login-hint {\n  margin: 18px 0 0;\n  font-size: 12px;\n  line-height: 1.8;\n  color: var(--muted);\n  text-align: center;\n}\n.login-hint.error { color: var(--danger); }\n\n/* ------------------------------ 顶栏 ------------------------------ */\n\n.app {\n  display: flex;\n  flex-direction: column;\n  height: 100dvh;\n}\n\n.topbar {\n  height: var(--topbar-h);\n  flex: 0 0 auto;\n  display: flex;\n  align-items: center;\n  gap: 14px;\n  padding: 0 20px;\n  background: var(--bg);\n  z-index: 5;\n}\n\n.brand { display: flex; align-items: center; gap: 9px; flex: 0 0 auto; }\n\n.brand-mark {\n  width: 32px;\n  height: 32px;\n  border-radius: 9px;\n  display: grid;\n  place-items: center;\n  font-size: 20px;\n  line-height: 1;\n  color: #fff;\n  background: linear-gradient(150deg, #7f92f9, var(--brand));\n}\n\n.brand-name { font-size: 16px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }\n\n.account { display: flex; align-items: center; gap: 8px; min-width: 0; }\n\n.domain-chip {\n  font-size: 12.5px;\n  color: var(--text-2);\n  background: rgba(255, 255, 255, 0.72);\n  border: 1px solid var(--border);\n  padding: 3px 10px;\n  border-radius: 999px;\n  cursor: pointer;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  max-width: 260px;\n  transition: border-color 0.15s, color 0.15s;\n}\n.domain-chip:hover { border-color: var(--brand); color: var(--brand); }\n.domain-chip:empty { display: none; }\n\n.domain-switch { display: inline-flex; align-items: center; }\n.domain-select {\n  appearance: none;\n  -webkit-appearance: none;\n  font: inherit;\n  font-size: 12.5px;\n  color: var(--text-2);\n  background: rgba(255, 255, 255, 0.72);\n  border: 1px solid var(--border);\n  border-radius: 999px;\n  padding: 4px 26px 4px 12px;\n  cursor: pointer;\n  max-width: 280px;\n  text-overflow: ellipsis;\n  background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2352575f' stroke-width='2.2' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\");\n  background-repeat: no-repeat;\n  background-position: right 9px center;\n  outline: none;\n}\n.domain-select:hover { border-color: var(--brand); color: var(--brand); }\n.domain-select:focus-visible { box-shadow: 0 0 0 3px var(--brand-soft); }\n\n.topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; min-width: 0; }\n\n.searchbox { position: relative; width: 300px; max-width: 34vw; }\n.searchbox-icon {\n  position: absolute;\n  left: 12px;\n  top: 50%;\n  transform: translateY(-50%);\n  width: 15px;\n  height: 15px;\n  color: var(--muted);\n}\n.searchbox input {\n  width: 100%;\n  height: 34px;\n  padding: 0 12px 0 34px;\n  border-radius: 999px;\n  border: 1px solid transparent;\n  background: rgba(255, 255, 255, 0.78);\n  color: var(--text);\n  font-family: inherit;\n  font-size: 13px;\n  outline: none;\n  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;\n}\n.searchbox input::placeholder { color: #a8adbd; }\n.searchbox input:focus {\n  background: #fff;\n  border-color: var(--brand);\n  box-shadow: 0 0 0 3px var(--brand-soft);\n}\n.searchbox input::-webkit-search-cancel-button { cursor: pointer; }\n\n.topbar-actions { display: flex; gap: 2px; }\n\n/* ------------------------------ 外壳 ------------------------------ */\n\n.shell {\n  flex: 1 1 auto;\n  min-height: 0;\n  display: flex;\n  padding-top: 2px;\n  background: var(--bg);\n}\n\n/* ------------------------------ 左侧导航 ------------------------------ */\n\n.sidebar {\n  width: var(--rail-w);\n  flex: 0 0 var(--rail-w);\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  padding-bottom: 6px;\n}\n\n.side-cta {\n  margin: 0 12px 12px;\n  height: 38px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 7px;\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);\n  background: #fff;\n  color: var(--brand);\n  font: inherit;\n  font-size: 14px;\n  cursor: pointer;\n  transition: background 0.15s, border-color 0.15s;\n}\n.side-cta:hover { background: var(--brand-soft-2); border-color: #d7def0; }\n.side-cta svg { width: 15px; height: 15px; }\n\n.side-nav { flex: 0 0 auto; }\n\n.nav-item {\n  position: relative;\n  width: 100%;\n  height: 36px;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 0 20px;\n  border: 0;\n  background: transparent;\n  color: var(--text);\n  font: inherit;\n  font-size: 14px;\n  cursor: pointer;\n  text-align: left;\n  transition: background 0.12s, color 0.12s;\n}\n.nav-item:hover { background: var(--bg-hover); }\n.nav-item.active { background: var(--brand-soft); color: var(--brand); }\n.nav-ico { width: 16px; height: 16px; color: var(--muted); }\n.nav-item:hover .nav-ico { color: var(--text-2); }\n.nav-item.active .nav-ico { color: var(--brand); }\n.nav-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.nav-count {\n  font-size: 12px;\n  color: var(--brand);\n  flex: 0 0 auto;\n}\n\n.side-section {\n  margin-top: 14px;\n  flex: 1 1 auto;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n.side-section-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 0 20px 6px;\n  font-size: 12px;  color: var(--muted);\n}\n\n.pill {\n  min-width: 18px;\n  height: 18px;\n  padding: 0 6px;\n  border-radius: 999px;\n  background: rgba(255, 255, 255, 0.8);\n  color: var(--text-2);\n  font-size: 11px;\n  line-height: 18px;\n  text-align: center;\n}\n\n.alias-list {\n  flex: 1 1 auto;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  scrollbar-width: thin;\n  scrollbar-color: #cdd3e3 transparent;\n  padding-bottom: 6px;\n}\n\n.alias-item {\n  position: relative;\n  height: 40px;\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  padding: 0 16px 0 20px;\n  cursor: pointer;\n  transition: background 0.12s;\n  animation: fadeIn 0.2s ease;\n}\n.alias-item:hover { background: var(--bg-hover); }\n.alias-item.active { background: var(--brand-soft); }\n.alias-item.active .alias-name { color: var(--brand); }\n\n@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }\n\n.alias-online {\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: #c3c9d8;\n  flex: 0 0 auto;\n}\n.alias-item.active .alias-online { background: var(--brand); }\n\n.alias-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }\n.alias-name {\n  font-size: 14px;\n  color: var(--text);\n  line-height: 18px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.alias-note {\n  font-size: 11px;\n  line-height: 14px;\n  color: var(--muted);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.badge {\n  min-width: 18px;\n  font-size: 12px;\n  color: var(--brand);\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  flex: 0 0 auto;\n}\n.badge:empty, .badge[data-zero=\"1\"] { display: none; }\n\n.alias-tools { display: none; gap: 0; flex: 0 0 auto; }\n.alias-item:hover .alias-tools { display: flex; }\n.alias-item:hover .badge { display: none; }\n.alias-tools .icon-btn { width: 24px; height: 24px; border-radius: 4px; }\n.alias-tools .icon-btn svg { width: 14px; height: 14px; }\n\n.alias-add {\n  display: flex;\n  gap: 6px;\n  padding: 10px 12px 0;\n  margin-top: 2px;\n}\n.alias-add input {\n  flex: 1;\n  min-width: 0;\n  height: 34px;\n  padding: 0 10px;\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);\n  background: rgba(255, 255, 255, 0.8);\n  color: var(--text);\n  font-family: inherit;\n  font-size: 13px;\n  outline: none;\n}\n.alias-add input::placeholder { color: #a8adbd; }\n.alias-add input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); background: #fff; }\n.alias-add-btn {\n  width: 34px;\n  height: 34px;\n  flex: 0 0 auto;\n  display: grid;\n  place-items: center;\n  border: 0;\n  border-radius: var(--radius-sm);\n  background: var(--brand);\n  color: #fff;\n  cursor: pointer;\n  transition: background 0.15s;\n}\n.alias-add-btn:hover { background: var(--brand-deep); }\n.alias-add-btn svg { width: 16px; height: 16px; }\n\n.sidebar-foot {\n  padding: 12px 20px 4px;\n  display: grid;\n  gap: 3px;\n  font-size: 11.5px;\n  color: var(--muted);\n}\n.foot-row { display: flex; justify-content: space-between; gap: 10px; }\n.foot-row b { color: var(--text-2); font-weight: 500; }\n.foot-row.live { align-items: center; gap: 6px; justify-content: flex-start; margin-top: 3px; }\n.foot-row.live .dot {\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: #c3c9d8;\n  transition: background 0.2s;\n}\n.foot-row.live.online .dot { background: var(--ok); }\n.foot-row.live.online #live-text { color: var(--ok); }\n\n/* ------------------------------ 白色工作区 ------------------------------ */\n\n.workspace {\n  flex: 1 1 auto;\n  min-width: 0;\n  display: flex;\n  background: var(--panel);\n  border-radius: var(--radius) 0 0 0;\n  overflow: hidden;\n}\n\n.panes {\n  flex: 1 1 auto;\n  min-height: 0;\n  display: grid;\n  grid-template-columns: var(--list-w) minmax(0, 1fr);\n}\n\n/* ------------------------------ 列表 ------------------------------ */\n\n.list {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  min-width: 0;\n  border-right: 1px solid var(--border);\n}\n\n.list-head {\n  height: 48px;\n  flex: 0 0 auto;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 0 16px 0 20px;\n  border-bottom: 1px solid var(--border);\n}\n.list-title-wrap { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }\n.list-title-wrap h2 {\n  margin: 0;\n  font-size: 15px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.list-sub { font-size: 12px; color: var(--muted); white-space: nowrap; }\n.list-head-actions { display: flex; gap: 2px; }\n\n.list-body {\n  flex: 1 1 auto;\n  overflow-y: auto;\n  scrollbar-width: thin;\n  scrollbar-color: #d7dbe6 transparent;\n}\n\n.msg-row {\n  position: relative;\n  display: grid;\n  grid-template-columns: 24px 88px minmax(0, 1fr) auto 52px;\n  align-items: center;\n  gap: 8px;\n  height: 44px;\n  padding: 0 16px 0 18px;\n  border-bottom: 1px solid #f2f4f9;\n  cursor: pointer;\n  transition: background 0.12s;\n}\n.msg-row:hover { background: var(--panel-2); }\n.msg-row.active { background: var(--brand-soft); }\n\n.msg-avatar {\n  width: 24px;\n  height: 24px;\n  border-radius: 50%;\n  display: grid;\n  place-items: center;\n  font-size: 11px;\n  color: #fff;\n  background: #b9c4e8;\n  overflow: hidden;\n}\n.msg-row.unread .msg-avatar { background: var(--brand); }\n\n.msg-from {\n  font-size: 14px;\n  color: var(--text-2);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.msg-row.unread .msg-from { color: var(--text); }\n\n.msg-body {\n  display: flex;\n  align-items: baseline;\n  gap: 14px;\n  min-width: 0;\n  overflow: hidden;\n}\n.msg-subject {\n  flex: 0 0 auto;\n  max-width: 62%;\n  font-size: 14px;\n  color: var(--text);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.msg-row.unread .msg-subject { font-weight: 600; }\n.msg-row:not(.unread) .msg-subject { color: var(--text-2); }\n.msg-snippet {\n  flex: 1 1 0;\n  min-width: 0;\n  font-size: 13px;\n  color: var(--muted);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.msg-flags { display: flex; align-items: center; gap: 5px; }\n.msg-flags svg { width: 13px; height: 13px; color: var(--muted); }\n.unread-dot {\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: var(--brand);\n  flex: 0 0 auto;\n}\n\n.msg-time {\n  font-size: 12px;\n  color: var(--muted);\n  text-align: right;\n  white-space: nowrap;\n}\n\n.empty {\n  padding: 64px 26px;\n  text-align: center;\n  animation: fadeIn 0.3s;\n}\n.empty-art {\n  width: 52px;\n  height: 52px;\n  margin: 0 auto 14px;\n  border-radius: 14px;\n  display: grid;\n  place-items: center;\n  background: var(--brand-soft-2);\n  color: var(--brand);\n}\n.empty-art svg { width: 24px; height: 24px; }\n.empty-title { margin: 0 0 6px; font-size: 14px; font-weight: 600; }\n.empty-sub { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.8; }\n\n/* ------------------------------ 阅读区 ------------------------------ */\n\n.reader {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  min-width: 0;\n  background: var(--panel);\n}\n\n.reader-empty {\n  margin: auto;\n  max-width: 460px;\n  padding: 40px 32px;\n  text-align: center;\n}\n.reader-empty-art {\n  width: 56px;\n  height: 56px;\n  margin: 0 auto 16px;\n  border-radius: 16px;\n  display: grid;\n  place-items: center;\n  background: var(--brand-soft-2);\n  color: var(--brand);\n}\n.reader-empty-art svg { width: 26px; height: 26px; }\n.reader-empty h2 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }\n.reader-empty p { margin: 0 0 22px; color: var(--muted); font-size: 13px; line-height: 1.8; }\n\n.reader-address {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  justify-content: space-between;\n  background: var(--panel-2);\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);\n  padding: 6px 6px 6px 14px;\n  margin-bottom: 24px;\n}\n.reader-address code {\n  background: none;\n  border: 0;\n  padding: 0;\n  font-size: 13px;\n  color: var(--text);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.reader-steps {\n  text-align: left;\n  margin: 0;\n  padding-left: 18px;\n  color: var(--text-2);\n  font-size: 13px;\n  line-height: 1.9;\n}\n.reader-steps li { margin-bottom: 4px; }\n.reader-steps li::marker { color: var(--brand); }\n.reader-steps code { font-size: 12px; }\n\n.reader-article {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  height: 100%;\n  animation: fadeIn 0.2s;\n}\n\n.reader-toolbar {\n  height: 48px;\n  flex: 0 0 auto;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 0 12px;\n  border-bottom: 1px solid var(--border);\n}\n.tool-spacer { flex: 1 1 auto; }\n\n.reader-head {\n  flex: 0 0 auto;\n  padding: 20px 24px 16px;\n}\n.reader-subject {\n  margin: 0 0 14px;\n  font-size: 19px;\n  line-height: 1.5;\n  font-weight: 600;\n  word-break: break-word;\n}\n\n.meta-rows { display: grid; gap: 6px; }\n.meta-row { display: flex; gap: 10px; font-size: 13px; line-height: 21px; }\n.meta-label { flex: 0 0 48px; color: var(--muted); }\n.meta-value {\n  display: flex;\n  align-items: baseline;\n  gap: 6px;\n  flex-wrap: wrap;\n  min-width: 0;\n  color: var(--text);\n}\n.meta-value b { font-weight: 500; }\n.meta-addr { color: var(--muted); font-size: 12.5px; }\n\n.attachments {\n  flex: 0 0 auto;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n  padding: 12px 24px;\n  border-top: 1px solid #f2f4f9;\n  border-bottom: 1px solid #f2f4f9;\n  background: var(--panel-2);\n}\n.attachment {\n  display: inline-flex;\n  align-items: center;\n  gap: 7px;\n  max-width: 280px;\n  padding: 5px 10px;\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);\n  background: var(--panel);\n  color: var(--text-2);\n  font-size: 12.5px;\n  text-decoration: none;\n  transition: border-color 0.15s, color 0.15s;\n}\n.attachment:hover { border-color: var(--brand); color: var(--brand); }\n.attachment svg { width: 13px; height: 13px; }\n.attachment .att-size { color: var(--muted); font-size: 11.5px; }\n.attachment .att-name {\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  max-width: 180px;\n}\n\n.reader-body {\n  flex: 1 1 auto;\n  min-height: 0;\n  display: flex;\n  border-top: 1px solid #f2f4f9;\n}\n.mail-frame { flex: 1; width: 100%; border: 0; background: #fff; }\n.mail-text {\n  margin: 0;\n  padding: 20px 24px;\n  flex: 1;\n  overflow: auto;\n  white-space: pre-wrap;\n  word-break: break-word;\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 13px;\n  line-height: 1.75;\n  color: var(--text);\n}\n\n/* ------------------------------ 弹窗 ------------------------------ */\n\n.dialog {\n  border: 0;\n  border-radius: 8px;\n  padding: 0;\n  width: min(480px, calc(100vw - 32px));\n  background: var(--panel);\n  color: var(--text);\n  box-shadow: var(--shadow-pop);\n}\n.dialog::backdrop { background: rgba(34, 36, 40, 0.42); }\n.dialog form { padding: 0; }\n.dialog-head {\n  display: flex;\n  align-items: center;\n  padding: 16px 20px;\n  border-bottom: 1px solid var(--border);\n}\n.dialog-head h3 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; }\n\n.dialog-body { padding: 4px 20px 8px; max-height: min(70vh, 620px); overflow: auto; }\n\n.field { display: block; padding: 14px 0 0; }\n.field > span { display: block; font-size: 13px; margin-bottom: 7px; color: var(--text-2); }\n.field input,\n.field select {\n  width: 100%;\n  height: 38px;\n  padding: 0 11px;\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);\n  background: var(--panel);\n  color: var(--text);\n  font-family: inherit;\n  font-size: 13px;\n  outline: none;\n}\n.field select { padding-right: 26px; }\n.field input:focus,\n.field select:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }\n.field small { display: block; margin-top: 7px; font-size: 11.5px; color: var(--muted); line-height: 1.7; }\n\n.domain-manage { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }\n.domain-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 7px 10px;\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);\n  background: var(--panel-2);\n  font-size: 12.5px;\n}\n.domain-row .dom-name { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.domain-row .dom-count { color: var(--muted); font-size: 11.5px; }\n.domain-row .icon-btn { width: 24px; height: 24px; }\n.domain-row .icon-btn svg { width: 14px; height: 14px; }\n.domain-add { display: flex; gap: 6px; }\n.domain-add input { flex: 1; }\n\n.dialog-info {\n  margin: 16px 0 4px;\n  padding: 10px 12px;\n  border-radius: var(--radius-sm);\n  background: var(--panel-2);\n  border: 1px solid var(--border);\n  font-size: 12px;\n  color: var(--text-2);\n  line-height: 1.9;\n  word-break: break-all;\n}\n.dialog-info code { font-size: 11.5px; }\n\n.dialog-foot {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n  padding: 14px 20px 18px;\n  border-top: 1px solid var(--border);\n}\n.dialog-foot .btn { height: 34px; padding: 0 18px; font-size: 13px; }\n.dialog-foot .btn-primary { height: 34px; font-size: 13px; }\n\n/* ------------------------------ Toast / 遮罩 ------------------------------ */\n\n.toast {\n  position: fixed;\n  left: 50%;\n  bottom: 28px;\n  transform: translate(-50%, 12px);\n  background: #222428;\n  color: #fff;\n  padding: 9px 16px;\n  border-radius: var(--radius-sm);\n  font-size: 13px;\n  box-shadow: var(--shadow-pop);\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.2s, transform 0.2s;\n  z-index: 50;\n  max-width: calc(100vw - 40px);\n}\n.toast.show { opacity: 1; transform: translate(-50%, 0); }\n.toast.error { background: var(--danger); }\n/* 原生对话框在 top layer，普通 z-index 压不过它；用 popover 让提示也进 top layer */\n.toast[popover] {\n  inset: auto auto 28px 50%;\n  margin: 0;\n  border: 0;\n  max-width: min(80vw, 520px);\n  text-align: center;\n}\n.toast[popover]:not(:popover-open) { display: none; }\n\n.scrim {\n  position: fixed;\n  inset: 0;\n  background: rgba(34, 36, 40, 0.4);\n  z-index: 8;\n  animation: fadeIn 0.2s;\n}\n\n/* ------------------------------ 响应式 ------------------------------ */\n\n@media (max-width: 1280px) {\n  :root { --list-w: 460px; }\n  .searchbox { width: 240px; }\n}\n\n@media (max-width: 1080px) {\n  :root { --list-w: 380px; }\n  .msg-row { grid-template-columns: 24px 74px minmax(0, 1fr) auto 48px; gap: 7px; padding: 0 12px 0 16px; }\n  .msg-snippet { display: none; }\n}\n\n@media (max-width: 880px) {\n  :root { --rail-w: 264px; }\n  .only-mobile { display: inline-flex !important; }\n  .brand-name { display: none; }\n  .domain-chip { max-width: 150px; }\n  .searchbox { width: 160px; max-width: 40vw; }\n\n  .shell { position: relative; padding-top: 0; }\n  .workspace { border-radius: 0; }\n\n  .panes { grid-template-columns: minmax(0, 1fr); position: relative; }\n\n  .sidebar {\n    position: fixed;\n    top: 0;\n    bottom: 0;\n    left: 0;\n    z-index: 9;\n    background: var(--bg);\n    transform: translateX(-102%);\n    transition: transform 0.24s cubic-bezier(0.3, 0.9, 0.3, 1);\n    box-shadow: var(--shadow-pop);\n    padding-top: 16px;\n  }\n  body.sidebar-open .sidebar { transform: none; }\n\n  .reader {\n    position: absolute;\n    inset: 0;\n    z-index: 4;\n    display: none;\n  }\n  body.reader-open .reader { display: flex; }\n  body.reader-open .list { display: none; }\n\n  .msg-row { grid-template-columns: 26px 78px minmax(0, 1fr) auto 52px; }\n  .msg-snippet { display: none; }\n}\n\n@media (max-width: 560px) {\n  .login-wrap { grid-template-columns: 1fr; min-height: 0; }\n  .login-hero { display: none; }\n  .login-card { padding: 40px 24px; }\n  .domain-chip { display: none; }\n  .searchbox { width: 140px; }\n  .topbar { padding: 0 12px; gap: 8px; }\n  .searchbox input { font-size: 16px; }\n  .reader-head { padding: 16px 16px 12px; }\n  .reader-subject { font-size: 17px; }\n  .reader-toolbar { padding: 0 8px; }\n  .reader-empty { padding: 28px 18px; }\n}\n\n/* ============================================================================\n   多用户扩展：登录分栏 / 邮箱树 / 管理后台\n   ============================================================================ */\n\n/* ------------------------------ 登录：Tab 与表单 ------------------------------ */\n\n.auth-tabs {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 2px;\n  padding: 3px;\n  margin-bottom: 20px;\n  background: #f2f4fa;\n  border-radius: 6px;\n}\n.auth-tab {\n  height: 34px;\n  border: 0;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--text-2);\n  font: inherit;\n  font-size: 14px;\n  cursor: pointer;\n  transition: background 0.15s, color 0.15s;\n}\n.auth-tab:hover { color: var(--text); }\n.auth-tab.active {\n  background: var(--panel);\n  color: var(--brand);\n  font-weight: 600;\n  box-shadow: 0 1px 3px rgba(34, 36, 40, 0.1);\n}\n\n.auth-form { display: flex; flex-direction: column; }\n\n/* 注册前的邮箱验证 */\n.verify-block { margin-top: 12px; }\n.verify-panel {\n  margin-top: 10px;\n  padding: 12px 14px;\n  border: 1px solid var(--border);\n  border-radius: 8px;\n  background: var(--bg-hover);\n}\n.verify-tip { margin: 0 0 8px; font-size: 12px; line-height: 1.7; color: var(--text-2); }\n.verify-tip b { color: var(--text); }\n.verify-addr {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 7px 10px;\n  background: #fff;\n  border: 1px solid var(--border);\n  border-radius: 6px;\n}\n.verify-addr code {\n  flex: 1 1 auto;\n  min-width: 0;\n  font-size: 12px;\n  color: var(--brand);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.verify-state { margin: 8px 0 0; font-size: 12px; color: var(--muted); }\n.verify-panel.is-ok { border-color: #b7e2c8; background: #f2fbf5; }\n.verify-panel.is-ok .verify-state { color: #237a4b; font-weight: 600; }\n.verify-panel.is-expired { border-color: #f0c8c8; background: #fdf4f4; }\n.verify-panel.is-expired .verify-state { color: var(--danger); }\n\n/* 账号设置：只读绑定行 + 换绑面板 */\n.bind-row { display: flex; align-items: center; gap: 8px; }\n.bind-row input { flex: 1 1 auto; min-width: 0; }\n.bind-row .btn { flex: 0 0 auto; }\n.rebind-panel {\n  margin-top: 10px;\n  padding: 12px;\n  border: 1px solid var(--border);\n  border-radius: 8px;\n  background: var(--bg-hover);\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.rebind-panel input { width: 100%; }\n.rebind-line { display: flex; gap: 8px; flex-wrap: wrap; }\n.rebind-panel .verify-state { margin: 0; }\n\n/* 验证码输入行 + 忘记密码链接 */\n.verify-code-row { display: flex; gap: 8px; align-items: center; }\n.verify-code-row input {\n  flex: 1 1 auto;\n  min-width: 0;\n  letter-spacing: 4px;\n  font-variant-numeric: tabular-nums;\n}\n.verify-code-row .btn { flex: 0 0 auto; }\n.auth-link {\n  align-self: center;\n  margin-top: 2px;\n  background: none;\n  border: 0;\n  color: var(--brand);\n  font-size: 12.5px;\n  cursor: pointer;\n  padding: 4px 6px;\n}\n.auth-link:hover { text-decoration: underline; }\n\n.inputbox-suffix {\n  flex: 0 0 auto;\n  font-size: 13px;\n  color: var(--muted);\n  white-space: nowrap;\n  padding-left: 8px;\n  border-left: 1px solid var(--border);\n  margin-left: 2px;\n}\n.mailbox-box input { font-weight: 600; }\n\n.agree {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  margin: 2px 0 16px;\n  font-size: 12px;\n  line-height: 1.6;\n  color: var(--muted);\n  cursor: pointer;\n}\n.agree input { margin: 2px 0 0; accent-color: var(--brand); }\n\n.login-hint code {\n  padding: 1px 5px;\n  border-radius: 3px;\n  background: #f2f4fa;\n  color: var(--text-2);\n  font-size: 11.5px;\n}\n\n/* ------------------------------ 顶栏：账号 ------------------------------ */\n\n.user-chip {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  padding: 4px 12px 4px 4px;\n  border-radius: 999px;\n  background: var(--panel);\n  border: 1px solid var(--border);\n  min-width: 0;\n}\n.user-avatar {\n  width: 28px;\n  height: 28px;\n  flex: 0 0 auto;\n  border-radius: 50%;\n  display: grid;\n  place-items: center;\n  font-size: 13px;\n  font-weight: 600;\n  color: #fff;\n  background: var(--brand);\n}\n.user-meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }\n.user-meta b {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--text);\n  max-width: 150px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.user-meta small {\n  font-size: 11px;\n  color: var(--muted);\n  max-width: 170px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n/* ------------------------------ 侧栏：邮箱树 ------------------------------ */\n\n.mailbox-list { display: grid; gap: 1px; padding: 2px 0 6px; }\n\n.side-empty {\n  margin: 6px 20px;\n  font-size: 12px;\n  line-height: 1.7;\n  color: var(--muted);\n}\n\n.mb-item { border-radius: 0; }\n.mb-row {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  width: 100%;\n  min-height: 44px;\n  padding: 5px 16px 5px 18px;\n  border: 0;\n  background: transparent;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n  color: var(--text);\n}\n.mb-row:hover { background: var(--bg-hover); }\n.mb-item.active > .mb-row { background: var(--brand-soft); }\n\n.mb-avatar {\n  width: 26px;\n  height: 26px;\n  flex: 0 0 auto;\n  border-radius: 7px;\n  display: grid;\n  place-items: center;\n  font-size: 12px;\n  font-weight: 600;\n  color: #fff;\n}\n.mb-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }\n.mb-name {\n  font-size: 13px;\n  font-weight: 500;\n  color: var(--text);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.mb-at { color: var(--muted); font-weight: 400; }\n.mb-note {\n  font-size: 11px;\n  color: var(--muted);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.mb-badge,\n.sub-badge {\n  flex: 0 0 auto;\n  min-width: 18px;\n  height: 18px;\n  padding: 0 5px;\n  border-radius: 9px;\n  background: var(--brand);\n  color: #fff;\n  font-size: 11px;\n  line-height: 18px;\n  text-align: center;\n}\n.mb-item.active > .mb-row .mb-badge { background: #fff; color: var(--brand); }\n\n.mb-subs {\n  position: relative;\n  margin: 0 0 4px 31px;\n  padding-left: 9px;\n  border-left: 1px solid var(--border);\n  display: grid;\n}\n.sub-row {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  height: 28px;\n  padding: 0 10px;\n  border: 0;\n  border-radius: 4px;\n  background: transparent;\n  font: inherit;\n  font-size: 12px;\n  color: var(--text-2);\n  text-align: left;\n  cursor: pointer;\n  min-width: 0;\n}\n.sub-row:hover { background: var(--bg-hover); }\n.sub-row.active { background: var(--brand-soft); color: var(--brand); }\n.sub-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.sub-at { color: var(--muted); }\n.sub-row.active .sub-at { color: var(--brand); }\n.sub-badge { background: var(--brand-soft); color: var(--brand); min-width: 16px; height: 16px; line-height: 16px; font-size: 10px; }\n.sub-del {\n  flex: 0 0 auto;\n  width: 16px;\n  height: 16px;\n  line-height: 15px;\n  border-radius: 4px;\n  text-align: center;\n  font-size: 13px;\n  color: var(--muted);\n  opacity: 0;\n}\n.sub-row:hover .sub-del { opacity: 1; }\n.sub-del:hover { background: #fde8e8; color: #d14343; }\n\n/* 对话框里的分段选择 */\n.seg {\n  display: flex;\n  gap: 4px;\n  padding: 3px;\n  margin-bottom: 14px;\n  background: var(--bg-hover);\n  border-radius: 8px;\n}\n.seg-item {\n  flex: 1 1 0;\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  height: 30px;\n  border-radius: 6px;\n  font-size: 13px;\n  color: var(--text-2);\n  cursor: pointer;\n  user-select: none;\n}\n.seg-item input { position: absolute; opacity: 0; pointer-events: none; }\n.seg-item:has(input:checked) {\n  background: #fff;\n  color: var(--brand);\n  font-weight: 600;\n  box-shadow: 0 1px 3px rgba(20, 30, 60, 0.1);\n}\n.seg-item.is-off { opacity: 0.4; cursor: not-allowed; }\n.addr-preview {\n  margin-top: 8px;\n  font-size: 12px;\n  color: var(--muted);\n  word-break: break-all;\n}\n.addr-preview b { color: var(--text); font-weight: 600; }\n\n/* ------------------------------ 管理后台 ------------------------------ */\n\n.admin {\n  position: fixed;\n  inset: 0;\n  z-index: 60;\n  display: flex;\n  flex-direction: column;\n  background: #f4f6fb;\n  overflow: hidden;\n}\n.admin[hidden] { display: none; }\n\n.admin-head {\n  flex: 0 0 auto;\n  height: 68px;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 0 28px;\n  background: var(--panel);\n  border-bottom: 1px solid var(--border);\n}\n.admin-title { display: flex; align-items: center; gap: 12px; }\n.admin-badge {\n  width: 36px;\n  height: 36px;\n  border-radius: 10px;\n  display: grid;\n  place-items: center;\n  background: var(--brand-soft);\n  color: var(--brand);\n}\n.admin-badge svg { width: 18px; height: 18px; }\n.admin-title h1 { margin: 0; font-size: 17px; font-weight: 600; }\n.admin-title p { margin: 2px 0 0; font-size: 12px; color: var(--muted); }\n.admin-head-actions { display: flex; gap: 8px; }\n.admin-head-actions .btn { height: 32px; font-size: 13px; }\n\n.admin-body {\n  flex: 1 1 auto;\n  overflow: auto;\n  padding: 20px 28px 48px;\n  display: grid;\n  gap: 16px;\n  align-content: start;\n}\n\n.stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }\n.stat-card {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 16px 18px;\n  background: var(--panel);\n  border-radius: 12px;\n  box-shadow: 0 1px 2px rgba(34, 36, 40, 0.06);\n}\n.stat-label { font-size: 12px; color: var(--muted); }\n.stat-value { font-size: 24px; font-weight: 600; letter-spacing: -0.01em; }\n.stat-note { font-size: 11.5px; color: var(--muted); }\n\n.admin-card {\n  background: var(--panel);\n  border-radius: 12px;\n  padding: 16px 18px;\n  box-shadow: 0 1px 2px rgba(34, 36, 40, 0.06);\n}\n.admin-card-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n  margin-bottom: 10px;\n}\n.admin-card-head h2 { margin: 0; font-size: 14px; font-weight: 600; }\n.admin-card-foot { display: flex; justify-content: flex-end; margin-top: 12px; }\n\n.admin-search {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  height: 30px;\n  padding: 0 10px;\n  border: 1px solid var(--border);\n  border-radius: 4px;\n  background: var(--panel);\n}\n.admin-search svg { width: 14px; height: 14px; color: var(--muted); }\n.admin-search input { border: 0; outline: none; background: transparent; font: inherit; font-size: 13px; width: 210px; }\n\n.admin-table-wrap { overflow-x: auto; }\n.admin-table { width: 100%; border-collapse: collapse; font-size: 13px; }\n.admin-table th {\n  padding: 8px 10px;\n  text-align: left;\n  font-size: 11.5px;\n  font-weight: 500;\n  color: var(--muted);\n  white-space: nowrap;\n  border-bottom: 1px solid var(--border);\n}\n.admin-table td { padding: 10px; border-bottom: 1px solid #f0f2f8; vertical-align: middle; }\n.admin-table tr:last-child td { border-bottom: 0; }\n.admin-table tr.is-off td { opacity: 0.55; }\n.ta-r { text-align: right; }\n.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }\n.dim { color: var(--muted); }\n.admin-empty { text-align: center; color: var(--muted); padding: 24px; }\n\n.admin-user { display: flex; align-items: center; gap: 9px; min-width: 0; }\n.admin-avatar {\n  width: 30px;\n  height: 30px;\n  flex: 0 0 auto;\n  border-radius: 50%;\n  display: grid;\n  place-items: center;\n  font-size: 12px;\n  font-weight: 600;\n  color: #fff;\n}\n.admin-user-meta { display: flex; flex-direction: column; line-height: 1.35; min-width: 0; }\n.admin-user-meta b { font-size: 13px; }\n.admin-user-meta small { font-size: 11.5px; color: var(--muted); }\n.admin-user-meta em { font-style: normal; color: var(--brand); }\n\n.tag {\n  display: inline-block;\n  padding: 1px 7px;\n  border-radius: 3px;\n  font-size: 11.5px;\n  line-height: 18px;\n}\n.tag-on { background: #e8f7ef; color: #2ba471; }\n.tag-off { background: var(--danger-soft); color: var(--danger); }\n\n.row-actions { display: inline-flex; gap: 6px; justify-content: flex-end; }\n.mini-btn {\n  height: 26px;\n  padding: 0 9px;\n  border: 1px solid var(--border);\n  border-radius: 4px;\n  background: var(--panel);\n  color: var(--text-2);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.mini-btn:hover { border-color: var(--brand); color: var(--brand); }\n.mini-btn.danger:hover { border-color: var(--danger); color: var(--danger); }\n\n.mini-dot {\n  display: inline-block;\n  min-width: 16px;\n  height: 16px;\n  padding: 0 4px;\n  border-radius: 8px;\n  background: var(--brand-soft);\n  color: var(--brand);\n  font-size: 10.5px;\n  line-height: 16px;\n  text-align: center;\n}\n\n.admin-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }\n\n.admin-domains { display: grid; gap: 2px; }\n.domain-row {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 9px 0;\n  border-bottom: 1px solid #f0f2f8;\n  font-size: 13px;\n}\n.domain-row:last-child { border-bottom: 0; }\n.domain-name { display: flex; align-items: center; gap: 7px; font-weight: 500; min-width: 0; }\n.domain-name svg { width: 15px; height: 15px; color: var(--muted); }\n.domain-meta { flex: 1 1 auto; font-size: 11.5px; color: var(--muted); }\n.domain-add { display: flex; gap: 8px; margin-top: 12px; }\n.domain-add input {\n  flex: 1;\n  height: 32px;\n  padding: 0 10px;\n  border: 1px solid var(--border);\n  border-radius: 4px;\n  font: inherit;\n  font-size: 13px;\n  outline: none;\n}\n.domain-add input:focus { border-color: var(--brand); }\n\n.switch-list { display: grid; }\n.switch-row {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n  padding: 11px 0;\n  border-bottom: 1px solid #f0f2f8;\n  font-size: 13px;\n  cursor: pointer;\n}\n.switch-row:last-child { border-bottom: 0; }\n.switch-row b { font-weight: 500; }\n.switch-row small { display: block; margin-top: 2px; font-size: 11.5px; color: var(--muted); }\n.switch-row input[type=\"checkbox\"] { width: 36px; height: 20px; accent-color: var(--brand); flex: 0 0 auto; }\n.num-input {\n  width: 84px;\n  height: 30px;\n  padding: 0 8px;\n  border: 1px solid var(--border);\n  border-radius: 4px;\n  font: inherit;\n  font-size: 13px;\n  outline: none;\n}\n.num-input:focus { border-color: var(--brand); }\n\n/* ------------------------------ 一邮多用：外部邮箱 ------------------------------ */\n\n.link-btn {\n  border: 0;\n  background: transparent;\n  font: inherit;\n  font-size: 12px;\n  color: var(--brand);\n  cursor: pointer;\n  padding: 2px 4px;\n  border-radius: 4px;\n}\n.link-btn:hover { background: var(--brand-soft); }\n\n.ext-list { display: grid; gap: 1px; padding: 2px 0 6px; overflow-y: auto; min-height: 0; }\n\n/* 侧栏两段内容都可能在窄屏里超高：各段自己滚动，别互相盖住 */\n.sidebar { overflow: hidden; }\n.mailbox-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }\n.side-section--ext { flex: 0 1 auto; max-height: 46%; }\n\n.ext-item { display: flex; align-items: center; }\n.ext-item:hover { background: var(--bg-hover); }\n.ext-item.active { background: var(--brand-soft); }\n\n.ext-row {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  flex: 1 1 auto;\n  min-width: 0;\n  padding: 6px 4px 6px 18px;\n  border: 0;\n  background: transparent;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n  color: var(--text);\n}\n\n.ext-badge {\n  flex: 0 0 auto;\n  min-width: 34px;\n  padding: 2px 6px;\n  border-radius: 4px;\n  background: var(--brand-soft);\n  color: var(--brand);\n  font-size: 11px;\n  font-weight: 600;\n  text-align: center;\n  letter-spacing: 0.2px;\n}\n\n.ext-body { display: flex; flex-direction: column; min-width: 0; }\n.ext-addr {\n  font-size: 12.5px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.ext-note { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n\n.ext-del {\n  flex: 0 0 auto;\n  width: 26px;\n  height: 26px;\n  margin-right: 8px;\n  opacity: 0;\n  transition: opacity 0.12s;\n}\n.ext-item:hover .ext-del { opacity: 1; }\n.ext-del svg { width: 14px; height: 14px; }\n.ext-del:hover { color: var(--danger); }\n\n.msg-ext {\n  display: inline-block;\n  margin-right: 6px;\n  padding: 1px 5px;\n  border-radius: 3px;\n  background: var(--brand-soft);\n  color: var(--brand);\n  font-size: 10.5px;\n  font-weight: 600;\n  vertical-align: 1px;\n}\n\n.reader-ext {\n  margin: -4px 0 14px;\n  font-size: 12px;\n  color: var(--muted);\n}\n.reader-ext b { color: var(--brand); font-weight: 600; }\n\n.ext-intro {\n  font-size: 12.5px;\n  line-height: 1.8;\n  color: var(--text-2);\n  background: var(--panel-2);\n  border-radius: 8px;\n  padding: 12px 14px;\n}\n\n.ext-tip:not(:empty) {\n  margin-top: 10px;\n  font-size: 12px;\n  line-height: 1.75;\n  color: var(--brand);\n  background: var(--brand-soft);\n  border-radius: 6px;\n  padding: 9px 12px;\n}\n\n.ext-existing { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 12px; }\n.ext-existing-head { font-size: 12px; color: var(--muted); margin-bottom: 8px; }\n.ext-empty { font-size: 12px; color: var(--muted); }\n\n.ext-card {\n  border: 1px solid var(--border);\n  border-radius: 8px;\n  padding: 10px 12px;\n  margin-bottom: 8px;\n}\n.ext-card-head { display: flex; align-items: center; gap: 8px; font-size: 13px; min-width: 0; }\n.ext-card-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.ext-card-count { margin-left: auto; font-size: 11.5px; color: var(--muted); flex: 0 0 auto; }\n.ext-card-intake { display: flex; align-items: center; gap: 8px; margin-top: 8px; }\n.ext-card-intake code {\n  flex: 1 1 auto;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  padding: 5px 8px;\n  background: var(--panel-2);\n  border-radius: 4px;\n  font-size: 12px;\n}\n.ext-card-hint { margin: 8px 0 0; font-size: 11.5px; line-height: 1.75; color: var(--muted); }\n.ext-card-foot { margin-top: 8px; display: flex; justify-content: flex-end; }\n\n.mini-btn.is-danger:hover { border-color: var(--danger); color: var(--danger); }\n\n.dialog-info.is-ok { color: var(--brand); }\n.dialog-info.is-error { color: var(--danger); }\n\n.msg-ext.is-plain {\n  background: #eef0f6;\n  color: var(--text-2);\n  font-weight: 500;\n}\n\n.field-hint {\n  display: block;\n  margin-top: 6px;\n  padding: 8px 10px;\n  background: var(--brand-soft);\n  border-radius: 8px;\n  color: var(--text-2);\n  line-height: 1.6;\n}\n.field-hint code {\n  background: #fff;\n  border-radius: 4px;\n  padding: 1px 5px;\n  color: var(--brand-deep);\n  font-size: 12px;\n}\n\n.mb-catch-icon {\n  width: 15px;\n  height: 15px;\n  fill: none;\n  stroke: #fff;\n  stroke-width: 1.9;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n}\n.mb-item.is-catchall .mb-name { font-weight: 600; }\n\n.dropped-list { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px; }\n.dropped-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 12px;\n  color: var(--muted);\n  margin-bottom: 8px;\n}\n.dropped-row {\n  display: flex;\n  align-items: baseline;\n  gap: 10px;\n  padding: 6px 0;\n  border-bottom: 1px dashed #eef0f6;\n  font-size: 12px;\n}\n.dropped-row:last-child { border-bottom: 0; }\n.dropped-row code { color: var(--brand); flex: 0 0 auto; }\n.dropped-sub { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.dropped-from { color: var(--muted); flex: 0 0 auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n\n/* ------------------------------ 响应式补充 ------------------------------ */\n\n@media (max-width: 1080px) {\n  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n  .admin-two { grid-template-columns: minmax(0, 1fr); }\n}\n\n@media (max-width: 880px) {\n  .user-meta { display: none; }\n  .user-chip { padding: 4px; }\n  .admin-head { height: 60px; padding: 0 14px; }\n  .admin-title p { display: none; }\n  .admin-head-actions .btn svg { margin-right: 0; }\n  .admin-body { padding: 14px 12px 40px; }\n  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }\n  .admin-search input { width: 120px; }\n}\n\n@media (max-width: 560px) {\n  .login-card { padding: 32px 20px 36px; }\n  .admin-table th:nth-child(2),\n  .admin-table td:nth-child(2),\n  .admin-table th:nth-child(6),\n  .admin-table td:nth-child(6) { display: none; }\n  .stat-value { font-size: 20px; }\n}\n"};

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
