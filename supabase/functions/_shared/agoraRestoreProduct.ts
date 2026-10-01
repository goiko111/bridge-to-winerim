// Restores prior attributes/price on an existing Agora <Product> element.
// Only the listed attributes and the MainPrice of one price list change.
export function restoreAgoraProductXml(
  productXml: string,
  attrs: Record<string, string>,
  mainPrice: string | undefined,
  priceListId = "1",
): { ok: true; xml: string } | { ok: false; error: string } {
  const allowed = new Set(["FamilyId", "Name", "ButtonText", "Order", "SaleableAsMain", "UseAsDirectSale", "Color"]);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const openMatch = /^<Product\b[^>]*?(\/?)>/.exec(productXml);
  if (!openMatch) return { ok: false, error: "RESTORE_BAD_PRODUCT_XML" };
  let open = openMatch[0];
  for (const [k, v] of Object.entries(attrs)) {
    if (!allowed.has(k)) return { ok: false, error: `RESTORE_ATTR_NOT_ALLOWED:${k}` };
    if (k === "Color" && !/^#[0-9A-F]{6}$/i.test(String(v))) return { ok: false, error: "RESTORE_BAD_COLOR" };
    const re = new RegExp(`\\s${k}="[^"]*"`);
    const val = ` ${k}="${esc(String(v))}"`;
    open = re.test(open) ? open.replace(re, val) : open.replace(/\s*(\/?)>$/, `${val}$1>`);
  }
  let xml = open + productXml.slice(openMatch[0].length);
  if (mainPrice != null) {
    const priceRe = new RegExp(`<Price\\b[^>]*\\bPriceListId="${priceListId}"[^>]*\\/?>`);
    const m = priceRe.exec(xml);
    if (!m) return { ok: false, error: "RESTORE_PRICE_LIST_NOT_FOUND" };
    const patched = /\sMainPrice="[^"]*"/.test(m[0])
      ? m[0].replace(/\sMainPrice="[^"]*"/, ` MainPrice="${esc(mainPrice)}"`)
      : m[0].replace(/\s*(\/?)>$/, ` MainPrice="${esc(mainPrice)}"$1>`);
    xml = xml.replace(m[0], patched);
  }
  return { ok: true, xml };
}
