# Casa Esteban read-only scope request (2026-09-03)

## Requested capability

- Connection: `5bed7bf7-f28a-4a1c-95f4-bc02ecb9298f`.
- Lifetime: minimum viable window, maximum 30 minutes.
- Secret material: reference existing Secret Manager records only; do not
  rotate, export, print, duplicate, or place a value in PostgreSQL.
- Remote capability: authenticated Agora `GET` only for master data and
  invoices. No Agora import, product write, price write, Winerim write,
  background scheduler, queue producer, or stock endpoint.
- Control-plane state: must preserve `enabled=false`, `PULL_ONLY/NONE`, zero
  active writer fences, and no active sales/catalogue worker.

## Readback required before any canary

1. Two authenticated `200/XML` reads of Families, Products and Invoices,
   separated by at least five minutes.
2. Sanitized snapshot hashes, mapped-line count and latest invoice timestamp.
3. Explicit automatic expiry/revocation receipt with no residual active scope,
   credential, lease or writer fence.

## Why the existing activation is rejected

The only available `adopt-existing` SQL sets both credential rows active and
updates the connection to `enabled=true`. It is therefore an activation, even
with `PULL_ONLY/NONE`, and cannot satisfy a read-only preflight requirement.
