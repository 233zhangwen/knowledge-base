/**
 * 流协议解析的 vitest 版本 —— 与 scripts/verify-stream-protocol.mts **共用同一批用例**
 * （W12 决策②-③：`scripts/protocol-cases.mts`）。
 *
 * 为什么要两套 runner 跑同一批断言：
 *   · 这边进 CI、进 watch，改协议立刻知道；
 *   · 那边零依赖，哪怕 node_modules 装不上也能验（本仓库踩过两次）。
 * 断言只有一份，所以永远不会出现"脚本绿、测试红"的分裂。
 */
import { describe, expect, it } from 'vitest';

import { protocolCases } from '../../scripts/protocol-cases.mts';

describe('chat-protocol', () => {
  for (const testCase of protocolCases) {
    it(testCase.name, () => {
      for (const { label, actual, expected } of testCase.checks()) {
        // 第二个参数是失败时的提示：不写的话 11 个 case 报错看起来一模一样
        expect(actual, label).toEqual(expected);
      }
    });
  }
});
