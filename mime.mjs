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
