import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The app's typographic vocabulary, in one place.
 *
 * Before this, size and weight were spelled out at 44 call sites and the same recipe
 * was copy-pasted verbatim three times — which is how the app ended up with four
 * different spellings of "heading", two page-level `h1`s ten pixels and a weight apart,
 * and a log pane whose populated rows had a line-height its own skeleton did not.
 *
 * A named role, not a size: `text-sm font-medium` tells the next component nothing
 * about whether it should match. `<Text variant="label">` does. The prop is called
 * `variant` rather than `role` so it cannot be confused — by a reader or by
 * jsx-a11y — with the ARIA attribute of that name, which callers may still pass.
 *
 * Size and leading come from the tokens (see globals.css); weight is a stock utility,
 * chosen here and nowhere else. Inter Tight — the `font-display` family — ships 500,
 * 600 and 700 only, so the display roles never ask for a lighter one.
 */
const textVariants = cva("", {
  variants: {
    variant: {
      display: "font-display text-display font-semibold tracking-tight",
      title: "font-display text-title font-semibold tracking-tight",
      heading: "font-display text-heading font-medium",
      body: "text-body font-normal",
      label: "text-label font-medium",
      caption: "text-caption font-normal",
      /**
       * A caption carrying weight, for a short label on a compact tinted control — a
       * status pill or a preset chip. Its own step because those two were the only
       * places reaching for a 12px medium, and they had each spelled it out.
       */
      badge: "text-caption font-medium",
      mono: "font-mono text-mono font-normal",
    },
    /**
     * Which text colour. Separate from the variant because the same role legitimately
     * appears at three emphases — a caption is subtle under a form field and muted in a
     * banner — while the size and weight stay fixed.
     */
    tone: {
      default: "text-text",
      muted: "text-text-muted",
      subtle: "text-text-subtle",
      /** Inherit from an ancestor that owns the colour, such as Banner's tone. */
      inherit: "",
    },
  },
  defaultVariants: { variant: "body", tone: "default" },
});

type TextProps = React.ComponentProps<"span"> &
  VariantProps<typeof textVariants> & {
    /** Render the child element instead of a <span>, keeping the typography. */
    asChild?: boolean;
  };

export function Text({
  variant,
  tone,
  asChild = false,
  className,
  ...props
}: TextProps) {
  const Component = asChild ? Slot.Root : "span";
  return (
    <Component className={cn(textVariants({ variant, tone }), className)} {...props} />
  );
}

type HeadingProps = Omit<React.ComponentProps<"h2">, "children"> &
  VariantProps<typeof textVariants> & {
    /**
     * Heading rank. Chosen by the caller and NOT derived from the variant: the outline
     * a screen reader walks is document structure, while the variant is appearance, and
     * tying them together forces one to lie whenever a small heading opens a page or a
     * large one sits mid-document.
     */
    level: 1 | 2 | 3;
    children: React.ReactNode;
  };

export function Heading({
  level,
  variant = "heading",
  tone,
  className,
  ...props
}: HeadingProps) {
  const Component = `h${level}` as const;
  return (
    <Component className={cn(textVariants({ variant, tone }), className)} {...props} />
  );
}
