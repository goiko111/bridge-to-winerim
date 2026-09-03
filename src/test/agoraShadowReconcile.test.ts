import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  reconcileArtifacts,
  reconcilePrivateFiles,
  ShadowReconcileError,
} from "../../scripts/agora-shadow-reconcile.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(process.cwd(), "scripts/agora-shadow-reconcile.mjs");
const temporaryDirectories: string[] = [];

function line(overrides: Record<string, unknown> = {}) {
  return {
    providerLineId: "line-1",
    providerProductId: "product-1",
    format: "BOTTLE",
    qty: 1,
    soldAt: "2026-08-04T12:01:00+02:00",
    mapping: {
      mapped: true,
      status: "CONFIRMED",
      winerimProductId: "wine-1",
      winerimFormat: "BOTTLE",
    },
    ...overrides,
  };
}

function connection(connectionId: string, overrides: Record<string, unknown> = {}) {
  const base = {
    connectionId,
    cursor: {
      lastBusinessDaySynced: "2026-08-04",
      lastSyncAt: "2026-08-04T10:05:00Z",
      salesCursor: "invoice-100",
    },
    events: [{
      businessDay: "2026-08-04",
      providerDocId: "invoice-100",
      docType: "INVOICE",
      orderId: "order-100",
      soldAt: "2026-08-04T12:00:00+02:00",
      lines: [line()],
    }],
    receipts: [{
      receiptId: "receipt-100",
      businessDay: "2026-08-04",
      providerDocId: "invoice-100",
      orderId: "order-100",
      status: "SUCCESS",
      live: true,
      stockApplied: true,
      duplicate: false,
      payloadSha256: "a".repeat(64),
    }],
  };
  const result = { ...base, ...overrides } as typeof base;
  result.events = result.events.map((event) => (
    "docType" in event || "doc_type" in event ? event : { docType: "INVOICE", ...event }
  ));
  return result;
}

function artifact(connections = [connection("connection-a")]) {
  return { schemaVersion: "agora-shadow-v2", connections };
}

async function privateArtifact(directory: string, name: string, contents: unknown, mode = 0o600) {
  const filePath = join(directory, name);
  await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode });
  await chmod(filePath, mode);
  return filePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agora shadow reconciliation", () => {
  it("reconciles multiple connections exactly independent of input ordering", () => {
    const connectionA = connection("connection-a");
    const connectionB = connection("connection-b", {
      events: [{
        business_day: "2026-08-03",
        provider_doc_id: "invoice-200",
        doc_type: "Invoice",
        order_id: "order-200",
        sold_at: "2026-08-03T20:00:00Z",
        lines: [{
          provider_line_id: "line-200",
          provider_product_id: "product-200",
          format: "glass",
          quantity: "2.000",
          mapped: false,
          mapping_status: "unmapped",
          sold_at: "2026-08-03T20:00:00Z",
        }],
      }],
      receipts: [],
    });

    const first = reconcileArtifacts(artifact([connectionB, connectionA]), artifact([connectionA, connectionB]));
    const second = reconcileArtifacts(artifact([connectionA, connectionB]), artifact([connectionB, connectionA]));

    expect(first.result).toBe("RECONCILED_EXACT");
    expect(first.writes).toBe(false);
    expect(first.summary).toEqual({ reconciledConnections: 2, differingConnections: 0, differences: 0 });
    expect(first.reportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
    const { reportSha256, ...body } = first;
    expect(reportSha256).toBe(createHash("sha256").update(canonicalJson(body)).digest("hex"));
  });

  it("blocks line, soldAt, mapping, cursor and receipt differences without leaking document identities", () => {
    const own = connection("connection-a", {
      cursor: {
        lastBusinessDaySynced: "2026-08-03",
        lastSyncAt: "2026-08-04T10:06:00Z",
        salesCursor: "invoice-099",
      },
      events: [{
        businessDay: "2026-08-04",
        providerDocId: "invoice-100",
        orderId: "order-100",
        soldAt: "2026-08-04T12:00:30+02:00",
        lines: [line({
          format: "GLASS",
          qty: 2,
          soldAt: "2026-08-04T12:02:00+02:00",
          mapping: {
            mapped: true,
            status: "CONFIRMED",
            winerimProductId: "wine-2",
            winerimFormat: "GLASS",
          },
        })],
      }],
      receipts: [{
        receiptId: "receipt-100",
        businessDay: "2026-08-04",
        providerDocId: "invoice-100",
        orderId: "order-100",
        status: "FAILED",
        live: true,
        stockApplied: false,
        duplicate: false,
        payloadSha256: "b".repeat(64),
      }],
    });

    const report = reconcileArtifacts(artifact(), artifact([own]));
    const serialized = JSON.stringify(report);

    expect(report.result).toBe("BLOCKED_DIFFERENCES");
    expect(report.summary.differingConnections).toBe(1);
    expect(report.differences.map((difference) => difference.entity)).toEqual(
      expect.arrayContaining(["cursor", "event", "line", "receipt"]),
    );
    expect(report.differences.flatMap((difference) => difference.fields)).toEqual(
      expect.arrayContaining(["qty", "format", "soldAt", "mapping.winerimProductId", "stockApplied"]),
    );
    expect(serialized).not.toContain("invoice-100");
    expect(serialized).not.toContain("order-100");
    expect(serialized).not.toContain("receipt-100");
    expect(serialized).not.toContain("wine-2");
  });

  it("blocks missing connections and supports an explicit connection scope", () => {
    const lovable = artifact([connection("connection-a"), connection("connection-b")]);
    const own = artifact([connection("connection-a")]);

    const all = reconcileArtifacts(lovable, own);
    expect(all.result).toBe("BLOCKED_DIFFERENCES");
    expect(all.differences).toContainEqual(expect.objectContaining({
      connectionId: "connection-b",
      entity: "connection",
      kind: "MISSING_IN_OWN",
    }));

    const scoped = reconcileArtifacts(lovable, own, { connectionIds: ["connection-a"] });
    expect(scoped.result).toBe("RECONCILED_EXACT");
    expect(scoped.scope.connectionIds).toEqual(["connection-a"]);
  });

  it("rejects duplicate and unstable identities as ambiguous", () => {
    const duplicateConnection = artifact([connection("connection-a"), connection("connection-a")]);
    expect(() => reconcileArtifacts(duplicateConnection, artifact())).toThrowError(
      expect.objectContaining<Partial<ShadowReconcileError>>({ code: "AMBIGUOUS_INPUT" }),
    );

    const unstableLine = connection("connection-a", {
      events: [{
        businessDay: "2026-08-04",
        providerDocId: "invoice-100",
        orderId: "order-100",
        soldAt: "2026-08-04T10:00:00Z",
        lines: [line({ providerLineId: undefined })],
      }],
    });
    expect(() => reconcileArtifacts(artifact([unstableLine]), artifact())).toThrowError(
      expect.objectContaining<Partial<ShadowReconcileError>>({ code: "AMBIGUOUS_INPUT" }),
    );
  });

  it("ignores database-local line UUIDs when a portable provider identity is present", () => {
    const withDatabaseId = connection("connection-a", {
      events: [{
        businessDay: "2026-08-04",
        providerDocId: "invoice-100",
        orderId: "order-100",
        soldAt: "2026-08-04T10:00:00Z",
        lines: [line({ id: "database-specific-uuid" })],
      }],
    });
    expect(reconcileArtifacts(artifact(), artifact([withDatabaseId])).result).toBe("RECONCILED_EXACT");
  });

  it("rejects a database-local UUID or ordinal as the only line identity", () => {
    const localOnly = connection("connection-a", {
      events: [{
        businessDay: "2026-08-04",
        providerDocId: "invoice-100",
        soldAt: "2026-08-04T10:00:00Z",
        lines: [{ ...line(), providerLineId: undefined, id: "database-specific-uuid", ordinal: 1 }],
      }],
    });
    expect(() => reconcileArtifacts(artifact([localOnly]), artifact())).toThrowError(
      expect.objectContaining<Partial<ShadowReconcileError>>({ code: "AMBIGUOUS_INPUT" }),
    );
  });

  it("uses the provider document as event identity without inventing an order id", () => {
    const withoutOrder = connection("connection-a", {
      events: [{
        businessDay: "2026-08-04",
        providerDocId: "invoice-100",
        soldAt: "2026-08-04T12:00:00+02:00",
        lines: [line()],
      }],
    });
    const withDifferentOrder = connection("connection-a", {
      events: [{
        businessDay: "2026-08-04",
        providerDocId: "invoice-100",
        orderId: "real-order-elsewhere",
        soldAt: "2026-08-04T12:00:00+02:00",
        lines: [line()],
      }],
    });
    const report = reconcileArtifacts(artifact([withoutOrder]), artifact([withDifferentOrder]));
    expect(report.result).toBe("BLOCKED_DIFFERENCES");
    expect(report.differences).toContainEqual(expect.objectContaining({
      entity: "event",
      fields: ["orderId"],
    }));
  });

  it("accepts only private regular files and refuses symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agora-shadow-security-"));
    temporaryDirectories.push(directory);
    const lovablePath = await privateArtifact(directory, "lovable.json", artifact(), 0o600);
    const ownPath = await privateArtifact(directory, "own.json", artifact(), 0o400);

    await expect(reconcilePrivateFiles({ lovablePath, ownPath })).resolves.toMatchObject({
      result: "RECONCILED_EXACT",
      writes: false,
      inputs: {
        lovableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        ownSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const publicPath = await privateArtifact(directory, "public.json", artifact(), 0o644);
    await expect(reconcilePrivateFiles({ lovablePath: publicPath, ownPath })).rejects.toMatchObject({
      code: "UNSAFE_FILE",
    });

    const symlinkPath = join(directory, "lovable-link.json");
    await symlink(lovablePath, symlinkPath);
    await expect(reconcilePrivateFiles({ lovablePath: symlinkPath, ownPath })).rejects.toMatchObject({
      code: "UNSAFE_FILE",
    });
  });

  it("runs only with --dry-run, returns deterministic sanitized output and creates no files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agora-shadow-cli-"));
    temporaryDirectories.push(directory);
    const lovablePath = await privateArtifact(directory, "lovable.json", artifact());
    const ownPath = await privateArtifact(directory, "own.json", artifact());
    const before = await readdir(directory);

    const first = await execFileAsync(process.execPath, [
      scriptPath,
      "--lovable", lovablePath,
      "--own", ownPath,
      "--connection-id", "connection-a",
      "--dry-run",
    ]);
    const second = await execFileAsync(process.execPath, [
      scriptPath,
      "--lovable", lovablePath,
      "--own", ownPath,
      "--connection-id", "connection-a",
      "--dry-run",
    ]);

    expect(JSON.parse(first.stdout)).toMatchObject({ result: "RECONCILED_EXACT", dryRun: true, writes: false });
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).not.toContain(lovablePath);
    expect(first.stdout).not.toContain("invoice-100");
    expect(await readdir(directory)).toEqual(before);

    await expect(execFileAsync(process.execPath, [scriptPath, "--lovable", lovablePath, "--own", ownPath]))
      .rejects.toMatchObject({ code: 2 });
  });

  it("returns a blocking CLI exit for differences without exposing business identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agora-shadow-cli-difference-"));
    temporaryDirectories.push(directory);
    const lovablePath = await privateArtifact(directory, "lovable.json", artifact());
    const ownPath = await privateArtifact(directory, "own.json", artifact([
      connection("connection-a", {
        events: [{
          businessDay: "2026-08-04",
          providerDocId: "invoice-100",
          orderId: "order-100",
          soldAt: "2026-08-04T12:00:00+02:00",
          lines: [line({ qty: 9 })],
        }],
      }),
    ]));

    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [
        scriptPath,
        "--lovable", lovablePath,
        "--own", ownPath,
        "--dry-run",
      ]);
    } catch (error) {
      failure = error;
    }
    const result = failure as { code: number; stdout: string };
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      result: "BLOCKED_DIFFERENCES",
      writes: false,
      summary: { differences: 1 },
    });
    expect(result.stdout).not.toContain("invoice-100");
    expect(result.stdout).not.toContain("order-100");
  });
});
