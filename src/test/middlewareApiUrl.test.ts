import { describe, expect, it } from "vitest";
import { resolveMiddlewareApiUrl, stripTrailingSlashes } from "@/lib/middlewareApiUrl";

describe("middleware API URL resolver", () => {
  it("uses explicit env URL and removes trailing slashes", () => {
    expect(resolveMiddlewareApiUrl("https://api.example.test///", "https://staging.middleware.winerim.wine")).toBe(
      "https://api.example.test",
    );
  });

  it("resolves staging UI host to staging API host", () => {
    expect(resolveMiddlewareApiUrl("", "https://staging.middleware.winerim.wine/onboarding")).toBe(
      "https://api-staging.middleware.winerim.wine",
    );
  });

  it("resolves production UI host to production API host", () => {
    expect(resolveMiddlewareApiUrl(undefined, "https://middleware.winerim.wine/onboarding")).toBe(
      "https://api.middleware.winerim.wine",
    );
  });

  it("falls back to local Worker in unknown/local environments", () => {
    expect(resolveMiddlewareApiUrl("", "http://127.0.0.1:8084/onboarding")).toBe("http://127.0.0.1:8787");
    expect(resolveMiddlewareApiUrl("", "not-a-url")).toBe("http://127.0.0.1:8787");
  });

  it("strips only trailing slashes", () => {
    expect(stripTrailingSlashes("https://example.test/api/v1///")).toBe("https://example.test/api/v1");
  });
});
