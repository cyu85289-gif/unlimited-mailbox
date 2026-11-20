// ============================================================================
//  test/check-dns.mjs —— 检查域名收信配置是否已经切到 Cloudflare Email Routing
//  用法：node test/check-dns.mjs example.com
//  走 DNS-over-HTTPS，绕过本机代理/运营商 DNS 缓存，结果更可信
// ============================================================================

const DOMAIN = (process.argv[2] || 'example.com').trim().toLowerCase().replace(/\.$/, '');

const DOH = 'https://cloudflare-dns.com/dns-query';

async function query(name, type, tries = 3) {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/dns-json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const answer = (data.Answer || []).map((a) => a.data);
      if (answer.length) return answer;
      // 空结果也可能是抖动，等一下再试一次
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

const line = (ok, text, hint = '') => {
  console.log(`${ok === true ? '✅' : ok === 'warn' ? '⚠️ ' : '❌'} ${text}${hint ? `\n     ${hint}` : ''}`);
};

console.log(`\n检查域名：${DOMAIN}\n${'─'.repeat(52)}`);

const [ns, mx, txt] = await Promise.all([
  query(DOMAIN, 'NS').catch(() => []),
  query(DOMAIN, 'MX').catch(() => []),
  query(DOMAIN, 'TXT').catch(() => []),
]);

/* 1. 域名服务器 */
const cfNs = ns.filter((n) => n.includes('ns.cloudflare.com'));
if (cfNs.length) {
  line(true, `域名已托管在 Cloudflare（${cfNs.length} 个 NS）`, cfNs.join('  '));
} else {
  line(false, '域名还没接入 Cloudflare', ns.length ? `当前 NS：${ns.join(', ')}` : '查不到 NS 记录');
}

/* 2. MX 记录 */
const mxList = mx.map((m) => {
  const [pref, host] = m.split(/\s+/);
  return { pref: Number(pref), host: (host || '').replace(/\.$/, '') };
});
const cfMx = mxList.filter((m) => m.host.endsWith('.mx.cloudflare.net'));
const otherMx = mxList.filter((m) => !m.host.endsWith('.mx.cloudflare.net'));

if (cfMx.length >= 2) {
  line(true, `MX 已指向 Cloudflare Email Routing（${cfMx.length} 条）`, cfMx.map((m) => `${m.pref} ${m.host}`).join('   '));
} else if (!mxList.length) {
  line(false, '没有 MX 记录，现在收不到任何邮件');
} else {
  line(false, 'MX 还没切到 Cloudflare', mxList.map((m) => `${m.pref} ${m.host}`).join('   '));
}

if (otherMx.length) {
  line(
    'warn',
    `还有非 Cloudflare 的 MX：${otherMx.map((m) => m.host).join(', ')}`,
    '多个 MX 并存会让邮件随机投到两边；切到 Email Routing 后要删掉这些旧记录'
  );
}

/* 3. SPF */
const spf = txt.find((t) => /v=spf1/i.test(t));
if (spf) {
  const okSpf = spf.includes('_spf.mx.cloudflare.net');
  line(
    okSpf,
    `SPF：${spf}`,
    okSpf ? '' : '建议改成 v=spf1 include:_spf.mx.cloudflare.net ~all（Cloudflare 启用 Email Routing 时会自动加）'
  );
} else {
  line('warn', '没有 SPF 记录', 'Cloudflare 启用 Email Routing 时会自动添加 v=spf1 include:_spf.mx.cloudflare.net ~all');
}

/* 4. 结论 */
const ready = cfNs.length > 0 && cfMx.length >= 2 && otherMx.length === 0;
console.log(`${'─'.repeat(52)}`);
if (ready) {
  console.log(`\n🎉 ${DOMAIN} 的收信已经全部交给 Cloudflare 了。`);
  console.log('   下一步：确认 Email Routing 的 Catch-all 指向了 Worker，然后发一封测试邮件。\n');
} else {
  console.log('\n还没弄完。按顺序做：');
  if (!cfNs.length) console.log('  1) 把域名 NS 改到 Cloudflare');
  if (!cfMx.length) console.log('  2) Cloudflare → Email Routing → Enable Email Routing');
  if (otherMx.length) console.log('  3) 删掉旧的 MX 记录（腾讯企业邮那两条）');
  console.log('  4) Catch-all address → Send to a Worker → 选你的 Worker');
  console.log('  改完 DNS 一般 1~10 分钟生效，可以再跑一次这个脚本确认。\n');
}

process.exit(ready ? 0 : 1);
