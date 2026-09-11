#!/usr/bin/env bash
set -euo pipefail

QEMU_COMMIT="0ef7b4e2814b231705d8371dd7997f5b72e70baf"
SDL_COMMIT="55b03c7493a7abed33cf803d1380a40fa8af903f"
C2W_NET_VERSION="v0.5.0"
C2W_NET_SHA256="b01b09c3a60444c3ebaca9ef60a63b7581ebea5a00c6b7844eded719c98b5aa1"
C2W_NET_LICENSE_SHA256="cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
IMAGE_NAME="linux-lab-qemu-wasm"
CONTAINER_NAME="linux-lab-qemu-wasm-build"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/public/qemu}"
WORK_DIR="${LINUX_LAB_QEMU_BUILD_DIR:-/tmp/linux-lab-qemu-wasm}"
SOURCE_DIR="$WORK_DIR/source"
SDL_SOURCE_DIR="$WORK_DIR/sdl2"
PACK_DIR="$WORK_DIR/pack"
NETWORK_SOURCE_DIR="$SOURCE_DIR/examples/networking/htdocs"
NETWORK_TOOL_DIR="$SCRIPT_DIR/network"
NETWORK_WORK_DIR="$WORK_DIR/network"
NETWORK_OUTPUT_DIR="$OUTPUT_DIR/network"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for tool in git docker node npm sha256sum bzip2 curl gzip; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

rm -rf "$WORK_DIR" "$OUTPUT_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR" "$PACK_DIR"
git clone --filter=blob:none --no-checkout https://github.com/ktock/qemu-wasm.git "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --detach "$QEMU_COMMIT"
node "$SCRIPT_DIR/patch-upstream.mjs" "$SOURCE_DIR/Dockerfile"
cp "$SCRIPT_DIR/linuxlab-media.c" "$SOURCE_DIR/block/linuxlab-media.c"
node "$SCRIPT_DIR/patch-browser-media.mjs" "$SOURCE_DIR/block/meson.build"
cp "$SCRIPT_DIR/linuxlab-onedrive.c" "$SOURCE_DIR/hw/9pfs/linuxlab-onedrive.c"
node "$SCRIPT_DIR/patch-onedrive.mjs" "$SOURCE_DIR/hw/9pfs/meson.build"
cp "$SCRIPT_DIR/linuxlab-control.c" "$SOURCE_DIR/system/linuxlab-control.c"
node "$SCRIPT_DIR/patch-control.mjs" \
  "$SOURCE_DIR/system/meson.build" \
  "$SOURCE_DIR/system/main.c"
node "$SCRIPT_DIR/patch-sdl-software.mjs" "$SOURCE_DIR/ui/sdl2.c"

git clone --filter=blob:none --no-checkout https://github.com/libsdl-org/SDL.git "$SDL_SOURCE_DIR"
git -C "$SDL_SOURCE_DIR" checkout --detach "$SDL_COMMIT"
test "$(git -C "$SDL_SOURCE_DIR" rev-parse HEAD)" = "$SDL_COMMIT"
node "$SCRIPT_DIR/patch-sdl-framebuffer.mjs" "$SDL_SOURCE_DIR/src/video/emscripten/SDL_emscriptenframebuffer.c"
rm -rf "$SDL_SOURCE_DIR/.git"

mkdir -p "$NETWORK_WORK_DIR" "$NETWORK_OUTPUT_DIR"
cp "$NETWORK_SOURCE_DIR/stack.js" "$NETWORK_WORK_DIR/stack.js"
cp "$NETWORK_SOURCE_DIR/stack-worker.js" "$NETWORK_WORK_DIR/stack-worker.js"
cp "$NETWORK_SOURCE_DIR/wasi-util.js" "$NETWORK_WORK_DIR/wasi-util.js"
node "$SCRIPT_DIR/patch-networking.mjs" "$NETWORK_WORK_DIR/stack.js"
npm ci --ignore-scripts --prefix "$NETWORK_TOOL_DIR"
node "$NETWORK_TOOL_DIR/bundle.mjs" "$NETWORK_WORK_DIR/stack.js" "$NETWORK_OUTPUT_DIR/stack.js" Stack
node "$NETWORK_TOOL_DIR/bundle.mjs" "$NETWORK_WORK_DIR/stack-worker.js" "$NETWORK_OUTPUT_DIR/stack-worker.js"
C2W_NET_URL="https://github.com/container2wasm/container2wasm/releases/download/$C2W_NET_VERSION/c2w-net-proxy.wasm"
curl -fL "$C2W_NET_URL" -o "$WORK_DIR/c2w-net-proxy.wasm"
echo "$C2W_NET_SHA256  $WORK_DIR/c2w-net-proxy.wasm" | sha256sum -c -
gzip -9 -n -c "$WORK_DIR/c2w-net-proxy.wasm" > "$NETWORK_OUTPUT_DIR/c2w-net-proxy.wasm.gz"
C2W_NET_LICENSE_URL="https://raw.githubusercontent.com/container2wasm/container2wasm/$C2W_NET_VERSION/LICENSE"
curl -fL "$C2W_NET_LICENSE_URL" -o "$NETWORK_OUTPUT_DIR/LICENSE.apache-2.0"
echo "$C2W_NET_LICENSE_SHA256  $NETWORK_OUTPUT_DIR/LICENSE.apache-2.0" | sha256sum -c -
node "$SCRIPT_DIR/package-network-licenses.mjs" "$NETWORK_TOOL_DIR" "$NETWORK_OUTPUT_DIR/THIRD_PARTY_LICENSES.txt"
cat > "$NETWORK_OUTPUT_DIR/NOTICE.txt" <<EOF
Linux Lab QEMU browser networking runtime

qemu-wasm examples/networking, commit $QEMU_COMMIT: Apache-2.0 as declared by its package manifest.
container2wasm c2w-net-proxy $C2W_NET_VERSION: Apache-2.0.
Bundled npm dependency notices and license texts are in THIRD_PARTY_LICENSES.txt.
EOF

docker build -t "$IMAGE_NAME" -f "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR"
docker run --rm -d \
  --name "$CONTAINER_NAME" \
  -e EMCC_LOCAL_PORTS="sdl2=/linux-lab-sdl2" \
  -v "$SOURCE_DIR:/qemu" \
  -v "$SCRIPT_DIR:/linux-lab-runtime:ro" \
  -v "$SDL_SOURCE_DIR:/linux-lab-sdl2:ro" \
  "$IMAGE_NAME"

docker exec "$CONTAINER_NAME" embuilder --force build sdl2-mt

COMMON_FLAGS="-O3 -g0 -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -pthread -sUSE_SDL=2 -sASYNCIFY=1 -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=dlmalloc --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js"
LINK_FLAGS="--pre-js /linux-lab-runtime/pre.js -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS,ccall"

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
cp "$SDL_SOURCE_DIR/LICENSE.txt" "$OUTPUT_DIR/LICENSE.sdl"

cat > "$OUTPUT_DIR/runtime.json" <<EOF
{
  "qemuCommit": "$QEMU_COMMIT",
  "sdlCommit": "$SDL_COMMIT",
  "architecture": "x86_64",
  "display": "sdl2",
  "localMedia": "browser-blob-range",
  "network": "browser-http-https-proxy",
  "networkProxyVersion": "$C2W_NET_VERSION",
  "oneDrive": "lazy-graph-virtio-9p",
  "controls": ["pause", "resume", "keyboard-text"]
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
    network/stack.js \
    network/stack-worker.js \
    network/c2w-net-proxy.wasm.gz \
    network/LICENSE.apache-2.0 \
    network/THIRD_PARTY_LICENSES.txt \
    network/NOTICE.txt \
    COPYING.qemu \
    LICENSE.sdl \
    runtime.json > SHA256SUMS
)

echo "QEMU-Wasm x86_64 runtime built in $OUTPUT_DIR"
