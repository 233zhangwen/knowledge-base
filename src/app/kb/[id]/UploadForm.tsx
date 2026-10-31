'use client';

import { useActionState, useState } from 'react';

import { ACCEPT_ATTR, MAX_FILE_SIZE } from '@/lib/file-types';

import { uploadDocument, type ActionState } from './actions';

/**
 * ⚠️ 这里有一个绕不过去的限制，先说清楚：
 * 文件输入框是**不受控**的，而 React 19 会在 action 完成后自动 reset 表单 ——
 * 包括把已选文件清掉。成功时这正是我们想要的（清空待下一次上传），
 * 但**失败时用户选的文件也没了，得重新选一遍**。
 *
 * 和文本输入框不同，这里没法用受控 input 解决：浏览器不允许用 JS 给
 * `<input type="file">` 赋值（可以置空，但不能塞回用户选的那个 File 对象）。
 * 这是浏览器的安全限制，正确做法是在错误提示里说清楚"请重新选择文件"。
 */
export function UploadForm({ kbId }: { kbId: string }) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    uploadDocument,
    {},
  );

  /**
   * 大小必须在**客户端先拦一道**。这不是重复劳动，是唯一能优雅失败的路径。
   *
   * 三层限制从外到内：
   *   ① 浏览器 accept      —— 软过滤，用户照样能选别的文件
   *   ② Next bodySizeLimit  —— **框架层**。超过 5mb 直接抛 "Body exceeded 5mb limit"，
   *      整页变成错误页；我们的 Server Action 连执行的机会都没有，写不出友好提示
   *   ③ 业务 MAX_FILE_SIZE  —— 能给出清晰红字，但只在 4~5MB 这一段生效
   *
   * 也就是说：**超过 5MB 的文件，服务端无论如何都拦不住**（实测：传一个 20MB 的 exe，
   * 得到的不是红字而是崩溃页）。想让用户看到人话，唯一的办法是让请求别发出去。
   *
   * ⚠️ 但它是 **UX 层，不是安全边界**：绕过浏览器直接打 Server Action 的请求
   *（curl、脚本、被改过的客户端）根本不经过这里。服务端那道 4MB 校验必须保留 ——
   * 客户端校验省的是崩溃页，服务端校验守的是数据。两者缺一不可。
   */
  const [clientError, setClientError] = useState<string | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    // 每次重选都先把上一次的错误抹掉：useActionState 没有 reset API，
    // 而 useState 的错误不主动清就会一直挂着（这条红字是"残留错误"的翻版）
    setClientError(null);

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setClientError(
        `这个文件是 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 上限`,
      );

      /**
       * 清空选择，让请求发不出去。
       *
       * 这里的置空是**有意为之**，和上面那条"React 自动 reset 会丢文件"并不冲突：
       * 那种情况是不想丢却丢了；这里是主动丢，因为这个文件注定失败。
       * 置空之后 input 上的 `required` 会拦住提交（浏览器原生校验），
       * 用户必须先重选一个合规文件才能点按钮 —— 不需要我们写禁用逻辑。
       */
      event.target.value = '';
    }
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border bg-zinc-50/50 p-4"
    >
      <input type="hidden" name="kbId" value={kbId} />

      <div className="flex flex-col gap-1">
        <label htmlFor="document-file" className="text-sm font-medium">
          上传文档
        </label>
        <input
          id="document-file"
          data-testid="file-input"
          name="file"
          type="file"
          accept={ACCEPT_ATTR}
          required
          onChange={handleFileChange}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:text-white hover:file:bg-zinc-700"
        />
        <p className="text-xs text-zinc-500">
          支持 PDF、Markdown、TXT，单文件最多 {MAX_FILE_SIZE / 1024 / 1024}MB
        </p>
      </div>

      {state.error ? (
        <p className="text-sm text-red-600">{state.error}（请重新选择文件）</p>
      ) : null}

      {clientError ? (
        <p className="text-sm text-red-600">{clientError}（已取消选择，请重新选择文件）</p>
      ) : null}

      <button
        type="submit"
        data-testid="upload-submit"
        disabled={isPending}
        className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? '上传并解析中…' : '开始上传'}
      </button>
    </form>
  );
}
