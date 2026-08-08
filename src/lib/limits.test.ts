import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/limits";
import { OUTPUT_RING_BUFFER_CAP } from "@/stores/terminals";

describe("LIMITS", () => {
  it("exposes a positive integer for every cap", () => {
    for (const [name, value] of Object.entries(LIMITS)) {
      expect(Number.isInteger(value), `${name} must be an integer`).toBe(true);
      expect(value, `${name} must be positive`).toBeGreaterThan(0);
    }
  });

  it("output ring buffer cap comes from LIMITS", () => {
    expect(OUTPUT_RING_BUFFER_CAP).toBe(LIMITS.outputRingLines);
  });

  // The bug this module exists to prevent was two features disagreeing about
  // how many terminals one dock may hold. Phase 2 removed the second claimant
  // (the launch wizard), so the cap now has exactly one reader — but it is
  // still the only place the number may be written down.
  it("keeps the pane cap in one place", () => {
    expect(LIMITS.terminalsPerWorkspace).toBeGreaterThan(1);
  });

  // Groups and profiles left with the model in Phase 2; their caps must go with
  // them rather than linger as numbers nothing enforces.
  it("no longer carries caps for the retired profile model", () => {
    expect(LIMITS).not.toHaveProperty("profiles");
    expect(LIMITS).not.toHaveProperty("groupsPerProfile");
    expect(LIMITS).not.toHaveProperty("terminalsPerProfile");
  });
});
