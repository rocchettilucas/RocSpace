import { describe, expect, it } from "vitest";
import { normalizeBrowserAddress } from "@/views/WebPreview/browserAddress";

describe("normalizeBrowserAddress", () => {
  it("keeps absolute http and https URLs", () => {
    expect(normalizeBrowserAddress("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    expect(normalizeBrowserAddress("http://localhost:3000")).toBe(
      "http://localhost:3000/",
    );
  });

  it("turns plain domains into https URLs", () => {
    expect(normalizeBrowserAddress("www.youtube.com")).toBe(
      "https://www.youtube.com/",
    );
    expect(normalizeBrowserAddress("youtube.com/watch?v=abc")).toBe(
      "https://youtube.com/watch?v=abc",
    );
  });

  it("keeps local development hosts on http", () => {
    expect(normalizeBrowserAddress("localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(normalizeBrowserAddress("127.0.0.1:1420/app")).toBe(
      "http://127.0.0.1:1420/app",
    );
  });

  it("turns search text into a Google search URL", () => {
    expect(normalizeBrowserAddress("react router docs")).toBe(
      "https://www.google.com/search?q=react+router+docs",
    );
  });

  it("does not embed unsafe protocols", () => {
    expect(normalizeBrowserAddress("javascript:alert(1)")).toBe(
      "https://www.google.com/search?q=javascript%3Aalert%281%29",
    );
  });
});
