export type AnalyticsCategory = "WINE" | "OTHER_BEVERAGE" | "FOOD" | "UNCLASSIFIED";
export type AnalyticsLine = {
  connectionId: string;
  effectiveAt: string;
  category: AnalyticsCategory;
  quantity: number;
  revenueMinor: number;
  costMinor: number | null;
  ticketId: string;
  isReturn: boolean;
  currency: string | null;
};

export type AnalyticsBucket = {
  period: "DAY" | "WEEK" | "MONTH" | "ROLLING_7D" | "ROLLING_28D";
  periodStart: string;
  category: AnalyticsCategory | "ALL";
  quantity: number;
  revenueMinor: number;
  revenueShare: number | null;
  costMinor: number | null;
  marginMinor: number | null;
  ticketCount: number;
  currency: string | null;
};

const day = (iso: string) => iso.slice(0, 10);
const addDays = (value: string, delta: number) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};
const weekStart = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(value, -offset);
};
const monthStart = (value: string) => `${value.slice(0, 7)}-01`;

function periodStart(kind: AnalyticsBucket["period"], effectiveDay: string, anchorDay: string): string | null {
  if (kind === "DAY") return effectiveDay;
  if (kind === "WEEK") return weekStart(effectiveDay);
  if (kind === "MONTH") return monthStart(effectiveDay);
  const days = kind === "ROLLING_7D" ? 7 : 28;
  return effectiveDay >= addDays(anchorDay, -(days - 1)) && effectiveDay <= anchorDay ? addDays(anchorDay, -(days - 1)) : null;
}

export function buildAnalytics(lines: AnalyticsLine[], anchorDay: string): AnalyticsBucket[] {
  const periods: AnalyticsBucket["period"][] = ["DAY", "WEEK", "MONTH", "ROLLING_7D", "ROLLING_28D"];
  const rows = new Map<string, { period: AnalyticsBucket["period"]; periodStart: string; category: AnalyticsCategory; quantity: number; revenueMinor: number; costs: number; costsComplete: boolean; tickets: Set<string>; currencies: Set<string> }>();
  for (const line of lines) {
    // Category must be supplied by an explicit rule/source field. No name heuristics.
    if (!["WINE", "OTHER_BEVERAGE", "FOOD", "UNCLASSIFIED"].includes(line.category)) throw new Error(`Categoría no contractual: ${line.category}`);
    const direction = line.isReturn ? -1 : 1;
    for (const period of periods) {
      const start = periodStart(period, day(line.effectiveAt), anchorDay);
      if (!start) continue;
      const key = `${period}|${start}|${line.category}`;
      const row = rows.get(key) ?? { period, periodStart: start, category: line.category, quantity: 0, revenueMinor: 0, costs: 0, costsComplete: true, tickets: new Set<string>(), currencies: new Set<string>() };
      row.quantity += direction * Math.abs(line.quantity);
      row.revenueMinor += direction * Math.abs(line.revenueMinor);
      if (line.costMinor == null) row.costsComplete = false;
      else row.costs += direction * Math.abs(line.costMinor);
      row.tickets.add(line.ticketId);
      if (line.currency) row.currencies.add(line.currency);
      rows.set(key, row);
    }
  }

  const result: AnalyticsBucket[] = [];
  const byPeriod = new Map<string, typeof rows extends Map<string, infer T> ? T[] : never>();
  for (const row of rows.values()) {
    const key = `${row.period}|${row.periodStart}`;
    const group = byPeriod.get(key) ?? [];
    group.push(row);
    byPeriod.set(key, group);
  }
  for (const group of byPeriod.values()) {
    const totalRevenue = group.reduce((sum, row) => sum + row.revenueMinor, 0);
    const totalQuantity = group.reduce((sum, row) => sum + row.quantity, 0);
    const allCostsComplete = group.every((row) => row.costsComplete);
    const totalCosts = group.reduce((sum, row) => sum + row.costs, 0);
    const allTickets = new Set(group.flatMap((row) => [...row.tickets]));
    for (const row of group) {
      result.push({
        period: row.period,
        periodStart: row.periodStart,
        category: row.category,
        quantity: row.quantity,
        revenueMinor: row.revenueMinor,
        revenueShare: totalRevenue === 0 ? null : row.revenueMinor / totalRevenue,
        costMinor: row.costsComplete ? row.costs : null,
        marginMinor: row.costsComplete ? row.revenueMinor - row.costs : null,
        ticketCount: row.tickets.size,
        currency: row.currencies.size === 1 ? [...row.currencies][0] : null,
      });
    }
    result.push({
      period: group[0].period,
      periodStart: group[0].periodStart,
      category: "ALL",
      quantity: totalQuantity,
      revenueMinor: totalRevenue,
      revenueShare: totalRevenue === 0 ? null : 1,
      costMinor: allCostsComplete ? totalCosts : null,
      marginMinor: allCostsComplete ? totalRevenue - totalCosts : null,
      ticketCount: allTickets.size,
      currency: new Set(group.flatMap((row) => [...row.currencies])).size === 1 ? [...new Set(group.flatMap((row) => [...row.currencies]))][0] : null,
    });
  }
  return result.sort((a, b) => `${a.period}|${a.periodStart}|${a.category}`.localeCompare(`${b.period}|${b.periodStart}|${b.category}`));
}
