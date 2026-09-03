import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  countXmlOpenTickets,
  parseAgoraOpenTicketsXml,
  parseOpenTickets,
} from "../../supabase/functions/_shared/agoraOpenTickets";

describe("Agora open tickets parser", () => {
  it("keeps existing JSON payload compatibility", () => {
    const tickets = parseOpenTickets({
      Tickets: [
        {
          GlobalId: "json-ticket",
          BusinessDay: "2026-07-29",
          Lines: [{ ProductId: "547593", Quantity: 1 }],
        },
      ],
    });

    expect(tickets).toHaveLength(1);
    expect(tickets[0].GlobalId).toBe("json-ticket");
    expect(tickets[0].Lines?.[0].ProductId).toBe("547593");
  });

  it("parses Sa Pedrera TicketModel XML with wine lines", () => {
    const xml = readFileSync("src/test/fixtures/sa-pedrera-open-tickets-ticketmodel.xml", "utf8");
    const tickets = parseAgoraOpenTicketsXml(xml);

    expect(countXmlOpenTickets(xml)).toBe(1);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].GlobalId).toBe("fixture-ticket-1");
    expect(tickets[0].BusinessDay).toBe("2026-07-29");
    expect(tickets[0].Lines).toHaveLength(2);

    const wineLine = tickets[0].Lines?.find((line) => line.ProductId === "547593");
    expect(wineLine).toMatchObject({
      ProductId: "547593",
      ProductName: "B B349 - Soverribas Albariño",
      FamilyName: "BLANCOS WINERIM",
      Quantity: "1.00",
      UnitPrice: "67.00",
    });
  });
});
