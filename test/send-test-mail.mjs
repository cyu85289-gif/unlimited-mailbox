// ============================================================================
//  test/send-test-mail.mjs —— 往自己的 SMTP 端口投递一封测试邮件
//  用法：node test/send-test-mail.mjs [--to shop@localhost] [--port 2525]
// ============================================================================

import net from 'node:net';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', 2525));
const TO = arg('to', 'shop@localhost');
const FROM = arg('from', 'sender@example.com');
const SUBJECT = arg('subject', '【测试】你好，无限邮箱');
const ENVELOPE_FROM = (FROM.match(/[^\s<>]+@[^\s<>]+/) || ['sender@example.com'])[0];

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encWord = (s) => `=?UTF-8?B?${b64(s)}?=`;

// 1x1 透明 PNG
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const html = `<div style="font-family:-apple-system,'PingFang SC',sans-serif;padding:8px 0">
  <h2 style="margin:0 0 12px;color:#4f46e5">你好，这是一封测试邮件 👋</h2>
  <p>如果你在网页收件箱里看到这段文字，说明整条链路是通的：</p>
  <ol style="line-height:1.9">
    <li>SMTP 收信 → 2. MIME 解析 → 3. SQLite 入库 → 4. 网页实时显示</li>
  </ol>
  <p>下面是一张内嵌图片（cid 方式）：</p>
  <p><img src="cid:pixel@mail-box" width="64" height="64"
        style="border:1px solid #e4e7ec;background:#eef2ff" alt="内嵌图片"></p>
  <p style="color:#6b7280;font-size:12px">验证码示例：<b style="font-size:20px;letter-spacing:4px;color:#111">246810</b></p>
</div>`;

const text = `你好，这是一封测试邮件。

如果你在网页收件箱里看到这段文字，说明整条链路是通的：
SMTP 收信 → MIME 解析 → SQLite 入库 → 网页实时显示。

验证码示例：246810
`;

const boundaryMix = '----mix_' + Math.random().toString(36).slice(2);
const boundaryAlt = '----alt_' + Math.random().toString(36).slice(2);
const boundaryRel = '----rel_' + Math.random().toString(36).slice(2);

const raw = [
  `From: ${FROM.includes('<') ? FROM : `"测试发件人" <${FROM}>`}`,
  `To: <${TO}>`,
  `Subject: ${/^[\x20-\x7e]*$/.test(SUBJECT) ? SUBJECT : encWord(SUBJECT)}`,
  `Date: ${new Date().toUTCString()}`,
  `Message-ID: <${Date.now()}@test.local>`,
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${boundaryMix}"`,
  '',
  `--${boundaryMix}`,
  `Content-Type: multipart/related; boundary="${boundaryRel}"`,
  '',
  `--${boundaryRel}`,
  `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
  '',
  `--${boundaryAlt}`,
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  `--${boundaryAlt}`,
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  `--${boundaryAlt}--`,
  '',
  `--${boundaryRel}`,
  'Content-Type: image/png; name="pixel.png"',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <pixel@mail-box>',
  'Content-Disposition: inline; filename="pixel.png"',
  '',
  PIXEL.toString('base64').replace(/(.{76})/g, '$1\r\n'),
  `--${boundaryRel}--`,
  '',
  `--${boundaryMix}`,
  `Content-Type: text/plain; charset="utf-8"; name="${encWord('说明.txt')}"`,
  'Content-Transfer-Encoding: base64',
  `Content-Disposition: attachment; filename="${encWord('说明.txt')}"`,
  '',
  b64('这是一个中文附件，用来验证附件解析。\n第二行内容。\n').replace(/(.{76})/g, '$1\r\n'),
  `--${boundaryMix}--`,
  '',
].join('\r\n');

const plan = [
  { line: 'EHLO test.local', expect: 250, label: 'EHLO' },
  { line: `MAIL FROM:<${ENVELOPE_FROM}>`, expect: 250, label: 'MAIL FROM' },
  { line: `RCPT TO:<${TO}>`, expect: 250, label: 'RCPT TO' },
  { line: 'DATA', expect: 354, label: 'DATA' },
  { line: raw.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n', expect: 250, label: '正文' },
  { line: 'QUIT', expect: 221, label: 'QUIT' },
];

const socket = net.connect(PORT, HOST);
socket.setEncoding('utf8');

let step = -1;
let buffer = '';
let finished = false;

function sendNext() {
  step += 1;
  if (step >= plan.length) return;
  const item = plan[step];
  console.log(`  → ${item.label}`);
  socket.write(item.line + '\r\n');
}

socket.on('connect', () => console.log(`已连接 ${HOST}:${PORT}`));

socket.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\r\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line) continue;
    console.log('  ←', line);
    if (/^\d{3}-/.test(line)) continue; // 多行响应的中间行
    const code = Number(line.slice(0, 3));

    if (step === -1) {
      if (code !== 220) return fail(`欢迎语异常：${line}`);
      return sendNext();
    }

    const item = plan[step];
    if (code !== item.expect) return fail(`${item.label} 失败：${line}`);

    if (item.label === '正文') {
      console.log('✅ 邮件已投递成功');
      finished = true;
    }
    sendNext();
  }
});

function fail(message) {
  console.error('❌ ' + message);
  process.exitCode = 1;
  socket.destroy();
}

socket.on('error', (err) => {
  console.error('❌ 连接失败：' + err.message);
  process.exitCode = 1;
});
socket.on('close', () => {
  if (!finished) {
    console.error('❌ 连接提前关闭');
    process.exitCode = 1;
  }
});

console.log(`正在投递测试邮件：${FROM} → ${TO}（${HOST}:${PORT}）`);

