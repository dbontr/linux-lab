import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const wasm32Path = process.argv[4]
const wasmHeaderPath = process.argv[5]
if (!mesonPath || !mainPath || !wasm32Path || !wasmHeaderPath) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <tcg/wasm32.c> <tcg/wasm32.h>')
}

const mesonSource = await readFile(mesonPath, 'utf8')
const sourceAnchor = /^  'cpus\.c',(\r?\n)/m
const sourceMatches = [...mesonSource.matchAll(new RegExp(sourceAnchor.source, 'gm'))]
if (sourceMatches.length !== 1) throw new Error(`expected one cpus.c source anchor, found ${sourceMatches.length}`)
if (mesonSource.includes("'linuxlab-control.c'")) throw new Error('Linux Lab control source is already registered')
const mesonEol = sourceMatches[0][1]
await writeFile(
  mesonPath,
  mesonSource.replace(sourceAnchor, `  'cpus.c',${mesonEol}  'linuxlab-control.c',${mesonEol}`),
  'utf8',
)

const mainSource = await readFile(mainPath, 'utf8')
const mainEol = mainSource.includes('\r\n') ? '\r\n' : '\n'
const prototypeAnchor = `${mainEol}int qemu_default_main(void)`
const callAnchor = `    qemu_init(argc, argv);${mainEol}    return qemu_main();`
if (!mainSource.includes(prototypeAnchor) || !mainSource.includes(callAnchor)) {
  throw new Error('QEMU main control anchors changed')
}
let patchedMain = mainSource.replace(
  prototypeAnchor,
  `${mainEol}void linuxlab_runtime_prepare(void);${mainEol}void linuxlab_runtime_ready(void);${mainEol}${mainEol}int qemu_default_main(void)`,
)
patchedMain = patchedMain.replace(
  callAnchor,
  `    linuxlab_runtime_prepare();${mainEol}    qemu_init(argc, argv);${mainEol}    linuxlab_runtime_ready();${mainEol}    return qemu_main();`,
)
await writeFile(mainPath, patchedMain, 'utf8')

const wasm32Source = await readFile(wasm32Path, 'utf8')
const wasm32Eol = wasm32Source.includes('\r\n') ? '\r\n' : '\n'
const wasm32DeclarationAnchor = `#include "wasm32.h"${wasm32Eol}`
const trysleepAnchor = `static inline void trysleep()${wasm32Eol}{${wasm32Eol}    if (--exec_cnt == 0) {`
const tciGotoTbAnchor = `        case INDEX_op_goto_tb:${wasm32Eol}            tci_args_l(insn, tb_ptr, &ptr);${wasm32Eol}            if (*(uint32_t **)ptr != 0) {${wasm32Eol}                tb_ptr = *(uint32_t **)ptr;${wasm32Eol}                ctx.tb_ptr = tb_ptr;`
const tciGotoPtrAnchor = `            tb_ptr = ptr;${wasm32Eol}${wasm32Eol}            ctx.tb_ptr = tb_ptr;`
if (!wasm32Source.includes(wasm32DeclarationAnchor) || !wasm32Source.includes(trysleepAnchor) || !wasm32Source.includes(tciGotoTbAnchor) || !wasm32Source.includes(tciGotoPtrAnchor)) {
  throw new Error('QEMU Wasm dispatcher pause anchors changed')
}
if (wasm32Source.includes('bool linuxlab_pause_requested(void);')) {
  throw new Error('Linux Lab dispatcher pause hook is already registered')
}
let patchedWasm32 = wasm32Source.replace(
  wasm32DeclarationAnchor,
  `${wasm32DeclarationAnchor}${wasm32Eol}bool linuxlab_pause_requested(void);${wasm32Eol}void linuxlab_vcpu_pause_wait(void);${wasm32Eol}`,
)
patchedWasm32 = patchedWasm32.replace(
  trysleepAnchor,
  `static inline void trysleep()${wasm32Eol}{${wasm32Eol}    linuxlab_vcpu_pause_wait();${wasm32Eol}    if (--exec_cnt == 0) {`,
)
patchedWasm32 = patchedWasm32.replace(
  tciGotoTbAnchor,
  `${tciGotoTbAnchor}${wasm32Eol}                if (linuxlab_pause_requested()) {${wasm32Eol}                    return 0;${wasm32Eol}                }`,
)
patchedWasm32 = patchedWasm32.replace(
  tciGotoPtrAnchor,
  `${tciGotoPtrAnchor}${wasm32Eol}            if (linuxlab_pause_requested()) {${wasm32Eol}                return 0;${wasm32Eol}            }`,
)
await writeFile(wasm32Path, patchedWasm32, 'utf8')

const wasmHeaderSource = await readFile(wasmHeaderPath, 'utf8')
const promotionAnchor = '#define INSTANTIATE_NUM 1500'
if (!wasmHeaderSource.includes(promotionAnchor)) {
  throw new Error('QEMU Wasm TCI promotion threshold changed')
}
await writeFile(
  wasmHeaderPath,
  wasmHeaderSource.replace(promotionAnchor, '#define INSTANTIATE_NUM 2147483647'),
  'utf8',
)
