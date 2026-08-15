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

const VCPU_FRACTION_DIGITS = 2;

/**
 * The smallest figure two decimals can show. Derived, never tuned.
 *
 * `10 ** -VCPU_FRACTION_DIGITS`, expressed against the same constant the format uses, so
 * changing the resolution moves the floor with it. A hardcoded 0.01 beside a
 * `maximumFractionDigits` someone later raised is how a "trace" marker starts appearing on
 * values the format can render perfectly well.
 */
const VCPU_TRACE_FLOOR = 10 ** -VCPU_FRACTION_DIGITS;

/**
 * A vCPU figure, and whether it had to be rounded up to be shown at all.
 *
 * Two decimals because that is the resolution the number carries meaning at: a container
 * idling at 0.003 and one at 0.008 are both "doing nothing", and rendering three digits
 * would put a jittering final character on screen every two minutes for no information.
 *
 * But two decimals alone made four different states render one string. A live probe returned
 * 0.00019975, 0.00030493 and 0.0000028666 off real idle containers, and each of those, an
 * exact zero, and a stopped container's zero all read "0.00 vCPU" — a column of them reads
 * as a readout that is broken rather than one reporting that nothing is happening. So a
 * value below what the format can show comes back as the floor with `trace` set, and the
 * caller composes `common.lessThan` around it: "< 0.01" is true, "0.00" was not.
 *
 * The `trace` flag rather than a "<" in the string, for the reason every function in this
 * file returns a bare number: the marker is copy, and a locale that writes it differently
 * has to be able to reach it.
 *
 * Significant digits (`0.0002`) were the alternative and are rejected in the ticket: they
 * make a 100× difference visible between two figures that are both 0.01% of the ceiling, at
 * the cost of a variable-width string in a mono column, and they turn a genuine zero into
 * "0" — one character away from the em dash that means Railway said nothing.
 */
export function formatVcpu(
  cores: number | null,
  locale: string,
): { value: string; trace: boolean } | null {
  if (cores === null) return null;

  const trace = cores > 0 && cores < VCPU_TRACE_FLOOR;
  return {
    value: new Intl.NumberFormat(locale, {
      minimumFractionDigits: VCPU_FRACTION_DIGITS,
      maximumFractionDigits: VCPU_FRACTION_DIGITS,
    }).format(trace ? VCPU_TRACE_FLOOR : cores),
    trace,
  };
}

/**
 * The ceiling a container's CPU is measured against.
 *
 * No `minimumFractionDigits`, which is the whole difference from `formatVcpu` above: a
 * ceiling of 2 reads "2", not "2.00". The numerator moves under the reader and wants a fixed
 * width so the row does not shuffle; the denominator is whatever the service was created
 * with and does not move at all, and padding it with zeros only makes the pair harder to
 * read at a glance.
 *
 * A second entry point rather than an options argument, on the precedent `formatVolumeMb`
 * sets: the call sites are different enough that a boolean at each of them would be a
 * parameter nobody can read without coming here anyway.
 */
export function formatVcpuLimit(cores: number | null, locale: string): string | null {
  if (cores === null) return null;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: VCPU_FRACTION_DIGITS,
  }).format(cores);
}

/** Railway's own factor. `MEMORY_USAGE_GB` is decimal gigabytes, never 1024-based. */
const MB_PER_GB = 1000;

/**
 * A memory figure, and the unit key the caller should render it with.
 *
 * Railway reports gigabytes (`MEMORY_USAGE_GB`), so this is a *display* conversion and
 * nothing more — the value is never round-tripped through bytes, which is where a
 * 1000-vs-1024 disagreement would silently enter and never leave.
 *
 * Returns the unit as a discriminant rather than a formatted string because the caller has
 * to pick a catalog key with it: a component that received "210 MB" could only concatenate.
 *
 * The unit is decided from the value AS DISPLAYED, which is a fix rather than a nicety. The
 * previous version compared the raw gigabytes against 1 and rounded afterwards, so the
 * 0.99999744 a live probe returned for a 1 GB limit chose megabytes and then rounded to
 * "1,000 MB" — a figure that is both wrong in its unit and one digit longer than the "1.0 GB"
 * it means. Rounding first and branching on the rounded integer keeps the number the decision
 * was made on and the number printed the same number.
 */
export function formatMemoryGb(
  gb: number | null,
  locale: string,
): { value: string; unit: "gb" | "mb" } | null {
  if (gb === null) return null;

  const megabytes = Math.round(gb * MB_PER_GB);
  if (megabytes < MB_PER_GB) {
    return {
      // The already-rounded integer, not `gb * MB_PER_GB` formatted again: re-rounding is
      // where the two could disagree, which is exactly the defect above.
      value: new Intl.NumberFormat(locale).format(megabytes),
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

/**
 * A volume figure, from the megabytes Railway states volumes in.
 *
 * A separate entry point rather than `formatMemoryGb(mb / 1000, locale)` at the call site,
 * because that division is exactly the kind that drifts: `MEMORY_USAGE_GB` and
 * `VolumeInstance.sizeMB` are different units on the same API, and a component doing the
 * conversion inline is a component that can do it with 1024 next time. The unit
 * discriminant comes back for the same reason it does above — the caller picks a catalog
 * key with it and cannot concatenate one.
 *
 * Not clamped to a minimum: `currentSizeMB` is genuinely 0 on a volume nothing has written
 * to yet, and "0 MB" is the true and useful reading of that.
 */
export function formatVolumeMb(
  mb: number | null,
  locale: string,
): { value: string; unit: "gb" | "mb" } | null {
  return mb === null ? null : formatMemoryGb(mb / MB_PER_GB, locale);
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
