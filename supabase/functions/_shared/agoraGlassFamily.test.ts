import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pickLiveGlassFamily } from "./agoraGlassFamily.ts";
const fams = [{ Id: "900157", Name: "TINTOS WINERIM" }, { Id: "901954", Name: "COPAS WINERIM" }];
Deno.test("glass goes to live COPAS WINERIM", () => assertEquals(pickLiveGlassFamily(fams), { id: "901954", name: "COPAS WINERIM" }));
Deno.test("explicit live copa mapping wins", () => assertEquals(pickLiveGlassFamily([...fams, { Id: "7", Name: "COPAS" }], { id: "7", name: "COPAS" }), { id: "7", name: "COPAS" }));
Deno.test("stale mapping falls back to COPAS WINERIM", () => assertEquals(pickLiveGlassFamily(fams, { id: "99", name: "X" })?.id, "901954"));
Deno.test("no glass family keeps old routing", () => assertEquals(pickLiveGlassFamily([fams[0]]), null));
