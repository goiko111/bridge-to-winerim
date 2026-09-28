import type { ReferenceInput } from "../closure.ts";

// Fixture real (sin llamada productiva): Taberna del Clinic, menuId 346.
export const CLINIC_PETALOS_2023: ReferenceInput = {
  connectionId: "taberna-del-clinic", menuId: 346, restaurantName: "Taberna del Clinic",
  wineId: 372078, name: "Pétalos del Bierzo", vintage: "2023", format: "BOTELLA_750",
  priceMinor: 3700, stock: 3, inInventory: true, inActiveMenu: false, inInactiveMenu: false, availableInAddWine: true,
  agora: null,
};

// Misma referencia tras entrar en carta activa y con readback Ágora exacto (fixture sintético).
export const CLINIC_PETALOS_2023_PUBLISHED: ReferenceInput = {
  ...CLINIC_PETALOS_2023, inActiveMenu: true,
  agora: { source: "READBACK", salesCenter: "SALA", priceList: "TARIFA GENERAL", family: "TINTOS WINERIM", visible: true, saleable: true, priceMinor: 3700, readAt: "2026-09-28T09:00:00Z" },
};
