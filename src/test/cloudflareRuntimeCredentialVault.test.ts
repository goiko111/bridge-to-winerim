import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  createPostgresEncryptedCredentialPort,
  createPostgresRuntimeConnectionPort,
  runtimeCredentialAttestation,
} from "../../cloudflare/workers/middleware-runtime/src/executor";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const KEY_VERSION = "fixture-v1";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function postgresWrappedBase64(value: string): string {
  return value.replace(/.{76}(?=.)/g, "$&\n");
}

function aad(kind: "agora" | "winerim"): Uint8Array {
  return new TextEncoder().encode([
    "winerim-runtime-credential",
    "1",
    CONNECTION_ID,
    "agora",
    kind,
    KEY_VERSION,
  ].join("|"));
}

async function encryptedRow(secret: string, kind: "agora" | "winerim" = "winerim") {
  const master = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(12).fill(3);
  const key = await crypto.subtle.importKey("raw", master, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: aad(kind),
    tagLength: 128,
  }, key, new TextEncoder().encode(secret));
  return {
    master: base64(master),
    row: {
      connection_id: CONNECTION_ID,
      provider: "agora",
      credential_kind: kind,
      algorithm: "AES-256-GCM",
      key_version: KEY_VERSION,
      aad_version: 1,
      ciphertext_base64: base64(new Uint8Array(ciphertext)),
      nonce_base64: base64(nonce),
      active: true,
    },
  };
}

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function database(rows: Record<string, unknown>[]) {
  const statements: SqlStatement[] = [];
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    statements.push(statement);
    return result(rows as Row[]);
  });
  const adapter: DatabaseAdapter = {
    query,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({ query }),
  };
  return { adapter, statements };
}

describe("encrypted runtime credential vault", () => {
  it("decrypts one connection-scoped credential with external AES-GCM key material", async () => {
    const fixture = await encryptedRow("fixture-winerim-token");
    const fake = database([fixture.row]);
    const binding = { get: vi.fn(async () => fixture.master) };
    const port = createPostgresEncryptedCredentialPort(fake.adapter, {
      masterKey: binding,
      keyVersion: KEY_VERSION,
    });

    const secret = await port.open({
      connectionId: CONNECTION_ID,
      provider: "agora",
      kind: "winerim",
    });

    expect(await secret?.read()).toBe("fixture-winerim-token");
    const attestation = runtimeCredentialAttestation(secret!);
    expect(attestation).toMatchObject({
      reference: `runtime-vault://postgres/${CONNECTION_ID}/agora/winerim`,
      version: expect.stringMatching(/^[a-f0-9]{64}$/),
      connectionId: CONNECTION_ID,
      provider: "agora",
      kind: "winerim",
    });
    expect(JSON.stringify(attestation)).not.toContain("fixture-winerim-token");
    expect(binding.get).toHaveBeenCalledOnce();
    expect(fake.statements[0].text).toContain("runtime_connection_credentials");
    expect(fake.statements[0].text).not.toMatch(/api_token|winerim_api_token|base_url/i);
    expect(JSON.stringify(fake.statements[0].values)).not.toContain("fixture-winerim-token");
    expect(JSON.stringify(fake.statements[0].values)).not.toContain(fixture.master);
  });

  it("accepts PostgreSQL-wrapped base64 for long encrypted credentials", async () => {
    const plaintext = `fixture-${"x".repeat(180)}`;
    const fixture = await encryptedRow(plaintext);
    const fake = database([{
      ...fixture.row,
      ciphertext_base64: postgresWrappedBase64(fixture.row.ciphertext_base64),
      nonce_base64: ` ${fixture.row.nonce_base64}\n`,
    }]);
    const port = createPostgresEncryptedCredentialPort(fake.adapter, {
      masterKey: { get: async () => postgresWrappedBase64(fixture.master) },
      keyVersion: KEY_VERSION,
    });

    const secret = await port.open({
      connectionId: CONNECTION_ID,
      provider: "agora",
      kind: "winerim",
    });
    expect(await secret?.read()).toBe(plaintext);
  });

  it("rejects row-scope mismatch without exposing or reading the key", async () => {
    const fixture = await encryptedRow("fixture-secret");
    const fake = database([{ ...fixture.row, connection_id: "22222222-2222-4222-8222-222222222222" }]);
    const binding = { get: vi.fn(async () => fixture.master) };
    const secret = await createPostgresEncryptedCredentialPort(fake.adapter, {
      masterKey: binding,
      keyVersion: KEY_VERSION,
    }).open({ connectionId: CONNECTION_ID, provider: "agora", kind: "winerim" });

    expect(secret).toBeNull();
    expect(binding.get).not.toHaveBeenCalled();
  });

  it("fails closed on tampered ciphertext with a non-secret error", async () => {
    const fixture = await encryptedRow("sensitive-fixture-material");
    const fake = database([{ ...fixture.row, ciphertext_base64: base64(new Uint8Array(32).fill(9)) }]);
    const port = createPostgresEncryptedCredentialPort(fake.adapter, {
      masterKey: { get: async () => fixture.master },
      keyVersion: KEY_VERSION,
    });

    let failure = "";
    try {
      await port.open({ connectionId: CONNECTION_ID, provider: "agora", kind: "winerim" });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toBeTruthy();
    expect(failure).not.toContain("sensitive-fixture-material");
    expect(failure).not.toContain(fixture.master);
  });

  it("changes the attested version when the opened ciphertext changes", async () => {
    const first = await encryptedRow("fixture-secret-v1");
    const second = await encryptedRow("fixture-secret-v2");
    const open = async (row: Record<string, unknown>) => createPostgresEncryptedCredentialPort(
      database([row]).adapter,
      { masterKey: { get: async () => first.master }, keyVersion: KEY_VERSION },
    ).open({ connectionId: CONNECTION_ID, provider: "agora", kind: "winerim" });

    const firstSecret = await open(first.row);
    const secondSecret = await open(second.row);
    const firstAttestation = runtimeCredentialAttestation(firstSecret!);
    const secondAttestation = runtimeCredentialAttestation(secondSecret!);

    expect(firstAttestation.reference).toBe(secondAttestation.reference);
    expect(firstAttestation.version).not.toBe(secondAttestation.version);
  });

  it("loads only non-secret connection scope for composition", async () => {
    const fake = database([{
      connection_id: CONNECTION_ID,
      provider: "agora",
      enabled: true,
      base_url: "https://agora.example.test",
    }]);
    await expect(createPostgresRuntimeConnectionPort(fake.adapter).load(CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      provider: "agora",
      enabled: true,
      baseUrl: "https://agora.example.test",
    });
    expect(fake.statements[0].text).toContain("base_url");
    expect(fake.statements[0].text).not.toMatch(/api_token|winerim_api_token|provider_config/i);
  });
});
