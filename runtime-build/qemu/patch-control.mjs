import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const cpuExecPath = process.argv[4]
if (!mesonPath || !mainPath || !cpuExecPath) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <accel/tcg/cpu-exec.c>')
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
const declarationAnchor = `#include "internal-target.h"${cpuExecEol}`
const noChainAnchor = `    } else if (qemu_loglevel_mask(CPU_LOG_TB_NOCHAIN)) {${cpuExecEol}        cflags |= CF_NO_GOTO_TB;`
const execLoopAnchor = `        while (!cpu_handle_interrupt(cpu, &last_tb)) {${cpuExecEol}            TranslationBlock *tb;`
if (!cpuExecSource.includes(declarationAnchor) || !cpuExecSource.includes(noChainAnchor) || !cpuExecSource.includes(execLoopAnchor)) {
  throw new Error('QEMU CPU execution pause anchors changed')
}
if (cpuExecSource.includes('linuxlab_vcpu_pause_wait')) {
  throw new Error('Linux Lab CPU pause hook is already registered')
}
let patchedCpuExec = cpuExecSource.replace(
  declarationAnchor,
  `${declarationAnchor}${cpuExecEol}void linuxlab_vcpu_pause_wait(void);${cpuExecEol}`,
)
patchedCpuExec = patchedCpuExec.replace(noChainAnchor, `    } else if (qemu_loglevel_mask(CPU_LOG_TB_NOCHAIN)) {${cpuExecEol}        cflags |= CF_NO_GOTO_TB | CF_NO_GOTO_PTR;`)
patchedCpuExec = patchedCpuExec.replace(
  execLoopAnchor,
  `        while (!cpu_handle_interrupt(cpu, &last_tb)) {${cpuExecEol}            linuxlab_vcpu_pause_wait();${cpuExecEol}            TranslationBlock *tb;`,
)
await writeFile(cpuExecPath, patchedCpuExec, 'utf8')
