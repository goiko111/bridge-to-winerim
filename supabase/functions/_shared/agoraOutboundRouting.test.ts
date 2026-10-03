import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isLegacyJsonTask } from "./agoraOutboundRouting.ts";

Deno.test("legacy writer accepts only JSON upserts", () => {
  assertEquals(isLegacyJsonTask("AGORA_UPSERT_PRODUCT"), true);
});

Deno.test("legacy writer rejects XML-only task types", () => {
  for (const t of ["AGORA_RESTORE_PRODUCT", "AGORA_HIDE_PRODUCT", "AGORA_XML_UPSERT_PRODUCT", "AGORA_MIGRATE_FAMILY", "", null]) {
    assertEquals(isLegacyJsonTask(t), false);
  }
});
