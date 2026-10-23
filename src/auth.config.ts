import type { NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';

/**
 * ⚠️ 这个文件必须保持 "Edge 安全"：
 *   不要 import Prisma，不要 import 任何 node-only 的包（fs、crypto、pg ...）。
 *
 * 原因：proxy.ts（Next 16 起 middleware 改叫 proxy）运行在 Edge Runtime，
 * 那里没有 Node API。一旦这里引入 Prisma，构建时就会报：
 *   "Module not found: Can't resolve 'fs'" 或 "PrismaClient is unable to run in this browser environment"
 *
 * 所以做法是把配置拆成两半：
 *   auth.config.ts —— 只有 provider / pages / authorized 回调（Edge 安全）
 *   auth.ts        —— 引入上面这份 + PrismaAdapter（运行在 Node Runtime）
 *
 * 这是 Auth.js v5 官方推荐的 split config 模式。
 */
export const authConfig = {
  providers: [GitHub],

  pages: {
    signIn: '/login', // 用我们自己的登录页，而不是 Auth.js 默认那张
  },

  /**
   * 必须是 jwt，且这份配置被 proxy 和 auth.ts 共用，所以策略要在这里声明。
   *
   * 为什么不能用 database：
   *   database 策略下 cookie 里放的是 Session 表的随机 token，
   *   每次「读 session」都要拿它查一次库。
   *   proxy 跑在 Edge Runtime，没有 adapter（Prisma 进不去），
   *   没有 adapter 时 Auth.js 默认按 jwt 解密 cookie ——
   *   拿一串随机 token 去 JWE 解密，必然报
   *   "JWEInvalid: Invalid Compact JWE"，然后所有已登录用户都被弹回登录页。
   *
   * jwt 策略下 cookie 本身就是 AUTH_SECRET 加密的会话，本地解密即可，
   * 不依赖数据库 —— 这才是 split config 能跑通的组合。
   *
   * 代价：服务端无法主动吊销某个设备的会话（MVP 接受，README Out of Scope 记一笔）。
   * 副作用：adapter 仍然会写 User/Account 表，但 Session 表将永远是空的。
   */
  session: {
    strategy: 'jwt',
  },

  callbacks: {
    /**
     * 只在 proxy.ts 里生效。返回 false → 重定向到 pages.signIn。
     * 注意：这里只做「有没有登录」这种粗判断，不查数据库。
     */
    authorized({ auth, request }) {
      const isLoggedIn = Boolean(auth?.user);
      const { pathname } = request.nextUrl;

      if (pathname.startsWith('/kb') && !isLoggedIn) {
        return false;
      }

      return true;
    },
  },
} satisfies NextAuthConfig;
