import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolvePreparation, resolveVisibleFamily, siblingPlacement } from "./agoraSiblingPlacement.ts";

const families = [
  { Id: "18", Name: "VINOS BLANCOS", ShowInPos: "false" },
  { Id: "904241", Name: "BLANCOS WINERIM", ShowInPos: "true" },
  { Id: "901954", Name: "COPAS WINERIM", ShowInPos: "true" },
];
const products = [
  { Id: "1", FamilyId: "904241", PreparationTypeId: "1", PreparationOrderId: "1" },
  { Id: "2", FamilyId: "904241", PreparationTypeId: "1", PreparationOrderId: "1" },
  { Id: "3", FamilyId: "904241", PreparationTypeId: "2", PreparationOrderId: "3" },
  { Id: "4", FamilyId: "18", PreparationTypeId: "9", PreparationOrderId: "9" },
  { Id: "5", FamilyId: "901954", PreparationTypeId: "4", PreparationOrderId: "4" },
];
const kinds = new Map([
  ["1", { wineType: "blanco", format: "BOTTLE" }],
  ["2", { wineType: "blanco", format: "BOTTLE" }],
  ["3", { wineType: "blanco", format: "BOTTLE" }],
  ["4", { wineType: "blanco", format: "BOTTLE" }],
  ["5", { wineType: "blanco", format: "GLASS" }],
]);

Deno.test("printer: most frequent pair among visible siblings of same type+format", () => {
  const s = siblingPlacement({ families, products, kinds, wineType: "Blanco", format: "BOTTLE" });
  assertEquals(s.preparation, { typeId: "1", orderId: "1" });
  assertEquals(s.siblingCount, 3);
});
Deno.test("printer: glass siblings are separate from bottles", () => {
  assertEquals(siblingPlacement({ families, products, kinds, wineType: "blanco", format: "GLASS" }).preparation, { typeId: "4", orderId: "4" });
});
Deno.test("printer: explicit route wins, default only without siblings", () => {
  assertEquals(resolvePreparation({ typeId: "7", orderId: "7" }, { typeId: "1", orderId: "1" }, { typeId: "", orderId: "" }).source, "route");
  assertEquals(resolvePreparation(null, { typeId: "1", orderId: "1" }, { typeId: "5", orderId: "5" }).typeId, "1");
  assertEquals(resolvePreparation(null, null, { typeId: "5", orderId: "5" }), { typeId: "5", orderId: "5", source: "default" });
});
Deno.test("family: hidden routed family is replaced by visible sibling family", () => {
  const s = siblingPlacement({ families, products, kinds, wineType: "blanco", format: "BOTTLE" });
  assertEquals(resolveVisibleFamily("18", false, families, s.familyId), { familyId: "904241", reason: "sibling_visible_family" });
});
Deno.test("family: visible routed family is kept", () => {
  assertEquals(resolveVisibleFamily("904241", false, families, null).familyId, "904241");
});
Deno.test("family: hidden and no visible siblings → do not create", () => {
  const s = siblingPlacement({ families, products, kinds, wineType: "tinto", format: "BOTTLE" });
  assertEquals(resolveVisibleFamily("18", false, families, s.familyId), { familyId: null, reason: "no_visible_family" });
});
Deno.test("family: hidden routed family with siblings of same type+format is kept", () => {
  // Family 18 is hidden but holds product 4 (blanco BOTTLE): sites selling
  // from hidden Winerim families must keep creating there.
  const s = siblingPlacement({ families, products, kinds, wineType: "blanco", format: "BOTTLE", routedFamilyId: "18" });
  assertEquals(s.routedSiblingCount, 1);
  assertEquals(resolveVisibleFamily("18", false, families, s.familyId, s.routedSiblingCount), { familyId: "18", reason: "routed_hidden_with_siblings" });
});
Deno.test("family: hidden routed family without siblings falls back to visible sibling family", () => {
  const s = siblingPlacement({ families, products, kinds, wineType: "blanco", format: "BOTTLE", routedFamilyId: "18" });
  const noSiblings = { ...s, routedSiblingCount: 0 };
  assertEquals(resolveVisibleFamily("18", false, families, noSiblings.familyId, noSiblings.routedSiblingCount), { familyId: "904241", reason: "sibling_visible_family" });
});
Deno.test("family: hidden routed family, siblings only of another format → still blocked", () => {
  // Product 5 is a GLASS in visible family; routed hidden family 18 has only a BOTTLE.
  const s = siblingPlacement({ families, products, kinds, wineType: "blanco", format: "GLASS", routedFamilyId: "18" });
  assertEquals(s.routedSiblingCount, 0);
  assertEquals(resolveVisibleFamily("18", false, families, s.familyId, s.routedSiblingCount), { familyId: "901954", reason: "sibling_visible_family" });
});
