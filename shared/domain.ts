import { DateTime } from "luxon";

export type SessionWindow = { sessionDate: string; opensAt: string; closesAt: string; isOpen: boolean };

export function getSessionWindow(instant: Date, timeZone: string): SessionWindow {
  const now = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(timeZone);
  if (!now.isValid) throw new Error(`Invalid time zone: ${timeZone}`);
  const friday = now.weekday === 6 && now.hour < 17 ? now.minus({ days: 1 }).startOf("day") : now.plus({ days: (5 - now.weekday + 7) % 7 }).startOf("day");
  const opens = friday.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
  const closes = friday.plus({ days: 1 }).set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
  return { sessionDate: friday.toISODate()!, opensAt: opens.toUTC().toISO()!, closesAt: closes.toUTC().toISO()!, isOpen: now.toMillis() >= opens.toMillis() && now.toMillis() < closes.toMillis() };
}

export function nextFeeEffectiveSessionDate(instant: Date, timeZone: string): string {
  const current = getSessionWindow(instant, timeZone);
  return current.isOpen ? DateTime.fromISO(current.sessionDate, { zone: timeZone }).plus({ days: 7 }).toISODate()! : current.sessionDate;
}

export type ChargeInput = { id: string; sessionDate: string; amountMinor: number; status: "active" | "void" };
export type PaymentInput = { id: string; amountMinor: number; receivedAt: string };

export function calculateLedger(charges: ChargeInput[], payments: PaymentInput[], reversedPaymentIds: string[] = []) {
  const active = charges.filter((charge) => charge.status === "active").sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.id.localeCompare(b.id));
  const reversed = new Set(reversedPaymentIds);
  const validPayments = payments.filter((payment) => !reversed.has(payment.id));
  const totalChargesMinor = active.reduce((sum, charge) => sum + charge.amountMinor, 0);
  const totalPaymentsMinor = validPayments.reduce((sum, payment) => sum + payment.amountMinor, 0);
  let remaining = totalPaymentsMinor;
  const allocatedCharges = active.map((charge) => { const paidMinor = Math.min(charge.amountMinor, remaining); remaining -= paidMinor; return { id: charge.id, sessionDate: charge.sessionDate, amountMinor: charge.amountMinor, paidMinor, dueMinor: charge.amountMinor - paidMinor }; });
  const balanceMinor = totalChargesMinor - totalPaymentsMinor;
  return { charges: allocatedCharges, totalChargesMinor, totalPaymentsMinor, balanceMinor, creditMinor: Math.max(0, -balanceMinor), amountDueMinor: Math.max(0, balanceMinor) };
}

export function monthlyDueMinor(charges: Array<{ sessionDate: string; dueMinor: number }>, month: string) {
  return charges.reduce((total, charge) => total + (charge.sessionDate.startsWith(`${month}-`) ? charge.dueMinor : 0), 0);
}
