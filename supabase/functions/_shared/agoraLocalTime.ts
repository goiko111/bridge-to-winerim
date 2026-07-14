function localIsoAt(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}T${byType.get("hour")}:${byType.get("minute")}:${byType.get("second")}`;
}

export function isAgoraTimestampOldEnough(
  value: unknown,
  minAgeMinutes: number,
  timeZone: string,
  nowMs = Date.now(),
): boolean {
  if (minAgeMinutes <= 0) return true;
  const raw = String(value ?? "").trim();
  if (!raw) return true;

  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (explicitZone) {
    const parsed = Date.parse(raw);
    return !Number.isFinite(parsed) || parsed <= nowMs - minAgeMinutes * 60_000;
  }

  const local = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
  if (!local) return true;
  const timestamp = `${local[1]}T${local[2]}`;
  const threshold = localIsoAt(nowMs - minAgeMinutes * 60_000, timeZone);
  return timestamp <= threshold;
}
