import type { CandidateTarget } from "../types.ts";

export type AuthorizedExternalResolution = {
  caseFingerprint: string;
  connectionId: string;
  identityScope: "SALE";
  candidateTargets: CandidateTarget[];
  keepSaleIds: string[];
  expectedRestoredQty: number;
};

const row = (caseFingerprint: string, connectionId: string, saleId: string, qty: number, receiptId: string, wineId: string, format: string, keepSaleIds: string[], expectedRestoredQty: number): AuthorizedExternalResolution => ({
  caseFingerprint, connectionId, identityScope: "SALE", candidateTargets: [{ saleId, saleDetailId: null, qty, receiptId, wineId, priceId: null, stockId: null, format }], keepSaleIds, expectedRestoredQty,
});

/** Exact authoritative SALE batch. Ocean Club and all six DETAIL/glass cases are intentionally absent. */
export const AUTHORIZED_EXTERNAL_RESOLUTIONS_19: AuthorizedExternalResolution[] = [
  row("1e633a73f5be9f56da23581d77b80620", "e3cb6dbb-3474-4926-b740-706fbd0ef7e0", "186029", 1, "rcpt_77ff8a90d295bdcf7384597ecbcef7ea", "257159", "botella", ["185943"], 1),
  row("9a0e6806c5f265268494a495c90a7f2e", "99f3a782-844f-4515-a570-662a111ced2e", "182552", 1, "rcpt_1e90f4a07390d3d9bfb8b67912592369", "221542", "botella", ["182185"], 1),
  row("d7aaf7dc9ced64246cfd5dbee5e573aa", "8466c229-773d-4ad9-a747-9bb862d7ae6b", "182339", 1, "rcpt_2a8193a1d78b6011936ac526d87c27df", "232955", "magnum", ["182175"], 1),
  row("36156b8475006b078f6bbe47e0e91e84", "8466c229-773d-4ad9-a747-9bb862d7ae6b", "188689", 1, "rcpt_774814bf139f33b4eda5bd7814a33d2a", "232986", "botella", ["188420"], 1),
  row("80a1e22f0770419aa7e87faf65288ab6", "8466c229-773d-4ad9-a747-9bb862d7ae6b", "188690", 1, "rcpt_aee92c8dc5955322691c4aa280ad67b7", "243873", "botella", ["188510"], 1),
  row("851c592ca26307b2bc220345fe0920be", "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2", "181922", 1, "rcpt_f420a90e30813498121dd925608a0066", "228159", "botella", ["181304"], 1),
  row("471204fbc2f2d443b7e41b0305a071de", "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2", "183454", 1, "rcpt_d351dc757d1ef631af0f6f1042d02d6d", "228278", "botella", ["183271"], 1),
  row("1e32435502dde0bdec3571cfc93745c2", "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2", "185190", 1, "rcpt_04d1e47bd913f528c6f72b1bfff89aab", "228253", "botella", ["184101"], 1),
  row("5c2ce8d9a749eac15b8dbddf8a8029f9", "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2", "185768", 1, "rcpt_9ee8d867fab084f2237cb7a5758a4d3f", "369416", "botella", ["185709"], 1),
  row("64981d2b76d315fa1858964d3e963ceb", "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2", "186492", 1, "rcpt_4d57b474ff72f33f7a488899f70392eb", "357257", "botella", ["186419"], 1),
  row("4c194dce67cac94128bc797becff815e", "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2", "187518", 1, "rcpt_fbca7f44d1a1facb6330368e607d70c8", "228142", "botella", ["187105", "187267"], 1),
  row("0927c88ee19153185353953d48667b5a", "a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2", "188022", 1, "rcpt_e130ed928bb8c9839957a00e00b83138", "234791", "botella", ["187886"], 1),
  row("834402cc1e141f12b3222e76b8954941", "d15af3ec-1225-4438-bb95-af672da43512", "186408", 2, "rcpt_3d95f572dfe6f6b131a2d4424e60d4b7", "285097", "botella", ["186357"], 2),
  row("b3e6b8f3f41687eb4ee2382bbe7db01a", "57e8acbe-5b5f-433c-a0c6-e760c211acd3", "186795", 1, "rcpt_0f3cf55c7b94c93646b2384432887e85", "61370", "botella", ["186671"], 1),
  row("59c978d5d3f71d01f83f875e7776331d", "57e8acbe-5b5f-433c-a0c6-e760c211acd3", "186477", 1, "rcpt_41ce8f8a75d5464c6c039dd420fee4f6", "61061", "botella", ["186406"], 1),
  row("3740a9e5379f55e18c55f5301a66dda6", "57e8acbe-5b5f-433c-a0c6-e760c211acd3", "189345", 1, "rcpt_22b9141cb855d100087390f31110ad9a", "61351", "botella", ["189161"], 1),
  row("13c22eb3fb0a12778abae466ba03c57d", "ae599bfb-d580-4250-9661-a97535d25e85", "189612", 4, "rcpt_a143283c2794951cde0aaebb4343ae8f", "180934", "botella", ["189283", "189310", "189366"], 4),
  row("da1da51e9e6a733e114fb46ef03d50b2", "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b", "185756", 1, "rcpt_2544098f061c6037338ffed23e3599c2", "70776", "botella", ["185713"], 1),
  row("08f29d279b6a65bd9143aeca2625fe87", "1efe95c0-5fb7-404f-9947-416eed598a46", "187580", 1, "rcpt_82a2b1c7130ace0cd4cb17683ce9f35a", "247935", "botella", ["187555"], 1),
];

if (AUTHORIZED_EXTERNAL_RESOLUTIONS_19.length !== 19) throw new Error("Authoritative batch cardinality changed");
