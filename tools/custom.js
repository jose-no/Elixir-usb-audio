// SPDX-License-Identifier: GPL-3.0-only
// Checks a locally built Elixir package (.fwsc) before the installer will write it: the package is whole (every CRC
// in fm1pkg.js's Package), it says it is an alternative firmware (FM-1_9xx), its flash layout is the one Elixir's
// build makes, and it reports what it carries: USB audio (the UAC1 format descriptor in the app) and whether its
// update loader is byte for byte the official Elixir release's (the loader is what finishes a cut-off install).
// The installer page inlines this after fm1pkg.js and fm1ota.js; the import lines below are for Node tests only.
import { Package, productOf, logicalImage } from "/tmp/elixir/web/fm1pkg.js"; // (STRIP)

// the layout tools/fm1pkg_make.py writes (Elixir 0.17's package, measured)
export const ELIXIR_LAYOUT = { flashFileOff: 1044, flashSize: 602112, appBase: 16384, appOff: 16672,
  appSize: 0x8DFBC, chipKey: 0x980F };

// UAC1 type I format descriptor, from usb.c D_FMT: CS_INTERFACE, FORMAT_TYPE, TYPE_I, 2 ch, 2-byte, 16 bit, n rates
const FMT_HEAD = [0x24, 0x02, 0x01, 0x02, 0x02, 0x10];

function indexOf(hay, pat, from = 0) {
  outer: for (let i = from; i + pat.length <= hay.length; i++) {
    for (let j = 0; j < pat.length; j++) if (hay[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

// the sample rates the app offers over USB audio, [] when it has none
export function usbAudioRates(app) {
  for (let i = indexOf(app, FMT_HEAD); i >= 1; i = indexOf(app, FMT_HEAD, i + 1)) {
    const n = app[i + 6], len = app[i - 1];
    if (n < 1 || n > 4 || len !== 8 + 3 * n) continue;           // bLength must match the rate count
    const rates = [];
    for (let k = 0; k < n; k++) {
      const o = i + 7 + 3 * k;
      rates.push(app[o] | (app[o + 1] << 8) | (app[o + 2] << 16));
    }
    if (rates.every((r) => r >= 8000 && r <= 192000)) return rates;
  }
  return [];
}

function loaderBytes(pkg) {
  const e = pkg.entries.find((x) => x.type === 100 && x.name === "ota.bin");
  return e ? pkg.raw.subarray(e.dataOff + pkg.skew, e.dataOff + pkg.skew + e.size) : null;
}

const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

// bytes: the chosen file. official: the official Elixir package's bytes, or null when it couldn't be fetched.
// -> { ok, product, image, usbRates, checks: [{ state: "ok" | "warn" | "fail" | "info", label, detail }] }
export function checkBuild(bytes, official) {
  const checks = [], add = (state, label, detail = "") => checks.push({ state, label, detail });
  const result = { ok: false, product: null, image: null, usbRates: [], checks };
  let pkg;
  try {
    pkg = new Package(bytes);
    add("ok", "Package is intact", "every header, entry and image checksum matches");
  } catch (e) {
    add("fail", "Not a valid FM-1 package", e.message);
    return result;
  }
  const product = productOf(bytes);
  if (!/^FM-1_9\d\d$/.test(product)) {
    add("fail", `Identity ${product || "(none)"}`, /^FM-1_0\d\d$/.test(product)
      ? "this is an official M-VAVE firmware: use the official V15 section below for that"
      : "an Elixir build reports FM-1_9xx (build.py's PRODUCT)");
    return result;
  }
  add("ok", `Identity ${product}`, "an alternative firmware, as Elixir's build makes it");
  const L = ELIXIR_LAYOUT;
  const bad = [["flash offset", pkg.flashFileOff, L.flashFileOff], ["flash size", pkg.flashSize, L.flashSize],
    ["app area", pkg.appBase, L.appBase], ["app offset", pkg.appOff, L.appOff], ["app slot", pkg.app.size, L.appSize],
    ["chip key", pkg.chipKey, L.chipKey]].filter(([, v, want]) => v !== want);
  const loader = loaderBytes(pkg);
  if (bad.length || pkg.entries.length !== 2 || !pkg.entries.some((e) => e.type === 0) || !loader) {
    add("fail", "Not Elixir's flash layout", bad.map(([n, v, w]) => `${n} ${v} (expected ${w})`).join(", ") ||
      "the package should hold exactly flash.bin and ota.bin");
    return result;
  }
  add("ok", "Elixir's flash layout", "same offsets, app slot and chip key as the official release");

  const app = pkg.dec.subarray(pkg.appOff, pkg.appOff + pkg.app.size);
  result.usbRates = usbAudioRates(app);
  if (result.usbRates.length)
    add("ok", "USB audio is built in", result.usbRates.map((r) => `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} kHz`).join(" and ") +
      ", 16-bit stereo: the FM-1 will show up as an audio input");
  else
    add("warn", "No USB audio in this build", "it has no USB audio descriptor: was it built with the patch applied?");

  if (!official) {
    add("warn", "Update loader not compared", "the official Elixir package couldn't be fetched to compare against");
  } else {
    let off = null;
    try { off = new Package(official); } catch (_) { /* compared as missing below */ }
    const offLoader = off && loaderBytes(off);
    if (same(loader, offLoader))
      add("ok", "Update loader matches the official release", "the part that finishes a cut-off install is unchanged");
    else
      add("warn", "Update loader differs from the official release",
        "the patch doesn't touch it, so this usually means a different toolchain or source version; if an install " +
        "is cut off, this loader is what has to finish it");
    if (off && same(off.dec.subarray(off.appOff, off.appOff + off.app.size), app))
      add("info", "This is the official Elixir build", "byte for byte the published release, not a custom one");
  }
  result.ok = true;
  result.product = product;
  result.image = logicalImage(bytes);
  return result;
}
