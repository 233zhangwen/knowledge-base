import { redirect } from 'next/navigation';

/**
 * 根路径只是个入口，不做任何渲染。
 *
 * 为什么不在这里判断登录态：`/kb` 页自己已经有「无 session 就 redirect('/login')」
 * 的判断，再在这里写一遍等于同一条规则维护两份 —— 哪天改了一处忘了另一处，
 * 就会出现「根路径放行、内页拦截」这种半吊子状态。
 * 规则只留一份，入口只管指路。
 *
 * （此文件原本是 create-next-app 的脚手架欢迎页，2026-10-27 部署后发现
 *  线上根路径仍是 "Create Next App / edit the page.tsx file" 才补上。）
 */
export default function Home() {
  redirect('/kb');
}
