import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const body = src.match(/export function terminalFailureCutoffIso[\s\S]*?\n}\n/)![0].replace("export ", "");
const fn = new Function(`${body.replace(/: (number|string)/g, "")}; return terminalFailureCutoffIso;`)();
Deno.test("30-sep: fallos anteriores a las 03:47 UTC no bloquean", () => {
  assertEquals(fn(Date.parse("2026-10-01T04:05:00Z"), "2026-09-30"), "2026-10-01T03:47:00.000Z");
});
Deno.test("días < 30-sep conservan la ventana de 24 h", () => {
  assertEquals(fn(Date.parse("2026-10-01T04:05:00Z"), "2026-09-29"), "2026-09-30T04:05:00.000Z");
});
Deno.test("pasadas 24 h desde la publicación, vuelve la ventana normal", () => {
  assertEquals(fn(Date.parse("2026-10-02T05:00:00Z"), "2026-10-01"), "2026-10-01T05:00:00.000Z");
});
