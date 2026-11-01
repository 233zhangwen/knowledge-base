/**
 * 一行式注册器：`node --experimental-transform-types --import ./scripts/lib/register.mjs <脚本>`
 *
 * 单独拆一个文件是因为 `--import` 接受的模块不能同时当解析钩子用（会自己 resolve 自己）。
 */
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
