/* Linux Lab browser controls for the QEMU-Wasm runtime. */
#include "qemu/osdep.h"
#include "qemu/atomic.h"
#include "qemu/main-loop.h"
#include "sysemu/cpu-timers.h"
#include "sysemu/runstate.h"
#include "ui/input.h"

#include <emscripten/emscripten.h>
#include <emscripten/threading.h>

#define LINUXLAB_TEXT_CAPACITY 4096

static void linuxlab_pause_bh(void *opaque);
static void linuxlab_text_bh(void *opaque);

static int linuxlab_ready;
static uint32_t linuxlab_paused;
static uint32_t linuxlab_pause_waiters;
static QEMUBH *linuxlab_pause_bh_handle;
static QEMUBH *linuxlab_text_bh_handle;
static char linuxlab_text_buffer[LINUXLAB_TEXT_CAPACITY];
static uint32_t linuxlab_text_length;
static uint32_t linuxlab_text_busy;

void linuxlab_runtime_prepare(void)
{
    if (mkdir("/linuxlab-onedrive", 0700) < 0 && errno != EEXIST) {
        fprintf(stderr, "Linux Lab: cannot create OneDrive 9P root: %s\n", strerror(errno));
    }
}

void linuxlab_runtime_ready(void)
{
    qatomic_store_release(&linuxlab_paused, 0);
    qatomic_set(&linuxlab_pause_waiters, 0);
    qatomic_set(&linuxlab_text_length, 0);
    qatomic_set(&linuxlab_text_busy, 0);
    linuxlab_pause_bh_handle = qemu_bh_new(linuxlab_pause_bh, NULL);
    linuxlab_text_bh_handle = qemu_bh_new(linuxlab_text_bh, NULL);
    qatomic_set(&linuxlab_ready, 1);
}

bool linuxlab_pause_requested(void)
{
    return qatomic_load_acquire(&linuxlab_paused) != 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t linuxlab_pause_word_address(void)
{
    return (uintptr_t)&linuxlab_paused;
}

EMSCRIPTEN_KEEPALIVE uintptr_t linuxlab_pause_waiters_word_address(void)
{
    return (uintptr_t)&linuxlab_pause_waiters;
}

bool linuxlab_vcpu_pause_wait(void)
{
    if (!linuxlab_pause_requested()) {
        return false;
    }

    qatomic_inc(&linuxlab_pause_waiters);
    while (linuxlab_pause_requested()) {
        emscripten_futex_wait(&linuxlab_paused, 1, 1.0);
    }
    return true;
}

void linuxlab_vcpu_resume_finish(void)
{
    if (qatomic_read(&linuxlab_pause_waiters) == 0) {
        return;
    }

    cpu_enable_ticks();
    qatomic_dec(&linuxlab_pause_waiters);
}

EMSCRIPTEN_KEEPALIVE double linuxlab_virtual_clock_ns(void)
{
    return (double)cpus_get_virtual_clock();
}

EMSCRIPTEN_KEEPALIVE double linuxlab_elapsed_ticks(void)
{
    return (double)cpus_get_elapsed_ticks();
}

EMSCRIPTEN_KEEPALIVE int linuxlab_is_ready(void)
{
    return qatomic_read(&linuxlab_ready) && runstate_is_running()
        && !linuxlab_pause_requested();
}

EMSCRIPTEN_KEEPALIVE int linuxlab_is_running(void)
{
    if (!runstate_is_running()) {
        return 0;
    }
    return qatomic_read(&linuxlab_pause_waiters) == 0;
}

static void linuxlab_pause_bh(void *opaque)
{
    (void)opaque;
    if (!runstate_is_running() || linuxlab_pause_requested()) {
        return;
    }

    cpu_disable_ticks();
    qatomic_store_release(&linuxlab_paused, 1);
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
    uint32_t length = qatomic_read(&linuxlab_text_length);
    uint32_t i;

    (void)opaque;
    for (i = 0; i < length; i++) {
        unsigned char ch = (unsigned char)linuxlab_text_buffer[i];
        if (ch < 0x80) {
            linuxlab_send_character(ch);
        }
    }
    qatomic_set(&linuxlab_text_length, 0);
    qatomic_set(&linuxlab_text_busy, 0);
}

EMSCRIPTEN_KEEPALIVE void linuxlab_pause(void)
{
    if (linuxlab_pause_bh_handle) {
        qemu_bh_schedule(linuxlab_pause_bh_handle);
    }
}

EMSCRIPTEN_KEEPALIVE int linuxlab_send_text(const char *text)
{
    size_t length;

    if (!text || !*text) return 0;
    if (!linuxlab_text_bh_handle) return -1;
    length = strlen(text);
    if (length >= sizeof(linuxlab_text_buffer)) return -2;
    if (qatomic_cmpxchg(&linuxlab_text_busy, 0, 1) != 0) return -3;

    memcpy(linuxlab_text_buffer, text, length);
    linuxlab_text_buffer[length] = '\0';
    qatomic_set(&linuxlab_text_length, (uint32_t)length);
    qemu_bh_schedule(linuxlab_text_bh_handle);
    return 0;
}
