# Linux Lab

Linux Lab boots compatible Linux PC media directly in a browser from GitHub Pages. It supports prepared 32-bit x86 guests, an x86-64 QEMU-Wasm compatibility runtime, local ISO/IMG uploads, and optional OneDrive storage for v86 guests.

**Pages:** https://dbontr.github.io/linux-lab/

## What it provides

- Real guest operating systems, not a simulated web desktop.
- v86 for the fast prepared x86 path.
- Source-built QEMU-Wasm for x86-64 and general PC media.
- Local ISO, IMG, and raw-disk upload without an application server.
- Automatic ISO-versus-disk detection with manual override.
- Automatic runtime and BIOS/UEFI selection with manual overrides.
- Prepared Alpine x86, Alpine x86-64, and Tiny Core catalog targets.
- Browser-native networking for v86 guests.
- Optional OneDrive storage exposed to compatible v86 guests as `host9p`.
- PKCE Microsoft authentication with no client secret and no OAuth token exposed to the guest.
- SHA-256-pinned external boot/build inputs and reproducible GitHub Actions deployment.

An accepted file is not necessarily bootable. The compatibility target is x86/x86-64 PC media that boots through legacy BIOS or UEFI using devices implemented by the selected browser runtime.

## Architecture

```text
GitHub Pages
  Host shell (Vite/TypeScript)
  Distro/runtime assets
  v86 backend
    Prepared x86 Linux
    Browser fetch networking
    host9p -> OneDrive
  QEMU-Wasm backend
    x86-64 PC system emulation
    SDL2 display/input
    WORKERFS local ISO/IMG media
    SeaBIOS + EDK2 UEFI firmware
```

The host selects a runtime from the manifest. Prepared 32-bit guests use v86. x86-64 and architecture-unknown PC media use QEMU-Wasm unless the user explicitly overrides it.

QEMU runs in a same-origin iframe. Replacing or removing the iframe provides a clean VM lifecycle boundary for Emscripten pthread workers and emulator state.

## Custom ISO and IMG files

Choose a local ISO, IMG, or raw disk from the custom-media dialog. Linux Lab keeps the selected browser `File` local to the device.

The automatic path is:

1. Detect ISO-9660 optical media from `CD001`; otherwise treat the file as a disk image.
2. Route architecture-unknown PC media to QEMU-Wasm so either 32-bit or 64-bit x86 guests can boot.
3. Detect UEFI ISOs from El Torito EFI entries.
4. Detect UEFI disk images from MBR EFI partitions or GPT EFI System Partitions.
5. Use legacy BIOS when no EFI boot structure is found.
6. Boot with a generic PC machine, IDE optical/disk devices, and standard VGA.

The dialog exposes media, runtime, and firmware overrides for ambiguous or unusual images. Remote HTTP(S) media remains supported when the source permits cross-origin browser access.

QEMU uses Emscripten `WORKERFS` for local media, allowing large local files to be read from the browser `File` without first duplicating the entire image into WebAssembly memory.

## OneDrive

OneDrive integration currently belongs to the v86 backend. When connected before boot, Linux Lab exposes a custom `9P2000.L` server as `host9p`. Prepared Alpine mounts it at `/mnt/onedrive` automatically; other compatible v86 Linux guests can mount it manually.

The QEMU x86-64 path does not yet expose the OneDrive 9P bridge or browser networking. Those are backend capability gaps, not guest-image format restrictions.

## Run locally

```bash
npm ci
npm run sync:distros
npm run check
npm run dev
```

The checked-in host can be developed without rebuilding QEMU. A production-equivalent artifact also needs generated VM/runtime files:

```bash
sudo bash distro-build/alpine/build.sh
bash runtime-build/qemu/build.sh
npm run build
npm run preview
```

The QEMU builder requires Git, Docker, Node.js, `sha256sum`, and `bzip2`. It checks out a pinned `qemu-wasm` commit, verifies its repaired zlib input, builds `x86_64-softmmu` with Emscripten pthreads and SDL2, packages PC BIOS/UEFI firmware, and emits checksums for generated runtime assets.

Generated VM images and QEMU binaries are ignored by Git and rebuilt or restored from the GitHub Actions cache during deployment.

## Verification

`npm run check` runs the protocol/media unit tests, strict TypeScript compilation, and the production Vite build. The media tests cover ISO detection, El Torito UEFI detection, GPT EFI System Partition detection, and BIOS fallback.

The Pages workflow repeats verification and builds the source-pinned QEMU-Wasm runtime before deployment.

## Compatibility boundary

Linux Lab targets x86 and x86-64 PC boot media, not arbitrary CPU architectures or malformed/non-bootable files. Browser WebAssembly memory and CPU-emulation cost also impose stricter limits than native QEMU, especially for memory-heavy desktop distributions.

## License

MIT. QEMU, v86, guest distributions, firmware, and other third-party assets remain under their respective licenses.
