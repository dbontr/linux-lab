import { readFile, writeFile } from 'node:fs/promises'

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('expected generated QEMU JavaScript paths')

let sentinels = 0
let workerHooks = 0
for (const file of files) {
  const source = await readFile(file, 'utf8')
  let patched = source
  let fileSentinels = 0
  patched = patched.replace(/throw Infinity/g, () => {
    fileSentinels += 1
    return 'if(globalThis.LINUXLAB_LONGJMP_TRACE){console.error("LINUXLAB_LONGJMP_STACK",new Error().stack)}throw Infinity'
  })

  const mailboxAnchor = '}else if(e.data.cmd==="checkMailbox"){'
  let fileWorkerHooks = 0
  if (patched.includes(mailboxAnchor)) {
    patched = patched.replace(
      mailboxAnchor,
      '}else if(e.data.cmd==="linuxlabLongjmpTrace"){globalThis.LINUXLAB_LONGJMP_TRACE=!!e.data.enabled}else if(e.data.cmd==="checkMailbox"){',
    )
    fileWorkerHooks = 1
  }

  sentinels += fileSentinels
  workerHooks += fileWorkerHooks
  console.log(`${file}: instrumented ${fileSentinels} longjmp sentinel(s), ${fileWorkerHooks} worker trace hook(s)`)
  if (patched !== source) await writeFile(file, patched, 'utf8')
}

if (sentinels !== 1) throw new Error(`expected exactly one longjmp sentinel, found ${sentinels}`)
if (workerHooks !== 1) throw new Error(`expected exactly one QEMU worker trace hook, found ${workerHooks}`)
