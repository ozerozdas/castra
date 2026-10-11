/** Removes trailing `chars` without a regex (`/x+$/` backtracks quadratically on long runs of `x`). */
export function trimEnd(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}
