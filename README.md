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

## Build

You don't have to: GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds it on every
change to the patch, on a Linux x86-64 runner where JieLi's toolchain runs natively. It clones Elixir at the commit
the patch was tested on, applies the patch, runs Felucca's USB audio host test against the patched `usb.c`, builds,
checks the package with the installer's own checks (refusing it without USB audio), and publishes it as
[`firmware/elixir-usb-audio.fwsc`](firmware/) with `firmware/build.json` (Elixir version and commit, SHA-256, the run).
Run it by hand under Actions → Build firmware → Run workflow, optionally with another Elixir commit, tag or branch.

To build locally instead:

```sh
git clone https://github.com/dmajka/elixir && cd elixir
git apply /path/to/elixir-usb-audio.patch
./build.sh                      # -> build/elixir.fwsc
```

`build.sh` needs what Elixir's README lists: the JieLi pi32v2 toolchain (`~/.jieli/toolchain`), the JieLi AC79 SDK
(`~/fw-AC79_AIoT_SDK`), Python 3 with Pillow and fontTools, and Docker on macOS.

## Install

Open the [installer](https://jose-no.github.io/elixir-usb-audio/) and press **Use the latest build** (or choose your
own `build/elixir.fwsc` under "Or use a build of your own"), then **Install this build**. It uses Elixir's updater
(`web/fm1ota.js`) and package reader (`web/fm1pkg.js`) unchanged; nothing is uploaded, and the latest build is checked
against the SHA-256 the workflow published. Before it will install, the page checks that the package is intact (every
CRC), reports an alternative-firmware identity (FM-1_9xx) and has Elixir's flash layout. It also reports whether USB
audio is built in and whether the update loader matches the official Elixir release. Updating Elixir keeps your
projects. The page can also reinstall the official Elixir release or return the FM-1 to M-VAVE's V15.

`tools/fm1_install.py build/elixir.fwsc` from Elixir's repo works too.

## This repo

- `index.html`: the installer, built by `tools/build_page.py` from `tools/page.html`, Elixir's `web/fm1pkg.js` and
  `web/fm1ota.js`, and `tools/custom.js` (the build checks).
- `tools/verify_build.mjs`, `tools/uac_host_test.sh`: the workflow's checks of a build and of the patched `usb.c`.
- `tools/test_check.mjs`, `tools/fixtures.mjs`: the build checks against the official package and altered copies.
  `tools/e2e.mjs`: the page in headless Chrome (Playwright) against a simulated FM-1: the latest-build button
  (none published, published, a bad checksum), chosen files, and a full install. They expect an Elixir checkout at
  `/tmp/elixir` and its published package at `/tmp/elixir-site/firmware/`.

## Licence

GPL-3.0 ([LICENSE](LICENSE)). Elixir: Dan Majka (@dmajka), GPL-3.0, after the Erica Synths LXR-02 firmware (GPL-3.0).
Felucca's hardware layer, USB driver, updater and package code: Leo Kuroshita (@kurogedelic), Hügelton Instruments,
GPL-3.0.
