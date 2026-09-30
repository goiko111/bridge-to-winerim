// Freno temporal (P1 Q Tomas, 30-sep): una factura (envío `definitive`) que se
// procesa después de la medianoche natural para un día de negocio que ya tuvo
// envíos `open_ticket` no se envía; queda BLOCKED para revisión manual.
// Motivo: tras medianoche el restaurador de abiertos "caducados" usa el día
// natural, devuelve stock de tickets aún abiertos (PUT /stock) sin retirar su
// historial, y la factura posterior vuelve a registrar la venta → duplicado.

export const LATE_DEFINITIVE_REVIEW = "LATE_DEFINITIVE_AFTER_OPEN_TICKET_REVIEW";

export function naturalDayInTimeZone(nowIso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(nowIso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function shouldHoldLateDefinitive(input: {
  day: string;
  desiredSource: "definitive" | "open_ticket";
  nowIso: string;
  timeZone: string;
  openTicketSuccessSends: number;
}): boolean {
  if (input.desiredSource !== "definitive") return false;
  if (input.openTicketSuccessSends <= 0) return false;
  return naturalDayInTimeZone(input.nowIso, input.timeZone) > input.day;
}
