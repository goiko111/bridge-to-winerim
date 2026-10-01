// A business day counts as Ágora-complete only if the bridge read Ágora successfully AFTER the day closed
// (pos_connections.last_sync_at is only stamped after a successful sales read).
import { businessWindow, type BindingMetadata } from "./time.ts";

export const AGORA_NOT_READ_AFTER_CLOSE = "AGORA_NOT_READ_AFTER_CLOSE";

export function agoraReadAfterClose(binding: BindingMetadata, businessDay: string, lastSyncAt: string | null | undefined): { ok: boolean; closeAt: string; lastSyncAt: string | null } {
  const closeAt = businessWindow(binding, businessDay).to;
  const last = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
  return { ok: Number.isFinite(last) && last >= Date.parse(closeAt), closeAt, lastSyncAt: lastSyncAt ?? null };
}
