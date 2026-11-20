// ============================================================================
//  test/edge-cases.mjs —— 各种“脏”邮件的解析回归测试
//  需要服务已启动（默认 SMTP 127.0.0.1:2525，API 127.0.0.1:8787）
//  用法：ACCESS_TOKEN=<口令> node test/edge-cases.mjs
// ============================================================================

import net from 'node:net';

const HOST = process.env.SMTP_HOST || '127.0.0.1';
const PORT = Number(process.env.SMTP_PORT || 2525);
const API = process.env.API_BASE || 'http://127.0.0.1:8787';
const TOKEN = process.env.ACCESS_TOKEN || process.argv[2];

if (!TOKEN) {
  console.error('用法：ACCESS_TOKEN=<root 口令> node test/edge-cases.mjs');
  process.exit(1);
}

// 多用户版：先以 root 登录，再建一个临时主邮箱专门收这些测试信
const anon = await fetch(API + '/api/bootstrap')
  .then((r) => r.json())
  .catch(() => ({}));
const DOMAIN = anon.domain || 'test.local';

const loginRes = await fetch(API + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `admin@${DOMAIN}`, password: TOKEN }),
});
if (!loginRes.ok) {
  console.error(`root 登录失败：HTTP ${loginRes.status} ${await loginRes.text()}`);
  process.exit(1);
}
const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

const PREFIX = 'edge' + Date.now().toString(36).slice(-6);
const created = await fetch(API + '/api/mailboxes', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ name: PREFIX, domain: DOMAIN }),
}).then((r) => r.json());
if (!created.ok) {
  console.error(`建测试邮箱失败：${created.error}`);
  process.exit(1);
}

/* ------------------------------ 迷你 SMTP 客户端 ------------------------------ */

function smtpSend({ to, from = 'edgy@example.com', data }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, HOST);
    socket.setEncoding('latin1');
    let buffer = '';
    let stage = 0;

    const steps = [
      () => socket.write(`MAIL FROM:<${from}>\r\n`),
      () => socket.write(`RCPT TO:<${to}>\r\n`),
      () => socket.write('DATA\r\n'),
      () => socket.write(data + '\r\n.\r\n'),
      () => socket.write('QUIT\r\n'),
    ];

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        if (/^\d{3}-/.test(line)) continue;
        const code = Number(line.slice(0, 3));
        if (code >= 400) {
          socket.destroy();
          reject(new Error(`SMTP 拒绝（${stage}）：${line}`));
          return;
        }
        if (stage === 0 && code === 220) {
          socket.write('EHLO edge.test\r\n');
          stage = 1;
          continue;
        }
        const step = steps[stage - 1];
        if (step) step();
        stage += 1;
        if (stage > steps.length) {
          socket.end();
          resolve(true);
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error('SMTP 超时'));
    });
  });
}

/* ------------------------------ 待测邮件 ------------------------------ */

const gbkB64 = (bytes) => Buffer.from(bytes).toString('base64');
const gbkSubject = gbkB64([0xb2, 0xe2, 0xca, 0xd4, 0xd6, 0xf7, 0xcc, 0xe2]); // 测试主题
const gbkFrom = gbkB64([0xb2, 0xe2, 0xca, 0xd4, 0xb7, 0xa2, 0xbc, 0xfe, 0xc8, 0xcb]); // 测试发件人

const cases = [
  {
    name: 'GBK 编码的标题与正文（QP）',
    to: 'gbk@' + DOMAIN,
    raw: [
      `From: =?GBK?B?${gbkFrom}?= <gbk@example.com>`,
      `To: <gbk@${DOMAIN}>`,
      `Subject: =?GBK?B?${gbkSubject}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="gbk"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=C4=E3=BA=C3=A3=AC=CA=C0=BD=E7',
    ].join('\r\n'),
    expect: (d) => ({
      subject: d.subject === '测试主题',
      body: d.text.includes('你好，世界'),
      fromName: d.from.name === '测试发件人',
    }),
  },
  {
    name: '完全没有 Content-Type 头（默认纯文本）',
    to: 'bare@' + DOMAIN,
    raw: ['From: bare@example.com', `To: <bare@${DOMAIN}>`, 'Subject: plain ascii mail', '', 'just a line of text'].join(
      '\r\n'
    ),
    expect: (d) => ({
      subject: d.subject === 'plain ascii mail',
      body: d.text.includes('just a line of text'),
    }),
  },
  {
    name: '只有 LF、没有 CR、8bit 中文',
    to: 'lf@' + DOMAIN,
    raw: [
      'From: "李雷" <li@example.com>',
      `To: <lf@${DOMAIN}>`,
      'Subject: LF only 邮件',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '这是 LF 换行的正文',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<b>加粗的 HTML</b>',
      '--b1--',
      '',
    ].join('\n'),
    expect: (d) => ({
      subject: d.subject === 'LF only 邮件',
      body: d.text.includes('LF 换行的正文'),
      html: d.html.includes('加粗'),
    }),
  },
];

/* ------------------------------ 执行 ------------------------------ */

const headers = { cookie };
let failed = 0;
let index = 0;

for (const testCase of cases) {
  try {
    // 每个用例发到不同的子地址，全部归到刚建的主邮箱
    const to = `${PREFIX}-${++index}@${DOMAIN}`;
    await smtpSend({ to, data: testCase.raw.replaceAll(testCase.to, to) });
    await new Promise((r) => setTimeout(r, 350));

    const res = await fetch(`${API}/api/messages?limit=200`, { headers });
    const { messages } = await res.json();
    const target = messages.find((m) => m.to === to);
    if (!target) throw new Error('列表里找不到刚发的邮件');

    const detail = await (await fetch(`${API}/api/messages/${target.id}`, { headers })).json();
    const checks = testCase.expect(detail.message);
    const bad = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);

    if (bad.length) {
      failed++;
      console.log(`❌ ${testCase.name} → 失败项：${bad.join(', ')}`);
      console.log(
        '   解析结果：',
        JSON.stringify({
          subject: detail.message.subject,
          from: detail.message.from,
          text: detail.message.text.slice(0, 80),
        })
      );
    } else {
      console.log(`✅ ${testCase.name}`);
    }
  } catch (err) {
    failed++;
    console.log(`❌ ${testCase.name} → ${err.message}`);
  }
}

console.log(failed ? `\n${failed} 个用例失败` : '\n全部用例通过');
process.exit(failed ? 1 : 0);
