import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "../src/config.js";
import { mintsUnitsKeysets } from "../src/api/stores.js";
import * as channel from "../src/api/channel.js";

const MINT_URL = "http://mint.test";

function resetKeysetCache() {
  for (const key of Object.keys(mintsUnitsKeysets)) {
    delete mintsUnitsKeysets[key];
  }
}

beforeEach(() => {
  resetKeysetCache();
  config.channel.approvedMintsAndUnits = { [MINT_URL]: ["sat"] };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keyset cache refresh", () => {
  it("retains inactive keysets on refresh", async () => {
    mintsUnitsKeysets[MINT_URL] = {
      sat: [{ id: "A", keys: { "1": "keyA" }, active: true, input_fee_ppk: 0 }],
    };

    vi.spyOn(channel, "fetchAllKeysetsFromMint").mockResolvedValue([
      { id: "A", unit: "sat", active: false, input_fee_ppk: 0, keys: { "1": "keyA" } },
      { id: "B", unit: "sat", active: true, input_fee_ppk: 0, keys: { "1": "keyB" } },
    ]);

    await channel.refreshKeysetsForMint(MINT_URL);

    const satKeysets = mintsUnitsKeysets[MINT_URL].sat;
    expect(satKeysets.find(k => k.id === "A")?.active).toBe(false);
    expect(satKeysets.find(k => k.id === "B")).toBeTruthy();
  });

  it("does not drop missing keysets", async () => {
    mintsUnitsKeysets[MINT_URL] = {
      sat: [{ id: "A", keys: { "1": "keyA" }, active: true, input_fee_ppk: 0 }],
    };

    vi.spyOn(channel, "fetchAllKeysetsFromMint").mockResolvedValue([
      { id: "B", unit: "sat", active: true, input_fee_ppk: 0, keys: { "1": "keyB" } },
    ]);

    await channel.refreshKeysetsForMint(MINT_URL);

    const satKeysets = mintsUnitsKeysets[MINT_URL].sat;
    expect(satKeysets.map(k => k.id)).toContain("A");
    expect(satKeysets.map(k => k.id)).toContain("B");
  });
});
