// Headless Chrome test of the installer (index.html): a simulated FM-1 (running Elixir) behind a mock Web MIDI, the
// official package served for github.io, the published build (firmware/) served next to the page. Checks the
// latest-build button (none published, published, a checksum mismatch), the build checks shown for chosen files, the
// button states, a full install (every byte the loader reads is the build's image) and the check-my-FM-1 text.
//   FIX=dir-with-fixtures node tools/e2e.mjs        (fixtures: tools/fixtures.mjs; Playwright with Chromium)
import { chromium } from "/opt/npm-tools/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PAGE = new URL("../index.html", import.meta.url).pathname;
const DIR = (process.env.FIX || ".").replace(/\/?$/, "/");
const OFFICIAL = readFileSync("/tmp/elixir-site/firmware/elixir-v0.17.fwsc");
const BUILD = readFileSync(DIR + "uac.fwsc"), BUILD8 = readFileSync(DIR + "uac8.fwsc");
const sha = (b) => createHash("sha256").update(b).digest("hex");
let published = "none";                              // none | ok | badsha
const server = createServer((req, res) => {
  if (req.url.startsWith("/firmware/build.json")) {
    if (published === "none") { res.statusCode = 404; res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    const bad = published === "badsha";
    res.end(JSON.stringify({ elixir_version: "v0.17", elixir_commit: "1a247769bd37", built: "2026-10-29T16:30Z",
      sha256: sha(BUILD), builds: [
        { id: "stereo", name: "Stereo", file: "elixir-usb-audio.fwsc", channels: 2, sha256: sha(BUILD) },
        { id: "8ch", name: "8 channels", file: "elixir-usb-audio-8ch.fwsc", channels: 8, sha256: bad ? "0".repeat(64) : sha(BUILD8) }] }));
    return;
  }
  if (req.url.startsWith("/firmware/elixir-usb-audio-8ch.fwsc")) { res.end(BUILD8); return; }
  if (req.url.startsWith("/firmware/elixir-usb-audio.fwsc")) { res.end(BUILD); return; }
  res.setHeader("Content-Type", "text/html");
  res.end(readFileSync(PAGE));
}).listen(8791);

// the simulated FM-1, in the page: identity handshake, step 1 (a few reads, then 0xE0000000), the loader as
// "ota-FM-1" (every 512-byte part, then 0xF0000000), back as FM-1_900. Records every address the loader read.
const SIM = () => {
  const pack7 = (data) => { const o = []; let a = 0, n = 0; for (const b of data) { a |= b << n; n += 8; while (n >= 7) { o.push(a & 127); a >>>= 7; n -= 7; } } if (n) o.push(a & 127); return o; };
  const unpack7 = (s) => { const o = []; let a = 0, n = 0; for (const b of s) { a |= (b & 127) << n; n += 7; while (n >= 8) { o.push(a & 255); a >>>= 8; n -= 8; } } return o; };
  const identity = (t) => { const d = new Array(34).fill(0); d[1] = 0x59; d[2] = 0x11; [...t].forEach((c, i) => { d[6 + i] = c.charCodeAt(0); }); return [0xF0, ...pack7(d), 0xF7]; };
  const request = (addr, len) => { const u = [0, 0x59, 0x30, 0, 0, 0, 0, addr & 255, (addr >>> 8) & 255, (addr >>> 16) & 255, (addr >>> 24) & 255, len & 255, (len >> 8) & 255, 0]; let s = 0; for (let i = 6; i < 14; i++) s += u[i]; u.push(~s & 255); return [0xF0, ...pack7(u), 0xF7]; };
  const sim = window.__sim = { mode: "app", text: "FM-1_900", written: null, imageLen: 0, log: [] };
  const ports = { inputs: new Map(), outputs: new Map() };
  let input = null;
  const later = (f, ms = 2) => setTimeout(f, ms);
  function plug(name) {
    const i = { name, state: "connected", onmidimessage: null, open: async () => {} };
    const o = { name, state: "connected", open: async () => {}, send: (bytes) => { if (o.state !== "connected") throw new Error("disconnected"); rx(Array.from(bytes)); } };
    ports.inputs.clear(); ports.outputs.clear();
    ports.inputs.set("a", i); ports.outputs.set("a", o);
    if (input) input.state = "disconnected";
    input = i;
  }
  const tx = (bytes) => later(() => input.onmidimessage && input.onmidimessage({ data: Uint8Array.from(bytes) }));
  let queue = [], fin = 0;
  const next = () => { if (queue.length) { const [a, l] = queue.shift(); tx(request(a, l)); } else tx(request(fin, 8)); };
  function rx(b) {
    if (b.length === 10 && b[1] === 0x00 && b[2] === 0x32 && b[3] === 0x45 && b[8] === 0x7F) { tx(identity(sim.mode === "ota" ? "ota-FM-1_000" : sim.text)); return; }
    if (b.length === 6 && b[1] === 0x22 && b[2] === 0x24 && b[3] === 0x35) {                       // UPGRADE
      if (sim.mode === "app") { queue = [[0, 64], [64, 64], [4096, 256]]; fin = 0xE0000000; }
      else { queue = []; for (let a = 0; a < sim.imageLen; a += 512) queue.push([a, Math.min(512, sim.imageLen - a)]); fin = 0xF0000000; sim.written = new Uint8Array(sim.imageLen); }
      later(next, 5); return;
    }
    const u = unpack7(b.slice(1, -1));
    if (u[1] !== 0x59 || u[2] !== 0x30) return;
    const addr = (u[7] | (u[8] << 8) | (u[9] << 16) | (u[10] << 24)) >>> 0, len = u[11] | (u[12] << 8);
    if (addr === 0xE0000000) { sim.log.push("staged"); sim.mode = "ota"; later(() => plug("FM-1 ota"), 50); return; }
    if (addr === 0xF0000000) { sim.log.push("written"); sim.mode = "app"; later(() => plug("Elixir"), 50); return; }
    if (sim.mode === "ota") sim.written.set(u.slice(14, 14 + len), addr);
    next();
  }
  plug("Elixir");
  navigator.requestMIDIAccess = async () => ports;
};

let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.route("https://dmajka.github.io/elixir/install/", (r) => r.fulfill({ body: '<script>const meta = {"pkg": "../firmware/elixir-v0.17.fwsc"}</script>', headers: { "access-control-allow-origin": "*" } }));
await page.route("https://dmajka.github.io/elixir/firmware/elixir-v0.17.fwsc", (r) => r.fulfill({ body: OFFICIAL, headers: { "access-control-allow-origin": "*" } }));
await page.addInitScript(SIM);
await page.goto("http://localhost:8791/");

await page.waitForFunction(() => document.getElementById("official-note").textContent.endsWith(".fwsc"));
check(!(await page.isDisabled("#official-go")), "official package fetched; Reinstall official Elixir enabled");
check(await page.isDisabled("#go"), "Install disabled before a build is chosen");
await page.waitForFunction(() => !/Looking/.test(document.getElementById("latest-note").textContent));
check((await page.$$("button.build")).length === 0 && /No build published yet/.test(await page.textContent("#latest-note")),
  "nothing published: no build cards, says so");

const latest = async (id = "stereo") => {
  await page.waitForFunction((id) => { const b = document.querySelector(`button.build[data-id="${id}"]`); return b && !b.disabled; }, id);
  await page.click(`button.build[data-id="${id}"]`);
  await page.waitForFunction(() => !/Checking/.test(document.getElementById("checks").textContent));
  return page.$$eval("#checks li", (ls) => ls.map((l) => l.className + ":" + l.querySelector(".l").textContent));
};
published = "badsha";
await page.reload();
let c = await latest("8ch");
check(c.length === 1 && /^fail:Couldn't read the build/.test(c[0]) && await page.isDisabled("#go"),
  "a published build with a wrong checksum: refused, Install disabled");
published = "ok";
await page.reload();
await page.waitForFunction(() => document.getElementById("official-note").textContent.endsWith(".fwsc"));
check(/Elixir v0\.17 \(1a24776\), built/.test(await page.textContent("#latest-note")), "latest build described: " + await page.textContent("#latest-note"));
check((await page.$$("button.build")).length === 2, "two build cards: stereo and 8 channels");
c = await latest("stereo");
check(c.length === 5 && c.every((x) => x.startsWith("ok")) && c.some((x) => /^ok:USB audio is built in$/.test(x)), "stereo build: 5 checks ok");
c = await latest("8ch");
check(c.length === 5 && c.every((x) => x.startsWith("ok")) && c.some((x) => /^ok:USB audio is built in: 8 channels/.test(x)),
  "8-channel build: 5 checks ok, 8 channels reported");
check(!(await page.isDisabled("#go")), "Install enabled for the latest build");
check(await page.$eval('button.build[data-id="8ch"]', (b) => b.classList.contains("picked")), "the picked card is marked");

await page.click("#check");
await page.waitForFunction(() => /FM-1_900/.test(document.getElementById("found").textContent));
check(/Elixir \(or Kettle\) is installed/.test(await page.textContent("#found")), "check my FM-1: " + await page.textContent("#found"));

const choose = async (f) => {
  await page.setInputFiles("#file", DIR + f);
  await page.waitForFunction(() => !/Checking/.test(document.getElementById("checks").textContent));
  return page.$$eval("#checks li", (ls) => ls.map((l) => l.className + ":" + l.querySelector(".l").textContent));
};
c = await choose("corrupt.fwsc");
check(c.length === 1 && c[0].startsWith("fail") && await page.isDisabled("#go"), "corrupt file: one failure, Install disabled");
c = await choose("fakeofficial.fwsc");
check(c.at(-1).startsWith("fail") && await page.isDisabled("#go"), "official-identity file refused, Install disabled");
c = await choose("official.fwsc");
check(c.some((x) => /^warn:No USB audio/.test(x)) && c.some((x) => /^info:This is the official/.test(x)), "official build: warns no USB audio, says it's the official one");
c = await latest("8ch");
check(c.length === 5 && c.every((x) => x.startsWith("ok")), "back to the 8-channel build: 5 checks ok: " + c.map((x) => x.split(":")[1]).join(" | "));

const want = (await import("/tmp/elixir/web/fm1pkg.js")).logicalImage(new Uint8Array(BUILD8));
await page.evaluate((n) => { window.__sim.imageLen = n; }, want.length);   // (the real loader reads the length from the package)
const t0 = Date.now();
await page.click("#go");
await page.waitForFunction(() => /^Done|Error|Stopped|not found|lost|did not/.test(document.getElementById("status").textContent), null, { timeout: 120000 });
const status = await page.textContent("#status");
check(/^Done\. The FM-1 runs FM-1_900\./.test(status), `install finished in ${((Date.now() - t0) / 1000).toFixed(1)} s: "${status}"`);
const got = await page.evaluate(() => Array.from(window.__sim.written || []));
check(got.length === want.length && got.every((x, i) => x === want[i]), `the loader received the build's image byte for byte (${got.length} B)`);
check(JSON.stringify(await page.evaluate(() => window.__sim.log)) === '["staged","written"]', "staged once, written once");
check(!(await page.isDisabled("#go")) && !(await page.isDisabled("#check")), "buttons unlocked after the install");
check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join("; ") : ""));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
await browser.close();
server.close();
console.log(failed ? `e2e: ${failed} FAILED` : "e2e: ok");
process.exit(failed ? 1 : 0);
