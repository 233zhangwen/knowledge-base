/**
 * Server Action 回给客户端的统一状态类型。
 *
 * 约定：
 *   - 有 error  → 显示错误（红色提示）
 *   - 没 error  → 当作成功
 *   - 不用 throw 传业务错误：Server Action 里 throw 在生产环境只给客户端一句
 *     模糊的 "An error occurred"，用户看到的是废话。
 *     业务校验失败要自己返回**可读**的信息；真正的故障才让它抛出去。
 *
 * 放在 lib 里是为了让所有 Actions 共用一份 —— 两处各定义一次 `ActionState`，
 * 迟早会出现"这边加了字段、那边没加"的不一致。
 */
export type ActionState = { error?: string };
