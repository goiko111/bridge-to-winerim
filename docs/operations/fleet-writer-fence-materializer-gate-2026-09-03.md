# Fleet Writer-Fence Materializer Gate

## Purpose

Add one fresh per-connection writer-fence entry to the existing fleet bundle
without exposing its entries, replacing it blindly, or affecting any other
connection.

## Required trusted capability

The capability must run inside the control plane boundary that already has
access to both the current fleet bundle and the fence proof. It accepts a
validated prepared activation package and returns metadata only.

1. Authenticate an approved operator and enforce an exact `connectionId` and
   `runId` allowlist.
2. Verify the prepared scope, inactive encrypted credential pair, no active
   fence and no live lease for that one connection.
3. Generate the fresh grant with the protected proof; never accept a caller
   supplied signature.
4. Read the current bundle only inside the trusted boundary, reject malformed
   or duplicate identities, append the new `(connectionId, runId,
   generationSha256, rawGrant, proof)` entry, and atomically persist the next
   version.
5. Return only `connectionId`, `runId`, previous/new version and SHA-256
   metadata. Do not return entries, proof, raw grant or credential bytes.
6. Verify the stored bundle resolves the new entry and leaves every previous
   identity intact before exposing the activation package.

## Casa Esteban input gate

- Connection: `5bed7bf7-f28a-4a1c-95f4-bc02ecb9298f`.
- Fresh source readbacks: `Families`, `Products`, `Invoices` each returned
  authenticated `200/XML` twice, with stable hashes.
- Own-infra is an inert preimage: zero active scope, credentials, fence and
  leases; no work must be drained.
- The activation remains fail-closed until the materializer returns a fresh
  bundle entry bound to the exact new run and credential generation.

## Explicitly excluded

- `wrangler secrets-store secret update` with a reconstructed/Casa-only value.
- Reading the global bundle into operator logs, local files or documents.
- Reusing an aborted scope, grant or proof.
- Fencing Lovable before the materialized entry can authorize own-infra.

## Local implementation ready

The pure append validator is implemented and tested in:

- `/Users/GOIKO/Documents/Playground/bridge-to-winerim-own-infra/infrastructure/runtime/fleet-writer-fence-bundle-materializer.mjs`
- `/Users/GOIKO/Documents/Playground/bridge-to-winerim-own-infra/infrastructure/runtime/fleet-writer-fence-bundle-materializer.test.mjs`

It validates the grant/proof/generation binding, preserves each prior entry
byte-for-byte, rejects duplicate identities and returns only entry count and
SHA-256 metadata. The three local tests pass. The missing deployment component
is the trusted wrapper that can obtain the existing bundle only within its own
protected execution boundary and perform the versioned Secret Store update.
