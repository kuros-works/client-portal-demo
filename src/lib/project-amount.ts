// Stripe の最低額（$0.50）と、USD の上限（$999,999.99）。単位はセント
export const MIN_AMOUNT_CENTS = 50;
export const MAX_AMOUNT_CENTS = 99999999;

// ドルの入力（例 "50.00"）をセントに変える。
// 空欄は null（請求なし）。形式が正しくない・上限超えは "invalid"、最低額未満は "too_small"。
export function parseDollarsToCents(
  input: string,
): number | null | "invalid" | "too_small" {
  const value = input.trim();
  if (value === "") {
    return null;
  }
  // 小数は 2 桁まで。浮動小数点の誤差を避けるため、形式を先に確かめる
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return "invalid";
  }

  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) {
    return "invalid";
  }
  if (cents < MIN_AMOUNT_CENTS) {
    return "too_small";
  }
  return cents;
}

// セントを "$50.00" の形にする
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// 入力欄の初期値用。"50.00"（$ なし）
export function centsToInputValue(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}
