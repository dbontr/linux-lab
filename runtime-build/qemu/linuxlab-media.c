/*
 * Linux Lab browser media block protocol.
 *
 * The browser owns the selected File and exposes it through a blob URL.
 * QEMU reads byte ranges from that URL on its Emscripten application worker.
 */

#include "qemu/osdep.h"
#include "qapi/error.h"
#include "qapi/qmp/qdict.h"
#include "qemu/cutils.h"
#include "qemu/iov.h"
#include "qemu/module.h"
#include "qemu/option.h"
#include "block/block-io.h"
#include "block/block_int.h"

#include <emscripten.h>

#define LINUXLAB_OPT_URL "url"

typedef struct LinuxLabMediaState {
    char *url;
    int64_t length;
} LinuxLabMediaState;

static QemuOptsList linuxlab_runtime_opts = {
    .name = "linuxlab",
    .head = QTAILQ_HEAD_INITIALIZER(linuxlab_runtime_opts.head),
    .desc = {
        {
            .name = LINUXLAB_OPT_URL,
            .type = QEMU_OPT_STRING,
            .help = "browser blob URL",
        },
        {
            .name = BLOCK_OPT_SIZE,
            .type = QEMU_OPT_SIZE,
            .help = "media size in bytes",
        },
        { /* end of list */ }
    },
};

EM_JS(int, linuxlab_read_range,
      (const char *url_ptr, double offset, int bytes, uint8_t *dest), {
    const url = UTF8ToString(url_ptr);
    const start = Math.trunc(offset);
    const length = bytes | 0;
    const chunkSize = 1024 * 1024;
    const maxChunks = 64;

    if (!url || start < 0 || length < 0) {
        return -22;
    }
    if (length === 0) {
        return 0;
    }

    Module['linuxLabBlockCache'] ||= new Map();
    let cache = Module['linuxLabBlockCache'].get(url);
    if (!cache) {
        cache = new Map();
        Module['linuxLabBlockCache'].set(url, cache);
    }

    let copied = 0;
    try {
        while (copied < length) {
            const position = start + copied;
            const chunkIndex = Math.floor(position / chunkSize);
            const chunkOffset = position % chunkSize;
            let chunk = cache.get(chunkIndex);

            if (!chunk) {
                const chunkStart = chunkIndex * chunkSize;
                const chunkEnd = chunkStart + chunkSize - 1;
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, false);
                xhr.responseType = 'arraybuffer';
                xhr.setRequestHeader('Range', `bytes=${chunkStart}-${chunkEnd}`);
                xhr.send(null);
                if (xhr.status !== 206 || !xhr.response) {
                    console.error(`Linux Lab media read failed: HTTP ${xhr.status}`);
                    return -5;
                }
                chunk = new Uint8Array(xhr.response);
                if (cache.size >= maxChunks) {
                    cache.delete(cache.keys().next().value);
                }
                cache.set(chunkIndex, chunk);
            } else {
                cache.delete(chunkIndex);
                cache.set(chunkIndex, chunk);
            }
            const available = chunk.length - chunkOffset;
            const take = Math.min(length - copied, available);
            if (take <= 0) {
                console.error('Linux Lab media range ended before the requested read');
                return -5;
            }
            HEAPU8.set(chunk.subarray(chunkOffset, chunkOffset + take), dest + copied);
            copied += take;
        }
    } catch (error) {
        console.error('Linux Lab media read failed', error);
        return -5;
    }
    return 0;
});

static void linuxlab_parse_filename(const char *filename, QDict *options,
                                    Error **errp)
{
    const char *payload;
    const char *separator;
    g_autofree char *size_text = NULL;

    if (!strstart(filename, "linuxlab:", &payload)) {
        error_setg(errp, "Linux Lab media URL must start with 'linuxlab:'");
        return;
    }

    separator = strchr(payload, ':');
    if (!separator || separator == payload || separator[1] == '\0') {
        error_setg(errp, "Linux Lab media URL is missing size or blob URL");
        return;
    }

    size_text = g_strndup(payload, separator - payload);
    qdict_put_str(options, BLOCK_OPT_SIZE, size_text);
    qdict_put_str(options, LINUXLAB_OPT_URL, separator + 1);
}

static int linuxlab_open(BlockDriverState *bs, QDict *options, int flags,
                         Error **errp)
{
    LinuxLabMediaState *s = bs->opaque;
    QemuOpts *opts;
    const char *url;
    uint64_t length;
    int ret;

    bdrv_graph_rdlock_main_loop();
    ret = bdrv_apply_auto_read_only(bs,
                                    "Linux Lab browser media is read-only",
                                    errp);
    bdrv_graph_rdunlock_main_loop();
    if (ret < 0) {
        return ret;
    }

    opts = qemu_opts_create(&linuxlab_runtime_opts, NULL, 0, &error_abort);
    if (!qemu_opts_absorb_qdict(opts, options, errp)) {
        qemu_opts_del(opts);
        return -EINVAL;
    }

    url = qemu_opt_get(opts, LINUXLAB_OPT_URL);
    length = qemu_opt_get_size(opts, BLOCK_OPT_SIZE, 0);
    if (!url || url[0] == '\0') {
        error_setg(errp, "Linux Lab media requires a browser blob URL");
        ret = -EINVAL;
        goto out;
    }
    if (length == 0 || length > INT64_MAX) {
        error_setg(errp, "Linux Lab media size is invalid");
        ret = -EINVAL;
        goto out;
    }
    s->url = g_strdup(url);
    s->length = length;

out:
    qemu_opts_del(opts);
    return ret;
}

static void linuxlab_close(BlockDriverState *bs)
{
    LinuxLabMediaState *s = bs->opaque;

    g_clear_pointer(&s->url, g_free);
}

static int64_t coroutine_fn linuxlab_getlength(BlockDriverState *bs)
{
    LinuxLabMediaState *s = bs->opaque;
    return s->length;
}

static int coroutine_fn linuxlab_preadv(BlockDriverState *bs,
                                        int64_t offset, int64_t bytes,
                                        QEMUIOVector *qiov,
                                        BdrvRequestFlags flags)
{
    LinuxLabMediaState *s = bs->opaque;
    g_autofree uint8_t *buffer = NULL;
    int ret;

    (void)flags;
    if (offset < 0 || bytes < 0 || offset > s->length ||
        bytes > s->length - offset || bytes > INT_MAX) {
        return -EIO;
    }
    if (bytes == 0) {
        return 0;
    }

    buffer = g_try_malloc(bytes);
    if (!buffer) {
        return -ENOMEM;
    }

    ret = linuxlab_read_range(s->url, (double)offset, (int)bytes, buffer);
    if (ret < 0) {
        return ret;
    }
    qemu_iovec_from_buf(qiov, 0, buffer, bytes);
    return 0;
}

static int64_t coroutine_fn
linuxlab_get_allocated_file_size(BlockDriverState *bs)
{
    LinuxLabMediaState *s = bs->opaque;
    return s->length;
}

static const char *const linuxlab_strong_runtime_opts[] = {
    LINUXLAB_OPT_URL,
    BLOCK_OPT_SIZE,
    NULL,
};

static BlockDriver bdrv_linuxlab = {
    .format_name = "linuxlab",
    .protocol_name = "linuxlab",
    .instance_size = sizeof(LinuxLabMediaState),

    .bdrv_file_open = linuxlab_open,
    .bdrv_parse_filename = linuxlab_parse_filename,
    .bdrv_close = linuxlab_close,
    .bdrv_co_getlength = linuxlab_getlength,
    .bdrv_co_get_allocated_file_size = linuxlab_get_allocated_file_size,
    .bdrv_co_preadv = linuxlab_preadv,
    .strong_runtime_opts = linuxlab_strong_runtime_opts,
};

static void bdrv_linuxlab_init(void)
{
    bdrv_register(&bdrv_linuxlab);
}

block_init(bdrv_linuxlab_init);
