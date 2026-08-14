import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A summary and a panel, on the platform's own `<details>`.
 *
 * Not Radix Collapsible, and the reasons are the ones ui/checkbox.tsx already gives for the
 * native input, plus one that is specific to this being inside a form.
 *
 * **A field in a closed panel still submits.** That is a correctness property rather than a
 * detail: closing Advanced after setting three replicas means "tidy this away", not "throw
 * this away", and a person who collapses the panel and presses the button must get what they
 * typed. `<details>` keeps its content in the DOM and hides it; Radix Collapsible unmounts
 * closed content unless it is force-mounted, so the library would need extra wiring to reach
 * the behaviour the platform starts with. disclosure.test.tsx asserts it against a real
 * `FormData`.
 *
 * **There is nothing to animate and therefore nothing to synchronise.** A height transition
 * on this would cost what container-row.tsx pays for its log panel — a mounted flag, an
 * intent ref, two `requestAnimationFrame`s and a documented stuck state — and would put a new
 * case in e2e/motion.spec.ts and the reduced-motion switch. The panel opens on the same
 * frame instead. The chevron is the only thing that moves, on the same duration token the
 * rest of the app uses.
 *
 * **`<summary>` is a button already.** It carries the role, the accessible name from its own
 * text, `aria-expanded` maintained by the browser, and Enter and Space — none of which can be
 * wired up wrong here because none of it is wired up here. It is also not a `<button>`, so it
 * does not submit the form it sits in and needs no `type="button"`.
 *
 * The ref is forwarded for exactly one caller: the spin-up form opens the panel when a
 * validation error names a field inside it, because an inline error nobody can see is
 * silence. That is a DOM write in the same register as clearing an uncontrolled input, and
 * it is why this component holds no `open` state of its own.
 */
export function Disclosure({
  summary,
  children,
  ref,
}: {
  summary: string;
  children: React.ReactNode;
  ref?: React.Ref<HTMLDetailsElement>;
}) {
  return (
    <details
      ref={ref}
      className="group border-border bg-subtle/40 rounded-md border"
      /*
       * No `name`. That attribute makes a group of `<details>` exclusive — opening one shuts
       * the others — and there is exactly one of these on the page today. Adding it later for
       * a second panel would silently close this one, so it is left off rather than set to
       * something that looks harmless.
       */
    >
      <summary
        className={cn(
          "focus-ring text-text text-label flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 font-medium",
          // The marker is suppressed in both spellings: the standard property, and the
          // pseudo-element Safari still uses.
          "list-none select-none [&::-webkit-details-marker]:hidden",
          "hover:bg-subtle",
        )}
      >
        <ChevronRight
          aria-hidden
          className="text-text-subtle duration-base size-4 shrink-0 transition-transform group-open:rotate-90"
        />
        {summary}
      </summary>

      <div className="space-y-4 px-3 pt-1 pb-3">{children}</div>
    </details>
  );
}
