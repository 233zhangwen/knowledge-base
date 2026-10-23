import NextAuth from 'next-auth';

import { authConfig } from '@/auth.config';

/**
 * Next 16 起，middleware.ts 更名为 proxy.ts（旧名仍可用但会报警告）。
 *
 * 关键：这里只用 authConfig，不能 import '@/auth'。
 * '@/auth' 带了 PrismaAdapter，跑在 Edge Runtime 会直接构建失败。
 */
export default NextAuth(authConfig).auth;

export const config = {
  /**
   * matcher 决定这个中间件对哪些路径生效。
   * 只对需要保护的路由生效，别写 '/(.*)' ——
   * 那会让每个静态资源请求都跑一遍中间件，白白拖慢速度。
   */
  matcher: ['/kb/:path*'],
};
