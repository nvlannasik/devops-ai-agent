import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn's `cn`, vendored verbatim because every component below is written to expect it.
 *
 * The `twMerge` half is the part that matters: it resolves CONFLICTS by keeping the last
 * value, so a caller passing `border-warning` to a component whose base is `border-border`
 * gets one border colour rather than two rules racing on source order. Plain `clsx` alone
 * would emit both and let whichever Tailwind happened to write later win — which, for a map
 * whose two state marks ARE its borders, is the difference between "not configured" showing
 * and not.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
