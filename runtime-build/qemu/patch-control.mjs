import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const cpusPath = process.argv[4]
const wasm32Path = process.argv[5]
const wasmTargetPath = process.argv[6]
if (!mesonPath || !mainPath || !cpusPath || !wasm32Path || !wasmTargetPath) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <system/cpus.c> <tcg/wasm32.c> <tcg/wasm32/tcg-target.c.inc>')
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

const cpusSource = await readFile(cpusPath, 'utf8')
const cpusEol = cpusSource.includes('\r\n') ? '\r\n' : '\n'
const clockPrototypeAnchor = `static const AccelOpsClass *cpus_accel;${cpusEol}`
const virtualClockAnchor = `    if (cpus_accel && cpus_accel->get_virtual_clock) {${cpusEol}        return cpus_accel->get_virtual_clock();${cpusEol}    }${cpusEol}    return cpu_get_clock();`
const elapsedTicksAnchor = `    if (cpus_accel->get_elapsed_ticks) {${cpusEol}        return cpus_accel->get_elapsed_ticks();${cpusEol}    }${cpusEol}    return cpu_get_ticks();`
if (!cpusSource.includes(clockPrototypeAnchor) || !cpusSource.includes(virtualClockAnchor) || !cpusSource.includes(elapsedTicksAnchor)) {
  throw new Error('QEMU CPU clock anchors changed')
}
if (cpusSource.includes('linuxlab_adjust_virtual_clock')) throw new Error('Linux Lab clock adjustment is already registered')
let patchedCpus = cpusSource.replace(
  clockPrototypeAnchor,
  `${clockPrototypeAnchor}${cpusEol}int64_t linuxlab_adjust_virtual_clock(int64_t raw_clock);${cpusEol}int64_t linuxlab_adjust_elapsed_ticks(int64_t raw_ticks);${cpusEol}`,
)
patchedCpus = patchedCpus.replace(
  virtualClockAnchor,
  `    if (cpus_accel && cpus_accel->get_virtual_clock) {${cpusEol}        return linuxlab_adjust_virtual_clock(cpus_accel->get_virtual_clock());${cpusEol}    }${cpusEol}    return linuxlab_adjust_virtual_clock(cpu_get_clock());`,
)
patchedCpus = patchedCpus.replace(
  elapsedTicksAnchor,
  `    if (cpus_accel->get_elapsed_ticks) {${cpusEol}        return linuxlab_adjust_elapsed_ticks(cpus_accel->get_elapsed_ticks());${cpusEol}    }${cpusEol}    return linuxlab_adjust_elapsed_ticks(cpu_get_ticks());`,
)
await writeFile(cpusPath, patchedCpus, 'utf8')

const wasm32Source = await readFile(wasm32Path, 'utf8')
const wasm32Eol = wasm32Source.includes('\r\n') ? '\r\n' : '\n'
const wasm32DeclarationAnchor = `#include "wasm32.h"${wasm32Eol}`
const dispatcherAnchor = `    while (true) {${wasm32Eol}        trysleep();${wasm32Eol}        int tb_counter_ptr = (uint32_t)ctx.tb_ptr + counter_vec_off;`
if (!wasm32Source.includes(wasm32DeclarationAnchor) || !wasm32Source.includes(dispatcherAnchor)) {
  throw new Error('QEMU Wasm dispatcher pause anchors changed')
}
if (wasm32Source.includes('void linuxlab_vcpu_pause_wait(void);')) throw new Error('Linux Lab dispatcher pause hook is already registered')
let patchedWasm32 = wasm32Source.replace(
  wasm32DeclarationAnchor,
  `${wasm32DeclarationAnchor}${wasm32Eol}void linuxlab_vcpu_pause_wait(void);${wasm32Eol}`,
)
patchedWasm32 = patchedWasm32.replace(
  dispatcherAnchor,
  `    while (true) {${wasm32Eol}        linuxlab_vcpu_pause_wait();${wasm32Eol}        trysleep();${wasm32Eol}        int tb_counter_ptr = (uint32_t)ctx.tb_ptr + counter_vec_off;`,
)
await writeFile(wasm32Path, patchedWasm32, 'utf8')

const wasmSource = await readFile(wasmTargetPath, 'utf8')
const wasmEol = wasmSource.includes('\r\n') ? '\r\n' : '\n'
const gotoPtrLoop = `    tcg_wasm_out_op_i64_const(s, 0);${wasmEol}    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);${wasmEol}    tcg_wasm_out_op_br(s, 2); // br to the top of loop`
const gotoTbLoop = `    tcg_wasm_out_op_i64_const(s, 0);${wasmEol}    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);${wasmEol}    tcg_wasm_out_op_br(s, 3); // br to the top of loop`
const dispatcherReturn = `    tcg_wasm_out_op_i64_const(s, 0);${wasmEol}    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);${wasmEol}    tcg_wasm_out_op_i32_const(s, 0);${wasmEol}    tcg_wasm_out_op_return(s);`
const ptrMatches = wasmSource.split(gotoPtrLoop).length - 1
const tbMatches = wasmSource.split(gotoTbLoop).length - 1
if (ptrMatches !== 1 || tbMatches !== 1) {
  throw new Error(`QEMU Wasm self-loop anchors changed: goto_ptr=${ptrMatches}, goto_tb=${tbMatches}`)
}
if (wasmSource.includes('Linux Lab dispatcher boundary')) throw new Error('Linux Lab self-loop patch is already registered')
const patchedWasm = wasmSource
  .replace(gotoPtrLoop, `${dispatcherReturn} // Linux Lab dispatcher boundary`)
  .replace(gotoTbLoop, `${dispatcherReturn} // Linux Lab dispatcher boundary`)
await writeFile(wasmTargetPath, patchedWasm, 'utf8')
