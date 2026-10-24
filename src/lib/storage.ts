/**
 * 对象存储抽象层。
 *
 * 为什么要这一层：业务代码不许知道原件存在哪。
 *   - 本地开发 → 写仓库根的 `.storage/` 目录（不进版本库）
 *   - 生产 Vercel → 写 Vercel Blob
 * 切换只靠一个环境变量 `BLOB_READ_WRITE_TOKEN`：有就用 Blob，没有就用本地磁盘。
 *
 * 这套"provider 可切换"的写法跟 LLM 那层（`@ai-sdk/openai` + baseURL 指向国内）是同一个思路：
 * 接口稳定，实现可换。好处是——本地能不能跑，不取决于你有没有开通某个云服务。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 本地 driver 的根目录。生产环境一定有 Blob token，走不到这里。 */
const LOCAL_ROOT = path.join(process.cwd(), '.storage');

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * ⚠️ 这个校验不能省 —— 防路径穿越。
 *
 * key 里包含用户上传的原文件名（例如 `abc123/report final.md`）。
 * 如果不校验，一个叫 `../../../../etc/passwd` 的文件名就能让 put/remove
 * 读写到仓库外面的任意位置。判断 Accessed Safe Key 的三条：
 *   - 不能以 / 开头（绝对路径）
 *   - 不能含 .. （向上穿越）
 *   - 不能含 Windows 非法字符（本机是 Windows，冒号和问号会直接炸）
 */
function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || /[\\:*?"<>|]/.test(key)) {
    throw new Error(`非法的存储 key：${key}`);
  }
}

const localStorage: ObjectStorage = {
  async put(key, body) {
    assertSafeKey(key);
    const full = path.join(LOCAL_ROOT, key);
    // recursive：key 里带两级目录（userId/documentId-文件名），父目录可能还不存在
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  },

  async remove(key) {
    assertSafeKey(key);
    // force：文件已经不在了也算成功。删除操作应当是幂等的，
    // 否则"重复删除同样的东西"会报错，调用方还得为此写 try/catch。
    await rm(path.join(LOCAL_ROOT, key), { force: true });
  },
};

const blobStorage: ObjectStorage = {
  async put(key, body, contentType) {
    assertSafeKey(key);
    /**
     * 动态 import + 变量包名：这样本地没装 @vercel/blob 也不会让 dev 起不来，
     * 类型检查同样不会报找不到模块。代价是这里没有类型提示（拿到的是 any）。
     *
     * TODO(W7)：真正要在 Vercel 上线前，装好 `@vercel/blob` 之后把这里改成
     * 静态 import 拿回类型；同时测量一下大文件上传是否需要改成浏览器直传。
     */
    const moduleName = '@vercel/blob';
    const { put } = (await import(/* webpackIgnore: true */ moduleName)) as {
      put: (k: string, b: Uint8Array, o: Record<string, unknown>) => Promise<unknown>;
    };

    await put(key, body, {
      access: 'private', // 私有：只能拿到签名 URL 才能读，不能直接拿公网地址
      contentType,
      addRandomSuffix: false, // key 里已经有 cuid 了，不需要再随机；key 必须可预测，否则删不掉
    });
  },

  async remove(key) {
    assertSafeKey(key);
    const moduleName = '@vercel/blob';
    const { del } = (await import(/* webpackIgnore: true */ moduleName)) as {
      del: (k: string) => Promise<unknown>;
    };
    await del(key);
  },
};

/** 模块加载时就定下来。生产环境的环境变量在进程启动前已注入，不会中途变。 */
export const storage: ObjectStorage = process.env.BLOB_READ_WRITE_TOKEN ? blobStorage : localStorage;

/**
 * "尽力删除"：失败只记录，不向上抛。
 *
 * 用在什么场景：删除数据库记录之后清理原件。这一步失败不该让用户看到
 * "删除失败"（其实数据库里已经删干净了，用户要的结果已经达成），
 * 但也不能静默 —— 留下无人认领却一直在计费的文件，正是我们要防的事。
 * 所以：吞掉异常，但打到日志里。
 */
export async function removeQuietly(key: string): Promise<void> {
  try {
    await storage.remove(key);
  } catch (error) {
    console.error(`[storage] 删除对象失败（孤儿文件，需人工清理）：${key}`, error);
  }
}
