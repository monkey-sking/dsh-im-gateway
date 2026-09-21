/**
 * 构建后置：把声明文件改回稳定名。
 *
 * 背景 —— tsdown 0.12.9 的 dts 插件用 rolldown 的 chunk 名给声明文件命名，
 * 产出的是 `lib/index-DKO0T1W1.d.ts` 这类**带内容哈希**的名字（哈希随代码变化），
 * 而 `package.json` 的 `types` / `exports.types` 必须指向稳定路径
 * （`lib/index.d.ts` 等）。不改名的话，发到 npm 的包**没有任何类型声明**：
 * 消费者 `import` 时 TS 会报找不到该模块的类型。
 *
 * 安全性 —— 三个声明文件之间互不 import（本地引用为空数组），所以重命名
 * 不会破坏任何相对引用。`client.js` 没有 dts，不涉及。
 *
 * 幂等 —— 若将来的 tsdown 已输出稳定名，本脚本自动 no-op。
 *
 * 注意：`scripts/` 不在 package.json 的 `files` 里，不会随包发布。
 */
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const LIB = 'lib'
/**
 * `<稳定名>-<8位哈希>.d.ts` —— 哈希段固定 8 位字母数字。
 * 首段必须用 `.+?`（非贪婪）且**允许连字符**：entry 基名自己就带 `-`
 * （`typert.remote-client`），用 `[\w.]` 之类会匹配失败。
 */
const HASHED_DTS = /^(.+?)-[A-Za-z0-9]{8}\.d\.ts$/

let renamed = 0

for (const file of readdirSync(LIB).sort()) {
  const matched = file.match(HASHED_DTS)
  if (!matched) continue

  const target = `${matched[1]}.d.ts`
  const to = join(LIB, target)

  if (existsSync(to)) {
    console.warn(`[fix-dts] 跳过 ${file} —— ${target} 已存在`)
    continue
  }

  renameSync(join(LIB, file), to)
  console.log(`[fix-dts] ${file} → ${target}`)
  renamed += 1
}

console.log(renamed === 0 ? '[fix-dts] 无需重命名（声明文件已是稳定名）' : `[fix-dts] 已重命名 ${renamed} 个声明文件`)
