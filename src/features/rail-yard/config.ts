/**
 * Every tuned number in the rail yard, grouped by the concern that owns it.
 *
 * The same rule src/lib/constants.ts states for the app: a timing, a ceiling or a
 * dimension goes here with a comment saying why it is what it is, never inline at the
 * one call site that happens to need it first. The sprite geometry is here for the same
 * reason — it is the shape of the scene, and the scene is data.
 */

import type { PaletteKey } from "./palette";

/** The fixed-timestep loop. */
export const SIM = {
  /**
   * 50 Hz, not 60.
   *
   * The renderer interpolates between steps, so the sim rate sets accuracy rather than
   * smoothness — a 120 Hz display is smooth either way. 20 ms costs a sixth less CPU
   * than 16.67 and divides the catch-up ceiling and the test's clock exactly, which the
   * awkward number did not.
   */
  STEP_MS: 20,
  /**
   * Spiral-of-death guard. A backgrounded tab that wakes after four seconds must not run
   * two hundred steps on the frame it wakes on — that is a visible freeze followed by
   * every train teleporting.
   */
  MAX_CATCHUP_MS: 240,
} as const;

/** The yard's own behaviour: how trains move, load and wait. */
export const YARD = {
  /**
   * Fixed, never `Date.now()`.
   *
   * Every visitor sees the same yard. That is what makes the still frame reviewable and
   * lets e2e compare two canvas snapshots for equality — seeding from the clock would
   * put wall-clock time back into a feature that is otherwise free of it. This one line
   * reverses the trade.
   */
  SEED: 0x5ea1_f00d,
  /**
   * Three trains.
   *
   * Two leaves the yard looking abandoned for the ten seconds one of them is away; four
   * queues at the bay more often than it moves. Three is also the point past which the
   * per-frame vehicle count stops being free on a phone.
   */
  TRAIN_COUNT: 3,
  /** World units per second at an edge speed of 1. A locomotive is 62 units long. */
  BASE_SPEED: 68,
  /** Units per second squared. Deliberately gentle: freight does not leap away. */
  ACCEL: 34,
  BRAKE: 58,
  /** Gap between couplings, so a rake reads as separate wagons rather than a bar. */
  WAGON_GAP: 5,
  /** One wagon coupled or uncoupled per this. Slow enough to watch happen. */
  COUPLE_MS: 900,
  /**
   * How far the simulation is run before anyone sees it.
   *
   * Step zero is three locomotives asleep in sheds, which is a picture of nothing — both
   * for a visitor arriving on the page and for the single frozen frame a reduced-motion
   * visitor gets in place of the animation. Forty-two seconds puts one train under the
   * gantry taking containers and another on the main line. Staged by running the real
   * simulation rather than by hand-placing trains into a state it would never produce;
   * at STEP_MS that is about two thousand steps, which is a few milliseconds once.
   */
  WARMUP_MS: 42_000,
  /** Added per train to the opening dwell, so the yard does not start with a convoy. */
  STAGGER_MS: 5_500,
  /** Dwell in the depot before a train is dispatched again. */
  IDLE_MS: [2_500, 11_000],
  /** Dwell off-camera. Long enough that the exit reads as somewhere else. */
  AWAY_MS: [5_000, 15_000],
  /** Retry when the entry road is occupied. Short — it is a look, not a wait. */
  BLOCKED_RETRY_MS: 900,
  /** Following distance at which a train starts braking rather than closing up. */
  HEADWAY: 34,
  /** One puff per this much *travel*, so a stationary locomotive stops smoking. */
  SMOKE_INTERVAL_UNITS: 12,
  SMOKE_LIFE_MS: 2_600,
  /** Ceiling on live puffs across the whole yard. Bounds the per-frame draw count. */
  MAX_PUFFS: 54,
  /** Rise and drift per second, world units. Wind blows the way the trains leave. */
  SMOKE_RISE: 10,
  SMOKE_DRIFT: 4,
  /** Puff radius, start and end. */
  SMOKE_RADIUS: [2.2, 7],
} as const;

/** Fitting the world to the canvas. See view.ts for how these compose. */
export const VIEW = {
  /**
   * Legibility floor and cartoon ceiling, in pixels per world unit.
   *
   * At 0.5 the 62-unit locomotive is 31 px long, which is the point below which the cab
   * and the hood stop being separable. At 1.35 a 2560 px column would otherwise render
   * a picture book.
   */
  MIN_SCALE: 0.5,
  MAX_SCALE: 1.35,
  /**
   * A Pixel 7 reports 2.625. Going past 2 triples fill cost to sharpen three-pixel
   * details nobody can resolve, and this is the one control that scales every draw call
   * at once.
   */
  MAX_DPR: 2,
  /**
   * Distance from the bottom edge to the main line, in world units.
   *
   * The scene is bottom-anchored rather than centred, so the track band always sits on
   * the bottom edge and the sky takes whatever is left. That is what keeps the yard
   * legible around the sign-in card: the card floats in the vertical middle, over sky,
   * which is the emptiest region of the picture by construction.
   */
  GROUND_INSET_UNITS: 42,
  /** Below this a drawn feature lands on its neighbour's pixel and only costs fill. */
  MIN_FEATURE_PX: 1,
  /**
   * The sign-in card's footprint, used to keep the track band clear of it.
   *
   * Not read from the DOM: measuring the card would couple the renderer to a layout it
   * must not know about, and the number only has to be right enough to decide whether to
   * pull the scale down a step.
   */
  CARD_SAFE_PX: { width: 448, height: 300 },
  /** Clearance between the card's bottom edge and the top rail before scale gives way. */
  MIN_BAND_CLEARANCE_PX: 12,
  /**
   * How far a train and a gantry reach above their own ground line, in world units.
   *
   * These bound the band the sign-in card is kept clear of. The vehicle figure is the
   * locomotive's chimney top, which is the tallest thing that runs on the rails.
   */
  VEHICLE_ALLOWANCE: 40,
  GANTRY_ALLOWANCE: 56,
  /** Samples per curved edge in the arc-length table. Straights use two regardless. */
  EDGE_SAMPLES: 24,
  /** Distant things are drawn through this much alpha. Depth without a blur. */
  SKYLINE_ALPHA: 0.55,
  FAR_STRUCTURE_ALPHA: 0.8,
  /** World y above which a structure counts as distant and is hazed. */
  HAZE_ABOVE_UNITS: 140,
  /** The contact shadow under a vehicle: half-height of the ellipse, world units. */
  SHADOW_HEIGHT: 2.2,
} as const;

/**
 * A rectangle in vehicle-local units: x forward from the rear coupling, y up from the
 * rail head. `cargo` defers to the container's own colour rather than the palette.
 */
export type Part = {
  readonly rect: readonly [x: number, y: number, w: number, h: number];
  readonly fill: PaletteKey | "cargo";
  readonly radius?: number;
};

export type WheelSet = {
  readonly at: number;
  readonly radius: number;
  readonly count: number;
  readonly pitch: number;
};

/**
 * A drawable made of rectangles, wheels and at most one chimney.
 *
 * Deliberately a closed spec rather than a drawing language. A general one would be
 * Canvas reimplemented with worse ergonomics, and it would move the renderer's test
 * claim from "it drew a locomotive" to "the spec says locomotive", which is not the same
 * assertion. But rolling stock and sheds really are all rectangles-with-wheels, so this
 * much turns four sprites into data and collapses the branch count with them.
 */
export type VehicleSpec = {
  readonly length: number;
  readonly parts: readonly Part[];
  readonly bogies: readonly WheelSet[];
  readonly chimney?: {
    readonly at: number;
    readonly width: number;
    readonly height: number;
    /** The local y it stands on, so the smoke origin is derived rather than guessed. */
    readonly base: number;
  };
};

/** A boxcab with a stack. Everything here survives MIN_SCALE; nothing smaller is drawn. */
export const LOCOMOTIVE: VehicleSpec = {
  length: 62,
  parts: [
    { rect: [0, 8, 4, 7], fill: "metal" }, // rear coupling
    { rect: [58, 8, 4, 7], fill: "metal" }, // front coupling
    { rect: [3, 7, 56, 15], fill: "loco", radius: 3 }, // running board and body
    { rect: [9, 22, 18, 9], fill: "metal", radius: 1 }, // hood
    { rect: [35, 22, 20, 14], fill: "loco", radius: 3 }, // cab
    { rect: [39, 26, 12, 7], fill: "locoTrim" }, // glass
  ],
  bogies: [
    { at: 12, radius: 5, count: 2, pitch: 12 },
    { at: 40, radius: 5, count: 2, pitch: 12 },
  ],
  // Stands on the hood, whose rect above tops out at y = 31.
  chimney: { at: 15, width: 7, height: 9, base: 31 },
} as const;

/** A flat wagon. The container sits on the deck when there is one. */
export const WAGON: VehicleSpec = {
  length: 46,
  parts: [
    { rect: [0, 8, 3, 6], fill: "metal" },
    { rect: [43, 8, 3, 6], fill: "metal" },
    { rect: [3, 8, 40, 6], fill: "metal", radius: 1 },
  ],
  bogies: [
    { at: 9, radius: 4, count: 2, pitch: 10 },
    { at: 32, radius: 4, count: 2, pitch: 10 },
  ],
} as const;

/** The box on a loaded wagon, in the same vehicle-local frame. */
export const CONTAINER = {
  rect: [4, 14, 38, 18],
  radius: 1.5,
  /** Corrugation, drawn as the body colour at reduced alpha rather than a second token. */
  ribAlpha: 0.22,
  ribWidth: 1,
  ribs: [5, 8],
  /** The door end, one shade down via the same alpha trick. */
  doorWidth: 5,
} as const;

/** A depot shed. Reuses the vehicle walker with no bogies — it is the same shape. */
export const SHED: VehicleSpec = {
  length: 1,
  parts: [
    { rect: [0, 0, 1, 0.78], fill: "structure" },
    { rect: [0, 0.78, 1, 0.22], fill: "structureTrim" },
  ],
  bogies: [],
} as const;

/** The engine-shed doorway, as a fraction of a shed's width and height. */
export const SHED_DOOR = {
  width: 0.26,
  height: 0.6,
  /** Inset of the first doorway from the shed's west end. */
  offset: 0.1,
  gap: 0.08,
} as const;

/**
 * The loading gantry that spans the bay road.
 *
 * `height` clears the tallest thing that passes under it. At 46 the beam grazed a loaded
 * container and read as a bar laid across the rake rather than as a structure over it.
 */
export const GANTRY = {
  legWidth: 4,
  height: 64,
  beamHeight: 7,
  /** The travelling hoist, parked over the middle of its span. */
  hoistWidth: 16,
  hoistDrop: 10,
} as const;

/** A signal post and its lamp. */
export const SIGNAL = {
  postWidth: 2,
  height: 26,
  lampRadius: 3,
} as const;

/** Rails, ties and ballast, per running metre of track. */
export const PERMANENT_WAY = {
  ballastHeight: 11,
  /** Two rails, drawn as lines offset either side of the centre line. */
  gauge: 6,
  railWidth: 1.2,
  tieSpacing: 9,
  tieLength: 10,
  tieWidth: 2,
  /** A siding is lighter track than the main line. */
  sidingScale: 0.82,
} as const;
