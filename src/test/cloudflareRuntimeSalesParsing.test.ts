import { describe, expect, it } from "vitest";

import {
  countOpenTickets,
  parseOpenTicketPayload,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";

const OPTIONS = {
  provider: "agora",
  businessDay: "2026-07-29",
  observedAt: "2026-07-29T19:45:00Z",
};

describe("Cloudflare runtime sales OpenTicket parser", () => {
  it("parses TicketModel XML and preserves the stable provider lifecycle id", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <ArrayOfTicketModel>
        <TicketModel GlobalId="ticket-sa-pedrera-1" BusinessDay="2026-07-29">
          <Lines>
            <Line Index="1" ProductId="547593" ProductName="B Vi de Glass" Quantity="1" Price="29.5" />
            <Line Index="2" ProductId="0" ProductName="Servicio &amp; pan" Quantity="2" Price="3" />
          </Lines>
        </TicketModel>
      </ArrayOfTicketModel>`;

    const documents = parseOpenTicketPayload(xml, OPTIONS);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      provider: "agora",
      documentId: "open-ticket:ticket-sa-pedrera-1",
      lifecycleId: "ticket-sa-pedrera-1",
      identitySource: "PROVIDER",
      businessDay: "2026-07-29",
      kind: "OPEN_TICKET",
    });
    expect(documents[0].lines).toEqual([
      expect.objectContaining({
        lineId: "1",
        providerProductId: "547593",
        productName: "B Vi de Glass",
        quantity: 1,
        unitPrice: 29.5,
        suggestedVariant: "BOTTLE",
      }),
      expect.objectContaining({
        lineId: "2",
        providerProductId: "0",
        productName: "Servicio & pan",
        quantity: 2,
      }),
    ]);
    expect(countOpenTickets(xml, OPTIONS)).toBe(1);
  });

  it.each([
    ["array", [{ TicketId: "t-1", Lines: [{ ProductId: 10, Quantity: 1 }] }]],
    ["Tickets", { Tickets: [{ TicketId: "t-1", Lines: [{ ProductId: 10, Quantity: 1 }] }] }],
    ["Data.Tickets", { Data: { Tickets: [{ TicketId: "t-1", Lines: [{ ProductId: 10, Quantity: 1 }] }] } }],
    ["TicketModel", { TicketModel: { TicketId: "t-1", Lines: [{ ProductId: 10, Quantity: 1 }] } }],
  ])("parses the %s JSON envelope", (_name, payload) => {
    const [document] = parseOpenTicketPayload(payload, OPTIONS);
    expect(document.lifecycleId).toBe("t-1");
    expect(document.lines[0]).toMatchObject({ providerProductId: "10", quantity: 1 });
  });

  it("creates a deterministic fallback identity but marks it unsafe for provisional stock", () => {
    const payload = { Tickets: [{ Lines: [{ ProductId: "42", Quantity: "1" }] }] };

    const first = parseOpenTicketPayload(payload, OPTIONS)[0];
    const second = parseOpenTicketPayload(JSON.stringify(payload), OPTIONS)[0];

    expect(first.lifecycleId).toBe(second.lifecycleId);
    expect(first.identitySource).toBe("FALLBACK");
    expect(first.lifecycleId).toMatch(/^fallback_0_/);
  });
});
