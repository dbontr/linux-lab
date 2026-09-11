import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const mttcgPath = process.argv[4]
if (!mesonPath || !mainPath || !mttcgPath) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <accel/tcg/tcg-accel-ops-mttcg.c>')
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
