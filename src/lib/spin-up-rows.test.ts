import { describe, expect, it } from "vitest";

import { DEFAULT_IMAGE, httpPortFor, presetVariableDefaults } from "./presets";
import { portFor, reattachProvenance, reseed, seedRows } from "./spin-up-rows";

/** A preset image whose catalog entry seeds at least one variable. */
const SEEDED = "postgres:16-alpine";
/** An image the catalog has never heard of, so it seeds nothing. */
const UNKNOWN = "example.com/nobody/nothing:1";

const user = (id: string, name: string, value: string) => ({
  id,
  name,
  value,
  origin: "user" as const,
  touched: false,
});

describe("seedRows", () => {
  it("locks the catalog's rows and marks them untouched", () => {
    const rows = seedRows(SEEDED);
    expect(rows.length).toBe(presetVariableDefaults(SEEDED).length);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.origin).toBe("preset");
      expect(row.locked).toBe(true);
      expect(row.touched).toBe(false);
    }
  });

  it("gives a row an id derived from its name, so a reseed does not move focus", () => {
    expect(seedRows(SEEDED).map((row) => row.id)).toEqual(
      seedRows(SEEDED).map((row) => row.id),
    );
  });

  it("marks a generated credential as blank-means-generated rather than inventing a value", () => {
    // The whole point of the catalog's generated entries: the browser never holds the value.
    const generated = seedRows(SEEDED).filter((row) => row.blankMeans === "generated");
    expect(generated.length).toBeGreaterThan(0);
    for (const row of generated) expect(row.value).toBe("");
  });

  it("seeds nothing for an image the catalog does not know", () => {
    expect(seedRows(UNKNOWN)).toEqual([]);
  });
});

describe("reseed", () => {
  it("replaces an untouched preset row", () => {
    const before = seedRows(SEEDED);
    const after = reseed(before, UNKNOWN);
    expect(after).toEqual([]);
  });

  it("keeps a user row, and unlocks a touched preset row", () => {
    /*
     * The one rule: nothing a person typed is thrown away by changing the image. A touched
     * preset row survives and stops being locked, because the catalog that owned its name
     * is gone.
     */
    const touched = { ...seedRows(SEEDED)[0]!, touched: true };
    const mine = user("u1", "MY_VAR", "value");

    const after = reseed([touched, mine], UNKNOWN);
    expect(after.map((row) => row.name)).toEqual([touched.name, "MY_VAR"]);
    expect(after.every((row) => row.locked === false)).toBe(true);
  });

  it("lets a user row win a name collision, and does not seed the default over it", () => {
    // Which is what keeps the editor's duplicate rule from firing on something the app
    // itself created.
    const seeded = seedRows(SEEDED);
    const clash = { ...user("u1", seeded[0]!.name, "mine"), touched: true };

    const after = reseed([clash], SEEDED);
    const named = after.filter((row) => row.name === clash.name);
    expect(named).toHaveLength(1);
    expect(named[0]!.value).toBe("mine");
  });

  it("puts the new catalog rows in front of what was kept", () => {
    const mine = { ...user("u1", "MY_VAR", "value"), touched: true };
    const after = reseed([mine], SEEDED);
    expect(after[after.length - 1]!.name).toBe("MY_VAR");
    expect(after.length).toBeGreaterThan(1);
  });
});

describe("reattachProvenance", () => {
  it("calls a row the editor invented a user row", () => {
    const [row] = reattachProvenance([{ id: "new", name: "A", value: "b" }], []);
    expect(row!.origin).toBe("user");
    expect(row!.touched).toBe(true);
  });

  it("marks a preset row touched once either cell changes", () => {
    const seeded = seedRows(SEEDED);
    const first = seeded[0]!;

    const unchanged = reattachProvenance(
      [{ id: first.id, name: first.name, value: first.value }],
      seeded,
    );
    expect(unchanged[0]!.touched).toBe(false);
    expect(unchanged[0]!.origin).toBe("preset");

    const edited = reattachProvenance(
      [{ id: first.id, name: first.name, value: "typed" }],
      seeded,
    );
    expect(edited[0]!.touched).toBe(true);
    expect(edited[0]!.origin).toBe("preset");
  });

  it("keeps a row touched once it has been touched", () => {
    const seeded = seedRows(SEEDED);
    const was = [{ ...seeded[0]!, touched: true }];
    const again = reattachProvenance(
      [{ id: was[0]!.id, name: was[0]!.name, value: was[0]!.value }],
      was,
    );
    expect(again[0]!.touched).toBe(true);
  });
});

describe("portFor", () => {
  it("offers the catalog's port for an image that serves one", () => {
    expect(portFor("nginx:alpine")).toBe(String(httpPortFor("nginx:alpine")));
  });

  it("is blank for an image the catalog knows serves nothing, and for one it does not know", () => {
    // The same empty field on purpose: in both cases the app has no port to offer.
    expect(portFor(SEEDED)).toBe("");
    expect(portFor(UNKNOWN)).toBe("");
  });

  it("agrees with the default image the form opens on", () => {
    expect(portFor(DEFAULT_IMAGE)).toBe(
      httpPortFor(DEFAULT_IMAGE) === undefined
        ? ""
        : String(httpPortFor(DEFAULT_IMAGE)),
    );
  });
});
