import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const cpuExecPath = process.argv[4]
const wasm32Path = process.argv[5]
const wasmTargetPath = process.argv[6]
if (!mesonPath || !mainPath || !cpuExecPath || !wasm32Path || !wasmTargetPath) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <accel/tcg/cpu-exec.c> <tcg/wasm32.c> <tcg/wasm32/tcg-target.c.inc>')
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

const cpuExecSource = await readFile(cpuExecPath, 'utf8')
const cpuExecEol = cpuExecSource.includes('\r\n') ? '\r\n' : '\n'
const cpuExecDeclarationAnchor = `#include "internal-target.h"${cpuExecEol}`
const execLoopAnchor = `        while (!cpu_handle_interrupt(cpu, &last_tb)) {${cpuExecEol}            TranslationBlock *tb;`
if (!cpuExecSource.includes(cpuExecDeclarationAnchor) || !cpuExecSource.includes(execLoopAnchor)) {
  throw new Error('QEMU CPU execution pause anchors changed')
}
if (cpuExecSource.includes('linuxlab_vcpu_pause_wait')) {
  throw new Error('Linux Lab CPU pause hook is already registered')
}
let patchedCpuExec = cpuExecSource.replace(
  cpuExecDeclarationAnchor,
  `${cpuExecDeclarationAnchor}${cpuExecEol}void linuxlab_vcpu_pause_wait(void);${cpuExecEol}`,
)
patchedCpuExec = patchedCpuExec.replace(
  execLoopAnchor,
  `        while (!cpu_handle_interrupt(cpu, &last_tb)) {${cpuExecEol}            linuxlab_vcpu_pause_wait();${cpuExecEol}            TranslationBlock *tb;`,
)
await writeFile(cpuExecPath, patchedCpuExec, 'utf8')

const wasm32Source = await readFile(wasm32Path, 'utf8')
const wasm32Eol = wasm32Source.includes('\r\n') ? '\r\n' : '\n'
const wasm32DeclarationAnchor = `#include "wasm32.h"${wasm32Eol}`
const tciGotoTbAnchor = `        case INDEX_op_goto_tb:${wasm32Eol}            tci_args_l(insn, tb_ptr, &ptr);`
const tciGotoPtrAnchor = `        case INDEX_op_goto_ptr:${wasm32Eol}            tci_args_r(insn, &r0);`
if (!wasm32Source.includes(wasm32DeclarationAnchor) || !wasm32Source.includes(tciGotoTbAnchor) || !wasm32Source.includes(tciGotoPtrAnchor)) {
  throw new Error('QEMU Wasm TCI pause anchors changed')
}
if (wasm32Source.includes('bool linuxlab_pause_requested(void);')) {
  throw new Error('Linux Lab TCI pause guard is already registered')
}
const tciPauseGuard = `${wasm32Eol}            if (linuxlab_pause_requested()) {${wasm32Eol}                uintptr_t pause_tb = (uintptr_t)ctx.tb_ptr;${wasm32Eol}                ctx.tb_ptr = 0;${wasm32Eol}                return pause_tb;${wasm32Eol}            }`
let patchedWasm32 = wasm32Source.replace(
  wasm32DeclarationAnchor,
  `${wasm32DeclarationAnchor}${wasm32Eol}bool linuxlab_pause_requested(void);${wasm32Eol}`,
)
patchedWasm32 = patchedWasm32.replace(tciGotoTbAnchor, `        case INDEX_op_goto_tb:${tciPauseGuard}${wasm32Eol}            tci_args_l(insn, tb_ptr, &ptr);`)
patchedWasm32 = patchedWasm32.replace(tciGotoPtrAnchor, `        case INDEX_op_goto_ptr:${tciPauseGuard}${wasm32Eol}            tci_args_r(insn, &r0);`)
await writeFile(wasm32Path, patchedWasm32, 'utf8')

const wasmSource = await readFile(wasmTargetPath, 'utf8')
const wasmEol = wasmSource.includes('\r\n') ? '\r\n' : '\n'
const wasmDeclarationAnchor = `#include "../tcg-pool.c.inc"${wasmEol}`
const exitFunctionAnchor = `static void tcg_wasm_out_exit_tb(TCGContext *s, uintptr_t arg)${wasmEol}{`
const gotoPtrAnchor = `static void tcg_wasm_out_goto_ptr(TCGContext *s, TCGReg arg)${wasmEol}{`
const gotoTbAnchor = `static void tcg_wasm_out_goto_tb(TCGContext *s, int which)${wasmEol}{`
if (!wasmSource.includes(wasmDeclarationAnchor) || !wasmSource.includes(exitFunctionAnchor) || !wasmSource.includes(gotoPtrAnchor) || !wasmSource.includes(gotoTbAnchor)) {
  throw new Error('QEMU Wasm generated-TB pause anchors changed')
}
if (wasmSource.includes('linuxlab_pause_word_address')) {
  throw new Error('Linux Lab generated-TB pause guard is already registered')
}

const pauseEmitter = [
  'static void tcg_wasm_out_pause_requested(TCGContext *s)',
  '{',
  '    tcg_wasm_out_op_i32_const(s, (int32_t)linuxlab_pause_word_address());',
  '    tcg_wasm_out8(s, 0xfe); /* i32.atomic.load prefix */',
  '    tcg_wasm_out8(s, 0x10); /* i32.atomic.load */',
  '    tcg_wasm_out8(s, 0x02); /* natural i32 alignment */',
  '    tcg_wasm_out8(s, 0x00); /* zero offset */',
  '}',
  '',
].join(wasmEol)

let patchedWasm = wasmSource.replace(
  wasmDeclarationAnchor,
  `${wasmDeclarationAnchor}${wasmEol}uintptr_t linuxlab_pause_word_address(void);${wasmEol}`,
)
patchedWasm = patchedWasm.replace(exitFunctionAnchor, `${pauseEmitter}${exitFunctionAnchor}`)
patchedWasm = patchedWasm.replace(
  gotoPtrAnchor,
  `${gotoPtrAnchor}${wasmEol}    tcg_wasm_out_pause_requested(s);${wasmEol}    tcg_wasm_out_op_if_noret(s);${wasmEol}    tcg_wasm_out_ctx_i32_load(s, TB_PTR_OFF);${wasmEol}    tcg_wasm_out_op_local_set(s, TMP32_LOCAL_0_IDX);${wasmEol}    tcg_wasm_out_ctx_i32_store_const(s, TB_PTR_OFF, 0);${wasmEol}    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);${wasmEol}    tcg_wasm_out_op_return(s);${wasmEol}    tcg_wasm_out_op_end(s);`,
)

patchedWasm = patchedWasm.replace(
  gotoTbAnchor,
  `${gotoTbAnchor}${wasmEol}    tcg_wasm_out_pause_requested(s);${wasmEol}    tcg_wasm_out_op_if_noret(s);${wasmEol}    tcg_wasm_out_ctx_i32_load(s, TB_PTR_OFF);${wasmEol}    tcg_wasm_out_op_local_set(s, TMP32_LOCAL_0_IDX);${wasmEol}    tcg_wasm_out_ctx_i32_store_const(s, TB_PTR_OFF, 0);${wasmEol}    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);${wasmEol}    tcg_wasm_out_op_return(s);${wasmEol}    tcg_wasm_out_op_end(s);`,
)

await writeFile(wasmTargetPath, patchedWasm, 'utf8')
