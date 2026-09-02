import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.js";

// shadcn's Badge, with this map's variants rather than the stock set.
//
// The variants are the map's own vocabulary, and the constraint behind them is stated in
// styles.ts and worth repeating where someone might add a sixth: COLOUR ON THIS MAP IS SPENT.
// `--accent` means "this hop crosses SQS" and `--warning` means "not configured". A badge that
// introduced a third meaning on either would make both ambiguous, which is why `write` — the
// most important thing a badge here can say — carries weight and case instead of ink.
const badgeVariants = cva(
  "inline-flex items-center font-mono uppercase tracking-[0.08em] leading-none shrink-0",
  {
    variants: {
      variant: {
        // heavy / light. Which chain a backend is on is structure, not health.
        muted: "text-2xs text-muted-foreground",
        // `unrouted` — the registry lists it but no chain will ever pick it. The one badge
        // that earns warning ink, because it IS a misconfiguration.
        warning: "text-2xs text-[var(--warning)]",
        // "this tool can change the cluster". Full-strength text, heavier than anything else
        // on the card, and no colour at all.
        strong: "text-2xs font-bold text-foreground",
      },
    },
    defaultVariants: { variant: "muted" },
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
