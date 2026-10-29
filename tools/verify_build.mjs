// SPDX-License-Identifier: GPL-3.0-only
// CI gate for a built package: the installer's own checks (custom.js) must pass, USB audio must be in it, and the
// result is printed for the log.
//   node tools/verify_build.mjs BUILD.fwsc [OFFICIAL.fwsc] [--channels N]
// (custom.js imports Elixir's web/fm1pkg.js from /tmp/elixir, where the workflow clones it.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { checkBuild } = await import(join(dirname(fileURLToPath(import.meta.url)), "custom.js"));
const args = process.argv.slice(2), ci = args.indexOf("--channels");
const want = ci >= 0 ? Number(args.splice(ci, 2)[1]) : 2;    // (removes the flag and its value from args)
const build = new Uint8Array(readFileSync(args[0]));
const official = args[1] ? new Uint8Array(readFileSync(args[1])) : null;
const r = checkBuild(build, official);
for (const c of r.checks) console.log(`${c.state.padEnd(4)} ${c.label}${c.detail ? " — " + c.detail : ""}`);
if (!r.ok) { console.error("verify_build: the installer would refuse this package"); process.exit(1); }
if (!r.usbRates.length) { console.error("verify_build: no USB audio in the package (was the patch applied?)"); process.exit(1); }
if (r.usbChannels !== want) { console.error(`verify_build: ${r.usbChannels} USB audio channels, want ${want}`); process.exit(1); }
console.log(`verify_build: ok, ${r.product}, USB audio ${r.usbChannels} ch at ${r.usbRates.join(" / ")} Hz`);
