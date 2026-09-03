import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter, DatabaseTransaction } from "../../middleware-api/src/db";
import {
  createAgoraMasterRefreshPort,
  parseAgoraMasterRows,
  validateAgoraMasterSnapshot,
  type AgoraMasterSnapshot,
} from "./agoraMasterRefresh";
import type { AgoraCatalogXmlProfile } from "./catalog";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const OBSERVED_AT = "2026-09-02T18:00:00.000Z";

function profile(): AgoraCatalogXmlProfile {
  return {
    vatId: "3",
    priceListIds: ["7"],
    warehouseIds: ["9"],
    colorByFormat: { BOTTLE: "red", GLASS: "white", MAGNUM: "black" },
    preparationTypeId: "11",
    preparationOrderId: "12",
    orderByProductId: {},
  };
}

function xml(container: string, item: string, rows: readonly string[]): string {
  return `<?xml version="1.0"?><Export><${container}>${rows.join("")}</${container}></Export>`;
}

function responses(): Readonly<Record<string, string>> {
  return {
    Families: xml("Families", "Family", ['<Family Id="10" Name="TINTOS WINERIM" ShowInPos="true" />']),
    Products: xml("Products", "Product", [
      '<Product Id="500001" Name="B Fixture" FamilyId="10" SaleableAsMain="true" PreparationTypeId="11" PreparationOrderId="12"><Prices><Price PriceListId="7" MainPrice="25.00" /></Prices></Product>',
    ]),
    Vats: xml("Vats", "Vat", ['<Vat Id="3" Name="IVA" />']),
    PriceLists: xml("PriceLists", "PriceList", ['<PriceList Id="7" Name="Principal" />']),
    PreparationTypes: xml("PreparationTypes", "PreparationType", ['<PreparationType Id="11" Name="Bebidas" />']),
    PreparationOrders: xml("PreparationOrders", "PreparationOrder", ['<PreparationOrder Id="12" Name="Bebidas" />']),
    Warehouses: xml("Warehouses", "Warehouse", ['<Warehouse Id="9" Name="Principal" />']),
    SalePoints: xml("SalePoints", "SalePoint", ['<SalePoint Id="14" Name="Barra" SaleCenterId="15" />']),
    SaleCenters: xml("SaleCenters", "SaleCenter", ['<SaleCenter Id="15" Name="Sala" PriceListId="7" CurrentPriceListId="7" />']),
  };
}

function database() {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ locked: true }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ connection_id: CONNECTION_ID }], rowCount: 1 });
  const transaction = vi.fn(async (work: (transaction: DatabaseTransaction) => Promise<unknown>) =>
    work({ query }));
  return {
    value: { query: vi.fn(), transaction } as unknown as DatabaseAdapter,
    query,
    transaction,
  };
}

function timer() {
  return {
    now: vi.fn(() => Date.parse(OBSERVED_AT)),
    schedule: vi.fn((callback: () => void) => setTimeout(callback, 60_000)),
    cancel: vi.fn((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  };
}

function snapshot(overrides: Partial<AgoraMasterSnapshot> = {}): AgoraMasterSnapshot {
  return {
    families: [{ Id: "10" }],
    products: [{ Id: "500001" }],
    vats: [{ Id: "3" }],
    priceLists: [{ Id: "7" }],
    preparationTypes: [{ Id: "11" }],
    preparationOrders: [{ Id: "12" }],
    warehouses: [{ Id: "9" }],
    salePoints: [{ Id: "14", SaleCenterId: "15" }],
    saleCenters: [{ Id: "15", PriceListId: "7", CurrentPriceListId: "7" }],
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe("Agora master parser", () => {
  it("preserves product attributes and nested price structures", () => {
    const [product] = parseAgoraMasterRows(responses().Products, "Products", "Product");

    expect(product).toMatchObject({
      Id: "500001",
      FamilyId: "10",
      SaleableAsMain: "true",
      PreparationTypeId: "11",
      PreparationOrderId: "12",
      Prices: { Price: { PriceListId: "7", MainPrice: "25.00" } },
    });
  });

  it("rejects declarations that can expand entities", () => {
    expect(() => parseAgoraMasterRows(
      '<!DOCTYPE Export [<!ENTITY token "sensitive">]><Export><Families /></Export>',
      "Families",
      "Family",
    )).toThrow("AGORA_MASTER_XML_INVALID");
  });
});

describe("Agora master operational contract", () => {
  it("requires the configured price list to be active on a live SaleCenter", () => {
    expect(() => validateAgoraMasterSnapshot(snapshot({
      priceLists: [{ Id: "7" }, { Id: "8" }],
      saleCenters: [{ Id: "15", PriceListId: "8", CurrentPriceListId: "8" }],
    }), profile())).toThrow("AGORA_MASTER_PROFILE_PRICE_LIST_NOT_ACTIVE");
  });

  it("requires every SalePoint to reference a SaleCenter from the same connection snapshot", () => {
    expect(() => validateAgoraMasterSnapshot(snapshot({
      salePoints: [{ Id: "14", SaleCenterId: "99" }],
    }), profile())).toThrow("AGORA_MASTER_SALE_POINT_CENTER_INVALID");
  });
});

describe("Agora master refresh port", () => {
  it("rejects an incomplete operational profile before reading credentials or HTTP", async () => {
    const db = database();
    const request = vi.fn();
    const credential = { read: vi.fn(async () => "secret-never-logged") };
    const port = createAgoraMasterRefreshPort({
      database: db.value,
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      request: { request },
      timer: timer(),
      profile: { ...profile(), preparationTypeId: "", preparationOrderId: "" },
    });

    await expect(port.refresh({ connectionId: CONNECTION_ID, credential })).resolves.toMatchObject({
      ok: false,
      httpStatus: 503,
      message: "AGORA_MASTER_PROFILE_OPERATIONAL_ROUTING_INVALID",
      diagnostic: {
        route: "agora.master.profile",
        errorCode: "AGORA_MASTER_PROFILE_OPERATIONAL_ROUTING_INVALID",
      },
    });
    expect(credential.read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("reads every contractual dataset before persisting the scoped snapshot", async () => {
    const db = database();
    const master = responses();
    const request = vi.fn(async (url: string) => {
      const filter = new URL(url).searchParams.get("filter") ?? "";
      const body = master[filter];
      return new Response(body ?? "", {
        status: body ? 200 : 404,
        headers: { "content-type": "application/xml" },
      });
    });
    const credential = { read: vi.fn(async () => "secret-never-logged") };
    const port = createAgoraMasterRefreshPort({
      database: db.value,
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      request: { request },
      timer: timer(),
      profile: profile(),
    });

    await expect(port.refresh({ connectionId: CONNECTION_ID, credential })).resolves.toEqual({
      ok: true,
      outcome: "complete",
      changed: 1,
      observedAt: OBSERVED_AT,
    });
    expect(credential.read).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(9);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain("secret-never-logged");
  });

  it("fails closed on an unavailable contractual route without persisting", async () => {
    const db = database();
    const master = responses();
    const request = vi.fn(async (url: string) => {
      const filter = new URL(url).searchParams.get("filter") ?? "";
      const body = master[filter] ?? "";
      return new Response(filter === "SalePoints" ? "unavailable" : body, {
        status: filter === "SalePoints" ? 500 : 200,
        headers: { "content-type": "application/xml" },
      });
    });
    const port = createAgoraMasterRefreshPort({
      database: db.value,
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      request: { request },
      timer: timer(),
      profile: profile(),
    });

    await expect(port.refresh({
      connectionId: CONNECTION_ID,
      credential: { read: async () => "secret-never-logged" },
    })).resolves.toMatchObject({
      ok: false,
      httpStatus: 500,
      message: "AGORA_MASTER_HTTP_REJECTED",
      diagnostic: {
        route: "/api/export-master/?filter=SalePoints",
        errorCode: "AGORA_MASTER_HTTP_REJECTED",
      },
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects cross-connection use before credential or HTTP access", async () => {
    const db = database();
    const request = vi.fn();
    const credential = { read: vi.fn(async () => "secret-never-logged") };
    const port = createAgoraMasterRefreshPort({
      database: db.value,
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      request: { request },
      timer: timer(),
      profile: profile(),
    });

    await expect(port.refresh({
      connectionId: "22222222-2222-4222-8222-222222222222",
      credential,
    })).resolves.toMatchObject({ ok: false, httpStatus: 422 });
    expect(credential.read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
