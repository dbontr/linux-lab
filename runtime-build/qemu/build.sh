#!/usr/bin/env bash
set -euo pipefail

QEMU_COMMIT="0ef7b4e2814b231705d8371dd7997f5b72e70baf"
IMAGE_NAME="linux-lab-qemu-wasm"
CONTAINER_NAME="linux-lab-qemu-wasm-build"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/public/qemu}"
WORK_DIR="${LINUX_LAB_QEMU_BUILD_DIR:-/tmp/linux-lab-qemu-wasm}"
SOURCE_DIR="$WORK_DIR/source"
PACK_DIR="$WORK_DIR/pack"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for tool in git docker node sha256sum bzip2; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

rm -rf "$WORK_DIR" "$OUTPUT_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR" "$PACK_DIR"
git clone --filter=blob:none --no-checkout https://github.com/ktock/qemu-wasm.git "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --detach "$QEMU_COMMIT"
node "$SCRIPT_DIR/patch-upstream.mjs" "$SOURCE_DIR/Dockerfile"

docker build -t "$IMAGE_NAME" -f "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR"
docker run --rm -d \
  --name "$CONTAINER_NAME" \
  -v "$SOURCE_DIR:/qemu" \
  -v "$SCRIPT_DIR:/linux-lab-runtime:ro" \
  "$IMAGE_NAME"

docker exec "$CONTAINER_NAME" embuilder build sdl2-mt

COMMON_FLAGS="-O3 -g0 -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -pthread -sUSE_SDL=2 -sASYNCIFY=1 -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=mimalloc --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js"
LINK_FLAGS="-lworkerfs.js --pre-js /linux-lab-runtime/pre.js -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"

docker exec "$CONTAINER_NAME" emconfigure /qemu/configure \
  --static \
  --target-list=x86_64-softmmu \
  --cpu=wasm32 \
  --cross-prefix= \
  --without-default-features \
  --enable-system \
  --enable-sdl \
  --enable-virtfs \
  --with-coroutine=fiber \
  --extra-cflags="$COMMON_FLAGS" \
  --extra-cxxflags="$COMMON_FLAGS" \
  --extra-ldflags="$LINK_FLAGS"

docker exec "$CONTAINER_NAME" emmake make -j"$(nproc)" qemu-system-x86_64

for firmware in \
  bios-256k.bin \
  bios.bin \
  vgabios.bin \
  vgabios-stdvga.bin \
  vgabios-cirrus.bin \
  kvmvapic.bin \
  linuxboot_dma.bin \
  efi-virtio.rom; do
  if [ -f "$SOURCE_DIR/pc-bios/$firmware" ]; then
    cp "$SOURCE_DIR/pc-bios/$firmware" "$PACK_DIR/"
  fi
done

for firmware in edk2-x86_64-code.fd edk2-i386-vars.fd; do
  source="$SOURCE_DIR/pc-bios/$firmware.bz2"
  if [ ! -f "$source" ]; then
    echo "required UEFI firmware is missing: $firmware" >&2
    exit 1
  fi
  bzip2 -dc "$source" > "$PACK_DIR/$firmware"
done
if [ ! -f "$PACK_DIR/bios-256k.bin" ] || [ ! -f "$PACK_DIR/vgabios-stdvga.bin" ]; then
  echo "required PC firmware is missing" >&2
  exit 1
fi

docker cp "$PACK_DIR" "$CONTAINER_NAME:/pack"
docker exec "$CONTAINER_NAME" /bin/sh -c \
  "/emsdk/upstream/emscripten/tools/file_packager.py qemu-system-x86_64.data --preload /pack > load.js"

docker cp "$CONTAINER_NAME:/build/qemu-system-x86_64" "$OUTPUT_DIR/out.js"
docker cp "$CONTAINER_NAME:/build/qemu-system-x86_64.wasm" "$OUTPUT_DIR/qemu-system-x86_64.wasm"
docker cp "$CONTAINER_NAME:/build/qemu-system-x86_64.worker.js" "$OUTPUT_DIR/qemu-system-x86_64.worker.js"
docker cp "$CONTAINER_NAME:/build/qemu-system-x86_64.data" "$OUTPUT_DIR/qemu-system-x86_64.data"
docker cp "$CONTAINER_NAME:/build/load.js" "$OUTPUT_DIR/load.js"
cp "$SOURCE_DIR/COPYING" "$OUTPUT_DIR/COPYING.qemu"

cat > "$OUTPUT_DIR/runtime.json" <<EOF
{
  "qemuCommit": "$QEMU_COMMIT",
  "architecture": "x86_64",
  "display": "sdl2",
  "localMedia": "workerfs"
}
EOF

(
  cd "$OUTPUT_DIR"
  sha256sum \
    out.js \
    qemu-system-x86_64.wasm \
    qemu-system-x86_64.worker.js \
    qemu-system-x86_64.data \
    load.js \
    runtime.json > SHA256SUMS
)

echo "QEMU-Wasm x86_64 runtime built in $OUTPUT_DIR"
