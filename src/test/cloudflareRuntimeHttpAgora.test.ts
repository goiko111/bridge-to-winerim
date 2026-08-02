import { describe, expect, it, vi } from "vitest";

import {
  createAgoraReadOnlyClient,
  HttpAdapterError,
  type HttpAdapterLogEvent,
  type HttpTimerPort,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/http";

function timer(): HttpTimerPort {
  let now = 1_000;
  return {
    now: () => now++,
    schedule: vi.fn(() => Symbol("timer")),
    cancel: vi.fn(),
  };
}

function response(body: string, status = 200, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("Agora provider-neutral read-only HTTP client", () => {
  it("does not execute network or credential I/O while being constructed", () => {
    const request = vi.fn();
    const credential = { read: vi.fn() };

    const client = createAgoraReadOnlyClient({
      baseUrl: "http://agora.example.test:8984",
      allowedHosts: ["agora.example.test:8984"],
      credential,
      request: { request },
      timer: timer(),
    });

    expect(client).toBeDefined();
    expect(request).not.toHaveBeenCalled();
    expect(credential.read).not.toHaveBeenCalled();
  });

  it("reads invoices through the exact GET export route and keeps credentials out of logs", async () => {
    const logs: HttpAdapterLogEvent[] = [];
    const request = vi.fn().mockResolvedValue(response(JSON.stringify({ Invoices: [{ Id: 12 }] })));
    const client = createAgoraReadOnlyClient({
      baseUrl: "http://agora.example.test:8984",
      allowedHosts: ["agora.example.test:8984"],
      credential: { read: async () => "agora-super-secret" },
      request: { request },
      timer: timer(),
      logger: { write: async (event) => { logs.push(event); } },
    });

    const result = await client.exportInvoices("2026-08-02");

    expect(result).toMatchObject({ ok: true, status: 200, body: { Invoices: [{ Id: 12 }] } });
    const [url, init] = request.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://agora.example.test:8984");
    expect(parsed.pathname).toBe("/api/export/");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      "business-day": "2026-08-02",
      filter: "Invoices",
    });
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: expect.objectContaining({ "Api-Token": "agora-super-secret" }),
    });
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(logs)).not.toContain("agora-super-secret");
    expect(logs).toEqual([expect.objectContaining({
      target: "agora",
      operation: "agora.export.invoices",
      method: "GET",
      host: "agora.example.test:8984",
      path: "/api/export/",
      outcome: "success",
      status: 200,
    })]);
  });

  it("supports XML TicketModel and allowlisted master filters without mutating Agora", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response("<ArrayOfTicketModel><TicketModel><Id>7</Id></TicketModel></ArrayOfTicketModel>", 200, "text/xml"))
      .mockResolvedValueOnce(response("<Master><Families/><Products/></Master>", 200, "application/xml"));
    const client = createAgoraReadOnlyClient({
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timer(),
    });

    const tickets = await client.exportOpenTickets();
    const master = await client.exportMaster(["Families", "Products", "Families"]);

    expect(tickets.body).toContain("TicketModel");
    expect(master.body).toBe("<Master><Families/><Products/></Master>");
    expect(new URL(request.mock.calls[0][0]).pathname).toBe("/api/export/tickets/");
    const masterUrl = new URL(request.mock.calls[1][0]);
    expect(masterUrl.pathname).toBe("/api/export-master/");
    expect(masterUrl.searchParams.get("filter")).toBe("Families,Products");
    expect(request.mock.calls.every(([, init]) => init.method === "GET" && init.body === undefined)).toBe(true);
  });

  it("offers only fixed read-only operations for preflight and catalog exports", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response("{}"))
      .mockResolvedValueOnce(response("<Products/>", 200, "text/xml"));
    const client = createAgoraReadOnlyClient({
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timer(),
    });

    await client.preflight();
    await client.exportCatalog("Products");

    expect(new URL(request.mock.calls[0][0]).pathname).toBe("/api/");
    expect(new URL(request.mock.calls[1][0]).searchParams.get("filter")).toBe("Products");
    expect(Object.keys(client).sort()).toEqual([
      "exportCatalog",
      "exportInvoices",
      "exportMaster",
      "exportOpenTickets",
      "preflight",
    ]);
  });

  it("rejects invalid dates and filters before reading credentials or invoking HTTP", async () => {
    const request = vi.fn();
    const credential = { read: vi.fn() };
    const client = createAgoraReadOnlyClient({
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      credential,
      request: { request },
      timer: timer(),
    });

    await expect(client.exportInvoices("2026-02-30")).rejects.toMatchObject<HttpAdapterError>({
      code: "AGORA_INVALID_BUSINESS_DAY",
    });
    await expect(client.exportCatalog("Invoices" as never)).rejects.toMatchObject<HttpAdapterError>({
      code: "AGORA_INVALID_EXPORT_FILTER",
    });
    await expect(client.exportMaster(["Unknown" as never])).rejects.toMatchObject<HttpAdapterError>({
      code: "AGORA_INVALID_MASTER_FILTER",
    });
    expect(credential.read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
