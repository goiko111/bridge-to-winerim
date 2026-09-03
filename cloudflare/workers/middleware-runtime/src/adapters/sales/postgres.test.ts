import { describe, expect, it } from "vitest";

import type {
  DatabaseAdapter,
  QueryResult,
  SqlStatement,
} from "../../../../middleware-api/src/db";
import { createPostgresSalesAdapter } from "./postgres";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

describe("Postgres sales mapping contract", () => {
  it("accepts confirmed Winerim-owned mappings backed by the stock_policy snapshot", async () => {
    const statements: SqlStatement[] = [];
    const database = {
      query: async <Row extends Record<string, unknown>>(statement: SqlStatement): Promise<QueryResult<Row>> => {
        statements.push(statement);
        return {
          rows: [{
            mapping_id: "mapping-glass",
            provider_product_id: "5623422",
            provider_product_name: "C COTAN Finca El Machanedo 2022",
            winerim_wine_id: "62342",
            format_type: "GLASS",
            stock_id: "87215",
            stock_active: false,
          }] as Row[],
          rowCount: 1,
        };
      },
      transaction: async () => {
        throw new Error("transaction is not used by readExactMappings");
      },
    } as DatabaseAdapter;

    const adapter = createPostgresSalesAdapter(database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await expect(adapter.readExactMappings(["5623422"])).resolves.toEqual([{
      mappingId: "mapping-glass",
      mappingStatus: "CONFIRMED",
      providerProductId: "5623422",
      providerProductName: "C COTAN Finca El Machanedo 2022",
      winerimWineId: "62342",
      variant: "GLASS",
      stockId: "87215",
      stockActive: false,
    }]);

    expect(statements).toHaveLength(1);
    expect(statements[0].text).toContain("ww.raw_payload->'stock_policy'");
    expect(statements[0].text).toContain("'WINERIM_OWNED_EXACT_VARIANT'");
    expect(statements[0].values).toContain(CONNECTION_ID);
  });
});
