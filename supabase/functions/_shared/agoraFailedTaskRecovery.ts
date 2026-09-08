// Automatic recovery of outbound tasks that only failed because the customer POS
// was unreachable / overloaded / behind a network fault.
//
// Contract (fail-closed):
//  - ONLY infrastructure failures are recoverable. Anything the POS rejected on
//    business grounds (duplicate, format mismatch, missing family, validation)
//    stays FAILED and needs a human decision — retrying it forever is noise.
//  - BLOCKED tasks are never touched (they were disabled deliberately).
//  - Recovery only runs when the POS answered a reachability probe in this very
//    cycle, so we never burn attempts against a POS that is still down.

export const RECOVERABLE_TASK_ERROR_CLASSES = [
  "POS_UNREACHABLE",
  "POS_OVERLOADED",
  "POS_TIMEOUT",
  "NETWORK_ERROR",
  "RATE_LIMITED",
  "UNKNOWN",
] as const;

const RECOVERABLE_PATTERNS: RegExp[] = [
  /\[(POS_UNREACHABLE|POS_OVERLOADED|POS_TIMEOUT|NETWORK_ERROR|RATE_LIMITED|UNKNOWN)\]/i,
  /no route to host/i,
  /connection (refused|reset|closed|timed out)/i,
  /network (error|unreachable)/i,
  /\b(etimedout|econnrefused|econnreset|ehostunreach|enotfound)\b/i,
  /timed? ?out/i,
  /error sending request/i,
  /http 50[0234]\b/i,
  /http 429\b/i,
  /http 5[23][0-9]\b/i,
  /temporarily unavailable/i,
];

// Explicit business rejections. Checked FIRST — an Agora 500 that carries a
// business message (e.g. "formato base que no coincide") must not be retried.
const BUSINESS_PATTERNS: RegExp[] = [
  /\[BUSINESS_ERROR\]/i,
  /\[AUTH_ERROR\]/i,
  /no coincide/i,
  /ya existe/i,
  /already exists/i,
  /duplicad/i,
  /no encontrad|not found/i,
  /obligatori|required|inv[aá]lid/i,
  /variant '[^']*' not found/i,
  /familia .* no/i,
  /unauthorized|forbidden|api[- ]?token/i,
];

export function isRecoverableTaskError(lastError: string | null | undefined): boolean {
  const err = (lastError || "").trim();
  if (!err) return false;
  if (BUSINESS_PATTERNS.some((re) => re.test(err))) return false;
  return RECOVERABLE_PATTERNS.some((re) => re.test(err));
}

export interface RecoverableTaskRow {
  id: string;
  status: string;
  last_error: string | null;
}

/** Ids of FAILED tasks that deserve an automatic retry now that the POS answers. */
export function selectTasksToRequeue(rows: RecoverableTaskRow[], limit = 200): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.status !== "FAILED") continue;
    if (!isRecoverableTaskError(row.last_error)) continue;
    ids.push(row.id);
    if (ids.length >= limit) break;
  }
  return ids;
}
