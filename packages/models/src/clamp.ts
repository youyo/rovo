export function clampInt(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n >= max) return max - 1;
  return n;
}
