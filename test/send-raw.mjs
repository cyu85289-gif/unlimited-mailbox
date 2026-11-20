// 本地调试用：往本地 SMTP（默认 2526）投一封纯文本信，模拟「别人给我发信」
//   node test/send-raw.mjs --from a@qq.com --to verify-abc@example.com [--subject hi] [--port 2526]
import net from 'node:net';

const arg = (name, def = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};

const from = arg('from', 'tester@example.com');
const to = arg('to', '');
const subject = arg('subject', 'verify');
const port = Number(arg('port', '2526'));
const body = arg('body', 'hello');

if (!to) {
  console.error('缺少 --to');
  process.exit(1);
}

const raw = [
  `From: ${from}`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Date: ${new Date().toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  body,
  '',
].join('\r\n');

const steps = [
  { send: null, expect: '220' },
  { send: 'EHLO localhost', expect: '250' },
  { send: `MAIL FROM:<${from}>`, expect: '250' },
  { send: `RCPT TO:<${to}>`, expect: '250' },
  { send: 'DATA', expect: '354' },
  { send: `${raw}\r\n.`, expect: '250' },
  { send: 'QUIT', expect: '221' },
];

const sock = net.connect(port, '127.0.0.1');
let buf = '';
let i = 0;
let done = false;

sock.setEncoding('utf8');
sock.setTimeout(15000);

sock.on('data', (chunk) => {
  buf += chunk;
  if (!buf.includes('\r\n')) return;
  const line = buf.split('\r\n').filter(Boolean).pop() || '';
  const step = steps[i];
  if (step && !line.startsWith(step.expect)) {
    console.error(`第 ${i + 1} 步失败，期望 ${step.expect}，收到：${line}`);
    sock.destroy();
    process.exitCode = 1;
    return;
  }
  if (step && step.send) buf = '';
  i += 1;
  const next = steps[i];
  if (!next) {
    done = true;
    sock.end();
    return;
  }
  if (next.send === null) return;
  sock.write(`${next.send}\r\n`);
  buf = '';
});

sock.on('close', () => {
  if (!done) {
    console.error('连接提前关闭');
    process.exitCode = 1;
    return;
  }
  console.log(`已投递：${from} → ${to}`);
});

sock.on('timeout', () => {
  console.error('超时');
  sock.destroy();
  process.exitCode = 1;
});

sock.on('error', (err) => {
  console.error('连接失败：', err.message);
  process.exitCode = 1;
});
