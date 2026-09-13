import { readFile, writeFile } from 'node:fs/promises'

const wasm32Path = process.argv[2]
const tcgPath = process.argv[3]
const targetPath = process.argv[4]
if (!wasm32Path || !tcgPath || !targetPath) {
  throw new Error('usage: patch-wasm-asyncify.mjs <tcg/wasm32.c> <tcg/tcg.c> <tcg/wasm32/tcg-target.c.inc>')
}

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText)
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`expected one ${label} anchor`)
  }
  return source.replace(oldText, newText)
}

const wasm32Source = await readFile(wasm32Path, 'utf8')
const wasm32Eol = wasm32Source.includes('\r\n') ? '\r\n' : '\n'
const helperAnchor = `        var helper = {};${wasm32Eol}        for (var i = 0; i < import_vec_size / 4; i++) {`
if (wasm32Source.includes('helper.u = () =>')) {
  throw new Error('QEMU Wasm Asyncify state helper is already registered')
}
const patchedWasm32 = replaceOnce(
  wasm32Source,
  helperAnchor,
  `        var helper = {};${wasm32Eol}        helper.u = () => (Asyncify.state != Asyncify.State.Unwinding) ? 1 : 0;${wasm32Eol}        for (var i = 0; i < import_vec_size / 4; i++) {`,
  'Wasm helper object',
)
await writeFile(wasm32Path, patchedWasm32, 'utf8')
const tcgSource = await readFile(tcgPath, 'utf8')
const tcgEol = tcgSource.includes('\r\n') ? '\r\n' : '\n'
let patchedTcg = tcgSource
const typeAnchor = `    0x60,${tcgEol}    0x01, 0x7f,${tcgEol}    0x01, 0x7f,${tcgEol}    ${tcgEol}};`
patchedTcg = replaceOnce(
  patchedTcg,
  typeAnchor,
  `    0x60,${tcgEol}    0x01, 0x7f,${tcgEol}    0x01, 0x7f,${tcgEol}    0x60,${tcgEol}    0x00,${tcgEol}    0x01, 0x7f,${tcgEol}    ${tcgEol}};`,
  'Wasm type section',
)
const memoryImportAnchor = `    0x02, 0x03, 0x00, 0x80, 0x80, 0x80, 0x80, 0x00,${tcgEol}};`
patchedTcg = replaceOnce(
  patchedTcg,
  memoryImportAnchor,
  `    0x02, 0x03, 0x00, 0x80, 0x80, 0x80, 0x80, 0x00,${tcgEol}    0x06, 0x68, 0x65, 0x6c, 0x70, 0x65, 0x72,${tcgEol}    0x01, 0x75,${tcgEol}    0x00, 0x01,${tcgEol}};`,
  'Wasm fixed Asyncify import',
)
patchedTcg = replaceOnce(
  patchedTcg,
  `    uint32_t type_section_size = added + 10;${tcgEol}    fill_uint32_leb128((uintptr_t)header_a_ptr + 9, type_section_size);${tcgEol}    fill_uint32_leb128((uintptr_t)header_a_ptr + 14, num_helper_funcs + 1);`,
  `    uint32_t type_section_size = added + 14;${tcgEol}    fill_uint32_leb128((uintptr_t)header_a_ptr + 9, type_section_size);${tcgEol}    fill_uint32_leb128((uintptr_t)header_a_ptr + 14, num_helper_funcs + 2);`,
  'Wasm type section accounting',
)
patchedTcg = replaceOnce(
  patchedTcg,
  `    uint32_t import_section_size = 35 + added - 11;${tcgEol}    fill_uint32_leb128((uintptr_t)header_b_ptr + 1, import_section_size);${tcgEol}    fill_uint32_leb128((uintptr_t)header_b_ptr + 6, num_imported_funcs + 1/*buffer+helpers...*/);`,
  `    uint32_t import_section_size = 35 + added;${tcgEol}    fill_uint32_leb128((uintptr_t)header_b_ptr + 1, import_section_size);${tcgEol}    fill_uint32_leb128((uintptr_t)header_b_ptr + 6, num_imported_funcs + 2/*buffer+Asyncify+helpers...*/);`,
  'Wasm import section accounting',
)
patchedTcg = replaceOnce(
  patchedTcg,
  `        wasm_blob_ptr = tcg_out_import_entry(s, wasm_blob_ptr, i, i+1/*type0=start,1=helpers...*/);`,
  `        wasm_blob_ptr = tcg_out_import_entry(s, wasm_blob_ptr, i, i+2/*type0=start,1=Asyncify,2=helpers...*/);`,
  'dynamic helper import type',
)
patchedTcg = replaceOnce(
  patchedTcg,
  `    write_wasm_export_section_size(s, header_c_base, num_helper_funcs);`,
  `    write_wasm_export_section_size(s, header_c_base, num_helper_funcs + 1);`,
  'Wasm start function index',
)
await writeFile(tcgPath, patchedTcg, 'utf8')

const targetSource = await readFile(targetPath, 'utf8')
const targetEol = targetSource.includes('\r\n') ? '\r\n' : '\n'
let patchedTarget = targetSource
patchedTarget = replaceOnce(
  patchedTarget,
  `#define HELPER_TABLE_IDX 0${targetEol}`,
  `#define HELPER_TABLE_IDX 0${targetEol}#define CHECK_UNWINDING_IDX 0${targetEol}`,
  'Asyncify checker function index',
)
const wrapperAnchor = `void gen_func_wrapper_code(TCGContext *s, const tcg_insn_unit *func, const TCGHelperInfo *info, int func_idx)${targetEol}`
const unwindHelper = `static void tcg_wasm_out_handle_unwinding(TCGContext *s)${targetEol}{${targetEol}    tcg_wasm_out_op_call(s, CHECK_UNWINDING_IDX);${targetEol}    tcg_wasm_out_op_i32_eqz(s);${targetEol}    tcg_wasm_out_op_if_noret(s);${targetEol}    tcg_wasm_out_op_i32_const(s, 0);${targetEol}    tcg_wasm_out_op_return(s);${targetEol}    tcg_wasm_out_op_end(s);${targetEol}}${targetEol}${targetEol}`
patchedTarget = replaceOnce(
  patchedTarget,
  wrapperAnchor,
  `${unwindHelper}${wrapperAnchor}`,
  'generic helper wrapper',
)
patchedTarget = replaceOnce(
  patchedTarget,
  `    tcg_wasm_out_op_call(s, func_idx);${targetEol}${targetEol}    stack_offset = 0;`,
  `    tcg_wasm_out_op_call(s, func_idx + 1);${targetEol}    tcg_wasm_out_handle_unwinding(s);${targetEol}${targetEol}    stack_offset = 0;`,
  'generic helper call',
)
patchedTarget = replaceOnce(
  patchedTarget,
  `    tcg_wasm_out_op_call(s, func_idx);${targetEol}    tcg_wasm_out_op_global_set_r(s, data_reg);`,
  `    tcg_wasm_out_op_call(s, func_idx + 1);${targetEol}    tcg_wasm_out_handle_unwinding(s);${targetEol}    tcg_wasm_out_op_global_set_r(s, data_reg);`,
  'load helper call',
)
patchedTarget = replaceOnce(
  patchedTarget,
  `    tcg_wasm_out_op_call(s, func_idx);${targetEol}${targetEol}    tcg_wasm_out_ctx_i32_load(s, DONE_FLAG_OFF);`,
  `    tcg_wasm_out_op_call(s, func_idx + 1);${targetEol}    tcg_wasm_out_handle_unwinding(s);${targetEol}${targetEol}    tcg_wasm_out_ctx_i32_load(s, DONE_FLAG_OFF);`,
  'store helper call',
)
await writeFile(targetPath, patchedTarget, 'utf8')