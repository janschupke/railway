import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMemoryGb, useVolumeSize } from "./use-memory-figure";

/**
 * The unit boundary, tested where the copy is attached rather than only in lib/format.
 *
 * `formatMemoryGb` returns a number and a `"gb" | "mb"` discriminant precisely so that
 * nothing under src/lib writes "MB"; these hooks are the layer that turns that pair into a
 * sentence fragment, and four call sites now render through them — the volume readout, the
 * destroy dialog, and both halves of the metrics readout's "35 MB of 1.0 GB". A branch that
 * exists once and is read four times is worth its own test.
 */
describe("useMemoryGb", () => {
  const render = () => renderHook(() => useMemoryGb()).result.current;

  it("names the unit it chose, in catalog copy", () => {
    // Real messages/en.json through the next-intl mock, not a key-echoing stub: a renamed
    // message fails here rather than rendering a missing-message marker at the user.
    expect(render()(0.035)).toBe("35 MB");
    expect(render()(3.14)).toBe("3.1 GB");
  });

  it("reads Railway's own one-gigabyte figure as a gigabyte", () => {
    /*
     * The regression, at the layer the user reads. Railway reports a 1 GB ceiling as
     * 0.99999744, which used to choose megabytes on the raw value and then round to
     * "1,000 MB" — wrong in its unit and a digit longer than the figure it means.
     */
    expect(render()(0.99999744)).toBe("1.0 GB");
    expect(render()(0.9994)).toBe("999 MB");
  });

  it("renders an em dash when there is no figure at all", () => {
    // The one thing a memory reading and a ceiling share with every other readout: absent is
    // not zero, and the placeholder comes from the catalog rather than from src/lib.
    expect(render()(null)).toBe("—");
  });

  it("renders a real zero as a zero", () => {
    // A running container using nothing is a fact. Distinct from the dash above, which is
    // Railway having said nothing.
    expect(render()(0)).toBe("0 MB");
  });
});

describe("useVolumeSize", () => {
  const render = () => renderHook(() => useVolumeSize()).result.current;

  it("reads megabytes, the unit Railway states volumes in", () => {
    // Two units on one API — MEMORY_USAGE_GB and VolumeInstance.sizeMB — which is why the
    // division lives in formatVolumeMb rather than at any call site.
    expect(render()(500)).toBe("500 MB");
    expect(render()(5000)).toBe("5.0 GB");
  });

  it("crosses to gigabytes at Railway's default volume size", () => {
    expect(render()(1000)).toBe("1.0 GB");
  });
});
