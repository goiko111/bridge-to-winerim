// Task types that the legacy JSON writer (`process-outbound-task`) can really apply.
// Everything else (XML upserts, hide, restore…) belongs to `process-xml-outbound-queue`;
// the legacy writer must never mark them SUCCESS.
export const LEGACY_JSON_TASK_TYPES = new Set(["AGORA_UPSERT_PRODUCT"]);

export function isLegacyJsonTask(taskType: unknown): boolean {
  return LEGACY_JSON_TASK_TYPES.has(String(taskType || ""));
}
