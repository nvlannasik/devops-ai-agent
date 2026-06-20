const DEFAULT_MAX = 200;

export function truncate(value: string, max = DEFAULT_MAX): string {
  if (value.length <= max) return value;
  const remaining = value.length - max;
  return `${value.slice(0, max)}...[truncated ${remaining} chars]`;
}
