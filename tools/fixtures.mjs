import { readFileSync, writeFileSync } from "node:fs";
const { Package } = await import("/tmp/elixir/web/fm1pkg.js");
const off = new Uint8Array(readFileSync("/tmp/elixir-site/firmware/elixir-v0.17.fwsc"));
// synthetic "USB audio" build: the official app with usb.c's 48K D_FMT planted in the slot's tail (test only)
const p = new Package(off);
const app = p.dec.slice(p.appOff, p.appOff + p.app.size);
app.set([14, 0x24, 2, 1, 2, 2, 16, 2, 0x44, 0xAC, 0x00, 0x80, 0xBB, 0x00], app.length - 64);
p.setApp(app);
writeFileSync("uac.fwsc", p.serialize());
// synthetic 8-channel build: usb.c's 44.1-only D_FMT at 8 channels planted the same way (test only)
const p8 = new Package(off);
const app8 = p8.dec.slice(p8.appOff, p8.appOff + p8.app.size);
app8.set([11, 0x24, 2, 1, 8, 2, 16, 1, 0x44, 0xAC, 0x00], app8.length - 64);
p8.setApp(app8);
writeFileSync("uac8.fwsc", p8.serialize());
const bad = off.slice(); bad[300000] ^= 0x55; writeFileSync("corrupt.fwsc", bad);
const v = new Package(off); v.setProduct("FM-1_015"); writeFileSync("fakeofficial.fwsc", v.serialize());
const l = new Package(off); const e = l.entries.find(x => x.type === 100); const raw = l.serialize(); raw[e.dataOff + l.skew + 100] ^= 1; writeFileSync("loader.fwsc", raw);
writeFileSync("short.fwsc", off.slice(0, 500));
