# Elixir with USB audio

An unofficial patch and web installer that add USB audio output to
[Elixir](https://github.com/dmajka/elixir), the LXR-02 drum machine firmware for the M-VAVE FM-1. With it, the FM-1
shows up as a class-compliant audio input (16-bit stereo, 44.1 or 48 kHz) on a computer, iPhone or iPad, alongside USB
MIDI.

**Installer:** https://jose-no.github.io/elixir-usb-audio/ (Chrome or Edge)

> **Untested on hardware.** Nobody has run this build on a real FM-1 yet. If a build crashes at start-up, the FM-1 can
> only be recovered with the [FM-1-transporter](https://github.com/kurogedelic/FM-1-transporter). Not made, reviewed
> or endorsed by Elixir's or Felucca's authors, Erica Synths or M-VAVE.

## The patch

Elixir already carries Felucca's USB audio driver (`firmware/src/usb.c`, `FELUCCA_UAC`) but builds it out and never
feeds it. [`elixir-usb-audio.patch`](elixir-usb-audio.patch) (4 files) turns it on:

- `elixir.c`: `FELUCCA_UAC` 1 (overridable with `-DFELUCCA_UAC=0`), and `HALF_FRAMES` defined before `usb.c`, whose ring
  sizing needs it (without this, enabling the flag doesn't compile).
- `audio.c`: `uac_render_start()` before each half buffer renders, and `uac_tap()` with the master mix after it, still
  Q15 (what Elixir's copy of `usb.c` expects).
- `main.c`: `uac_service()` also when TIMER5 interrupts the render, as Felucca does, so the host gets a packet every
  1 ms even while a render takes longer than that.
- `usb.c` / `elixir.c`: the 2 KB audio ring and the resampler's history go in Elixir's `.pool` (`UAC_BUF`), the same
  SRAM with its own budget, so main RAM keeps the 4 KB of headroom Elixir's build checks for. In `.bss` they leave
  2692 B and the build refuses it.

Felucca's own USB audio test suite (`tests/uac_test.c`) passes against Elixir's `usb.c` when fed 16-bit samples:
descriptors, packet pacing, underruns and overruns, the 44.1 / 48 kHz switch and the resampler.

USB audio carries the mix after the MASTER pot, so turn the FM-1 up while recording.

## 8 channels

[`elixir-usb-audio-8ch.patch`](elixir-usb-audio-8ch.patch), applied on top of the stereo patch, makes the FM-1 an
8-input USB audio device at 44.1 kHz:

| USB inputs | Signal |
|---|---|
| 1–2 | **MIX** (default): the full mix, as the stereo build sends it. **FX**: the FX bus and reverb returns only, through the master chain (compressor and sidechain, DIRT, DJ filter, STUTTER, COMB, CRUSH, REVERSE, tape stop's fade, MASTER) |
| 3–8 | D1, D2, D3, SN, CY, hats: each voice after its own chain (filter, drive, shape, volume, cross mod, choke, PUMP), before pan, the sends and the master |

CONFIG → USB AUDIO (the page before BUTTONS) switches 1–2 between MIX and FX; it is saved with the settings. FX mode
acts only while a host records: then the master chain runs on the FX returns alone, and the FM-1's own output is the
processed FX plus the dry voices. With no host it plays the full mix as usual.

What it changes:

- `usb.c`: a channel count (`UAC_CH`): the ring, packets, descriptors (input terminal and format at 8 channels,
  EP4 at 736 B, within full speed's 1023) and `uac_tap_frames()` for N interleaved channels; `bcdDevice` +0x40 so a
  host that cached the stereo device learns this one afresh. The 48 kHz resampler is stereo, so 8 channels are
  44.1 kHz only (iOS and macOS convert).
- `voices.c`: each voice tapped as it enters the mixer; in FX mode the dry mix set aside before the FX bus and reverb
  add their returns.
- `engine.c`: the USB frames each block; the dry mix back in for the FM-1's output after the master chain.
- `ui.c`, `ui_draw.c`, `project.c`: the USB AUDIO page and the setting (in the settings' padding: no format change).

The 8 KB ring lives in `.ram_buf` (RAMTEXT, beside the reverb's lines, about 100 B to spare) and the taps in `.pool`, so main RAM keeps its 4 KB and the pool its 8 KB of headroom, as Elixir's build requires. Tests: `tools/usb8_driver_test.c` (descriptors; a 10 s stream at the
I2S rate with every frame in order and all 8 channels in place; underruns and overruns) and
`tools/usb8_engine_test.c` (the real engine: USB 1–2 equal the output in MIX; the voices before pan; in FX mode the
output equals MIX mode's with the master neutral, USB 1–2 silent with no sends and carrying the delay and reverb
returns with them, MASTER scaling them but not the voices; no host, no change). Elixir's own `ui_test` passes with
the 8-channel path compiled in.

> **Unknown until it runs:** whether the FM-1's USB hardware sends 736-byte isochronous packets (the stereo build sends
> 184). If 8 channels don't appear or stutter, the stereo build is one click away on the installer.

## Build

You don't have to: GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds both on every
change to the patches, on a Linux x86-64 runner where JieLi's toolchain runs natively. It clones Elixir at the commit
the patches were tested on, applies the stereo patch, runs Felucca's USB audio host test against the patched `usb.c`,
builds and checks the stereo package; then applies the 8-channel patch, runs its two host tests, builds and checks
that package (with the installer's own checks, requiring 2 and 8 channels). It publishes
[`firmware/elixir-usb-audio.fwsc`](firmware/) and `firmware/elixir-usb-audio-8ch.fwsc` with `firmware/build.json`
(Elixir version and commit, each build's SHA-256, the run).
Run it by hand under Actions → Build firmware → Run workflow, optionally with another Elixir commit, tag or branch.

To build locally instead:

```sh
git clone https://github.com/dmajka/elixir && cd elixir
git apply /path/to/elixir-usb-audio.patch
git apply /path/to/elixir-usb-audio-8ch.patch       # (for 8 channels)
./build.sh                      # -> build/elixir.fwsc
```

`build.sh` needs what Elixir's README lists: the JieLi pi32v2 toolchain (`~/.jieli/toolchain`), the JieLi AC79 SDK
(`~/fw-AC79_AIoT_SDK`), Python 3 with Pillow and fontTools, and Docker on macOS.

## Install

Open the [installer](https://jose-no.github.io/elixir-usb-audio/), pick **Stereo** or **8 channels** (or choose your
own `build/elixir.fwsc` under "Or use a build of your own"), then **Install this build**. You can switch between
them any time. It uses Elixir's updater
(`web/fm1ota.js`) and package reader (`web/fm1pkg.js`) unchanged; nothing is uploaded, and the latest build is checked
against the SHA-256 the workflow published for it. Before it will install, the page checks that the package is intact (every
CRC), reports an alternative-firmware identity (FM-1_9xx) and has Elixir's flash layout. It also reports whether USB
audio is built in, with how many channels, and whether the update loader matches the official Elixir release. Updating Elixir keeps your
projects. The page can also reinstall the official Elixir release or return the FM-1 to M-VAVE's V15.

`tools/fm1_install.py build/elixir.fwsc` from Elixir's repo works too.

## This repo

- `index.html`: the installer, built by `tools/build_page.py` from `tools/page.html`, Elixir's `web/fm1pkg.js` and
  `web/fm1ota.js`, and `tools/custom.js` (the build checks).
- `tools/verify_build.mjs`, `tools/uac_host_test.sh`: the workflow's checks of a build and of the patched `usb.c`.
- `tools/usb8_driver_test.c`, `tools/usb8_engine_test.c`: the 8-channel driver and the engine's routing (see above).
- `tools/test_check.mjs`, `tools/fixtures.mjs`: the build checks against the official package and altered copies.
  `tools/e2e.mjs`: the page in headless Chrome (Playwright) against a simulated FM-1: the build cards (none
  published, both published, a bad checksum), chosen files, and a full install of the 8-channel build. They expect an Elixir checkout at
  `/tmp/elixir` and its published package at `/tmp/elixir-site/firmware/`.

## Licence

GPL-3.0 ([LICENSE](LICENSE)). Elixir: Dan Majka (@dmajka), GPL-3.0, after the Erica Synths LXR-02 firmware (GPL-3.0).
Felucca's hardware layer, USB driver, updater and package code: Leo Kuroshita (@kurogedelic), Hügelton Instruments,
GPL-3.0.
