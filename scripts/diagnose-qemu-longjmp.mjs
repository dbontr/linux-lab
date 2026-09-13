import { readFile, writeFile } from 'node:fs/promises'

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('expected generated QEMU JavaScript paths')

let sentinels = 0
let mainHooks = 0
let workerCatches = 0
for (const file of files) {
  const source = await readFile(file, 'utf8')
  let patched = source
  let fileSentinels = 0
  patched = patched.replace(/throw Infinity/g, () => {
    fileSentinels += 1
    return 'globalThis.LINUXLAB_LAST_LONGJMP_STACK=new Error().stack;throw Infinity'
  })

  const messageAnchor = 'if(cmd==="checkMailbox"){'
  let fileMainHooks = 0
  if (patched.includes(messageAnchor)) {
    patched = patched.replace(messageAnchor, 'if(cmd==="linuxlabLongjmpStack"){console.error("LINUXLAB_LONGJMP_STACK_UNCAUGHT",d["stack"])}else if(cmd==="checkMailbox"){')
    fileMainHooks = 1
  }

  const catchAnchor = '}catch(ex){if(Module["__emscripten_thread_crashed"]){'
  let fileWorkerCatches = 0
  if (patched.includes(catchAnchor)) {
    patched = patched.replace(
      catchAnchor,
      '}catch(ex){if(ex===Infinity&&globalThis.LINUXLAB_LAST_LONGJMP_STACK){postMessage({cmd:"linuxlabLongjmpStack",stack:globalThis.LINUXLAB_LAST_LONGJMP_STACK})}if(Module["__emscripten_thread_crashed"]){',
    )
    fileWorkerCatches = 1
  }

  sentinels += fileSentinels
  mainHooks += fileMainHooks
  workerCatches += fileWorkerCatches
  console.log(`${file}: ${fileSentinels} sentinel(s), ${fileMainHooks} main hook(s), ${fileWorkerCatches} worker escape hook(s)`)
  if (patched !== source) await writeFile(file, patched, 'utf8')
}

if (sentinels !== 1) throw new Error(`expected exactly one longjmp sentinel, found ${sentinels}`)
if (mainHooks !== 1) throw new Error(`expected exactly one QEMU main trace hook, found ${mainHooks}`)
if (workerCatches !== 1) throw new Error(`expected exactly one QEMU worker escape hook, found ${workerCatches}`)
