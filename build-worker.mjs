// ============================================================================
//  build-worker.mjs —— 把 MIME 解析器和网页资源内联进 worker.mjs
//  用法：node build-worker.mjs
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

const mime = await read('mime.mjs');
const template = await read('worker.template.mjs');

const assets = {};
for (const file of ['index.html', 'app.js', 'style.css']) {
  assets['/' + file] = await read(path.join('public', file));
}

let out = template;
out = out.replace('/*__MIME__*/', () => mime);
out = out.replace('/*__ASSETS__*/', () => `const ASSETS = ${JSON.stringify(assets)};`);

if (out.includes('/*__MIME__*/') || out.includes('/*__ASSETS__*/')) {
  throw new Error('模板占位符没有被全部替换');
}
if (/^\s*import\s/m.test(out)) {
  throw new Error('worker.mjs 不能包含 import 语句（Cloudflare 单文件粘贴需要自包含）');
}

const header = `// ============================================================================
//  worker.mjs —— 自动生成，请勿手改
//  源码：mime.mjs + worker.template.mjs + public/*（改完源码运行 node build-worker.mjs）
//  生成时间：${new Date().toISOString()}
//  总大小：约 ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB
// ============================================================================

`;

await writeFile(path.join(ROOT, 'worker.mjs'), header + out, 'utf8');

console.log(`✅ 已生成 worker.mjs（${(Buffer.byteLength(out) / 1024).toFixed(1)} KB）`);
console.log('   部署：Cloudflare 控制台 → Workers → 创建 → 粘贴 worker.mjs 全部内容 → 保存并部署');
