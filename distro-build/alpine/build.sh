#!/usr/bin/env bash
set -euo pipefail

ALPINE_VERSION="3.24.1"
ALPINE_BRANCH="v3.24"
MINIROOT="alpine-minirootfs-${ALPINE_VERSION}-x86.tar.gz"
MINIROOT_URL="https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}/releases/x86/${MINIROOT}"
MINIROOT_SHA256="634355e2245c9d56186d1b86fb6e034453eb303aea15b573ca250b343376fffd"
CHUNK_SIZE=4194304
ROOT_IMAGE_MIB=256

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/public/distros/alpine-v86}"
WORK_DIR="${LINUX_LAB_BUILD_DIR:-/tmp/linux-lab-alpine-v86}"
ROOTFS="$WORK_DIR/rootfs"
DOWNLOAD="$WORK_DIR/$MINIROOT"
RAW_IMAGE="$WORK_DIR/alpine-root.img"

if [ "$(id -u)" -ne 0 ]; then
  echo "build.sh must run as root" >&2
  exit 1
fi

for tool in curl sha256sum tar chroot mkfs.ext4 e2fsck resize2fs dumpe2fs truncate awk sed split find du cp mv chmod; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

rm -rf "$WORK_DIR" "$OUTPUT_DIR"
mkdir -p "$ROOTFS" "$OUTPUT_DIR"

curl -fL "$MINIROOT_URL" -o "$DOWNLOAD"
echo "$MINIROOT_SHA256  $DOWNLOAD" | sha256sum -c -
tar -xzf "$DOWNLOAD" -C "$ROOTFS"
cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf"

cat > "$ROOTFS/etc/apk/repositories" <<EOF
https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}/main
https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}/community
EOF

chroot "$ROOTFS" /bin/sh -eux <<'CHROOT'
apk update
apk add --no-cache alpine-base alpine-conf openrc agetty linux-virt linux-firmware-none e2fsprogs curl git nano bash

sed -i 's#^tty1::respawn:.*#tty1::respawn:/sbin/agetty --autologin root tty1 linux#' /etc/inittab
printf '%s\n' 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab
passwd -d root
printf '%s\n' 'linux-lab' > /etc/hostname

cat > /etc/network/interfaces <<'EOF'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
EOF

cat > /etc/modules <<'EOF'
virtio_net
9pnet
9pnet_virtio
9p
EOF

mkdir -p /etc/local.d /mnt/onedrive
cat > /etc/local.d/onedrive.start <<'EOF'
#!/bin/sh
grep -qs ' /mnt/onedrive ' /proc/mounts && exit 0
mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144,access=any host9p /mnt/onedrive 2>/dev/null || true
EOF
chmod 0755 /etc/local.d/onedrive.start
cat > /etc/motd <<'EOF'
Linux Lab / Alpine Linux
OneDrive is available at /mnt/onedrive when connected before boot.
EOF

cat > /etc/fstab <<'EOF'
/dev/sda / ext4 rw,relatime 0 1
proc /proc proc nosuid,noexec,nodev 0 0
sysfs /sys sysfs nosuid,noexec,nodev 0 0
devpts /dev/pts devpts gid=5,mode=620 0 0
tmpfs /tmp tmpfs nodev,nosuid 0 0
EOF

rc-update add devfs sysinit
rc-update add dmesg sysinit
rc-update add mdev sysinit
rc-update add modules boot
rc-update add sysctl boot
rc-update add hostname boot
rc-update add networking boot
rc-update add bootmisc boot
rc-update add local default
rc-update add killprocs shutdown
rc-update add mount-ro shutdown

KERNEL_RELEASE="$(cat /usr/share/kernel/virt/kernel.release)"
printf '%s\n' 'features="ata base ide scsi virtio ext4 9p"' > /etc/mkinitfs/mkinitfs.conf
mkinitfs -c /etc/mkinitfs/mkinitfs.conf "$KERNEL_RELEASE"
apk cache clean
rm -rf /var/cache/apk/* /tmp/*
CHROOT

KERNEL="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'vmlinuz-*' | head -n 1)"
INITRAMFS="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'initramfs-*' | head -n 1)"
if [ -z "$KERNEL" ] || [ -z "$INITRAMFS" ]; then
  echo "kernel or initramfs was not produced" >&2
  exit 1
fi

ROOT_KIB="$(du -sk "$ROOTFS" | awk '{print $1}')"
NEEDED_MIB="$(( (ROOT_KIB + 1023) / 1024 + 48 ))"
if [ "$NEEDED_MIB" -gt "$ROOT_IMAGE_MIB" ]; then ROOT_IMAGE_MIB="$NEEDED_MIB"; fi
truncate -s "${ROOT_IMAGE_MIB}M" "$RAW_IMAGE"
mkfs.ext4 -q -F -d "$ROOTFS" -L linuxlab-root "$RAW_IMAGE"
e2fsck -fy "$RAW_IMAGE" >/dev/null
resize2fs -M "$RAW_IMAGE" >/dev/null
e2fsck -fy "$RAW_IMAGE" >/dev/null
BLOCK_COUNT="$(dumpe2fs -h "$RAW_IMAGE" 2>/dev/null | awk -F: '/Block count/{gsub(/ /,"",$2); print $2}')"
BLOCK_SIZE="$(dumpe2fs -h "$RAW_IMAGE" 2>/dev/null | awk -F: '/Block size/{gsub(/ /,"",$2); print $2}')"
IMAGE_SIZE="$((BLOCK_COUNT * BLOCK_SIZE))"
truncate -s "$IMAGE_SIZE" "$RAW_IMAGE"
PADDED_SIZE="$(( (IMAGE_SIZE + CHUNK_SIZE - 1) / CHUNK_SIZE * CHUNK_SIZE ))"
truncate -s "$PADDED_SIZE" "$RAW_IMAGE"

cp "$KERNEL" "$OUTPUT_DIR/vmlinuz"
cp "$INITRAMFS" "$OUTPUT_DIR/initramfs"

rm -f "$WORK_DIR"/part-*
split -b "$CHUNK_SIZE" -d -a 8 "$RAW_IMAGE" "$WORK_DIR/part-"
index=0
for part in "$WORK_DIR"/part-*; do
  start="$((index * CHUNK_SIZE))"
  end="$((start + CHUNK_SIZE))"
  mv "$part" "$OUTPUT_DIR/rootfs-${start}-${end}.img"
  index="$((index + 1))"
done
cat > "$OUTPUT_DIR/boot.json" <<EOF
{
  "kernel": "vmlinuz",
  "initrd": "initramfs",
  "rootfs": "rootfs.img",
  "rootfsSize": $PADDED_SIZE,
  "fixedChunkSize": $CHUNK_SIZE,
  "cmdline": "root=/dev/sda rw console=tty0 console=ttyS0,115200n8 modules=sd-mod,ext4,9p,9pnet,9pnet_virtio"
}
EOF

(
  cd "$OUTPUT_DIR"
  sha256sum vmlinuz initramfs boot.json rootfs-*.img > SHA256SUMS
)

# The builder runs as root in CI, while Vite copies public assets as the runner user.
chmod -R a+rX "$OUTPUT_DIR"

echo "Alpine Linux Lab image: $PADDED_SIZE bytes, $index chunks"
