// ============================================================================
//  test/seed-demo.mjs —— 往本地收件箱塞几封“看起来像真的”的邮件，方便看效果
//  用法：node test/seed-demo.mjs [--port 2525] [--domain inbox.example.com]
// ============================================================================

import net from 'node:net';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(arg('port', 2525));
const DOMAIN = arg('domain', 'inbox.example.com');
// 多用户版：邮件必须发给已经存在的邮箱，默认塞进 root 的主邮箱（admin）的子地址
const PREFIX = arg('prefix', 'admin');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encWord = (s) => `=?UTF-8?B?${b64(s)}?=`;
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

function sendRaw({ to, from, subject, html, text, attachment }) {
  const boundary = '----seed' + Math.random().toString(36).slice(2);
  const parts = [
    `From: ${from}`,
    `To: <${to}>`,
    `Subject: ${isAscii(subject) ? subject : encWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}${Math.random().toString(36).slice(2)}@demo.local>`,
    'MIME-Version: 1.0',
  ];

  if (attachment) {
    parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
    parts.push(`--${boundary}`, 'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64', '');
    parts.push(b64(html).replace(/(.{76})/g, '$1\r\n'));
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${attachment.type}; name="${encWord(attachment.name)}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${encWord(attachment.name)}"`, '');
    parts.push(Buffer.from(attachment.content).toString('base64').replace(/(.{76})/g, '$1\r\n'));
    parts.push(`--${boundary}--`, '');
  } else {
    parts.push('Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64', '');
    parts.push(b64(html).replace(/(.{76})/g, '$1\r\n'));
  }

  const data = parts.join('\r\n');

  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1');
    socket.setEncoding('latin1');
    let buffer = '';
    let stage = 0;
    const steps = [
      () => socket.write(`MAIL FROM:<${from.replace(/.*<([^>]+)>.*/, '$1')}>\r\n`),
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
        if (!line || /^\d{3}-/.test(line)) continue;
        const code = Number(line.slice(0, 3));
        if (code >= 400) {
          socket.destroy();
          reject(new Error(line));
          return;
        }
        if (stage === 0 && code === 220) {
          socket.write('EHLO seed.local\r\n');
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
  });
}

const shell = (title, bodyHtml) => `<div style="font-family:-apple-system,'Segoe UI','PingFang SC',sans-serif;color:#1a1d21;line-height:1.7">
  <div style="font-size:13px;color:#8b93a1;margin-bottom:18px">${title}</div>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #eef0f3;margin:26px 0 12px">
  <div style="font-size:11.5px;color:#9aa3b2">此邮件由系统自动发送，请勿直接回复。</div>
</div>`;

const demo = [
  {
    to: `${PREFIX}-github@${DOMAIN}`,
    from: 'GitHub <noreply@github.com>',
    subject: '[GitHub] Please verify your device',
    html: shell(
      'GitHub · 设备验证',
      `<p>你好，</p>
       <p>我们检测到有人从新的设备登录你的账号。如果这是你本人，请输入下面的验证码完成验证：</p>
       <p style="font-size:30px;font-weight:700;letter-spacing:8px;background:#f6f8fa;border:1px solid #e4e7ec;border-radius:10px;padding:14px 18px;display:inline-block">518204</p>
       <p>验证码 15 分钟内有效。如果这不是你，请立即修改密码。</p>`
    ),
  },
  {
    to: `${PREFIX}-taobao@${DOMAIN}`,
    from: '"淘宝网" <notice@taobao.com>',
    subject: '【淘宝】你的订单已发货',
    html: shell(
      '淘宝 · 交易物流',
      `<p>亲，你的订单 <b>#20481…7731</b> 已由顺丰速运揽收。</p>
       <table style="border-collapse:collapse;font-size:13px;margin:12px 0">
         <tr><td style="padding:4px 14px 4px 0;color:#8b93a1">商品</td><td>无线机械键盘 87 键</td></tr>
         <tr><td style="padding:4px 14px 4px 0;color:#8b93a1">运单号</td><td>SF1234567890123</td></tr>
         <tr><td style="padding:4px 14px 4px 0;color:#8b93a1">预计送达</td><td>明天 18:00 前</td></tr>
       </table>
       <p><a href="#" style="color:#4f46e5">查看物流详情</a></p>`
    ),
  },
  {
    to: `${PREFIX}-subs@${DOMAIN}`,
    from: 'Vercel <notifications@vercel.com>',
    subject: 'Deployment ready · mail-box',
    html: shell(
      'Vercel · 部署通知',
      `<p>Your deployment is ready.</p>
       <table style="border-collapse:collapse;font-size:13px;margin:12px 0">
         <tr><td style="padding:4px 14px 4px 0;color:#8b93a1">Project</td><td>mail-box</td></tr>
         <tr><td style="padding:4px 14px 4px 0;color:#8b93a1">Environment</td><td>Production</td></tr>
         <tr><td style="padding:4px 14px 4px 0;color:#8b93a1">Duration</td><td>18s</td></tr>
       </table>
       <p style="color:#16a34a">✓ Completed successfully</p>`
    ),
  },
  {
    to: `${PREFIX}-subs@${DOMAIN}`,
    from: 'Railway <billing@railway.app>',
    subject: '你的 9 月账单已生成',
    html: shell(
      'Railway · 账单',
      `<p>本期账单已生成，明细见附件。</p>
       <p style="font-size:22px;font-weight:700">¥ 128.00</p>`
    ),
    attachment: {
      name: '账单-2025-09.pdf',
      type: 'application/pdf',
      content: '%PDF-1.4\n% 演示用假 PDF，仅用于验证附件下载\n',
    },
  },
];

for (const item of demo) {
  try {
    await sendRaw(item);
    console.log(`✅ ${item.from} → ${item.to}：${item.subject}`);
  } catch (err) {
    console.error(`❌ ${item.subject}：${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 120));
}
