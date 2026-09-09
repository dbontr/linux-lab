# Linux Lab

Linux Lab runs compatible Linux distributions directly in a web browser from GitHub Pages. The guest machine is disposable by default. Users can optionally connect Microsoft OneDrive and expose it to Linux as a `9P2000.L` virtio filesystem.

**Pages:** https://dbontr.github.io/linux-lab/

## What it provides

- Real x86 Linux guests through [v86](https://github.com/copy/v86), not a simulated web desktop.
- A manifest-driven distro catalog with Alpine Linux and Tiny Core Linux as initial targets.
- User-supplied HTTP(S) ISO and disk images.
- Browser-native networking through the v86 fetch backend.
- Optional OneDrive storage exposed to the guest as `host9p`.
- Read, write, create, rename, directory, lock, flush, and delete operations through a browser-side `9P2000.L` server.
- PKCE Microsoft authentication with no client secret in the site.
- SHA-256-pinned BIOS/media sources plus a reproducible Alpine x86 image builder.
- Lazy 4 MiB root-disk chunks so prepared guests do not require a full disk download before boot.
- GitHub Pages deployment with no application server.

## Architecture

```text
GitHub repository
├── Vite/TypeScript browser shell
├── distro catalog + pinned source manifest
└── GitHub Actions
        │
        ├── verify/download distro media + BIOS
        ├── build the Alpine browser root image
        ├── test + build
        └── deploy GitHub Pages

Browser
├── Linux Lab UI
├── v86 WebAssembly x86 runtime
│   ├── Linux guest
│   ├── browser fetch network backend
│   └── virtio 9P device (optional)
└── OneDrive bridge
    ├── Microsoft OAuth 2.0 + PKCE
    ├── Microsoft Graph filesystem adapter
    └── 9P2000.L server → host9p → /mnt/onedrive
```

The guest root filesystem and OneDrive are deliberately separate. Destroying or replacing a guest does not alter the cloud-storage architecture.

## Run locally

```bash
npm ci
npm run sync:distros
npm test
npm run dev
```

For a production-equivalent build on Linux or WSL:

```bash
npm run check
npm run sync:distros
sudo bash distro-build/alpine/build.sh
npm run build
npm run preview
```

The Alpine builder starts from the pinned official x86 minirootfs, installs signed `v3.24` packages, creates a writable ext4 root, and splits it into GitHub-Pages-friendly chunks. Generated image files are ignored by Git.

## Add or update a distro

The browser UI does not contain distro-specific boot logic. Catalog entries live in `public/distros/catalog.json`. Reproducible upstream artifacts live in `distros/sources.json` with an exact SHA-256 digest.

A catalog entry currently supports:

```json
{
  "id": "example-x86",
  "name": "Example Linux",
  "version": "1.0",
  "architecture": "x86",
  "summary": "Example browser-compatible Linux image.",
  "media": { "kind": "cdrom", "path": "distros/example.iso" },
  "memoryMiB": 512,
  "vgaMemoryMiB": 8,
  "networkDevice": "virtio",
  "homepage": "https://example.org/"
}
```

For a conventional ISO/HDD entry, add the matching download source to `distros/sources.json`. `npm run sync:distros` fails closed if the downloaded bytes do not match the pinned digest.

Prepared guests can instead reference a direct-Linux descriptor:

```json
"linux": { "descriptorPath": "distros/example-v86/boot.json" }
```

The descriptor names a kernel, initramfs, aligned rootfs size, fixed chunk size, and kernel command line. `distro-build/alpine/build.sh` is the reference implementation for producing this layout from an upstream distro.

## OneDrive

When OneDrive is connected before boot, Linux Lab supplies a custom v86 `handle9p` server. In a compatible Linux guest, mount it with:

```bash
mkdir -p /mnt/onedrive
mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144,access=any host9p /mnt/onedrive
```

Linux Lab maps ordinary guest file operations to Microsoft Graph. Cloud files use regular file/directory semantics. Unix-only concepts that OneDrive cannot represent faithfully, such as device nodes, hard links, and symbolic links, are intentionally not emulated as native OneDrive objects.

### Microsoft application registration

The site uses an OAuth public-client identifier and never contains a client secret. The deployed Pages URL must be allowed as a SPA redirect URI in the Microsoft application registration:

```text
https://dbontr.github.io/linux-lab/
```

A different public client ID can be injected at build time with `VITE_MICROSOFT_CLIENT_ID`.

## Current compatibility boundary

The current v86 engine emulates 32-bit x86 and does not provide x86-64 or multicore CPU support. Linux Lab therefore rejects claims of general modern x86-64 distro compatibility. Alpine x86 and Tiny Core x86 are the initial verified catalog targets. The runtime layer is isolated so a future x86-64 browser backend can be added without redesigning the catalog or OneDrive filesystem.

## Verification

```bash
npm test
npm run build
```

The protocol test suite exercises 9P negotiation plus create, write, flush, read, rename, and unlink operations against an in-memory cloud filesystem. The Pages workflow repeats tests before every deployment.

## License

MIT. Third-party guest images and v86 remain under their respective licenses.
