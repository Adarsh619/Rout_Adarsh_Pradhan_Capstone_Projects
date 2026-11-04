// The API works in integer paise (₹499.00 = 49900). These convert at the edges of the UI only.

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

// ₹1,999 or ₹1,999.50 (decimals only when there are paise).
export function formatINR(paise: number): string {
  return (paise % 100 === 0 ? inrWhole : inr).format(paise / 100);
}

// What a vendor types ("1,999", "₹ 1999.5") → paise, or undefined if it isn't an amount.
export function parseRupees(input: string): number | undefined {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  return Math.round(Number(cleaned) * 100);
}

// Paise → the plain number shown in a price input ("1999" or "1999.50").
export function rupeesInput(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}
