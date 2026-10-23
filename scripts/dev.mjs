/**
 * dev 启动包装器 —— 让本地开发时「服务端 fetch 也能走代理」。
 *
 * ------------------------------------------------------------------
 * 为什么要这个东西
 * ------------------------------------------------------------------
 * 浏览器能用代理访问 GitHub（系统代理开在 127.0.0.1:6864），
 * 但 Node 的内置 fetch 完全不认 Windows 系统代理。于是 GitHub OAuth 登录时：
 *
 *   ① 浏览器跳 GitHub 授权页          → 走代理，通 ✅
 *   ② 授权完带 code 回调 localhost
 *   ③ Auth.js 在服务端拿 code 去 github.com 换 access_token
 *      → Node 直连 github.com → 超时 ❌ CallbackRouteError
 *
 * ------------------------------------------------------------------
 * 解法：NODE_USE_ENV_PROXY
 * ------------------------------------------------------------------
 * Node 22.15+ / 24 内置支持这个开关：进程启动时读 HTTPS_PROXY / HTTP_PROXY /
 * NO_PROXY，自动给 http 请求和内置 fetch 挂上代理。零依赖，不需要装 undici。
 *
 * ⚠️ 关键限制：它**只在 Node 进程启动那一刻**读取。
 *    在 Next 内部（哪怕是 instrumentation.ts）再设置已经来不及了，实测无效。
 *    所以必须在「外层进程」里设好环境变量，再 spawn next dev ——
 *    子进程会继承父进程的 process.env。
 *
 * ------------------------------------------------------------------
 * 生产环境不受影响
 * ------------------------------------------------------------------
 * Vercel 上没有 HTTPS_PROXY，这个包装器什么都不做，直连。
 * 而且 Vercel 跑的是 npm run build / next start，不走这个脚本。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

/** 最简 .env 文件解析（这里还没进 Next，拿不到它的 env 加载） */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > -1) {
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const localEnv = {
  ...readEnvFile(path.join(root, '.env')),
  ...readEnvFile(path.join(root, '.env.local')), // local 优先级更高
};

const proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  localEnv.HTTPS_PROXY ||
  localEnv.https_proxy;

/**
 * 从 .env 里的 *_BASE_URL 提取主机名，加入 NO_PROXY（直连名单）。
 *
 * 为什么必须做这一步：
 *   DeepSeek / 硅基流动都是国内服务，走代理纯属绕远路（慢），
 *   更糟的是 —— 一旦代理软件关掉，连 AI 接口也一起发不出去了。
 *   把它们放进 NO_PROXY，AI 调用就和代理彻底解耦：
 *   代理挂了只是 GitHub 登录不能用，RAG 主链路照跑。
 */
const baseUrlHosts = Object.entries(localEnv)
  .filter(([k]) => /_BASE_URL$/i.test(k))
  .map(([, v]) => {
    try {
      return new URL(v).hostname;
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1'];

const noProxy = Array.from(
  new Set([...DEFAULT_NO_PROXY, ...baseUrlHosts, ...(process.env.NO_PROXY || '').split(',').map((s) => s.trim()).filter(Boolean)])
).join(',');

const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NODE_USE_ENV_PROXY', 'NO_PROXY'];

/**
 * 从一份 env 里把所有代理相关变量抹掉。
 *
 * ⚠️ 这里必须**原地 delete**。之前用 Object.assign(process.env, withoutProxy(...)) 是个 bug：
 * assign 只会覆盖/新增源里**存在**的 key，源里没有的 key 原样保留 ——
 * HTTPS_PROXY 根本删不掉，降级等于没降，Next 拿着死代理照样 ECONNREFUSED。
 * 和「对象展开同名 key 覆盖」同属一类：改对象前想清楚是要换整个对象，还是在原对象上增删。
 */
function clearProxyInPlace(env) {
  for (const k of PROXY_KEYS) delete env[k];
  return env;
}

/** 返回一份抹掉代理变量的副本（不动原对象） */
function withoutProxy(env) {
  return clearProxyInPlace({ ...env });
}

/**
 * 用子进程探一次 github.com。
 * 必须开子进程：NODE_USE_ENV_PROXY 只在进程启动那一刻读取，
 * 在本进程里设完再 fetch 是无效的（实测确认过）。
 */
function probe(env) {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      `fetch('https://github.com', { signal: AbortSignal.timeout(8000) })
         .then(r => console.log('HTTP ' + r.status))
         .catch(e => { console.log('FAILED ' + (e.cause?.code || e.message)); process.exit(1); })`,
    ],
    { env, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return { ok: r.status === 0, out: (r.stdout || '').trim() || (r.stderr || '').trim() || '(无输出)' };
}

if (proxy) {
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxy;
  process.env.NODE_USE_ENV_PROXY = '1';
  // 本地回环 + 国内 AI 接口走直连；其余（github.com）才走代理
  process.env.NO_PROXY = noProxy;

  const viaProxy = probe(process.env);

  if (viaProxy.ok) {
    console.log(
      `[dev] ✅ 服务端 fetch 走代理 ${proxy}（自检 ${viaProxy.out}）\n` +
        `[dev]    直连（不走代理）：${noProxy}`
    );
  } else {
    // 代理不通 —— 但国内访问 github.com 本来就是「时通时不通」，
    // 很多时候直连反而是好的。所以不要直接判死，先试直连。
    const viaDirect = probe(withoutProxy(process.env));

    if (viaDirect.ok) {
      // 降级为直连：把代理变量从 process.env 原地删掉，子进程就继承不到了
      clearProxyInPlace(process.env);
      console.warn(
        [
          '',
          `[dev] ⚠️  代理 ${proxy} 不可用（${viaProxy.out.replace('FAILED ', '')}）`,
          `[dev] ✅ 但直连 github.com 通（${viaDirect.out}）→ 本次启动自动降级为直连`,
          '[dev]    不用改 .env.local；哪天代理恢复，启动时会自己切回去。',
          '',
        ].join('\n')
      );
    } else {
      const code = viaProxy.out.replace('FAILED ', '');
      const hint =
        code === 'ECONNREFUSED'
          ? `代理软件没在运行（${proxy} 端口没人监听）。去开代理软件，或删掉 .env.local 里的 HTTPS_PROXY。`
          : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
            ? '代理软件开着，但连不上 github.com。试试换个节点，或检查订阅是否过期。'
            : '未知原因。手动测：curl -I -x ' + proxy + ' https://github.com';

      console.warn(
        [
          '',
          '==================================================================',
          '[dev] ⚠️  代理和直连都失败 —— GitHub 登录这一步会失败',
          '------------------------------------------------------------------',
          `[dev]    代理 ${proxy} → ${viaProxy.out}`,
          `[dev]    直连          → ${viaDirect.out}`,
          `[dev]    怎么修：${hint}`,
          '[dev]    注意：页面能打开 ≠ 登录能通。只有「服务端换 token」需要出网，',
          '[dev]          所以这个失败只在点登录时才暴露，平时看不出来。',
          '==================================================================',
          '',
        ].join('\n')
      );
    }
  }
} else {
  const direct = probe(withoutProxy(process.env));
  console.log(
    direct.ok
      ? `[dev] 未配置 HTTPS_PROXY，服务端 fetch 直连（自检 ${direct.out}）`
      : `[dev] ⚠️  未配置 HTTPS_PROXY，且直连 github.com 失败：${direct.out}\n[dev]    如需 GitHub 登录，在 .env.local 里配上 HTTPS_PROXY。`
  );
}

const nextBin = require.resolve('next/dist/bin/next');
const args = ['dev', ...process.argv.slice(2)];

const child = spawn(process.execPath, [nextBin, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

// 信号转发：Ctrl+C 打到这个包装器时，要传给真正的 next 进程
const forward = (signal) => () => child.kill(signal);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
