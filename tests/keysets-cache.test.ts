import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { channelConfig } from "../src/config.js";
import { spilmanStores } from "../src/api/stores.js";

const MINT_URL = "http://mint.test";

beforeEach(() => {
  // Clear cache for the test mint
  spilmanStores.keysetCache.clearForMint(MINT_URL);
  channelConfig.mints = { [MINT_URL]: ["sat"] };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keyset cache via kit KeysetCache", () => {
  it("stores and retrieves keyset entries", () => {
    spilmanStores.keysetCache.set(MINT_URL, "A", {
      infoJson: JSON.stringify({ keysetId: "A", unit: "sat", keys: { "1": "keyA" }, inputFeePpk: 0, amounts: [1] }),
      active: true,
      unit: "sat",
    });

    const entry = spilmanStores.keysetCache.get(MINT_URL, "A");
    expect(entry).not.toBeNull();
    expect(entry!.active).toBe(true);
    expect(entry!.unit).toBe("sat");

    const info = JSON.parse(entry!.infoJson);
    expect(info.keysetId).toBe("A");
    expect(info.keys["1"]).toBe("keyA");
  });

  it("getActiveIds returns only active keysets for a unit", () => {
    spilmanStores.keysetCache.set(MINT_URL, "A", {
      infoJson: "{}",
      active: false,
      unit: "sat",
    });
    spilmanStores.keysetCache.set(MINT_URL, "B", {
      infoJson: "{}",
      active: true,
      unit: "sat",
    });

    const activeIds = spilmanStores.keysetCache.getActiveIds(MINT_URL, "sat");
    expect(activeIds).not.toContain("A");
    expect(activeIds).toContain("B");
  });

  it("getMintsUnitsKeysets returns keyset IDs grouped by mint and unit", () => {
    spilmanStores.keysetCache.set(MINT_URL, "A", {
      infoJson: "{}",
      active: true,
      unit: "sat",
    });
    spilmanStores.keysetCache.set(MINT_URL, "B", {
      infoJson: "{}",
      active: true,
      unit: "usd",
    });

    const muk = spilmanStores.keysetCache.getMintsUnitsKeysets();
    expect(muk[MINT_URL]).toBeDefined();
    expect(muk[MINT_URL].sat).toContain("A");
    expect(muk[MINT_URL].usd).toContain("B");
  });

  it("clearForMint removes all entries for a mint", () => {
    spilmanStores.keysetCache.set(MINT_URL, "A", {
      infoJson: "{}",
      active: true,
      unit: "sat",
    });

    expect(spilmanStores.keysetCache.has(MINT_URL, "A")).toBe(true);

    spilmanStores.keysetCache.clearForMint(MINT_URL);

    expect(spilmanStores.keysetCache.has(MINT_URL, "A")).toBe(false);
  });
});
