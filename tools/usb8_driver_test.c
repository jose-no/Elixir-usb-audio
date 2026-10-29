/* SPDX-License-Identifier: GPL-3.0-only
 * Host test of the 8-channel USB audio driver (Elixir's firmware/src/usb.c with UAC_CH 8, after Felucca's
 * tests/uac_test.c, whose stream simulation it follows):
 *   descriptors  every descriptor's length, the total; input terminal and type I format at 8 channels, 16 bit,
 *                44.1 kHz only; EP 0x84 isochronous at 46 frames x 16 bytes (within full speed's 1023)
 *   stream       renders of HALF_FRAMES at the I2S rate (44,117.6 Hz) in BLOCK-frame taps, as the engine
 *                makes them, random render times; a packet each ms: sizes 43..46, 44.1 on average, every frame
 *                once and in order with all 8 channels in their places (channel c of frame n holds n ^ c * 0x1111)
 *   underrun     the producer stops: the last frame repeated, all 8 channels; then the overrun: frames dropped,
 *                the ring never overfills
 *   cc -O2 -std=gnu99 -I $ELIXIR/firmware/src -I $ELIXIR/firmware/hal tools/usb8_driver_test.c -o usb8_driver_test */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define HALF_FRAMES 128u
#define BLOCK 64u
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#define FELUCCA_OTA 0
#define FELUCCA_CDC 0
#define FELUCCA_UAC 1
#define FELUCCA_UAC_48K 0
#define UAC_CH 8u
static void fm1_delay_ms(uint32_t ms) { (void)ms; }
#pragma GCC diagnostic ignored "-Wint-to-pointer-cast"
#include "usb.c"

static int fails;
static void check(const char *what, int ok)
{
    printf("%-72s %s\n", what, ok ? "ok" : "FAIL");
    if (!ok)
        fails++;
}

static void test_descriptors(void)
{
    const uint8_t *c = CFG_DESC;
    uint32_t total = c[2] | c[3] << 8, n = sizeof CFG_DESC, off, it = 0, fmt = 0, ep = 0, lens = 1;
    for (off = 0; off < n; off += c[off]) {
        const uint8_t *d = c + off;
        if (d[0] < 2 || off + d[0] > n) {
            lens = 0;
            break;
        }
        if (d[1] == 0x24 && d[2] == 2 && d[0] == 12)                     /* AC input terminal */
            it = d[7] == 8 && (d[8] | d[9] << 8) == 0x0003;
        if (d[1] == 0x24 && d[2] == 2 && d[0] == 11 && d[3] == 1)        /* AS type I format */
            fmt = d[4] == 8 && d[5] == 2 && d[6] == 16 && d[7] == 1 && (d[8] | d[9] << 8 | d[10] << 16) == 44100;
        if (d[1] == 5 && d[2] == 0x84)
            ep = d[3] == 0x05 && (d[4] | d[5] << 8) == 46u * 16u && d[6] == 1;
    }
    check("descriptors: every length in range, the total matches", lens && total == n);
    check("input terminal: 8 channels (L R, then 6 non-spatial)", it);
    check("type I format: 8 ch, 2-byte subframe, 16 bit, 44100 Hz only", fmt);
    check("EP 0x84 IN isochronous async, 736 B (46 frames x 16), every frame", ep && 46u * 16u <= 1023u);
}

/* the stream: time in ns, the producer at the I2S rate, the consumer once a ms */
static const double fs_dev = 44117.6;
static uint32_t prod_n, cons_n, cons_bad, cons_rep, cons_zero, sizes[64], npk, last_n;
static uint64_t now_ns, next_half, next_pkt, next_block, rend_len;
static uint32_t blocks_left, lcg = 12345;
#define REND_MIN ((uint64_t)(HALF_FRAMES * 1e9 / fs_dev * 0.07))
#define REND_MAX ((uint64_t)(HALF_FRAMES * 1e9 / fs_dev * 0.85))

static void render_block(void)
{
    static int16_t f[BLOCK * 8];
    uint32_t i, c;
    for (i = 0; i < BLOCK; i++, prod_n++)
        for (c = 0; c < 8u; c++)
            f[i * 8 + c] = (int16_t)((prod_n & 0xFFFFu) ^ (c * 0x1111u));
    uac_tap_frames(f, BLOCK);
}

static void take_packet(void)
{
    uint32_t d[UA_MAXF * UA_W], n, i, c;
    n = uac_packet(d);
    sizes[n]++;
    npk++;
    for (i = 0; i < n; i++) {
        const uint32_t *w = &d[i * UA_W];
        uint16_t ch[8], v;
        int ok = 1, zero = 1;
        for (c = 0; c < 4u; c++) {
            ch[2 * c] = (uint16_t)w[c];
            ch[2 * c + 1] = (uint16_t)(w[c] >> 16);
        }
        v = ch[0];
        for (c = 0; c < 8u; c++) {
            ok &= ch[c] == (uint16_t)(v ^ (c * 0x1111u));
            zero &= ch[c] == 0;
        }
        if (zero) {                                    /* silence before the ring is primed */
            cons_zero++;
            continue;
        }
        if (!ok) {
            cons_bad++;
            continue;
        }
        if (cons_n && v == (uint16_t)last_n)
            cons_rep++;
        else if (cons_n && v != (uint16_t)(last_n + 1u))
            cons_bad++;
        last_n = v;
        cons_n++;
    }
}

static void run(uint32_t ms, uint64_t rend_ns, int produce, int consume)
{
    uint64_t end = now_ns + (uint64_t)ms * 1000000u;
    while (now_ns < end) {
        uint64_t t = end;
        if (next_half < t)
            t = next_half;
        if (blocks_left && next_block < t)
            t = next_block;
        if (next_pkt < t)
            t = next_pkt;
        now_ns = t;
        if (now_ns >= end)
            break;
        if (now_ns == next_half) {
            next_half += (uint64_t)((double)HALF_FRAMES / fs_dev * 1e9);
            if (produce) {
                lcg = lcg * 1103515245u + 12345u;
                rend_len = rend_ns ? rend_ns : REND_MIN + (lcg >> 8) % (REND_MAX - REND_MIN);
                uac_render_start();
                blocks_left = HALF_FRAMES / BLOCK;
                next_block = now_ns + rend_len / blocks_left;
            }
        } else if (blocks_left && now_ns == next_block) {
            render_block();
            blocks_left--;
            next_block += rend_len / (HALF_FRAMES / BLOCK);
        } else if (now_ns == next_pkt) {
            lcg = lcg * 1103515245u + 12345u;
            next_pkt = (now_ns / 1000000u + 1u) * 1000000u + (lcg >> 8) % 500000u;
            if (consume)
                take_packet();
        }
    }
}

static void test_stream(void)
{
    uint32_t i, sum, base_n, base_p;
    char s[128];
    usb.config = 1;
    memset(&uac, 0, sizeof uac);
    uac_stream(1);
    next_half = 300000;
    next_pkt = 1000000;
    run(3, 0, 1, 1);
    check("not fed before the host reads", uac.overruns == 0 && ua_w == 0);
    uac.flowing = 1;
    run(2000, 0, 1, 1);
    memset(sizes, 0, sizeof sizes);
    npk = 0;
    base_n = cons_n;
    base_p = uac.underruns + uac.overruns;
    run(10000, 0, 1, 1);
    for (i = sum = 0; i < 64u; i++)
        sum += sizes[i] * i;
    snprintf(s, sizeof s, "10 s, random render times: sizes 43..46 (43:%u 44:%u 45:%u 46:%u)", sizes[43], sizes[44],
             sizes[45], sizes[46]);
    check(s, sizes[43] + sizes[44] + sizes[45] + sizes[46] == npk);
    snprintf(s, sizeof s, "  mean packet %.4f frames (I2S %.1f Hz)", (double)sum / npk, fs_dev);
    check(s, (double)sum / npk > 44.05 && (double)sum / npk < 44.2);
    check("  every frame once, in order, all 8 channels in place; no underrun / overrun",
          cons_bad == 0 && cons_rep == 0 && uac.underruns + uac.overruns == base_p && cons_n - base_n == sum);
    snprintf(s, sizeof s, "  fill at render start %u..%u (band %u..%u)", uac.fill_lo, uac.fill_hi, UA_LO, UA_HI);
    check(s, uac.fill_lo >= 46u && uac.fill_hi + HALF_FRAMES <= UA_N);
    for (i = 0; i < 1000u; i++)
        run(1, REND_MAX, 1, 1);
    check("1000 packets with 85% renders: no glitch", cons_bad == 0 && cons_rep == 0 &&
          uac.underruns + uac.overruns == base_p);
    base_p = uac.underruns;
    run(30, 0, 0, 1);
    check("producer stopped 30 ms: underruns counted, frames intact", uac.underruns > base_p && cons_bad == 0);
    check("  the empty ring repeats the last frame (all 8 channels)", cons_rep > 0);
    base_p = uac.overruns;
    run(40, 0, 1, 0);
    check("consumer stopped 40 ms: overruns counted, the ring never overfills",
          uac.overruns > base_p && ua_w - ua_r <= UA_N);
}

int main(void)
{
    printf("-- USB audio, %u channels\n", (unsigned)UAC_CH);
    test_descriptors();
    test_stream();
    printf(fails ? "usb8_driver_test: %d FAILED\n" : "usb8_driver_test: all ok\n", fails);
    return fails != 0;
}
