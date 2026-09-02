import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.js";

// shadcn's Button, trimmed to the two shapes this map uses and nothing else. The stock
// component ships six variants and four sizes; carrying four unused ones would be dead code
// that looks like a menu of options someone is meant to pick from.
//
// `asChild` is kept, and it is the reason @radix-ui/react-slot is a dependency at all: the
// map's row link is an <a>, and it needs the button's look without stopping being a link —
// nesting an <a> inside a <button> is invalid, and styling a bare <a> to match would put the
// same declarations in two places.
// `bg-transparent border-0 font-[inherit]` is the price of leaving Tailwind's preflight out.
// shadcn's components are written assuming that reset ran, and it is preflight that neutralises
// a browser's own form-control styling — without it a <button> renders on the UA's `buttonface`
// grey, inside a UA border, in the UA's font, which is what a card wearing a disclosure looked
// like the first time this shipped. Reintroducing preflight is not the fix: it would strip the
// margins, list markers and table borders off the server-rendered half of this same page (see
// tailwind.css). Three declarations, applied where they are needed, is.
const buttonVariants = cva(
  "inline-flex items-center justify-center cursor-pointer transition-colors " +
    "bg-transparent border-0 font-[inherit] " +
    // The page's own focus treatment, not Tailwind's: an outline OUTSIDE the element, so it
    // never repaints the border the map keeps its two state marks in.
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
  {
    variants: {
      variant: {
        ghost: "text-muted-foreground hover:text-foreground",
      },
      size: {
        // Fills its card. The disclosure IS the card surface — a smaller hit area would leave
        // dead space on a control whose whole job is "click anywhere here".
        //
        // `items-start` is not decoration: the base above is `items-center`, which on a
        // flex-COLUMN is the horizontal axis, so without this override every title on an
        // expandable card shrinks to its content and centres. `text-left` does not help — the
        // span is already narrower than the button by then. Measured at 179px inside 214px.
        fill: "w-full h-full p-0 flex-col items-start justify-center gap-0.5 text-left",
        // The corner affordance. 20px is the smallest that still takes a comfortable click at
        // the zoom fitView settles on with a family open.
        icon: "size-5 rounded-sm text-2xs",
      },
    },
    defaultVariants: { variant: "ghost", size: "icon" },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
