import { describe, expect, it } from "vitest";

import {
  agoraTcpEgressRequiredForHosts,
  createAgoraTcpEgressProxyRequest,
  shouldUseAgoraTcpEgress,
} from "./agoraTcpEgressRouting";

describe("Agora TCP egress routing", () => {
  it("routes the certified Luruna and Cienvinos ports", () => {
    expect(shouldUseAgoraTcpEgress(new URL("http://luruna.dyndns.biz:8984/api/export/"))).toBe(true);
    expect(shouldUseAgoraTcpEgress(new URL("http://cien-vinos.ipglobaltec.es:9984/api/export/"))).toBe(true);
  });

  it("keeps HTTPS and unknown ports on the regular transport", () => {
    expect(shouldUseAgoraTcpEgress(new URL("https://cien-vinos.ipglobaltec.es/api/export/"))).toBe(false);
    expect(shouldUseAgoraTcpEgress(new URL("http://example.test:7777/api/export/"))).toBe(false);
  });

  it("detects that an executor binding is required from the host allowlist", () => {
    expect(agoraTcpEgressRequiredForHosts(
      "albariza.agoratpv.net,luruna.dyndns.biz:8984,cien-vinos.ipglobaltec.es:9984",
    )).toBe(true);
    expect(agoraTcpEgressRequiredForHosts("albariza.agoratpv.net")).toBe(false);
  });

  it("uses an internal service URL and strips unrelated headers", async () => {
    const proxy = await createAgoraTcpEgressProxyRequest(new Request(
      "http://cien-vinos.ipglobaltec.es:9984/api/export/?filter=Invoices",
      { headers: { "Api-Token": "secret", Authorization: "blocked" } },
    ));
    expect(proxy.url).toBe("https://agora-tcp-egress.internal/forward");
    expect(proxy.headers.get("api-token")).toBe("secret");
    expect(proxy.headers.get("authorization")).toBeNull();
    expect(proxy.headers.get("x-winerim-agora-target-url")).toBe(
      "http://cien-vinos.ipglobaltec.es:9984/api/export/?filter=Invoices",
    );
  });
});
