/**
 * Choosing what a failed row says, from Railway's deployment-event feed.
 *
 * Pure and network-free on purpose. `api.ts` is `server-only` and this is not; more to the
 * point, every branch here exists because of an uncertainty that has to be driven
 * exhaustively — which member of `DeploymentEventPayload` actually carries the reason has
 * never been observed on a real failed deployment, only introspected. The fetch is one
 * line in `api.ts`; the judgement is all here, where a unit test can reach it.
 */

/** One node of `deploymentEvents`, with every member nullable as the schema has it. */
export type DeploymentEventNode = {
  step?: string | null;
  payload?: {
    error?: string | null;
    reason?: string | null;
    detail?: string | null;
    skipped?: boolean | null;
  } | null;
};

export type DeploymentFailure = {
  /** Railway's `DeploymentEventStep` verbatim, or null when the event carried none. */
  step: string | null;
  /** One bounded line, or null when nothing in the feed carried text. */
  reason: string | null;
};

/**
 * Preference order across the three text members, which is a guess and is documented as
 * one.
 *
 * `error` is named for the purpose. `reason` is the likeliest platform-side wording for a
 * step that did not error so much as refuse. `detail` is last because it is the member
 * most likely to hold verbose prose, and a table row cannot hold verbose prose.
 *
 * `pnpm probe:deployment <id>` against a real failed deployment settles this. If it
 * disagrees, reorder here — nothing else in the app depends on which one won.
 */
const TEXT_MEMBERS = ["error", "reason", "detail"] as const;

/**
 * Fraction of the cap within which a word boundary is worth cutting back to.
 *
 * Beyond it the truncation is severing a single long token — a URL, a base64 blob — and
 * cutting back to the last space would throw away most of the budget to avoid splitting
 * something that was never words.
 */
const WORD_BOUNDARY_WINDOW = 0.2;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const NEXT_LINE = 0x85;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

function isLineBreak(code: number): boolean {
  return (
    code === NEWLINE ||
    code === CARRIAGE_RETURN ||
    code === NEXT_LINE ||
    code === LINE_SEPARATOR ||
    code === PARAGRAPH_SEPARATOR
  );
}

/** C0 (below 0x20) and C1 (0x7f–0x9f), which have no business in a paragraph. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * A code-point scan rather than a character-class regex.
 *
 * The regex form of this is four escape sequences inside a character class, which is both
 * unreadable and one typo away from a range nobody notices is wrong. It also invites
 * someone to paste the literal characters in, at which point the source file reads as
 * binary to `grep` and to a diff viewer.
 *
 * Line breaks are normalised rather than removed: the caller wants the first line, and a
 * control character replaced by a space must not be able to merge two lines into one.
 */
function normalise(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isLineBreak(code)) out += "\n";
    else if (isControl(code)) out += " ";
    else out += char;
  }
  return out;
}

/**
 * Upstream text, reduced to something a row can hold.
 *
 * A stack trace's first line is the useful one and the rest is not something a table row
 * can carry, so everything after the first non-empty line is dropped rather than folded in.
 */
function boundText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;

  const firstLine = normalise(value)
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (firstLine === undefined) return null;

  const flattened = firstLine.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) return null;
  if (flattened.length <= max) return flattened;

  const cut = flattened.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const keep =
    lastSpace > max * (1 - WORD_BOUNDARY_WINDOW) ? cut.slice(0, lastSpace) : cut;
  return `${keep.trimEnd()}…`;
}

/**
 * What to say about a failed deployment, from the events it produced.
 *
 * Walks the feed **backwards**. Relay's `last:` returns the tail oldest-first, so the newest
 * event is the last edge, and the reason for a failure is on the last step that actually
 * ran. A skipped step did not fail and is passed over.
 *
 * Step and reason always come from the **same** event. Pairing the newest event's step with
 * an older event's text produces sentences like "the health check step failed: manifest not
 * found", which is not a hedge — it is a confident lie about which part broke.
 *
 * Returns null when there is nothing to add, and the row keeps the sentence it already had.
 */
export function pickFailureReason(
  events: readonly DeploymentEventNode[],
  max: number,
): DeploymentFailure | null {
  let fallback: DeploymentFailure | null = null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.payload?.skipped === true) continue;

    const step = typeof event.step === "string" && event.step ? event.step : null;

    for (const member of TEXT_MEMBERS) {
      const reason = boundText(event.payload?.[member], max);
      if (reason) return { step, reason };
    }

    // The newest non-skipped event, kept in case no event anywhere carries text.
    if (!fallback && step) fallback = { step, reason: null };
  }

  return fallback;
}
