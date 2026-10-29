/* SPDX-License-Identifier: GPL-3.0-only
 * Host test of the 8-channel USB audio routing in Elixir's engine (elixir-usb-audio-8ch.patch): the real engine
 * (tests/engine_host.h) with USB_MULTI on and a stub USB side that keeps every frame engine_block hands it.
 *   MIX      USB 1-2 are the FM-1's output, sample for sample
 *   raw      USB 3-8 are the voices before pan: a voice panned hard left is full on its channel, silent on the right
 *   FX       with the master chain neutral, the FM-1's output in FX mode equals MIX mode's (FX + dry = the mix);
 *            nothing sent to the FX bus or the reverb: USB 1-2 silent; a reverb send: USB 1-2 carry its tail
 *   master   the MASTER level scales USB 1-2 in FX mode (the master chain runs on the FX pair)
 *   no host  FX mode with no host reading: the output is MIX mode's
 * Each case runs in a child process from the same start, so the cases compare exactly.
 *   cc -O2 -std=gnu99 -w -I $ELIXIR/build/gen -I $ELIXIR/firmware/src -I $ELIXIR/firmware/hal -I $ELIXIR/tests \
 *      tools/usb8_engine_test.c -lm -o usb8_engine_test     (ELIXIR: a checkout with both patches applied) */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <stdint.h>
#include <string.h>

#define FELUCCA_UAC 1
#define UAC_CH 8u
#define USB_MULTI 1
#define BLOCK_FRAMES (64u * 1450u)                     /* (BLOCK: 64) ~2.1 s */
static struct { uint32_t feed; } uac;                /* the stub: usb.c's uac.feed */
static int16_t cap[BLOCK_FRAMES * 8];               /* every frame the engine handed to USB */
static uint32_t cap_n;
static void uac_tap_frames(const int16_t *f, uint32_t n)
{
    if (!uac.feed)
        abort();                                     /* (the engine must not feed USB when no host reads) */
    memcpy(&cap[cap_n * UAC_CH], f, n * UAC_CH * sizeof *f);
    cap_n += n;
}
#include "engine_host.h"

#define FRAMES BLOCK_FRAMES                          /* a bar at 120 BPM and a little more */
typedef struct { int16_t dac[FRAMES * 2]; int16_t usb[FRAMES * UAC_CH]; uint32_t usb_n; } run_t;

/* one case in a child: the setup, then FRAMES of the beat; the DAC output and the USB frames come back */
static void run(run_t *r, uint32_t feed, uint32_t fx, void (*setup)(void))
{
    int fd[2];
    pid_t pid;
    size_t got = 0;
    if (pipe(fd) || (pid = fork()) < 0)
        exit(2);
    if (!pid) {
        static run_t c;
        int32_t blk[BLOCK * 2];
        uint32_t n, i;
        close(fd[0]);
        uac.feed = feed;
        usb_fx = (uint8_t)fx;
        if (setup)
            setup();
        seq_start(1);
        for (n = 0; n < FRAMES; n += BLOCK) {
            engine_block(blk);
            for (i = 0; i < 2u * BLOCK; i++)
                c.dac[2u * n + i] = (int16_t)sat16(blk[i]);
        }
        memcpy(c.usb, cap, sizeof c.usb);
        c.usb_n = cap_n;
        if (write(fd[1], &c, sizeof c) != (ssize_t)sizeof c)
            _exit(3);
        _exit(0);
    }
    close(fd[1]);
    while (got < sizeof *r) {
        ssize_t k = read(fd[0], (char *)r + got, sizeof *r - got);
        if (k <= 0)
            break;
        got += (size_t)k;
    }
    close(fd[0]);
    waitpid(pid, 0, 0);
    if (got != sizeof *r)
        exit(4);
}

static int fails;
static void check(int ok, const char *what)
{
    printf("  %s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok)
        fails++;
}
static int32_t peak_ch(const run_t *r, uint32_t ch)
{
    int32_t p = 0;
    for (uint32_t i = 0; i < r->usb_n; i++)
        p = abs(r->usb[i * UAC_CH + ch]) > p ? abs(r->usb[i * UAC_CH + ch]) : p;
    return p;
}

static void setup_rev(void) { par_set(PAR_REV_SEND1 + 3, 100); par_set(PAR_REV_LEVEL, 127); }
static void setup_delay(void) { par_set(PAR_FX_TYPE, FX_DELAY); par_set(PAR_FX_SEND1 + 5, 100); setup_rev(); }
static void setup_pan(void) { par_set(PAR_PAN1, 0); }
static void setup_master(void) { setup_rev(); master_q12 = 2048; }
static void setup_rev_full(void) { setup_rev(); master_q12 = 4096; }

int main(void)
{
    static run_t mix, fx, fx_rev, fx_rev_m, mix_rev, nohost_fx, nohost_mix, fx_delay, mix_delay, pan;
    uint32_t i, k, same, zero, diff;
    int32_t pk[UAC_CH];
    engine_init();
    master_q12 = 4096;
    for (k = 0; k < 16; k += 4)                      /* a beat on every voice (render_test's) */
        main_set(&pat[0], 0, k, 1);
    main_set(&pat[0], 3, 4, 1);
    main_set(&pat[0], 3, 12, 1);
    main_set(&pat[0], 4, 12, 1);
    for (k = 0; k < 16; k += 2)
        main_set(&pat[0], 5, k, 1);
    main_set(&pat[0], 6, 14, 1);
    main_set(&pat[0], 1, 10, 1);
    main_set(&pat[0], 2, 7, 1);
    pat_backup = pat[0];

    run(&mix, 1, 0, 0);
    printf("MIX\n");
    check(mix.usb_n == FRAMES, "every frame went to USB");
    for (i = same = 0; i < FRAMES; i++)
        same += mix.usb[i * UAC_CH] == mix.dac[2 * i] && mix.usb[i * UAC_CH + 1] == mix.dac[2 * i + 1];
    check(same == FRAMES, "USB 1-2 = the FM-1's output, sample for sample");
    for (k = 0; k < UAC_CH; k++)
        pk[k] = peak_ch(&mix, k);
    printf("  peaks: 1-2 %d %d | D1 %d D2 %d D3 %d SN %d CY %d HH %d\n", pk[0], pk[1], pk[2], pk[3], pk[4], pk[5], pk[6], pk[7]);
    for (k = 2, zero = 0; k < UAC_CH; k++)
        zero += pk[k] < 500;
    check(!zero, "USB 3-8: every voice of the beat on its own channel");

    run(&pan, 1, 0, setup_pan);
    printf("raw (D1 panned hard left)\n");
    {
        int32_t r = 0;                               /* the right side while only D1 plays (its first hit, before D2..) */
        for (i = 0; i < 2048; i++) {
            int32_t l = abs(pan.usb[i * UAC_CH + 1]);
            int busy = 0;
            for (k = 3; k < UAC_CH; k++)
                busy |= abs(pan.usb[i * UAC_CH + k]) > 50;
            if (!busy)
                r = l > r ? l : r;
        }
        check(peak_ch(&pan, 2) > 0 && abs(peak_ch(&pan, 2) - peak_ch(&mix, 2)) <= 1, "D1's channel is as loud as when centred (before pan)");
        check(r < 64, "while only D1 sounds, USB 2 (right) stays silent");
    }

    run(&fx, 1, 1, 0);
    printf("FX\n");
    for (i = same = 0; i < 2 * FRAMES; i++)
        same += fx.dac[i] == mix.dac[i];
    check(same == 2 * FRAMES, "the FM-1's output in FX mode = MIX mode's (master chain neutral)");
    check(peak_ch(&fx, 0) == 0 && peak_ch(&fx, 1) == 0, "nothing sent to FX or reverb: USB 1-2 silent");
    for (k = 2, diff = 0; k < UAC_CH; k++)
        for (i = 0; i < fx.usb_n; i++)
            diff += fx.usb[i * UAC_CH + k] != mix.usb[i * UAC_CH + k];
    check(diff == 0, "USB 3-8 the same in both modes");

    run(&fx_rev, 1, 1, setup_rev_full);
    run(&mix_rev, 1, 0, setup_rev_full);
    run(&fx_delay, 1, 1, setup_delay);
    run(&mix_delay, 1, 0, setup_delay);
    for (i = same = 0; i < 2 * FRAMES; i++)
        same += fx_rev.dac[i] == mix_rev.dac[i];
    check(peak_ch(&fx_rev, 0) > 200, "the snare into the reverb: USB 1-2 carry its return");
    check(same == 2 * FRAMES, "with the reverb: FX mode's output = MIX mode's");
    for (i = same = 0; i < 2 * FRAMES; i++)
        same += fx_delay.dac[i] == mix_delay.dac[i];
    check(peak_ch(&fx_delay, 0) > 200, "the hats through the delay: USB 1-2 carry the echoes");
    check(same == 2 * FRAMES, "with the delay and the reverb: FX mode's output = MIX mode's");

    run(&fx_rev_m, 1, 1, setup_master);
    printf("master on the FX pair\n");
    {
        int32_t a = peak_ch(&fx_rev, 0), b = peak_ch(&fx_rev_m, 0);
        printf("  USB 1 peak: MASTER full %d, half %d\n", a, b);
        check(b > 0 && abs(2 * b - a) <= 4, "MASTER at half halves USB 1-2 in FX mode");
        check(peak_ch(&fx_rev_m, 2) == peak_ch(&fx_rev, 2), "but not the raw voices");
    }

    run(&nohost_fx, 0, 1, setup_rev);
    run(&nohost_mix, 0, 0, setup_rev);
    printf("no host\n");
    for (i = same = 0; i < 2 * FRAMES; i++)
        same += nohost_fx.dac[i] == nohost_mix.dac[i];
    check(nohost_fx.usb_n == 0, "nothing handed to USB");
    check(same == 2 * FRAMES, "FX mode without a host: the output is MIX mode's");
    printf(fails ? "usb8_engine_test: %d FAILED\n" : "usb8_engine_test: all ok\n", fails);
    return fails != 0;
}
