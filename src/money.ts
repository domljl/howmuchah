export function currencyDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function parseAmount(value: string, currency: string): number {
  const digits = currencyDigits(currency);
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) throw new Error("Enter a positive amount using numbers only.");
  const [whole, fraction = ""] = value.trim().split(".");
  if (fraction.length > digits) throw new Error(`Use no more than ${digits} decimal places.`);
  const scale = 10 ** digits;
  const minor = Number(whole) * scale + Number(fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(minor) || minor > 100_000_000) throw new Error("Amount is too large.");
  return minor;
}

export function formatAmount(amountMinor: number, currency: string): string {
  const scale = 10 ** currencyDigits(currency);
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / scale);
}
