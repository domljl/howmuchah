import { describe, expect, it } from "vitest";
import { calculateLedger, getSessionWindow, monthlyDueMinor, nextFeeEffectiveSessionDate } from "../functions/src/domain.js";

const instant = (value: string) => new Date(value);

describe("Friday check-in window", () => {
  it("opens Friday at 19:00 inclusive", () => {
    expect(getSessionWindow(instant("2026-10-23T11:00:00Z"), "Asia/Singapore")).toMatchObject({
      sessionDate: "2026-10-23",
      isOpen: true,
    });
  });

  it("is closed before Friday 19:00", () => {
    expect(getSessionWindow(instant("2026-10-23T10:59:00Z"), "Asia/Singapore").isOpen).toBe(false);
  });

  it("remains open Saturday until 17:00 exclusive", () => {
    expect(getSessionWindow(instant("2026-10-24T08:59:00Z"), "Asia/Singapore")).toMatchObject({
      sessionDate: "2026-10-23",
      isOpen: true,
    });
    expect(getSessionWindow(instant("2026-10-24T09:00:00Z"), "Asia/Singapore").isOpen).toBe(false);
  });

  it("uses the configured timezone when deriving the Friday date", () => {
    expect(getSessionWindow(instant("2026-10-24T02:00:00Z"), "America/Los_Angeles")).toMatchObject({
      sessionDate: "2026-10-23",
      isOpen: true,
    });
  });

  it("applies a new fee to the active session's next Friday", () => {
    expect(nextFeeEffectiveSessionDate(instant("2026-10-23T11:00:00Z"), "Asia/Singapore")).toBe("2026-10-30");
  });
});

describe("monthly ledger", () => {
  const charges = [
    { id: "oct-1", sessionDate: "2026-10-02", amountMinor: 200, status: "active" as const },
    { id: "oct-2", sessionDate: "2026-10-09", amountMinor: 500, status: "active" as const },
    { id: "nov-1", sessionDate: "2026-11-06", amountMinor: 300, status: "active" as const },
    { id: "void", sessionDate: "2026-10-16", amountMinor: 900, status: "void" as const },
  ];

  it("applies partial payments to the oldest charges and carries excess as credit", () => {
    const result = calculateLedger(charges, [
      { id: "p1", amountMinor: 500, receivedAt: "2026-10-10T00:00:00Z" },
      { id: "p2", amountMinor: 700, receivedAt: "2026-10-11T00:00:00Z" },
    ]);
    expect(result).toMatchObject({ totalChargesMinor: 1000, totalPaymentsMinor: 1200, balanceMinor: -200, creditMinor: 200 });
    expect(result.charges).toEqual([
      { id: "oct-1", sessionDate: "2026-10-02", amountMinor: 200, paidMinor: 200, dueMinor: 0 },
      { id: "oct-2", sessionDate: "2026-10-09", amountMinor: 500, paidMinor: 500, dueMinor: 0 },
      { id: "nov-1", sessionDate: "2026-11-06", amountMinor: 300, paidMinor: 300, dueMinor: 0 },
    ]);
  });

  it("does not count reversed receipts", () => {
    expect(calculateLedger(charges, [
      { id: "p1", amountMinor: 800, receivedAt: "2026-10-10T00:00:00Z" },
      { id: "p2", amountMinor: 200, receivedAt: "2026-10-11T00:00:00Z" },
    ], ["p2"]).balanceMinor).toBe(200);
  });

  it("shows the month balance after payments allocate to the oldest charges", () => {
    const result = calculateLedger([
      { id: "oct", sessionDate: "2026-10-30", amountMinor: 200, status: "active" },
      { id: "nov", sessionDate: "2026-11-06", amountMinor: 500, status: "active" },
    ], [{ id: "partial", amountMinor: 300, receivedAt: "2026-11-07T00:00:00Z" }]);
    expect(monthlyDueMinor(result.charges, "2026-11")).toBe(400);
  });
});
