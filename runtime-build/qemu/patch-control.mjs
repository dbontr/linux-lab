import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const wasm32Path = process.argv[4]
const wasmTargetPath = process.argv[5]
if (!mesonPath || !mainPath || !wasm32Path || !wasmTargetPath) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <tcg/wasm32.c> <tcg/wasm32/tcg-target.c.inc>')
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
const tciGotoTbAnchor = `        case INDEX_op_goto_tb:${wasm32Eol}            tci_args_l(insn, tb_ptr, &ptr);${wasm32Eol}            if (*(uint32_t **)ptr != 0) {${wasm32Eol}                tb_ptr = *(uint32_t **)ptr;${wasm32Eol}                ctx.tb_ptr = tb_ptr;`
const tciGotoPtrAnchor = `            tb_ptr = ptr;${wasm32Eol}${wasm32Eol}            ctx.tb_ptr = tb_ptr;`
if (!wasm32Source.includes(wasm32DeclarationAnchor) || !wasm32Source.includes(tciGotoTbAnchor) || !wasm32Source.includes(tciGotoPtrAnchor)) {
  throw new Error('QEMU Wasm TCI pause anchors changed')
}
if (wasm32Source.includes('void linuxlab_vcpu_pause_wait(void);')) {
  throw new Error('Linux Lab TCI pause hook is already registered')
}
let patchedWasm32 = wasm32Source.replace(
  wasm32DeclarationAnchor,
  `${wasm32DeclarationAnchor}${wasm32Eol}void linuxlab_vcpu_pause_wait(void);${wasm32Eol}`,
)
patchedWasm32 = patchedWasm32.replace(
  tciGotoTbAnchor,
  `${tciGotoTbAnchor}${wasm32Eol}                linuxlab_vcpu_pause_wait();`,
)
patchedWasm32 = patchedWasm32.replace(
  tciGotoPtrAnchor,
  `${tciGotoPtrAnchor}${wasm32Eol}            linuxlab_vcpu_pause_wait();`,
)
await writeFile(wasm32Path, patchedWasm32, 'utf8')

const wasmSource = await readFile(wasmTargetPath, 'utf8')
const wasmEol = wasmSource.includes('\r\n') ? '\r\n' : '\n'
const wasmDeclarationAnchor = `#include "../tcg-pool.c.inc"${wasmEol}`
const gotoPtrAnchor = `static void tcg_wasm_out_goto_ptr(TCGContext *s, TCGReg arg)${wasmEol}{`
const gotoTbAnchor = `static void tcg_wasm_out_goto_tb(TCGContext *s, int which)${wasmEol}{`
if (!wasmSource.includes(wasmDeclarationAnchor) || !wasmSource.includes(gotoPtrAnchor) || !wasmSource.includes(gotoTbAnchor)) {
  throw new Error('QEMU Wasm generated-TB pause anchors changed')
}
if (wasmSource.includes('linuxlab_pause_word_address')) {
  throw new Error('Linux Lab generated-TB pause guard is already registered')
}

const pauseEmitter = [
  'static void tcg_wasm_out_linuxlab_atomic_prefix(TCGContext *s, uint32_t op)',
  '{',
  '    tcg_wasm_out8(s, 0xfe);',
  '    tcg_wasm_out_leb128_uint32_t(s, op);',
  '}',
  '',
  'static void tcg_wasm_out_linuxlab_atomic_memarg(TCGContext *s)',
  '{',
  '    tcg_wasm_out_leb128_uint32_t(s, 2); /* natural i32 alignment */',
  '    tcg_wasm_out_leb128_uint32_t(s, 0); /* zero offset */',
  '}',
  '',
  'static void tcg_wasm_out_linuxlab_pause_requested(TCGContext *s)',
  '{',
  '    tcg_wasm_out_op_i32_const(s, (int32_t)linuxlab_pause_word_address());',
  '    tcg_wasm_out_linuxlab_atomic_prefix(s, 0x10); /* i32.atomic.load */',
  '    tcg_wasm_out_linuxlab_atomic_memarg(s);',
  '}',
  '',
  'static void tcg_wasm_out_linuxlab_waiting_store(TCGContext *s, int32_t value)',
  '{',
  '    tcg_wasm_out_op_i32_const(s, (int32_t)linuxlab_pause_waiting_word_address());',
  '    tcg_wasm_out_op_i32_const(s, value);',
  '    tcg_wasm_out_linuxlab_atomic_prefix(s, 0x17); /* i32.atomic.store */',
  '    tcg_wasm_out_linuxlab_atomic_memarg(s);',
  '}',
  '',
  'static void tcg_wasm_out_linuxlab_pause_wait(TCGContext *s)',
  '{',
  '    tcg_wasm_out_linuxlab_pause_requested(s);',
  '    tcg_wasm_out_op_if_noret(s);',
  '    tcg_wasm_out_linuxlab_waiting_store(s, 1);',
  '    tcg_wasm_out8(s, 0x02); /* block */',
  '    tcg_wasm_out8(s, 0x40); /* empty block type */',
  '    tcg_wasm_out8(s, 0x03); /* loop */',
  '    tcg_wasm_out8(s, 0x40); /* empty block type */',
  '    tcg_wasm_out_op_i32_const(s, (int32_t)linuxlab_pause_word_address());',
  '    tcg_wasm_out_op_i32_const(s, 1);',
  '    tcg_wasm_out_op_i64_const(s, -1);',
  '    tcg_wasm_out_linuxlab_atomic_prefix(s, 0x01); /* memory.atomic.wait32 */',
  '    tcg_wasm_out_linuxlab_atomic_memarg(s);',
  '    tcg_wasm_out8(s, 0x1a); /* drop wait result */',
  '    tcg_wasm_out_linuxlab_pause_requested(s);',
  '    tcg_wasm_out_op_i32_eqz(s);',
  '    tcg_wasm_out8(s, 0x0d); /* br_if */',
  '    tcg_wasm_out8(s, 0x01); /* leave block */',
  '    tcg_wasm_out_op_br(s, 0); /* retry after a spurious wake */',
  '    tcg_wasm_out_op_end(s); /* loop */',
  '    tcg_wasm_out_op_end(s); /* block */',
  '    tcg_wasm_out_linuxlab_waiting_store(s, 0);',
  '    tcg_wasm_out_op_end(s); /* if paused */',
  '}',
  '',
].join(wasmEol)

let patchedWasm = wasmSource.replace(
  wasmDeclarationAnchor,
  `${wasmDeclarationAnchor}${wasmEol}uintptr_t linuxlab_pause_word_address(void);${wasmEol}uintptr_t linuxlab_pause_waiting_word_address(void);${wasmEol}`,
)
patchedWasm = patchedWasm.replace(gotoPtrAnchor, `${pauseEmitter}${gotoPtrAnchor}`)

function guardFastChain(source, functionAnchor, loopBranch) {
  const start = source.indexOf(functionAnchor)
  const bodyStart = start + functionAnchor.length
  const end = source.indexOf(`${wasmEol}}${wasmEol}`, bodyStart)
  if (start < 0 || end < 0) throw new Error('QEMU Wasm chain function boundary changed')
  const body = source.slice(bodyStart, end)
  if (!body.includes(loopBranch)) throw new Error(`QEMU Wasm loop branch changed: ${loopBranch}`)
  const guardedBody = body.replace(loopBranch, `    tcg_wasm_out_linuxlab_pause_wait(s);${wasmEol}${loopBranch}`)
  return `${source.slice(0, bodyStart)}${guardedBody}${source.slice(end)}`
}

patchedWasm = guardFastChain(
  patchedWasm,
  gotoPtrAnchor,
  '    tcg_wasm_out_op_br(s, 2); // br to the top of loop',
)
patchedWasm = guardFastChain(
  patchedWasm,
  gotoTbAnchor,
  '    tcg_wasm_out_op_br(s, 3); // br to the top of loop',
)

await writeFile(wasmTargetPath, patchedWasm, 'utf8')
