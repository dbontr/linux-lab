import { readFile, writeFile } from 'node:fs/promises'

const wasm32Path = process.argv[2]
if (!wasm32Path) throw new Error('usage: patch-wasm-tci-only.mjs <tcg/wasm32.c>')

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText)
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`expected one ${label} anchor`)
  }
  return source.replace(oldText, newText)
}

const source = await readFile(wasm32Path, 'utf8')
const eol = source.includes('\r\n') ? '\r\n' : '\n'
let patched = replaceOnce(
  source,
  'typedef uint32_t (*wasm_func_ptr)(struct wasmContext*);',
  [
    'typedef uint32_t (*wasm_func_ptr)(struct wasmContext*);',
    '',
    '/* Keep setjmp/longjmp control flow inside the primary Emscripten module. */',
    'static const bool linuxlab_dynamic_tb_instantiation = false;',
  ].join(eol),
  'dynamic TB enable flag',
)

const oldBlock = [
  '        uint32_t res;',
  '        int fidx = get_instance_running_local(ctx.tb_ptr);',
  '        if (fidx > 0) {',
  '            res = ((wasm_func_ptr)(fidx))(&ctx);',
  '        } else if (*(int32_t*)tb_counter_ptr < INSTANTIATE_NUM) {',
  '            *(int32_t*)tb_counter_ptr += 1;',
  '            res = tcg_qemu_tb_exec_tci(env);',
  '        } else if (!can_add_instance()) {',
  '            remove_instance_running_local();',
  '            check_instance_garbage_collected();',
  '            res = tcg_qemu_tb_exec_tci(env);',
  '        } else {',
  '            int fidx = instantiate_wasm();',
  '            add_instance_running_local(fidx, ctx.tb_ptr);',
  '            res = ((wasm_func_ptr)(fidx))(&ctx);',
  '        }',
].join(eol)

const newBlock = [
  '        uint32_t res;',
  '        if (!linuxlab_dynamic_tb_instantiation) {',
  '            res = tcg_qemu_tb_exec_tci(env);',
  '        } else {',
  '            int fidx = get_instance_running_local(ctx.tb_ptr);',
  '            if (fidx > 0) {',
  '                res = ((wasm_func_ptr)(fidx))(&ctx);',
  '            } else if (*(int32_t*)tb_counter_ptr < INSTANTIATE_NUM) {',
  '                *(int32_t*)tb_counter_ptr += 1;',
  '                res = tcg_qemu_tb_exec_tci(env);',
  '            } else if (!can_add_instance()) {',
  '                remove_instance_running_local();',
  '                check_instance_garbage_collected();',
  '                res = tcg_qemu_tb_exec_tci(env);',
  '            } else {',
  '                int fidx = instantiate_wasm();',
  '                add_instance_running_local(fidx, ctx.tb_ptr);',
  '                res = ((wasm_func_ptr)(fidx))(&ctx);',
  '            }',
  '        }',
].join(eol)

patched = replaceOnce(patched, oldBlock, newBlock, 'TCG execution dispatch')
await writeFile(wasm32Path, patched, 'utf8')
