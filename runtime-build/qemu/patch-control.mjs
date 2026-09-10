import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const cpuExecPath = process.argv[4]
const mttcgPath = process.argv[5]
const wasm32Path = process.argv[6]
if (!mesonPath || !mainPath || !cpuExecPath || !mttcgPath || !wasm32Path) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <accel/tcg/cpu-exec.c> <accel/tcg/tcg-accel-ops-mttcg.c> <tcg/wasm32.c>')
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
const eol = mainSource.includes('\r\n') ? '\r\n' : '\n'
const prototypeAnchor = `${eol}int qemu_default_main(void)`
const callAnchor = `    qemu_init(argc, argv);${eol}    return qemu_main();`
if (!mainSource.includes(prototypeAnchor) || !mainSource.includes(callAnchor)) {
  throw new Error('QEMU main control anchors changed')
}
let patched = mainSource.replace(prototypeAnchor, `${eol}void linuxlab_runtime_prepare(void);${eol}void linuxlab_runtime_ready(void);${eol}${eol}int qemu_default_main(void)`)
patched = patched.replace(callAnchor, `    linuxlab_runtime_prepare();${eol}    qemu_init(argc, argv);${eol}    linuxlab_runtime_ready();${eol}    return qemu_main();`)
await writeFile(mainPath, patched, 'utf8')

const cpuExecSource = await readFile(cpuExecPath, 'utf8')
const cpuExecEol = cpuExecSource.includes('\r\n') ? '\r\n' : '\n'
const cpuExecDeclarationAnchor = `#include "internal-target.h"${cpuExecEol}`
const interruptAnchor = `static inline bool cpu_handle_interrupt(CPUState *cpu,${cpuExecEol}                                        TranslationBlock **last_tb)${cpuExecEol}{`
const requestedExitAnchor = `    *last_tb = NULL;${cpuExecEol}    insns_left = qatomic_read(&cpu->neg.icount_decr.u32);`
if (!cpuExecSource.includes(cpuExecDeclarationAnchor) || !cpuExecSource.includes(interruptAnchor) || !cpuExecSource.includes(requestedExitAnchor)) {
  throw new Error('QEMU CPU execution pause anchors changed')
}
if (cpuExecSource.includes('linuxlab_pause_requested')) {
  throw new Error('Linux Lab CPU execution pause hook is already registered')
}
let patchedCpuExec = cpuExecSource.replace(
  cpuExecDeclarationAnchor,
  `${cpuExecDeclarationAnchor}${cpuExecEol}bool linuxlab_pause_requested(void);${cpuExecEol}`,
)
patchedCpuExec = patchedCpuExec.replace(
  interruptAnchor,
  `${interruptAnchor}${cpuExecEol}    if (unlikely(linuxlab_pause_requested())) {${cpuExecEol}        cpu->exception_index = EXCP_INTERRUPT;${cpuExecEol}        *last_tb = NULL;${cpuExecEol}        return true;${cpuExecEol}    }${cpuExecEol}`,
)
patchedCpuExec = patchedCpuExec.replace(
  requestedExitAnchor,
  `    *last_tb = NULL;${cpuExecEol}    if (unlikely(linuxlab_pause_requested())) {${cpuExecEol}        return;${cpuExecEol}    }${cpuExecEol}    insns_left = qatomic_read(&cpu->neg.icount_decr.u32);`,
)
await writeFile(cpuExecPath, patchedCpuExec, 'utf8')

const mttcgSource = await readFile(mttcgPath, 'utf8')
const mttcgEol = mttcgSource.includes('\r\n') ? '\r\n' : '\n'
const mttcgDeclarationAnchor = `#include "tcg-accel-ops-mttcg.h"${mttcgEol}`
const mttcgLoopAnchor = `    do {${mttcgEol}        if (cpu_can_run(cpu)) {`
if (!mttcgSource.includes(mttcgDeclarationAnchor) || !mttcgSource.includes(mttcgLoopAnchor)) {
  throw new Error('QEMU MTTCG pause anchors changed')
}
if (mttcgSource.includes('linuxlab_vcpu_pause_wait')) {
  throw new Error('Linux Lab MTTCG pause wait is already registered')
}
let patchedMttcg = mttcgSource.replace(
  mttcgDeclarationAnchor,
  `${mttcgDeclarationAnchor}${mttcgEol}bool linuxlab_pause_requested(void);${mttcgEol}void linuxlab_vcpu_pause_wait(void);${mttcgEol}`,
)
patchedMttcg = patchedMttcg.replace(
  mttcgLoopAnchor,
  `    do {${mttcgEol}        if (linuxlab_pause_requested()) {${mttcgEol}            qemu_mutex_unlock_iothread();${mttcgEol}            linuxlab_vcpu_pause_wait();${mttcgEol}            qemu_mutex_lock_iothread();${mttcgEol}        }${mttcgEol}        if (cpu_can_run(cpu)) {`,
)
await writeFile(mttcgPath, patchedMttcg, 'utf8')

const wasm32Source = await readFile(wasm32Path, 'utf8')
const wasm32Eol = wasm32Source.includes('\r\n') ? '\r\n' : '\n'
const declarationAnchor = `#include "wasm32.h"${wasm32Eol}`
const loopAnchor = `    while (true) {${wasm32Eol}        trysleep();`
if (!wasm32Source.includes(declarationAnchor) || !wasm32Source.includes(loopAnchor)) {
  throw new Error('QEMU Wasm TB dispatcher pause anchors changed')
}
if (wasm32Source.includes('linuxlab_pause_requested')) {
  throw new Error('Linux Lab Wasm pause exit is already registered')
}
let patchedWasm32 = wasm32Source.replace(
  declarationAnchor,
  `${declarationAnchor}${wasm32Eol}bool linuxlab_pause_requested(void);${wasm32Eol}`,
)
patchedWasm32 = patchedWasm32.replace(
  loopAnchor,
  `    while (true) {${wasm32Eol}        if (linuxlab_pause_requested()) {${wasm32Eol}            TranslationBlock *pause_tb = tcg_tb_lookup((uintptr_t)ctx.tb_ptr);${wasm32Eol}            if (pause_tb) {${wasm32Eol}                ctx.tb_ptr = 0;${wasm32Eol}                return (uintptr_t)pause_tb | TB_EXIT_REQUESTED;${wasm32Eol}            }${wasm32Eol}        }${wasm32Eol}        trysleep();`,
)
await writeFile(wasm32Path, patchedWasm32, 'utf8')
