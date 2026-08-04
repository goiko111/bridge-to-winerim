import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { renderInactiveRuntimeCredentialProvisionerConfig } from "../render-inactive-config.mjs";

const template = readFileSync(new URL("../wrangler.toml.example", import.meta.url), "utf8");
const values = {
  CF_ACCESS_AUD: "a".repeat(64),
  CF_ACCESS_TEAM_DOMAIN: "winerim.cloudflareaccess.com",
  OPERATOR_KEY_ID: "operator-v1",
  OPERATOR_PUBLIC_KEY_JWK: JSON.stringify({
    crv: "Ed25519",
    kty: "OKP",
    x: "a".repeat(43),
  }),
  RUNTIME_VAULT_KEY_VERSION: "fleet-v1",
  CLOUDFLARE_RUNTIME_VAULT_STORE_ID: "b".repeat(32),
  CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME: "winerim-rescue-prod-vault-key-v1",
  RUNTIME_CREDENTIAL_PROVISIONER_CUSTOM_DOMAIN: "credentials.middleware.winerim.wine",
  RUNTIME_CREDENTIAL_PROVISIONER_MAIN:
    "/private/tmp/winerim-fleet-full-lanes/cloudflare/workers/runtime-credential-provisioner/src/worker.ts",
};

describe("inactive runtime credential provisioner config", () => {
  it("renders an inactive custom-domain config without Access service credentials", () => {
    const rendered = renderInactiveRuntimeCredentialProvisionerConfig({ template, values });
    expect(rendered).toContain('PROVISIONING_ENABLED = "false"');
    expect(rendered).toContain('pattern = "credentials.middleware.winerim.wine"');
    expect(rendered).toContain('main = "/private/tmp/winerim-fleet-full-lanes/');
    expect(rendered).toContain("custom_domain = true");
    expect(rendered).toContain("workers_dev = false");
    expect(rendered).toContain("preview_urls = false");
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("CF_ACCESS_CLIENT_ID");
    expect(rendered).not.toContain("CF_ACCESS_CLIENT_SECRET");
  });

  it("fails closed on extra values, private JWKs and malformed domains", () => {
    expect(() => renderInactiveRuntimeCredentialProvisionerConfig({
      template,
      values: { ...values, CF_ACCESS_CLIENT_SECRET: "must-not-be-rendered" },
    })).toThrow("RUNTIME_CREDENTIAL_PROVISIONER_CONFIG_VALUES_STRUCTURE_INVALID");
    expect(() => renderInactiveRuntimeCredentialProvisionerConfig({
      template,
      values: {
        ...values,
        OPERATOR_PUBLIC_KEY_JWK: JSON.stringify({
          crv: "Ed25519",
          d: "private-material",
          kty: "OKP",
          x: "a".repeat(43),
        }),
      },
    })).toThrow("RUNTIME_CREDENTIAL_PROVISIONER_CONFIG_OPERATOR_PUBLIC_KEY_JWK_INVALID");
    expect(() => renderInactiveRuntimeCredentialProvisionerConfig({
      template,
      values: { ...values, RUNTIME_CREDENTIAL_PROVISIONER_CUSTOM_DOMAIN: "https://bad.test/path" },
    })).toThrow("RUNTIME_CREDENTIAL_PROVISIONER_CONFIG_RUNTIME_CREDENTIAL_PROVISIONER_CUSTOM_DOMAIN_INVALID");
  });
});
