/**
 * Numbers and durations, in the reader's locale.
 *
 * Split out of lib/utils.ts, which was already three unrelated concerns — class merging, an
 * Intl helper and an async primitive — and whose `TYPE_SCALE` constant is coupled to four
 * other files and *parsed* by src/app/type-scale.test.ts. Putting presentation formatting in
 * the file the design-system gate reads is how the two start constraining each other.
 * `relativeTime` moved here with them rather than staying behind: two homes for formatting is
 * the drift this split exists to prevent.
 *
 * Every function here returns the NUMBER and never its unit. "GB" and "vCPU" are copy, they
 * live in messages/en.json, and the component composes them with `t()` — a unit string
 * hardcoded in src/lib is one no locale can reach.
 *
 * Every function returns null for absent input, so the caller supplies its own placeholder
 * from the catalog rather than this emitting an em dash nobody can translate.
 */

/**
 * Elapsed time, in the reader's locale.
 *
 * `Intl.RelativeTimeFormat` rather than hand-built strings: it owns the plural forms,
 * the digit system, and whether the marker precedes or follows the number — all of
 * which the previous `${n}s ago` version got wrong outside English.
 *
 * Returns null for a missing or unparseable timestamp so the caller supplies its own
 * placeholder from the catalog, rather than this returning an em dash nobody can
 * translate.
 */
export function relativeTime(
  iso: string | null | undefined,
  locale: string,
): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;

  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return format.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}

/**
 * A vCPU figure.
 *
 * Two decimals because that is the resolution the number carries meaning at: a container
 * idling at 0.003 and one at 0.008 are both "doing nothing", and rendering three digits
 * would put a jittering final character on screen every two minutes for no information.
 * Small non-zero values are not floored to "0.00" for the same reason the mapper never turns
 * an absent sample into a zero — see `minimumFractionDigits` below.
 */
export function formatVcpu(cores: number | null, locale: string): string | null {
  if (cores === null) return null;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cores);
}

/** Below this, memory reads better in megabytes. Exactly 1 GB stays in gigabytes. */
const GB_FLOOR = 1;

/**
 * A memory figure, and the unit key the caller should render it with.
 *
 * Railway reports gigabytes (`MEMORY_USAGE_GB`), so this is a *display* conversion and
 * nothing more — the value is never round-tripped through bytes, which is where a
 * 1000-vs-1024 disagreement would silently enter and never leave.
 *
 * Returns the unit as a discriminant rather than a formatted string because the caller has
 * to pick a catalog key with it: a component that received "210 MB" could only concatenate.
 */
export function formatMemoryGb(
  gb: number | null,
  locale: string,
): { value: string; unit: "gb" | "mb" } | null {
  if (gb === null) return null;

  if (gb < GB_FLOOR) {
    return {
      value: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
        gb * 1000,
      ),
      unit: "mb",
    };
  }

  return {
    value: new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(gb),
    unit: "gb",
  };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const unit = (
  locale: string,
  value: number,
  name: "day" | "hour" | "minute" | "second",
) =>
  new Intl.NumberFormat(locale, {
    style: "unit",
    unit: name,
    // Narrow, so two of them fit the row: "3d 4h" rather than "3 days, 4 hours". Still a
    // localised abbreviation rather than a hardcoded letter — which is the whole reason this
    // goes through Intl instead of a template string.
    unitDisplay: "narrow",
  }).format(value);

/**
 * How long a deployment has been up, as a duration.
 *
 * A duration, not a relative time — which is why `Intl.RelativeTimeFormat` is no use here.
 * It renders "3 days ago", and the thing on screen is "3d 4h": two units, largest first,
 * which is what someone reading an uptime column wants and what one Intl unit cannot say.
 *
 * Two units rather than one because the second is where the information is. "3d" is the
 * same string for eleven hours of a container's life, and "4h" is the same for an hour of
 * it — the pair is what makes a readout that visibly moves.
 *
 * Clamped at zero exactly as `relativeTime` clamps, and for the same reason: this is
 * computed against the *client* clock while the timestamp came from Railway's, so a few
 * seconds of skew would otherwise render a container that has been up for a negative time.
 *
 * `now` is injectable so the unit test is deterministic rather than racing the system clock.
 */
export function formatUptime(
  deployedAt: string | null | undefined,
  locale: string,
  now: number = Date.now(),
): string | null {
  if (!deployedAt) return null;
  const started = new Date(deployedAt).getTime();
  if (Number.isNaN(started)) return null;

  const elapsed = Math.max(0, now - started);

  if (elapsed >= DAY) {
    return [
      unit(locale, Math.floor(elapsed / DAY), "day"),
      unit(locale, Math.floor((elapsed % DAY) / HOUR), "hour"),
    ].join(" ");
  }
  if (elapsed >= HOUR) {
    return [
      unit(locale, Math.floor(elapsed / HOUR), "hour"),
      unit(locale, Math.floor((elapsed % HOUR) / MINUTE), "minute"),
    ].join(" ");
  }
  if (elapsed >= MINUTE) {
    return unit(locale, Math.floor(elapsed / MINUTE), "minute");
  }
  return unit(locale, Math.floor(elapsed / SECOND), "second");
}
