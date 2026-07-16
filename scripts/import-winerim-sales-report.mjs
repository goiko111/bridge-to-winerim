#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const WINERIM_API_BASE = "https://app.winerim.com/api/v2";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index++;
    }
  }
  return args;
}

function required(args, key) {
  const value = String(args[key] || "").trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
      return text.trim() ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
}

async function snapshotStocks(token, candidates) {
  const wineIds = Array.from(new Set(
    candidates.map((sale) => String(sale.audit?.winerimId || "")).filter(Boolean),
  )).sort();
  const stocks = {};
  for (const wineId of wineIds) {
    const response = await fetchJson(`${WINERIM_API_BASE}/stock/wine/${wineId}`, {
      headers: {
        "WINERIM-API-TOKEN": token,
        Accept: "application/json",
      },
    });
    for (const stock of response?.stocks || []) {
      stocks[String(stock.id)] = {
        wineId,
        wine: stock.winePrice?.wine?.name || null,
        variant: stock.winePrice?.variant || null,
        stock: Number(stock.stock || 0),
        stockActive: stock.stockActive === true,
      };
    }
    await sleep(250);
  }
  return stocks;
}

function stockChanges(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(keys)
    .map((stockId) => ({
      stockId,
      before: before[stockId] || null,
      after: after[stockId] || null,
    }))
    .filter((row) =>
      !row.before ||
      !row.after ||
      row.before.stock !== row.after.stock ||
      row.before.stockActive !== row.after.stockActive
    );
}

async function importCandidates(token, candidates) {
  const result = {
    batches: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const response = await fetchJson(`${WINERIM_API_BASE}/sales/import`, {
      method: "POST",
      headers: {
        "WINERIM-API-TOKEN": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sales: batch.map((sale) => ({
          stockId: sale.stockId,
          qty: sale.qty,
          soldAt: sale.soldAt,
          orderId: sale.orderId,
        })),
      }),
    });
    result.batches++;
    result.imported += Number(response?.imported || 0);
    result.skipped += Number(response?.skipped || 0);
    result.failed += Number(response?.failed || 0);
    for (const error of response?.errors || []) {
      const localIndex = Number(error?.index);
      const sale = Number.isInteger(localIndex) ? batch[localIndex] : null;
      result.errors.push({
        ...error,
        globalIndex: Number.isInteger(localIndex) ? offset + localIndex : null,
        orderId: sale?.orderId || null,
        audit: sale?.audit || null,
      });
    }
    await sleep(250);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = required(args, "report");
  const outputPath = args.output ? String(args.output) : null;
  if (args.apply !== true || args["confirm-no-stock"] !== true) {
    throw new Error("Import requires --apply --confirm-no-stock");
  }

  const token = String(process.env.WINERIM_API_TOKEN || "").trim();
  if (!token) throw new Error("Missing WINERIM_API_TOKEN environment variable");

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report?.guarantees?.endpoint !== "/api/v2/sales/import") {
    throw new Error("Report does not declare the sales/import no-stock endpoint");
  }
  const candidates = report?.importable?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Report does not contain importable.candidates");
  }
  const orderIds = candidates.map((sale) => String(sale.orderId || ""));
  if (orderIds.some((orderId) => !orderId)) throw new Error("Candidate without orderId");
  if (new Set(orderIds).size !== orderIds.length) throw new Error("Duplicate orderIds in report");

  const before = await snapshotStocks(token, candidates);
  const firstPass = await importCandidates(token, candidates);
  const afterFirstPass = await snapshotStocks(token, candidates);
  const firstPassStockChanges = stockChanges(before, afterFirstPass);
  const secondPass = await importCandidates(token, candidates);
  const afterSecondPass = await snapshotStocks(token, candidates);
  const secondPassStockChanges = stockChanges(afterFirstPass, afterSecondPass);

  const result = {
    generatedAt: new Date().toISOString(),
    sourceReport: reportPath,
    locationName: report.locationName,
    range: report.range,
    endpoint: "/api/v2/sales/import",
    candidates: candidates.length,
    quantity: candidates.reduce((total, sale) => total + Number(sale.qty || 0), 0),
    firstPass,
    secondPass,
    firstPassStockChanges,
    secondPassStockChanges,
    stockUnchanged: firstPassStockChanges.length === 0 && secondPassStockChanges.length === 0,
    idempotent: secondPass.imported === 0 &&
      secondPass.failed === 0 &&
      secondPass.skipped === candidates.length,
  };

  if (outputPath) await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));

  if (firstPass.failed > 0 || firstPass.errors.length > 0) {
    throw new Error("First historical import pass contains failures");
  }
  if (!result.stockUnchanged) {
    throw new Error("Historical sales import changed stock");
  }
  if (!result.idempotent) {
    throw new Error("Second historical import pass was not fully idempotent");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
