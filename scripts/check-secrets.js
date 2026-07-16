/**
 * 提交前 / CI：确保不会把本地密钥与竞品数据打进仓库
 * node scripts/check-secrets.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = 0;

function fail(msg) {
  console.error('  ✗', msg);
  failed++;
}
function ok(msg) {
  console.log('  ✓', msg);
}

console.log('\n========== 密钥与数据防泄漏检查 ==========\n');

// 1. 敏感路径不得存在于将提交的内容
const bannedPaths = [
  '.data',
  '.data/competitor-intel-config.json',
  '.data/competitor-intel.json',
  'dist',
  'node_modules',
];

for (const rel of bannedPaths) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    ok(`不存在（安全）: ${rel}`);
    continue;
  }
  // 若在 git 跟踪中则失败
  try {
    const tracked = execSync(`git ls-files --error-unmatch -- "${rel}"`, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    if (tracked) fail(`已被 git 跟踪（禁止）: ${rel}`);
    else ok(`本地存在但未跟踪: ${rel}`);
  } catch {
    ok(`本地存在但未跟踪: ${rel}`);
  }
}

// 2. 扫描将提交的文本文件，查找疑似真实 key
let files = [];
try {
  files = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  // 尚未 init git 时扫描源码树
  function walk(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.data' || name === 'dist' || name === '.git') continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, out);
      else out.push(path.relative(root, p));
    }
    return out;
  }
  files = walk(root);
}

const textExt = /\.(js|ts|json|md|html|css|yml|yaml|txt|sh|ps1|bat|example)$/i;
const patterns = [
  { re: /sk-[a-zA-Z0-9]{20,}/g, name: 'OpenAI-style sk- key' },
  { re: /sk-or-v1-[a-zA-Z0-9]{20,}/g, name: 'OpenRouter key' },
  { re: /["']apiKey["']\s*:\s*["'][^"']{12,}["']/g, name: 'hardcoded apiKey field' },
];

const allowFiles = new Set(['scripts/check-secrets.js', '.env.example', 'README.md']);

for (const rel of files) {
  if (!textExt.test(rel)) continue;
  if (allowFiles.has(rel)) continue;
  if (rel.startsWith('.data/') || rel.includes('node_modules/')) continue;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  // 忽略明显占位
  if (/your[_-]?api[_-]?key|sk-\.\.\.|placeholder|••••/i.test(content) && content.length < 5000) {
    // still scan for real looking keys
  }
  for (const { re, name } of patterns) {
    re.lastIndex = 0;
    const m = content.match(re);
    if (!m) continue;
    // 过滤明显假值
    const real = m.filter(
      (x) =>
        !/sk-\.\.\.|sk-xxxx|sk-test|your-?key|example|placeholder/i.test(x) &&
        !/apiKey["']\s*:\s*["']\s*["']/.test(x)
    );
    // apiKey: '' 空串允许
    const dangerous = real.filter((x) => {
      if (/apiKey/.test(x)) {
        const val = x.match(/:\s*["']([^"']*)["']/);
        if (!val || !val[1] || val[1].length < 8) return false;
        if (/^(test|xxx|your|demo)/i.test(val[1])) return false;
      }
      return true;
    });
    if (dangerous.length) {
      fail(`${rel}: 疑似 ${name} → ${dangerous[0].slice(0, 24)}…`);
    }
  }
}

// 3. .gitignore 必须覆盖敏感目录
const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
for (const must of ['.data/', 'node_modules/', 'dist/', '.env']) {
  ok(gi.includes(must) || gi.includes(must.replace(/\/$/, '')), `.gitignore 含 ${must}`);
  if (!(gi.includes(must) || gi.includes(must.replace(/\/$/, '')))) fail(`.gitignore 缺少 ${must}`);
}

console.log('');
if (failed) {
  console.error(`防泄漏检查失败：${failed} 项\n`);
  process.exit(1);
}
console.log('防泄漏检查通过\n');
