/* Linux Lab browser controls for the QEMU-Wasm runtime. */
#include "qemu/osdep.h"
#include "qemu/atomic.h"
#include "qemu/main-loop.h"
#include "sysemu/cpus.h"
#include "sysemu/runstate.h"
#include "ui/input.h"

#include <emscripten/emscripten.h>

typedef struct LinuxLabTextRequest {
    char *text;
    size_t offset;
} LinuxLabTextRequest;

static int linuxlab_ready;

void linuxlab_runtime_ready(void)
{
    qatomic_set(&linuxlab_ready, 1);
}

EMSCRIPTEN_KEEPALIVE int linuxlab_is_ready(void)
{
    return qatomic_read(&linuxlab_ready);
}

EMSCRIPTEN_KEEPALIVE int linuxlab_is_running(void)
{
    return runstate_is_running() ? 1 : 0;
}

static void linuxlab_pause_bh(void *opaque)
{
    (void)opaque;
    if (runstate_is_running()) {
        vm_stop(RUN_STATE_PAUSED);
    }
}

static void linuxlab_resume_bh(void *opaque)
{
    (void)opaque;
    if (runstate_check(RUN_STATE_PAUSED)) {
        vm_start();
    }
}
static int linuxlab_scan_code(unsigned char ch, bool *shift)
{
    static const uint8_t letters[26] = {
        0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24,
        0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14,
        0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
    };
    static const uint8_t digits[10] = {
        0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
    };
    const char *plain = "-=[]\\;'`,./";
    const char *shifted = "_+{}|:\"~<>?";
    const uint8_t punctuation[] = {
        0x0c, 0x0d, 0x1a, 0x1b, 0x2b, 0x27, 0x28, 0x29, 0x33, 0x34, 0x35,
    };
    const char *digit_shift = ")!@#$%^&*(";
    const char *match;

    *shift = false;
    if (ch >= 'a' && ch <= 'z') return letters[ch - 'a'];
    if (ch >= 'A' && ch <= 'Z') { *shift = true; return letters[ch - 'A']; }
    if (ch >= '0' && ch <= '9') return digits[ch - '0'];
    if (ch == ' ') return 0x39;
    if (ch == '\n' || ch == '\r') return 0x1c;
    if (ch == '\t') return 0x0f;
    if (ch == '\b') return 0x0e;

    match = strchr(plain, ch);
    if (match) return punctuation[match - plain];
    match = strchr(shifted, ch);
    if (match) { *shift = true; return punctuation[match - shifted]; }
    match = strchr(digit_shift, ch);
    if (match) { *shift = true; return digits[match - digit_shift]; }
    return -1;
}

static void linuxlab_send_character(unsigned char ch)
{
    bool shift;
    int scan = linuxlab_scan_code(ch, &shift);
    if (scan < 0) return;
    if (shift) qemu_input_event_send_key_number(NULL, 0x2a, true);
    qemu_input_event_send_key_number(NULL, scan, true);
    qemu_input_event_send_key_number(NULL, scan, false);
    if (shift) qemu_input_event_send_key_number(NULL, 0x2a, false);
}

static void linuxlab_text_bh(void *opaque)
{
    LinuxLabTextRequest *request = opaque;
    while (request->text[request->offset] != '\0') {
        unsigned char ch = (unsigned char)request->text[request->offset++];
        if (ch >= 0x80) continue;
        linuxlab_send_character(ch);
        aio_bh_schedule_oneshot(qemu_get_aio_context(), linuxlab_text_bh, request);
        return;
    }
    g_free(request->text);
    g_free(request);
}

EMSCRIPTEN_KEEPALIVE void linuxlab_pause(void)
{
    aio_bh_schedule_oneshot(qemu_get_aio_context(), linuxlab_pause_bh, NULL);
}

EMSCRIPTEN_KEEPALIVE void linuxlab_resume(void)
{
    aio_bh_schedule_oneshot(qemu_get_aio_context(), linuxlab_resume_bh, NULL);
}

EMSCRIPTEN_KEEPALIVE void linuxlab_send_text(const char *text)
{
    LinuxLabTextRequest *request;
    if (!text || !*text) return;
    request = g_new0(LinuxLabTextRequest, 1);
    request->text = g_strdup(text);
    aio_bh_schedule_oneshot(qemu_get_aio_context(), linuxlab_text_bh, request);
}
