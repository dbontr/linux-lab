# Security

## Browser trust boundary

Linux Lab is a static browser application. Guest Linux code runs inside the v86 WebAssembly emulator. Microsoft access and refresh tokens remain in the browser and are not passed into the guest.

The OneDrive mount is implemented by a browser-side 9P server. The guest receives filesystem operations, not OAuth credentials.

## Boot media

Catalog boot artifacts are pinned by SHA-256 in `distros/sources.json`. GitHub Actions fails the build if downloaded bytes do not match the recorded digest.

Custom user-supplied boot media is not trusted or integrity-pinned. It runs inside the emulator but can still interact with emulated devices and any OneDrive filesystem the user intentionally exposes to that session.

## OneDrive scope

The application requests `Files.ReadWrite` because a writable Linux mount needs create, update, rename, and delete operations. Disconnecting OneDrive deletes the locally stored session from Linux Lab's IndexedDB database.

## Reporting

Use a private GitHub security advisory for vulnerabilities that could expose Microsoft tokens, escape the intended browser/guest trust boundary, or corrupt cloud files. Use ordinary GitHub issues for non-sensitive bugs.
