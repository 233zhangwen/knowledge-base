/**
 * DB 集成测试：错误去重与节流（W13 C 组，对应反证 R3）。
 *
 * 要证明两件**写错了不会报错**的事：
 *   ① 同一 fingerprint 连报 3 次 → DB 里**1 行、count=3**（去重生效）；
 *   ② 节流开着时连报 3 次 → count 只涨 1（不会把库打爆）。
 *
 * 为什么把节流做成环境变量：不开节流就走不到 upsert 的 update 分支，
 * 这条测试就变成"只验证了别写"——那是最容易自欺的测试形态。
 *
 * 清理：fingerprint 前缀带运行 id，afterAll 精确删除，不碰真实错误记录。
 */
import { afterAll, describe, expect, it } from 'vitest';

import { reportError } from '@/lib/error-report';
import { prisma } from '@/lib/prisma';

const RUN_DB_TESTS = Boolean(process.env.RUN_DB_TESTS);
const RUN_ID = `w13test-${Date.now()}`;

/** 用 log 的 event 前缀定位本轮的测试行（reportError 会把 level 固定成 error） */
function msg(suffix: string) {
  return `${RUN_ID}-${suffix}`;
}

describe.skipIf(!RUN_DB_TESTS)('error-report · 去重与节流（真实 Neon）', () => {
  afterAll(async () => {
    await prisma.errorLog.deleteMany({ where: { message: { startsWith: RUN_ID } } });
    delete process.env.ERROR_REPORT_THROTTLE_MS;
  });

  it('节流关闭时：同一错误报 3 次 → 1 行，count=3', async () => {
    process.env.ERROR_REPORT_THROTTLE_MS = '0';
    const message = msg('dedupe');

    for (let i = 0; i < 3; i++) {
      await reportError({
        event: 'test.error.dedupe',
        message,
        path: '/test',
      });
    }

    const rows = await prisma.errorLog.findMany({ where: { message } });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  it('节流开启时：连报 3 次只写 1 次（count=1）', async () => {
    // 默认 60s 窗口；不设环境变量即为默认
    delete process.env.ERROR_REPORT_THROTTLE_MS;
    const message = msg('throttled');

    for (let i = 0; i < 3; i++) {
      await reportError({ event: 'test.error.throttle', message, path: '/test' });
    }

    const rows = await prisma.errorLog.findMany({ where: { message } });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  it('不同 message → 不同指纹（不会被合并成一条）', async () => {
    process.env.ERROR_REPORT_THROTTLE_MS = '0';

    await reportError({ event: 'test.error.distinct', message: msg('a'), path: '/test' });
    await reportError({ event: 'test.error.distinct', message: msg('b'), path: '/test' });

    const rows = await prisma.errorLog.findMany({
      where: { event: 'test.error.distinct', message: { startsWith: RUN_ID } },
    });
    expect(rows).toHaveLength(2);
  });
});
