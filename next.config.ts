import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Server Action 的请求体上限，默认只有 1MB —— 不配这行，
   * 超过 1MB 的上传会在轮到我们代码之前就被框架拒绝。
   *
   * 为什么是 5mb 而不是更大：见 `src/lib/file-types.ts` 的 MAX_FILE_SIZE。
   * Vercel 对函数请求体有 4.5MB 硬上限，配再大也没用；
   * 这里比应用层限制（4MB）多 1MB，是留给 multipart 表单的分隔符等开销。
   *
   * ⚠️ 真要支持大文件，方向是浏览器直传对象存储（签名 URL），不走 Server Action。
   */
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
