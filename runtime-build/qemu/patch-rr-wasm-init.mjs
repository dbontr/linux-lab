import { readFile, writeFile } from 'node:fs/promises'

const rrPath = process.argv[2]
if (!rrPath) {
  throw new Error('usage: patch-rr-wasm-init.mjs <accel/tcg/tcg-accel-ops-rr.c>')
}

const source = await readFile(rrPath, 'utf8')
const eol = source.includes('\r\n') ? '\r\n' : '\n'
const includeAnchor = `#include "tcg-accel-ops-icount.h"${eol}`
const functionAnchor = `static void *rr_cpu_thread_fn(void *arg)${eol}{${eol}    Notifier force_rcu;`
if (!source.includes(includeAnchor) || !source.includes(functionAnchor)) {
  throw new Error('QEMU RR Wasm initialization anchors changed')
}
if (source.includes('../../tcg/wasm32.h') || source.includes('init_wasm32();')) {
  throw new Error('QEMU RR Wasm runtime is already initialized')
}

let patched = source.replace(
  includeAnchor,
  `${includeAnchor}${eol}#if defined(EMSCRIPTEN) && !defined(CONFIG_TCG_INTERPRETER)${eol}#include "../../tcg/wasm32.h"${eol}#endif${eol}`,
)
patched = patched.replace(
  functionAnchor,
  `static void *rr_cpu_thread_fn(void *arg)${eol}{${eol}    Notifier force_rcu;${eol}${eol}#if defined(EMSCRIPTEN) && !defined(CONFIG_TCG_INTERPRETER)${eol}    init_wasm32();${eol}#endif`,
)

await writeFile(rrPath, patched, 'utf8')
