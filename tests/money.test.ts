import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/money.js";

describe("currency minor units", () => {
  it("parses and formats currencies using their own decimal places", () => {
    expect(parseAmount("12.34", "SGD")).toBe(1234);
    expect(formatAmount(1234, "SGD")).toContain("12.34");
    expect(parseAmount("1200", "JPY")).toBe(1200);
    expect(formatAmount(1200, "JPY")).toContain("1,200");
  });

  it("rejects malformed or over-precise amounts instead of rounding money", () => {
    expect(() => parseAmount("1.239", "SGD")).toThrow("decimal places");
    expect(() => parseAmount("$2.00", "SGD")).toThrow("numbers only");
    expect(() => parseAmount("1e3", "SGD")).toThrow("numbers only");
  });
});
