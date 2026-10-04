export function formatRevealedSupply(supplyStr: string | undefined | null, decimals: number): string | null {
  if (!supplyStr) return null;
  try {
    const v = BigInt(supplyStr);
    const div = 10n ** BigInt(decimals);
    const whole = v / div;
    const frac = v % div;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toLocaleString()}.${fracStr}`;
  } catch {
    return null;
  }
}
