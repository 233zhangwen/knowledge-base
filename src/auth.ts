import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';

import { authConfig } from '@/auth.config';
import { prisma } from '@/lib/prisma';

/**
 * 这一份运行在 Node Runtime（服务端 / Route Handler），
 * 所以可以放心用 PrismaAdapter 读写数据库。
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,

  adapter: PrismaAdapter(prisma),

  /**
   * session 策略在 auth.config.ts 里声明为 jwt（proxy 和这里共用一份配置）。
   * 注意：strategy 是 jwt 时 Session 表不会有记录，会话整个存在加密 cookie 里。
   */

  callbacks: {
    /**
     * ⚠️ 这行不能省。
     * `...authConfig` 展开后，如果这里直接写 `callbacks: { jwt, session }`，
     * 会把 authConfig.callbacks 整个覆盖掉 —— **这个实例就没有 authorized 回调了**。
     *
     * 会不会立刻出问题？在当前的 proxy.ts 写法下**不会**：
     *   proxy.ts 是 `NextAuth(authConfig).auth` —— 拿 authConfig 自己建的一个**独立实例**，
     *   不吃 auth.ts 的 callbacks，所以路由保护照常生效。
     *
     * 但这是一颗定时炸弹：一旦有人按「统一从 @/auth 导入」的思路把 proxy 改掉，
     * authorized 就凭空消失了 —— **不报错、不告警，路由保护静默失效，谁都能进 /kb。**
     *
     * 通用教训：JS 对象展开里同名 key 是**后者直接覆盖前者**，不做合并。
     * 配置合并场景必须写 `...prev.callbacks` 再追加（复杂场景用深合并）。
     */
    ...authConfig.callbacks,

    /**
     * jwt 策略下，token 才是会话的载体。
     * 登录那次（user 存在时）把数据库里的 user.id 塞进 token，
     * 之后每次请求 session 回调从 token 里取 —— 不用再查库。
     */
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },

    /**
     * 把 userId 暴露给 session.user，业务代码（知识库归属、会话查询）处处要用。
     * 注意参数从 user 变成了 token —— 策略不同，回调签名也不同。
     */
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
});
