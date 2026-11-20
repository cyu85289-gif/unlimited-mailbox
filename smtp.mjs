// ============================================================================
//  smtp.mjs —— 极简「收信」SMTP 服务器（只收不发，够用就好）
//  支持 EHLO / MAIL / RCPT / DATA / RSET / NOOP / QUIT，多收件人，dot-unstuffing
// ============================================================================

import net from 'node:net';

const CRLF = '\r\n';
const MAX_SIZE_DEFAULT = 25 * 1024 * 1024;

export function createSmtpServer({
  port = 2525,
  host = '0.0.0.0',
  domain = '',
  maxSize = MAX_SIZE_DEFAULT,
  onMessage,
  resolveRcpt, // (address) => true | string(错误提示)
  log = () => {},
}) {
  const resolveDomain = () => (typeof domain === 'function' ? domain() || '' : domain || '');
  const server = net.createServer((socket) => {
    socket.setEncoding('latin1');
    socket.setTimeout(180_000);

    let buffer = '';
    let inData = false;
    let dataChunks = [];
    let dataSize = 0;
    let from = '';
    let recipients = [];
    let helo = '';

    const reply = (line) => {
      if (!socket.destroyed) socket.write(line + CRLF);
    };

    const resetEnvelope = () => {
      from = '';
      recipients = [];
    };

    socket.on('timeout', () => {
      reply('421 4.4.2 Connection timed out, bye');
      socket.destroy();
    });
    socket.on('error', (err) => log('smtp socket error:', err.message));
    reply(`220 ${resolveDomain() || 'localhost'} ESMTP unlimited-mailbox ready`);

    socket.on('data', (chunk) => {
      buffer += chunk;
      processBuffer();
    });

    function processBuffer() {
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          const endLf = end === -1 ? buffer.indexOf('\n.\n') : -1;
          const nlEnd = buffer.startsWith('.\r\n') ? 0 : -1;
          if (nlEnd === 0) {
            // 空邮件：DATA 后立刻就是 "."
            buffer = buffer.slice(3);
            finishData([]);
            continue;
          }
          if (end === -1 && endLf === -1) return; // 等待更多数据
          const cut = end !== -1 ? end : endLf;
          const part = buffer.slice(0, cut);
          const consumed = end !== -1 ? cut + 5 : cut + 3;
          buffer = buffer.slice(consumed);
          dataChunks.push(part);
          dataSize += part.length;
          finishData(dataChunks);
          continue;
        }

        const nl = buffer.indexOf('\n');
        if (nl === -1) {
          if (buffer.length > 4096) {
            reply('500 5.5.2 Line too long');
            socket.destroy();
          }
          return;
        }
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        handleCommand(line);
      }
    }

    function finishData(chunks) {
      inData = false;
      const raw = chunks.join('');
      dataChunks = [];
      dataSize = 0;
      if (!recipients.length) {
        reply('503 5.5.1 No recipients given');
        resetEnvelope();
        return;
      }
      const bytes = Buffer.from(raw, 'latin1');
      Promise.resolve()
        .then(() => onMessage({ from, recipients: recipients.slice(), helo, raw: bytes }))
        .then(() => reply(`250 2.0.0 OK queued ${bytes.length} bytes`))
        .catch((err) => {
          log('smtp store error:', err);
          reply('451 4.3.0 Temporary storage failure, try again later');
        })
        .finally(resetEnvelope);
    }

    function handleCommand(line) {
      const sp = line.indexOf(' ');
      const cmd = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp === -1 ? '' : line.slice(sp + 1).trim();

      switch (cmd) {
        case 'HELO':
          helo = arg;
          reply(`250 ${resolveDomain() || 'localhost'}`);
          break;
        case 'EHLO':
          helo = arg;
          reply(
            [
              `250-${resolveDomain() || 'localhost'} greetings`,
              `250-SIZE ${maxSize}`,
              '250-8BITMIME',
              '250-SMTPUTF8',
              '250-PIPELINING',
              '250-ENHANCEDSTATUSCODES',
              '250 HELP',
            ].join(CRLF)
          );
          break;
        case 'MAIL': {
          if (recipients.length || from) resetEnvelope();
          const m = /^FROM:\s*<([^>]*)>(.*)$/i.exec(arg) || /^FROM:\s*(\S+)(.*)$/i.exec(arg);
          from = m ? m[1].trim() : '';
          const sizeMatch = /SIZE=(\d+)/i.exec(arg);
          if (sizeMatch && Number(sizeMatch[1]) > maxSize) {
            reply('552 5.3.4 Message too big');
            resetEnvelope();
            break;
          }
          reply('250 2.1.0 OK');
          break;
        }
        case 'RCPT': {
          const m = /^TO:\s*<([^>]*)>/i.exec(arg) || /^TO:\s*(\S+)/i.exec(arg);
          const addr = (m ? m[1] : '').trim().toLowerCase();
          if (!addr || !addr.includes('@')) {
            reply('501 5.1.3 Bad recipient address syntax');
            break;
          }
          const dom = resolveDomain().toLowerCase();
          if (dom && addr.split('@')[1] !== dom) {
            reply(`550 5.1.2 Only accepts mail for @${dom}`);
            break;
          }
          if (typeof resolveRcpt === 'function') {
            const verdict = resolveRcpt(addr);
            if (typeof verdict === 'string' && verdict) {
              reply(verdict);
              break;
            }
          }
          if (recipients.length >= 50) {
            reply('452 4.5.3 Too many recipients');
            break;
          }
          recipients.push(addr);
          reply('250 2.1.5 OK');
          break;
        }
        case 'DATA':
          if (!recipients.length) {
            reply('503 5.5.1 Need RCPT first');
            break;
          }
          inData = true;
          dataChunks = [];
          dataSize = 0;
          reply('354 End data with <CR><LF>.<CR><LF>');
          break;
        case 'RSET':
          resetEnvelope();
          reply('250 2.0.0 OK');
          break;
        case 'NOOP':
          reply('250 2.0.0 OK');
          break;
        case 'VRFY':
        case 'EXPN':
          reply('252 2.5.2 Cannot verify, will attempt delivery');
          break;
        case 'HELP':
          reply('214 Commands: EHLO MAIL RCPT DATA RSET NOOP QUIT');
          break;
        case 'QUIT':
          reply('221 2.0.0 Bye');
          socket.end();
          break;
        default:
          if (line) reply('500 5.5.2 Command unrecognized');
      }
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}


