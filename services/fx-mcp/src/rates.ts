/**
 * Reference FX rates (per 1 EUR) and ISO 4217 minor units. A fixed table, so every conversion is exact and
 * repeatable: the tests know the right answer. Rates are scaled integers (1e6) and amounts use BigInt.
 */
export const MINOR_UNITS: Record<string, number> = { EUR: 2, USD: 2, GBP: 2, CHF: 2, SEK: 2, JPY: 0 };

const RATES_PER_EUR: Record<string, bigint> = {
  EUR: 1_000_000n,
  USD: 1_085_000n,
  GBP: 854_000n,
  CHF: 956_000n,
  SEK: 11_420_000n,
  JPY: 164_050_000n,
};

/** Currencies that exist but are switched off until an operator enables them (to exercise list_changed). */
export const DORMANT: Record<string, { rate: bigint; minor: number }> = {
  NOK: { rate: 11_680_000n, minor: 2 },
};

export class RateTable {
  private readonly rates = new Map(Object.entries(RATES_PER_EUR));
  private readonly minor = new Map(Object.entries(MINOR_UNITS));

  codes(): string[] {
    return [...this.rates.keys()].sort();
  }

  has(code: string) {
    return this.rates.has(code);
  }

  minorUnits(code: string) {
    return this.minor.get(code)!;
  }

  enable(code: string): boolean {
    const d = DORMANT[code];
    if (!d || this.rates.has(code)) return false;
    this.rates.set(code, d.rate);
    this.minor.set(code, d.minor);
    return true;
  }

  /** Cross rate from → to with 6 decimals, as a string. */
  rate(from: string, to: string): string {
    const r = (this.rates.get(to)! * 1_000_000n * 10n) / this.rates.get(from)!;
    const rounded = (r + 5n) / 10n; // half up at the 7th decimal
    return `${rounded / 1_000_000n}.${String(rounded % 1_000_000n).padStart(6, '0')}`;
  }

  /** amount (decimal string) × rate, rounded half up to the target's minor units. */
  convert(amount: string, from: string, to: string): string {
    const [w, f = ''] = amount.split('.');
    const cents = BigInt(w!) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2)); // amount in 1/100
    const toMicros = (cents * this.rates.get(to)! * 10_000n) / this.rates.get(from)!; // 1e-6 of target
    const digits = this.minor.get(to)!;
    const step = 10n ** BigInt(6 - digits);
    const units = (toMicros + step / 2n) / step;
    if (digits === 0) return String(units);
    const s = String(units).padStart(digits + 1, '0');
    return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  }
}
