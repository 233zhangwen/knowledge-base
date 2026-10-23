import { auth } from '@/auth';

/**
 * 取当前登录用户的 id。所有需要「知道是谁在操作」的地方都走这里。
 *
 * 为什么不直接在每个页面/action 里写 `const session = await auth()`？
 *   1. 统一出口：漏判一次就是一个越权漏洞，抽成函数才可能"只检查一次、到处复用"
 *   2. 返回类型收窄：外面拿到的是 string，不是 `string | undefined`，
 *      编译器会逼你处理不了"没登录"的情况
 *   3. 抛错而不是返回 null：调用方没法"忘了处理"，一漏就炸在明处
 *
 * ⚠️ 铁律：userId 只能从 session 里取，**永远不要信任客户端传来的 userId**。
 *   表单里带一个隐藏的 userId 字段？那等于把权限大门交给用户自己填。
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();

  const userId = session?.user?.id;
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }

  return userId;
}
