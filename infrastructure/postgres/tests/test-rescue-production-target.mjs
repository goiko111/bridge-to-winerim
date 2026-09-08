#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  RESCUE_PRODUCTION_ENVIRONMENT,
  RESCUE_PRODUCTION_PROJECT_REF,
  validateRescueProductionTarget,
} from "../rescue-production-target.mjs";

const projectRef = RESCUE_PRODUCTION_PROJECT_REF;
const base = {
  expectedProjectRef: projectRef,
  expectedEnvironment: RESCUE_PRODUCTION_ENVIRONMENT,
};

test("accepts the exact direct Supabase rescue target", () => {
  const result = validateRescueProductionTarget({
    ...base,
    databaseUrl: `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`,
  });
  assert.equal(result.projectRef, projectRef);
  assert.equal(result.mode, "direct");
});

test("accepts the exact Supabase pooler identity", () => {
  const result = validateRescueProductionTarget({
    ...base,
    databaseUrl: `postgresql://postgres.${projectRef}:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
  });
  assert.equal(result.mode, "pooler");
});

test("rejects staging and recovering Lovable refs", () => {
  for (const forbidden of ["qpbmqvfnunkylvtvnyyx", "csiertktrefwewsmequr"]) {
    assert.throws(
      () => validateRescueProductionTarget({
        databaseUrl: `postgresql://postgres:secret@db.${forbidden}.supabase.co:5432/postgres`,
        expectedProjectRef: forbidden,
        expectedEnvironment: RESCUE_PRODUCTION_ENVIRONMENT,
      }),
      /RESCUE_PRODUCTION_UNKNOWN_PROJECT_REF|RESCUE_PRODUCTION_FORBIDDEN_PROJECT_REF/,
    );
  }
});

test("rejects unknown host identity, database, port and environment", () => {
  const cases = [
    { databaseUrl: "postgresql://postgres:secret@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres", expectedProjectRef: "zzzzzzzzzzzzzzzzzzzz" },
    { databaseUrl: `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/other`, expectedProjectRef: projectRef },
    { databaseUrl: `postgresql://postgres:secret@db.${projectRef}.supabase.co:6543/postgres`, expectedProjectRef: projectRef },
    { databaseUrl: `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`, expectedProjectRef: projectRef, expectedEnvironment: "staging" },
  ];
  for (const value of cases) {
    assert.throws(() => validateRescueProductionTarget({ ...base, ...value }));
  }
});

test("local disposable target requires an explicit test gate", () => {
  const databaseUrl = "postgresql://postgres@127.0.0.1:56432/winerim_rescue_production_test";
  assert.throws(() => validateRescueProductionTarget({ ...base, databaseUrl }));
  assert.equal(validateRescueProductionTarget({
    ...base,
    databaseUrl,
    allowLocalDisposable: true,
  }).mode, "local-disposable");
});
