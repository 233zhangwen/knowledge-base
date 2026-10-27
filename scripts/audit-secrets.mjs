// 临时审计脚本：反查 .env.local 里每个值是否出现在 git 追踪文件中
// 用法：node scripts/audit-secrets.mjs   （只读，不改任何东西）
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const lines = fs.readFileSync('.env.local', 'utf8').split(/\r?\n/);
const mask = (v) => v.slice(0, 6) + '***(' + v.length + '字)';

for (const line of lines) {
  const m = line.match(/^([A-Z_]+)="?(.+?)"?\s*$/);
  if (!m) continue;
  const key = m[1];
  const val = m[2];
  if (key === 'HTTPS_PROXY' || val.length < 10) continue;
  let out = '';
  try {
    out = execSync('git grep -F -n -- ' + JSON.stringify(val), { encoding: 'utf8' });
  } catch {
    out = ''; // grep 无命中时退出码非 0
  }
  if (out.trim()) {
    const hits = [...new Set(out.trim().split('\n').map((l) => l.split(':')[0]))];
    console.log(`${key} ${mask(val)} -> 命中: ${hits.join(', ')}`);
  } else {
    console.log(`${key} ${mask(val)} -> 仓库内未命中`);
  }
}
