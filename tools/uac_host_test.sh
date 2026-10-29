#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Felucca's USB audio host test (tests/uac_test.c) run against Elixir's (patched) firmware/src/usb.c. Elixir's copy of
# usb.c takes Q15 samples where Felucca's current one takes 24-bit, so the test's inputs are fed at 16 bits.
#   tools/uac_host_test.sh ELIXIR_DIR FELUCCA_DIR
set -e
ELIXIR="$1"; FELUCCA="$2"
T="$(mktemp -d)"
sed -e "s#\"../firmware/bsp/chip/usb.c\"#\"$ELIXIR/firmware/src/usb.c\"#" \
    -e 's#blk\[2 \* i\] = (int16_t)prod_n \* 256;#blk[2 * i] = (int16_t)prod_n;#' \
    -e 's#blk\[2 \* i + 1\] = (int16_t)~prod_n \* 256;#blk[2 * i + 1] = (int16_t)~prod_n;#' \
    -e 's#in24\[i\] = in\[i\] \* 256;#in24[i] = in[i];#' \
    "$FELUCCA/tests/uac_test.c" > "$T/uac_test.c"
grep -q "$ELIXIR/firmware/src/usb.c" "$T/uac_test.c" || { echo "uac_host_test: Felucca's test changed (include)"; exit 1; }
gcc -O2 -DHALF_FRAMES=128 -DT_CDC=0 "$T/uac_test.c" -lm -o "$T/uac_test"
"$T/uac_test" | tail -3
"$T/uac_test" | grep -q "uac: all ok"
