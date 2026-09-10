/* OneDrive-backed virtio-9P adapter for Linux Lab QEMU-Wasm. */
#include "qemu/osdep.h"
#include "qemu/iov.h"
#include "qemu/module.h"
#include "fsdev/qemu-fsdev.h"
#include "9p.h"

#include <emscripten/emscripten.h>

#define LINUXLAB_ONEDRIVE_ROOT "/linuxlab-onedrive"

static FileOperations linuxlab_local_ops;

EM_JS(int, linuxlab_od_ensure, (const char *path), {
    return Module['linuxLabOneDriveBridge'].ensurePath(UTF8ToString(path));
});
EM_JS(int, linuxlab_od_refresh_dir, (const char *path), {
    return Module['linuxLabOneDriveBridge'].refreshDir(UTF8ToString(path));
});
EM_JS(double, linuxlab_od_size, (const char *path), {
    return Module['linuxLabOneDriveBridge'].size(UTF8ToString(path));
});
EM_JS(double, linuxlab_od_mtime, (const char *path), {
    return Module['linuxLabOneDriveBridge'].mtime(UTF8ToString(path));
});
EM_JS(void, linuxlab_od_track, (int fd, const char *path), {
    Module['linuxLabOneDriveBridge'].track(fd, UTF8ToString(path));
});
EM_JS(void, linuxlab_od_untrack, (int fd), {
    Module['linuxLabOneDriveBridge'].untrack(fd);
});
EM_JS(int, linuxlab_od_has_fd, (int fd), {
    return Module['linuxLabOneDriveBridge'].hasFd(fd) ? 1 : 0;
});
EM_JS(double, linuxlab_od_fd_size, (int fd), {
    return Module['linuxLabOneDriveBridge'].fdSize(fd);
});
EM_JS(double, linuxlab_od_fd_mtime, (int fd), {
    return Module['linuxLabOneDriveBridge'].fdMtime(fd);
});
EM_JS(int, linuxlab_od_pread, (int fd, double offset, int bytes, uint8_t *dest), {
    return Module['linuxLabOneDriveBridge'].pread(fd, offset, bytes, dest);
});
EM_JS(int, linuxlab_od_pwrite, (int fd, double offset, int bytes, const uint8_t *src), {
    return Module['linuxLabOneDriveBridge'].pwrite(fd, offset, bytes, src);
});
EM_JS(int, linuxlab_od_flush, (int fd), {
    return Module['linuxLabOneDriveBridge'].flushFd(fd);
});
EM_JS(int, linuxlab_od_create, (const char *path), {
    return Module['linuxLabOneDriveBridge'].createFile(UTF8ToString(path));
});
EM_JS(int, linuxlab_od_truncate, (const char *path, double size), {
    return Module['linuxLabOneDriveBridge'].truncate(UTF8ToString(path), size);
});
EM_JS(int, linuxlab_od_mkdir, (const char *path), {
    return Module['linuxLabOneDriveBridge'].mkdir(UTF8ToString(path));
});
EM_JS(int, linuxlab_od_remove, (const char *path), {
    return Module['linuxLabOneDriveBridge'].remove(UTF8ToString(path));
});
EM_JS(int, linuxlab_od_rename, (const char *from, const char *to), {
    return Module['linuxLabOneDriveBridge'].rename(UTF8ToString(from), UTF8ToString(to));
});
EM_JS(void, linuxlab_od_reset, (), {
    Module['linuxLabOneDriveBridge'].reset();
});

static bool linuxlab_od_enabled(FsContext *ctx)
{
    return ctx && ctx->fs_root && !strcmp(ctx->fs_root, LINUXLAB_ONEDRIVE_ROOT);
}

static int linuxlab_od_result(int result)
{
    if (result >= 0) return result;
    errno = -result;
    return -1;
}

static char *linuxlab_od_child(V9fsPath *dir, const char *name)
{
    if (!strcmp(dir->data, ".")) return g_strdup_printf("./%s", name);
    return g_strdup_printf("%s/%s", dir->data, name);
}

static void linuxlab_od_apply_stat(const char *path, struct stat *stbuf)
{
    double size = linuxlab_od_size(path);
    double modified = linuxlab_od_mtime(path);
    if (size >= 0 && S_ISREG(stbuf->st_mode)) {
        stbuf->st_size = (off_t)size;
        stbuf->st_blocks = (blkcnt_t)((stbuf->st_size + 511) / 512);
    }
    if (modified >= 0) {
        time_t seconds = (time_t)(modified / 1000.0);
        stbuf->st_atime = seconds;
        stbuf->st_mtime = seconds;
        stbuf->st_ctime = seconds;
    }
}

static int linuxlab_lstat(FsContext *ctx, V9fsPath *path, struct stat *stbuf)
{
    int result;
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.lstat(ctx, path, stbuf);
    if (linuxlab_od_result(linuxlab_od_ensure(path->data)) < 0) return -1;
    result = linuxlab_local_ops.lstat(ctx, path, stbuf);
    if (result == 0) linuxlab_od_apply_stat(path->data, stbuf);
    return result;
}

static int linuxlab_opendir(FsContext *ctx, V9fsPath *path, V9fsFidOpenState *fs)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.opendir(ctx, path, fs);
    if (linuxlab_od_result(linuxlab_od_refresh_dir(path->data)) < 0) return -1;
    return linuxlab_local_ops.opendir(ctx, path, fs);
}

static int linuxlab_open(FsContext *ctx, V9fsPath *path, int flags, V9fsFidOpenState *fs)
{
    int result;
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.open(ctx, path, flags, fs);
    if (linuxlab_od_result(linuxlab_od_ensure(path->data)) < 0) return -1;
    result = linuxlab_local_ops.open(ctx, path, flags, fs);
    if (result < 0) return result;
    linuxlab_od_track(fs->fd, path->data);
    if ((flags & O_TRUNC) && linuxlab_od_result(linuxlab_od_truncate(path->data, 0)) < 0) {
        linuxlab_od_untrack(fs->fd);
        linuxlab_local_ops.close(ctx, fs);
        return -1;
    }
    return result;
}

static int linuxlab_open2(FsContext *ctx, V9fsPath *dir, const char *name,
                          int flags, FsCred *cred, V9fsFidOpenState *fs)
{
    int result;
    g_autofree char *path = NULL;
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.open2(ctx, dir, name, flags, cred, fs);
    if (linuxlab_od_result(linuxlab_od_refresh_dir(dir->data)) < 0) return -1;
    path = linuxlab_od_child(dir, name);
    result = linuxlab_local_ops.open2(ctx, dir, name, flags, cred, fs);
    if (result < 0) return result;
    if (linuxlab_od_result(linuxlab_od_create(path)) < 0) {
        linuxlab_local_ops.close(ctx, fs);
        linuxlab_local_ops.remove(ctx, path);
        return -1;
    }
    linuxlab_od_track(fs->fd, path);
    return result;
}
static int linuxlab_close(FsContext *ctx, V9fsFidOpenState *fs)
{
    int flush = 0;
    int result;
    if (!linuxlab_od_enabled(ctx) || !linuxlab_od_has_fd(fs->fd)) {
        return linuxlab_local_ops.close(ctx, fs);
    }
    flush = linuxlab_od_flush(fs->fd);
    linuxlab_od_untrack(fs->fd);
    result = linuxlab_local_ops.close(ctx, fs);
    if (flush < 0) return linuxlab_od_result(flush);
    return result;
}

static ssize_t linuxlab_preadv(FsContext *ctx, V9fsFidOpenState *fs,
                               const struct iovec *iov, int iovcnt, off_t offset)
{
    size_t bytes;
    g_autofree uint8_t *buffer = NULL;
    int result;
    if (!linuxlab_od_enabled(ctx) || !linuxlab_od_has_fd(fs->fd)) {
        return linuxlab_local_ops.preadv(ctx, fs, iov, iovcnt, offset);
    }
    bytes = iov_size(iov, iovcnt);
    if (bytes > INT_MAX) { errno = EINVAL; return -1; }
    buffer = g_try_malloc(MAX(bytes, 1));
    if (!buffer) { errno = ENOMEM; return -1; }
    result = linuxlab_od_pread(fs->fd, (double)offset, (int)bytes, buffer);
    if (result < 0) return linuxlab_od_result(result);
    iov_from_buf(iov, iovcnt, 0, buffer, result);
    return result;
}
static ssize_t linuxlab_pwritev(FsContext *ctx, V9fsFidOpenState *fs,
                                const struct iovec *iov, int iovcnt, off_t offset)
{
    size_t bytes;
    g_autofree uint8_t *buffer = NULL;
    int result;
    if (!linuxlab_od_enabled(ctx) || !linuxlab_od_has_fd(fs->fd)) {
        return linuxlab_local_ops.pwritev(ctx, fs, iov, iovcnt, offset);
    }
    bytes = iov_size(iov, iovcnt);
    if (bytes > INT_MAX) { errno = EINVAL; return -1; }
    buffer = g_try_malloc(MAX(bytes, 1));
    if (!buffer) { errno = ENOMEM; return -1; }
    iov_to_buf(iov, iovcnt, 0, buffer, bytes);
    result = linuxlab_od_pwrite(fs->fd, (double)offset, (int)bytes, buffer);
    return result < 0 ? linuxlab_od_result(result) : result;
}

static int linuxlab_fstat(FsContext *ctx, int fid_type,
                          V9fsFidOpenState *fs, struct stat *stbuf)
{
    int result = linuxlab_local_ops.fstat(ctx, fid_type, fs, stbuf);
    if (result == 0 && linuxlab_od_enabled(ctx) && fid_type != P9_FID_DIR
        && linuxlab_od_has_fd(fs->fd)) {
        double size = linuxlab_od_fd_size(fs->fd);
        double modified = linuxlab_od_fd_mtime(fs->fd);
        if (size >= 0) {
            stbuf->st_size = (off_t)size;
            stbuf->st_blocks = (blkcnt_t)((stbuf->st_size + 511) / 512);
        }
        if (modified >= 0) {
            time_t seconds = (time_t)(modified / 1000.0);
            stbuf->st_atime = seconds;
            stbuf->st_mtime = seconds;
            stbuf->st_ctime = seconds;
        }
    }
    return result;
}

static int linuxlab_fsync(FsContext *ctx, int fid_type,
                          V9fsFidOpenState *fs, int datasync)
{
    int flush;
    if (linuxlab_od_enabled(ctx) && fid_type != P9_FID_DIR && linuxlab_od_has_fd(fs->fd)) {
        flush = linuxlab_od_flush(fs->fd);
        if (flush < 0) return linuxlab_od_result(flush);
    }
    return linuxlab_local_ops.fsync(ctx, fid_type, fs, datasync);
}

static int linuxlab_truncate(FsContext *ctx, V9fsPath *path, off_t size)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.truncate(ctx, path, size);
    if (size < 0) { errno = EINVAL; return -1; }
    return linuxlab_od_result(linuxlab_od_truncate(path->data, (double)size));
}

static int linuxlab_mkdir(FsContext *ctx, V9fsPath *dir,
                          const char *name, FsCred *cred)
{
    int result;
    g_autofree char *path = NULL;
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.mkdir(ctx, dir, name, cred);
    if (linuxlab_od_result(linuxlab_od_refresh_dir(dir->data)) < 0) return -1;
    path = linuxlab_od_child(dir, name);
    result = linuxlab_local_ops.mkdir(ctx, dir, name, cred);
    if (result < 0) return result;
    if (linuxlab_od_result(linuxlab_od_mkdir(path)) < 0) {
        linuxlab_local_ops.remove(ctx, path);
        return -1;
    }
    return result;
}

static int linuxlab_remove(FsContext *ctx, const char *path)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.remove(ctx, path);
    if (linuxlab_od_result(linuxlab_od_remove(path)) < 0) return -1;
    return linuxlab_local_ops.remove(ctx, path);
}

static int linuxlab_rename(FsContext *ctx, const char *from, const char *to)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.rename(ctx, from, to);
    if (linuxlab_od_result(linuxlab_od_rename(from, to)) < 0) return -1;
    return linuxlab_local_ops.rename(ctx, from, to);
}

static int linuxlab_renameat(FsContext *ctx, V9fsPath *old_dir, const char *old_name,
                             V9fsPath *new_dir, const char *new_name)
{    g_autofree char *from = NULL;
    g_autofree char *to = NULL;
    if (!linuxlab_od_enabled(ctx)) {
        return linuxlab_local_ops.renameat(ctx, old_dir, old_name, new_dir, new_name);
    }
    from = linuxlab_od_child(old_dir, old_name);
    to = linuxlab_od_child(new_dir, new_name);
    if (linuxlab_od_result(linuxlab_od_rename(from, to)) < 0) return -1;
    return linuxlab_local_ops.renameat(ctx, old_dir, old_name, new_dir, new_name);
}

static int linuxlab_unlinkat(FsContext *ctx, V9fsPath *dir, const char *name, int flags)
{
    g_autofree char *path = NULL;
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.unlinkat(ctx, dir, name, flags);
    path = linuxlab_od_child(dir, name);
    if (linuxlab_od_result(linuxlab_od_remove(path)) < 0) return -1;
    return linuxlab_local_ops.unlinkat(ctx, dir, name, flags);
}

static int linuxlab_unsupported(void)
{
    errno = EOPNOTSUPP;
    return -1;
}

static int linuxlab_mknod(FsContext *ctx, V9fsPath *dir,
                          const char *name, FsCred *cred)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.mknod(ctx, dir, name, cred);
    return linuxlab_unsupported();
}
static int linuxlab_symlink(FsContext *ctx, const char *oldpath,
                            V9fsPath *dir, const char *name, FsCred *cred)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.symlink(ctx, oldpath, dir, name, cred);
    return linuxlab_unsupported();
}

static int linuxlab_link(FsContext *ctx, V9fsPath *oldpath,
                         V9fsPath *dir, const char *name)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.link(ctx, oldpath, dir, name);
    return linuxlab_unsupported();
}

static ssize_t linuxlab_readlink(FsContext *ctx, V9fsPath *path, char *buf, size_t size)
{
    if (!linuxlab_od_enabled(ctx)) return linuxlab_local_ops.readlink(ctx, path, buf, size);
    errno = EINVAL;
    return -1;
}

static void linuxlab_cleanup(FsContext *ctx)
{
    if (linuxlab_od_enabled(ctx)) linuxlab_od_reset();
    linuxlab_local_ops.cleanup(ctx);
}

static void linuxlab_install_onedrive_adapter(void)
{
    linuxlab_local_ops = local_ops;
    local_ops.cleanup = linuxlab_cleanup;
    local_ops.lstat = linuxlab_lstat;
    local_ops.readlink = linuxlab_readlink;
    local_ops.mknod = linuxlab_mknod;
    local_ops.symlink = linuxlab_symlink;
    local_ops.link = linuxlab_link;
    local_ops.close = linuxlab_close;
    local_ops.opendir = linuxlab_opendir;
    local_ops.open = linuxlab_open;
    local_ops.open2 = linuxlab_open2;
    local_ops.preadv = linuxlab_preadv;
    local_ops.pwritev = linuxlab_pwritev;
    local_ops.mkdir = linuxlab_mkdir;
    local_ops.fstat = linuxlab_fstat;
    local_ops.rename = linuxlab_rename;
    local_ops.truncate = linuxlab_truncate;
    local_ops.fsync = linuxlab_fsync;
    local_ops.remove = linuxlab_remove;
    local_ops.renameat = linuxlab_renameat;
    local_ops.unlinkat = linuxlab_unlinkat;
}

type_init(linuxlab_install_onedrive_adapter);
