import { readFile, writeFile } from 'node:fs/promises'

const mesonPath = process.argv[2]
const mainPath = process.argv[3]
const wasm32Path = process.argv[4]
if (!mesonPath || !mainPath || !wasm32Path) {
  throw new Error('usage: patch-control.mjs <system/meson.build> <system/main.c> <tcg/wasm32.c>')
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

const wasm32Source = await readFile(wasm32Path, 'utf8')
const wasm32Eol = wasm32Source.includes('\r\n') ? '\r\n' : '\n'
const declarationAnchor = `#include "wasm32.h"${wasm32Eol}`
const loopAnchor = `    while (true) {${wasm32Eol}        trysleep();`
if (!wasm32Source.includes(declarationAnchor) || !wasm32Source.includes(loopAnchor)) {
  throw new Error('QEMU Wasm TB dispatcher pause anchors changed')
}
if (wasm32Source.includes('linuxlab_vcpu_pause_point')) {
  throw new Error('Linux Lab Wasm pause point is already registered')
}
let patchedWasm32 = wasm32Source.replace(
  declarationAnchor,
  `${declarationAnchor}${wasm32Eol}void linuxlab_vcpu_pause_point(void);${wasm32Eol}`,
)
patchedWasm32 = patchedWasm32.replace(
  loopAnchor,
  `    while (true) {${wasm32Eol}        linuxlab_vcpu_pause_point();${wasm32Eol}        trysleep();`,
)
await writeFile(wasm32Path, patchedWasm32, 'utf8')
