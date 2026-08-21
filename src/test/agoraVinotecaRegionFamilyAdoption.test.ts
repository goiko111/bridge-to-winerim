import { describe, expect, it } from "vitest";
import {
  findAdoptableVinotecaRegionFamily,
  isVinotecaRegionFamilyAdoptable,
  vinotecaRegionKey,
} from "../../supabase/functions/_shared/agoraVinotecaNativeFormats.ts";

const ROOT = "112";
const CAVA_KEY = vinotecaRegionKey("Cava");

// Ponzano live master data: legacy homonym, rootless + hidden.
const ponzanoFamilies = [
  { Id: "112", Name: "VINOTECA ABIERTA", ParentFamilyId: "", ShowInPos: "true", DeletionDate: "" },
  { Id: "123", Name: "CAVA", ParentFamilyId: "", ShowInPos: "false", DeletionDate: "" },
  { Id: "900", Name: "VINOTECA ABIERTA - Rioja", ParentFamilyId: "112", ShowInPos: "true", DeletionDate: "" },
];

// Santander live master data: valid region child of the root.
const santanderFamilies = [
  { Id: "112", Name: "VINOTECA ABIERTA", ParentFamilyId: "", ShowInPos: "true", DeletionDate: "" },
  { Id: "123", Name: "Cava", ParentFamilyId: "112", ShowInPos: "true", DeletionDate: "" },
];

describe("VINOTECA region family adoption", () => {
  it("Ponzano legacy 123 CAVA (rootless + hidden) is not adoptable", () => {
    expect(isVinotecaRegionFamilyAdoptable(ponzanoFamilies[1], ROOT)).toBe(false);
    expect(findAdoptableVinotecaRegionFamily(ponzanoFamilies, ROOT, CAVA_KEY)).toBeNull();
  });

  it("Santander 123 Cava (child of 112 + visible) is reused", () => {
    const found = findAdoptableVinotecaRegionFamily(santanderFamilies, ROOT, CAVA_KEY);
    expect(found?.Id).toBe("123");
  });

  it("hidden child of the root is not adoptable", () => {
    const families = [{ Id: "500", Name: "Cava", ParentFamilyId: "112", ShowInPos: "false", DeletionDate: "" }];
    expect(findAdoptableVinotecaRegionFamily(families, ROOT, CAVA_KEY)).toBeNull();
  });

  it("deleted child of the root is not adoptable", () => {
    const families = [
      { Id: "501", Name: "Cava", ParentFamilyId: "112", ShowInPos: "true", DeletionDate: "2026-01-01T00:00:00" },
    ];
    expect(findAdoptableVinotecaRegionFamily(families, ROOT, CAVA_KEY)).toBeNull();
  });

  it("two valid candidates fail closed", () => {
    const families = [
      { Id: "601", Name: "Cava", ParentFamilyId: "112", ShowInPos: "true", DeletionDate: "" },
      { Id: "602", Name: "VINOTECA ABIERTA - Cava", ParentFamilyId: "112", ShowInPos: "true", DeletionDate: "" },
    ];
    expect(() => findAdoptableVinotecaRegionFamily(families, ROOT, CAVA_KEY)).toThrow(/ambiguous region family/);
  });

  it("the root itself is never adopted as a region", () => {
    const families = [{ Id: "112", Name: "Cava", ParentFamilyId: "112", ShowInPos: "true", DeletionDate: "" }];
    expect(findAdoptableVinotecaRegionFamily(families, ROOT, CAVA_KEY)).toBeNull();
  });

  it("resolution is idempotent across cycles", () => {
    const first = findAdoptableVinotecaRegionFamily(santanderFamilies, ROOT, CAVA_KEY);
    const second = findAdoptableVinotecaRegionFamily(santanderFamilies, ROOT, CAVA_KEY);
    expect(first?.Id).toBe(second?.Id);
    expect(findAdoptableVinotecaRegionFamily(ponzanoFamilies, ROOT, CAVA_KEY)).toBeNull();
    expect(findAdoptableVinotecaRegionFamily(ponzanoFamilies, ROOT, CAVA_KEY)).toBeNull();
  });
});
