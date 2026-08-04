import { describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import { buildBusinessDayRepair } from "../../scripts/prepare-business-day-repair.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";

function artifact({ target = false, openTicket = false, shifted = false } = {}) {
  const events = ["invoice-1", "invoice-2"].map((providerDocId, index) => ({
    businessDay: shifted ? `2026-08-0${index + 1}` : `2026-08-0${index + 2}`,
    providerDocId,
    docType: openTicket && index === 0 ? "OPENTICKET" : "INVOICE",
    soldAt: `2026-08-0${index + 2}T12:00:00.000Z`,
    lines: [{
      providerLineId: `line-${index}`,
      providerProductId: `product-${index}`,
      format: "BOTTLE",
      qty: 1,
      soldAt: `2026-08-0${index + 2}T12:00:00.000Z`,
      mapping: { mapped: true, status: "CONFIRMED", winerimProductId: `wine-${index}`, winerimFormat: "BOTTLE" },
    }],
  }));
  return {
    schemaVersion: "agora-shadow-v2",
    capture: target ? {
      mode: "POSTGRES_REPEATABLE_READ_ONLY",
      authoritative: true,
      captureStartedAt: "2026-08-04T12:00:00.000Z",
      captureEndedAt: "2026-08-04T12:00:01.000Z",
      sourceMarkerStable: true,
      consistencyBlocker: null,
    } : {
      mode: "OBSERVATIONAL_READ_ONLY",
      authoritative: false,
      captureStartedAt: "2026-08-04T12:00:00.000Z",
      captureEndedAt: "2026-08-04T12:00:01.000Z",
      sourceMarkerStable: true,
      consistencyBlocker: "REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED",
    },
    connections: [{
      connectionId: CONNECTION_ID,
      cursor: {
        lastBusinessDaySynced: shifted ? "2026-08-02" : "2026-08-03",
        lastSyncAt: shifted ? "2026-08-03T12:00:00.000Z" : "2026-08-04T12:00:00.000Z",
        baselineFromBusinessDay: "2026-08-01",
        baselineThroughBusinessDay: "2026-08-04",
      },
      events,
      receipts: events.map((event, index) => ({
        receiptId: `receipt-${index}`,
        businessDay: event.businessDay,
        providerDocId: event.providerDocId,
        orderId: event.providerDocId,
        status: "SUCCESS",
        live: false,
        stockApplied: false,
        duplicate: false,
        payloadSha256: null,
      })),
    }],
  };
}

describe("business-day repair package", () => {
  it("renders a guarded reversible update without recreating dependent rows", () => {
    const result = buildBusinessDayRepair({
      sourceArtifact: artifact(),
      targetArtifact: artifact({ target: true, shifted: true }),
      sourceSha256: "a".repeat(64),
      targetSha256: "b".repeat(64),
      connectionId: CONNECTION_ID,
      expectedEvents: 2,
      expectedLines: 2,
      expectedReceipts: 2,
    });

    expect(result.manifest.changedRows).toBe(2);
    expect(result.apply).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(result.apply).toContain("BUSINESS_DAY_REPAIR_RUNTIME_ACTIVE");
    expect(result.apply).toContain("BUSINESS_DAY_REPAIR_RUNTIME_IDEMPOTENCY_PRESENT");
    expect(result.apply).toContain("UPDATE public.sales_events event SET business_day=expected.new_day");
    expect(result.apply).not.toMatch(/DELETE\s+FROM|INSERT\s+INTO\s+public\.sales_(events|line_items)/i);
    expect(result.rollback).toContain("BUSINESS_DAY_ROLLBACK_PREIMAGE_MISMATCH");
  });

  it("fails closed for OpenTicket history or incomplete watermarks", () => {
    expect(() => buildBusinessDayRepair({
      sourceArtifact: artifact({ openTicket: true }),
      targetArtifact: artifact({ target: true, shifted: true }),
      sourceSha256: "a".repeat(64),
      targetSha256: "b".repeat(64),
      connectionId: CONNECTION_ID,
      expectedEvents: 2,
      expectedLines: 2,
      expectedReceipts: 2,
    })).toThrow("SOURCE_OPEN_TICKET_REPAIR_FORBIDDEN");

    expect(buildBusinessDayRepair({
      sourceArtifact: artifact({ openTicket: true }),
      targetArtifact: artifact({ target: true, shifted: true, openTicket: true }),
      sourceSha256: "a".repeat(64),
      targetSha256: "b".repeat(64),
      connectionId: CONNECTION_ID,
      expectedEvents: 2,
      expectedLines: 2,
      expectedReceipts: 2,
      expectedOpenTickets: 1,
      allowOpenTickets: true,
    }).manifest).toMatchObject({ allowOpenTickets: true, expectedOpenTickets: 1 });

    expect(() => buildBusinessDayRepair({
      sourceArtifact: artifact(),
      targetArtifact: artifact({ target: true, shifted: true }),
      sourceSha256: "a".repeat(64),
      targetSha256: "b".repeat(64),
      connectionId: CONNECTION_ID,
      expectedEvents: 3,
      expectedLines: 2,
      expectedReceipts: 2,
    })).toThrow("BUSINESS_DAY_REPAIR_WATERMARK_MISMATCH");
  });
});
