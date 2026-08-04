export function runtimeCredentialProvisionerLifecyclePlan() {
  return {
    version: 1,
    status: "RUNTIME_CREDENTIAL_PROVISIONER_LIFECYCLE_PLAN",
    productionChangesPerformed: false,
    deployment: [
      "Generate an offline Ed25519 operator key; keep the private PKCS8 file 0600 outside the repository and configure only its public JWK on the Worker.",
      "Create a dedicated Cloudflare Access application with MFA, explicit operator policy and a maximum 15-minute token lifetime.",
      "Create the Durable Object namespace and deploy the Worker with workers.dev and preview URLs disabled, no route, and PROVISIONING_ENABLED=false.",
      "Bind the existing RUNTIME_VAULT_KEY Secrets Store secret by reference; never read, copy or rotate its value for provisioning.",
      "Run typecheck, unit tests and a Wrangler dry-run; verify the bundle contains no key, credential fixture or production hostname.",
      "Attach one Access-protected custom route, enable provisioning for a bounded maintenance window, and issue exactly one challenge per connection.",
      "Validate the encrypted artifact locally and feed it to prepare-runtime-credential-provisioning through RUNTIME_ENCRYPTED_CREDENTIALS_FILE.",
    ],
    rollback: [
      "Set PROVISIONING_ENABLED=false first.",
      "Remove the custom route without changing the shared RUNTIME_VAULT_KEY secret.",
      "Roll back or delete only the provisioner Worker; runtime executor bindings remain unchanged.",
      "Leave generated database credentials inactive until the separate activation gate succeeds.",
    ],
    retirement: [
      "Confirm no unconsumed challenge remains inside its 120-second maximum TTL.",
      "Remove the Access application and revoke its short-lived operator session.",
      "Delete the provisioner Worker and its Durable Object namespace after the challenge retention window.",
      "Securely delete local plaintext input and operator private key copies according to the operator key policy; retain only encrypted artifacts and attestations.",
    ],
    failClosedAssertions: [
      "No public workers.dev or preview URL.",
      "Cloudflare Access JWT and Ed25519 request signature are both mandatory.",
      "A challenge is atomically consumed before Secrets Store is read.",
      "Vault failures burn the challenge and never return plaintext or key material.",
      "The response contains only scope metadata plus nonce, ciphertext and attestation.",
    ],
  };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(`${JSON.stringify(runtimeCredentialProvisionerLifecyclePlan(), null, 2)}\n`);
}
