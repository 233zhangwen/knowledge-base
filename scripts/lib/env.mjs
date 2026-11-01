/**
 * 极简 .env 加载器，给 scripts/ 下的脚本共用。
 *
 * 为什么不用 dotenv：脚本都是「零依赖」或「极轻依赖」，而这个需求只有 20 行。
 * 为什么要有这个文件：W16 之前每个脚本各自抄了一份 loadEnv，共 4 份 —— 又是一种漂移源
 * （其中一份漏了去引号，导致带空格的 key 在某个脚本里读出来是错的）。
 *
 * 规则：KEY=VALUE，忽略 # 注释与空行，值两侧的成对引号会被去掉。
 * **行内注释也要去**（本项目 .env.local 里就写着 `DATABASE_URL=... # 应用运行时用`）：
 * 只按「整行以 # 开头」判断，值里就会带上 ` # 应用运行时用`，连接串直接解析成
 * `host=base` 这种鬼东西 —— 症状是 P1001「连不上库」，看起来像网络问题，
 * 实际上是 20 行解析器的一个分支没写。踩过一次，写在这里。
 *
 * 不展开变量、不做 export、不覆盖已存在的 process.env（已设置的环境变量优先，
 * 这样 `LOG_LEVEL=info node ...` 这种临时覆盖才有效）。
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    let v = t.slice(i + 1).trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      // 引号包裹：值里可以有 # 和空格，只认到配对的收尾引号
      const end = v.indexOf(q, 1);
      v = end === -1 ? v.slice(1) : v.slice(1, end);
    } else {
      // 无引号：` #` 之后一律视为注释。用带空格的 ` #` 而不是裸 `#`，
      // 是因为 URL 里的 fragment 或密码可能含 #（虽然应当被 percent-encode）。
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

/** 加载项目根目录的 .env.local（不覆盖已有环境变量）。 */
export function loadProjectEnv(root = process.cwd()) {
  const env = loadEnv(path.join(root, '.env.local'));
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return env;
}
