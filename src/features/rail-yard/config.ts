/**
 * Every tuned number in the rail yard, grouped by the concern that owns it.
 *
 * The same rule src/lib/constants.ts states for the app: a timing, a ceiling or a
 * dimension goes here with a comment saying why it is what it is, never inline at the one
 * call site that happens to need it first. The sprite geometry is here for the same
 * reason — it is the shape of the scene, and the scene is data.
 */

import type { PaletteKey } from "./palette";

/** The fixed-timestep loop. */
export const SIM = {
  /**
   * 50 Hz, not 60.
   *
   * The renderer interpolates between steps, so the sim rate sets accuracy rather than
   * smoothness — a 120 Hz display is smooth either way. 20 ms costs a sixth less CPU than
   * 16.67 and divides the catch-up ceiling and the test's clock exactly, which the awkward
   * number did not.
   */
  STEP_MS: 20,
  /**
   * Spiral-of-death guard. A backgrounded tab that wakes after four seconds must not run
   * two hundred steps on the frame it wakes on — that is a visible freeze followed by
   * every train teleporting.
   */
  MAX_CATCHUP_MS: 240,
} as const;

/** The yard's own behaviour: how trains move, wait and signal. */
export const YARD = {
  /**
   * Fixed, never `Date.now()`.
   *
   * Every visitor sees the same yard. That is what makes the still frame reviewable and
   * lets e2e compare two canvas snapshots for equality — seeding from the clock would put
   * wall-clock time back into a feature that is otherwise free of it.
   */
  SEED: 0x5ea1_f00d,
  /**
   * Five yard trains, plus one express per express road.
   *
   * Three left the scene empty a sixth of the time: a train spends most of its cycle off
   * camera, on the hidden return or down the west throat, and three of them can all be
   * somewhere else at once. Five is what makes the frame never empty rather than usually
   * occupied, and the belt speeding the crane up is what stopped the extra two simply
   * queueing. Two and it looks abandoned; past five the per-frame vehicle count stops
   * being free on a phone.
   */
  TRAIN_COUNT: 5,
  /** Wagons per train. Fixed for the life of the world — the crane is what changes. */
  RAKE_SIZE: [3, 5],
  /** World units per second at an edge speed of 1. A locomotive is 62 units long. */
  BASE_SPEED: 74,
  /**
   * Units per second squared.
   *
   * Freight still does not leap away, but the old 30 was the dominant term in how long the
   * frame stayed empty rather than a look: an express reaching line speed took eight
   * seconds and nine hundred units, all of it out of sight, so the gap it was dispatched
   * to fill had grown by the time it arrived. Braking is stronger than accelerating, as it
   * is on anything with wheels.
   */
  ACCEL: 50,
  BRAKE: 75,
  /** Gap between couplings, so a rake reads as separate wagons rather than a bar. */
  WAGON_GAP: 5,
  /**
   * How far the simulation is run before anyone sees it.
   *
   * Step zero is five locomotives asleep in a shed, which is a picture of nothing — both
   * for a visitor arriving on the page and for the single frozen frame a reduced-motion
   * visitor gets in place of the animation.
   *
   * This lands on two yard trains working east under the gantry with the westbound express
   * crossing the frame behind them, which is the opening frame simulation.test.ts asserts. It
   * was found by probing rather than chosen: the warm-up runs the real simulation, so the
   * frame is one the rules actually produce, and retuning them cannot quietly leave the
   * page opening on a still yard.
   */
  WARMUP_MS: 100_000,
  /** Added per train to the opening dwell, so the yard does not start with a convoy. */
  STAGGER_MS: 7_000,
  /**
   * Dwell in the shed, and on the hidden return road.
   *
   * Both came down, and the second one hard. Dwelling in a shed is a train standing where
   * a visitor can see it; dwelling on the return is a train standing where nobody can, and
   * a yard that has half its stock waiting somewhere invisible is the yard that looked
   * empty. The expresses cover what is left; these make there be less of it.
   */
  IDLE_MS: [1_500, 5_000],
  AWAY_MS: [400, 2_500],
  /** Retry when the road ahead is occupied. Short — it is a look, not a wait. */
  BLOCKED_RETRY_MS: 900,
  /**
   * How long an express stands on its hidden road between runs.
   *
   * A timer of its own rather than a place in the yard's queue. The expresses exist to
   * cover the gaps the shunting leaves — a working that had to wait its turn for the crane
   * could not do that, and one on a fixed interval would read as a metronome.
   */
  EXPRESS_GAP_MS: [3_000, 12_000],
  /**
   * The most of that wait left once the frame has one moving train in it or none.
   *
   * A ceiling applied every step rather than a multiplier applied at the draw, because a
   * gap chosen during a busy minute outlives the minute — it was twenty-one seconds once,
   * and the yard fell quiet eight seconds in.
   */
  EXPRESS_URGENT_MS: 800,
  /** Offset between the two expresses' first runs, so they do not open in convoy. */
  EXPRESS_STAGGER_MS: 6_000,
  /**
   * The longest every train in the frame may be standing at once.
   *
   * The property that actually matters is stronger and has no constant: **the frame is
   * never empty**, which simulation.test.ts asserts over ten simulated minutes with no
   * allowance at all. This is the weaker second bound — how long the yard may be at a
   * standstill *with* trains in it, which is a queue at the crane rather than a dead scene,
   * and where the crane and the belt are both still working.
   *
   * Both are asserted as properties rather than as the constants behind them. Pinning the
   * dwells and the speeds instead would let a retune quietly produce the empty yard they
   * were chosen to prevent, which is exactly how it got one.
   */
  MAX_STILL_MS: 12_000,
  /**
   * Following distance, world units, measured coupling to coupling.
   *
   * This is the number that makes traffic look like traffic. The previous model could not
   * express a gap smaller than a whole edge, so a follower on the 230-unit loading road
   * stopped 230 units back and the two trains never appeared to be aware of each other.
   */
  HEADWAY: 40,
  /**
   * How far short of a contested junction a train has to stop, world units.
   *
   * The **fouling point**, which is the thing a real signal protects — not the frog. A
   * crossover is a curve with horizontal tangents at both ends, so for the last third of it
   * the diverging road runs *alongside* the road it is joining, a few units off it. Two
   * trains a headway apart at that point are two trains occupying the same piece of ground:
   * stopping the yielding one forty units short of the node left it drawn through the train
   * it had given way to.
   *
   * Derived from the geometry rather than guessed. Depth across a crossover follows
   * `3t^2 - 2t^3`, so the separation `e` of the way from the end is about `3 e^2` of a road
   * pitch — a wagon's width of clearance needs a little over four tenths of the run, and the
   * run is `CROSSOVER_RUN`.
   */
  FOULING_MARGIN: 180,
  /**
   * The floor on how far ahead a train claims the junctions on its route.
   *
   * Watching where the other trains *are* is not enough at a converging junction: two of
   * them a unit short of the same node both see it empty on the same step and both take it.
   * Claiming a node before reaching it turns that race into an interlock, and the tie is
   * broken by whichever train is nearer — a pure function of the same snapshot both trains
   * read, so they cannot disagree about who goes first.
   *
   * A floor rather than the whole rule: see `claimReach` in traffic.ts, which adds the
   * distance the train would need to stop.
   */
  JUNCTION_LOOKAHEAD: 130,
  /** One puff per this much *travel*, so a stationary locomotive stops smoking. */
  SMOKE_INTERVAL_UNITS: 11,
  SMOKE_LIFE_MS: 2_800,
  /** Ceiling on live puffs across the whole yard. Bounds the per-frame draw count. */
  MAX_PUFFS: 54,
  /** Rise in **z** and trail along the track, per second, world units. */
  SMOKE_RISE: 13,
  SMOKE_TRAIL: 6,
  /** Puff radius, start and end. */
  SMOKE_RADIUS: [2.4, 8],
} as const;

/**
 * The travelling gantry crane.
 *
 * Three degrees of freedom, all of them visible: the portal runs along the loading roads
 * in x, the trolley runs across the beam in y between the container stack and the wagon,
 * and the hoist runs in z. Every speed here is world units per second, so the timings the
 * eye sees are derived rather than authored.
 */
export const CRANE = {
  /*
   * Quicker than it was, because it is the yard's bottleneck and the bottleneck was
   * visible: one crane serving a rake at five seconds a container left the trains behind it
   * standing on the loading road for half a minute. The belt is what makes this affordable
   * — the freight is always at the head slot, so the cycle is travel and nothing else.
   */
  PORTAL_SPEED: 210,
  TROLLEY_SPEED: 160,
  HOIST_SPEED: 100,
  /** Time for the spreader to lock on or let go. Short, but not instant. */
  LATCH_MS: 250,
  /**
   * Height a box is carried at, measured to its **underside** — the same convention
   * `CraneState.hoistZ` uses everywhere else.
   *
   * Bounded from both ends. It has to clear the tallest thing the portal travels over,
   * which is a loaded wagon at 26. And the spreader hangs a container's height above it, so
   * the whole assembly must stay under the trolley the rope comes off at 78.
   *
   * It used to be 70, because the portal also had to clear a three-high pile of containers
   * on its way to the pile. Putting the freight on a belt at ground level is what let it
   * come down: the yard's buffer no longer has a height for the machine over it to be
   * bounded by.
   */
  TRAVEL_Z: 36,
} as const;

/**
 * The belt the yard's freight arrives on and leaves by. See conveyor.ts for the behaviour.
 *
 * Where it stands is scene data — one head, one tail, one depth, authored in scene.ts like
 * every other structure. What is here is only how it behaves.
 */
export const CONVEYOR = {
  /**
   * Centre to centre along the belt. A container is 38 long, so this leaves 8 between two
   * of them: enough to read as separate boxes on a moving belt rather than as one bar.
   */
  PITCH: 46,
  /**
   * The belt's own top surface, which is the underside of a box standing on it.
   *
   * Tall enough to read. At four it was a two-pixel line the containers hid entirely, and a
   * belt nobody can see is a row of boxes standing on the ground — which is the pile it
   * replaced.
   */
  DECK_Z: 8,
  /** Across the belt. Wider than a container so the box sits on it rather than over it. */
  WIDTH: 25,
  /**
   * World units per second.
   *
   * Deliberately quicker than the crane's cycle: the head slot has to be refilled before
   * the crane comes back for it, which is the whole of "the belt always has containers".
   * A full pitch takes 0.74 s against the two seconds the crane spends crossing the yard.
   */
  SPEED: 62,
  /** How near a slot counts as settled in it, world units. */
  SETTLE: 0.5,
  /**
   * Boxes on the belt when the world is made.
   *
   * The warm-up runs the real simulation, so this only has to be enough that the first
   * train to load does not stand waiting for the belt to fill from the tail.
   */
  FLOOR: 5,
} as const;

/** Fitting the world to the canvas. See view.ts for how these compose. */
export const VIEW = {
  /**
   * Depth foreshortening: how much of a world unit of *depth* survives on screen.
   *
   * This is the whole projection in one number. At 1 the camera looks straight down and
   * every solid flattens into its own roof; at 0 it lies on the ground and the yard
   * becomes the side elevation this replaced, where a road further back read as a ramp
   * climbing a hill. 0.55 is where a locomotive still shows a roof and two sides while
   * five parallel roads stay separable at phone width. Height is *not* foreshortened —
   * that asymmetry is what makes a box look like a box.
   */
  TILT: 0.55,
  /**
   * How far a world unit of depth carries the eye to the *right*.
   *
   * Without it the camera sits square in front of the yard and depth runs straight up the
   * screen — which is fine for a wagon, and degenerate for anything long that spans depth:
   * the gantry beam projected onto its own legs and the whole portal read as a lamppost.
   * Shearing depth sideways is what turns a plan with heights into a view from a corner,
   * and it is the other half of what "at an angle" has to mean.
   *
   * With TILT, a unit of depth lands at (0.42, -0.55) — about 53 degrees, which is the
   * angle a three-quarter view is normally drawn at. Larger and the parallel roads stagger
   * so far that the yard shears off the side of the frame.
   */
  SHEAR: 0.42,
  /**
   * Legibility floor and cartoon ceiling, in pixels per world unit along x.
   *
   * At 0.5 the 62-unit locomotive is 31 px long, which is the point below which the cab
   * and the hood stop being separable. At 1.35 a 2560 px column would render a picture
   * book.
   */
  MIN_SCALE: 0.5,
  MAX_SCALE: 1.35,
  /**
   * A Pixel 7 reports 2.625. Going past 2 triples fill cost to sharpen three-pixel details
   * nobody can resolve, and this is the one control that scales every draw call at once.
   */
  MAX_DPR: 2,
  /**
   * Apron in front of the nearest road, in projected units, so the yard has a foreground
   * rather than being cut off at the sleeper ends of the first track.
   */
  GROUND_INSET_UNITS: 40,
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
  /**
   * How far the card sits above centre, in CSS pixels.
   *
   * Must track the bottom padding on the `stage` recipe in components/ui/page.tsx — a
   * centred flex item moves up by half the padding below it. Change one without the other
   * and the clearance rule quietly protects a band the card is no longer in.
   */
  CARD_LIFT_PX: 64,
  /** Clearance between the card's bottom edge and the furthest rail before scale gives. */
  MIN_BAND_CLEARANCE_PX: 12,
  /**
   * How far rolling stock and a gantry reach above their own rail head, world units.
   *
   * These bound the band the sign-in card is kept clear of. The vehicle figure is the
   * locomotive's chimney top, which is the tallest thing that runs on the rails.
   */
  VEHICLE_ALLOWANCE: 36,
  GANTRY_ALLOWANCE: 100,
  /** Samples per crossover in the arc-length table. A run uses two regardless. */
  EDGE_SAMPLES: 24,
  /** Anything whose footprint is this far outside the canvas is not drawn at all. */
  CULL_MARGIN_PX: 220,
  /** Distant things are drawn through this much alpha. Depth without a blur. */
  SKYLINE_ALPHA: 0.5,
  FAR_STRUCTURE_ALPHA: 0.8,
  /** World y past which a structure counts as distant and is hazed. */
  HAZE_BEYOND_UNITS: 300,
  /** The contact shadow under a vehicle: how far it reaches past the body, world units. */
  SHADOW_SPREAD: 3,
} as const;

/**
 * A box in vehicle-local units: **x forward** from the rear coupling, **y to the left**,
 * **z up** from the rail head. `cargo` defers to a container's own colour.
 *
 * Deliberately a closed spec rather than a drawing language. A general one would be Canvas
 * reimplemented with worse ergonomics, and it would move the renderer's test claim from
 * "it drew a locomotive" to "the spec says locomotive". But rolling stock, sheds, gantry
 * legs and signal posts really are all boxes, so this much turns every solid in the scene
 * into data and collapses the branch count with them.
 *
 * A box rather than a rectangle is also what makes the mirroring defect unexpressible: the
 * corners are rotated into *world* space and projected, so there is no local coordinate
 * system left to flip. The version this replaces rotated the canvas by the heading, which
 * turned every westbound locomotive upside down.
 */
export type Box = {
  readonly at: readonly [x: number, y: number, z: number];
  readonly size: readonly [length: number, width: number, height: number];
  readonly fill: PaletteKey | "cargo";
};

export type VehicleSpec = {
  readonly length: number;
  readonly width: number;
  readonly boxes: readonly Box[];
  readonly chimney?: {
    /** Local x of the stack's centre, and the local z its top reaches. */
    readonly at: number;
    readonly top: number;
  };
};

/**
 * A boxcab. The hood and its stack lead; the cab is at the back.
 *
 * The stack was at local x 15 of 62 in the first version, which put it behind the cab in
 * the direction of travel — a locomotive running backwards with its exhaust trailing off
 * the wrong end. It is at 46 now.
 */
export const LOCOMOTIVE: VehicleSpec = {
  length: 62,
  width: 22,
  boxes: [
    { at: [6, -9, 0], size: [16, 18, 3], fill: "metal" }, // rear bogie
    { at: [40, -9, 0], size: [16, 18, 3], fill: "metal" }, // front bogie
    { at: [0, -3, 4], size: [3, 6, 4], fill: "metal" }, // rear coupling
    { at: [59, -3, 4], size: [3, 6, 4], fill: "metal" }, // front coupling
    { at: [0, -11, 3], size: [62, 22, 4], fill: "metal" }, // frame
    { at: [2, -10, 7], size: [58, 20, 11], fill: "loco" }, // body
    { at: [8, -10, 18], size: [20, 20, 13], fill: "loco" }, // cab
    { at: [9, -10, 22], size: [18, 20, 6], fill: "locoTrim" }, // glazing band
    { at: [34, -8, 18], size: [24, 16, 9], fill: "loco" }, // hood
    { at: [43, -3, 27], size: [6, 6, 8], fill: "metal" }, // stack
  ],
  chimney: { at: 46, top: 35 },
} as const;

/** A flat wagon. A container sits on the deck when the crane has put one there. */
export const WAGON: VehicleSpec = {
  length: 46,
  width: 20,
  boxes: [
    { at: [5, -8, 0], size: [13, 16, 3], fill: "metal" },
    { at: [28, -8, 0], size: [13, 16, 3], fill: "metal" },
    { at: [0, -3, 4], size: [3, 6, 4], fill: "metal" },
    { at: [43, -3, 4], size: [3, 6, 4], fill: "metal" },
    { at: [0, -10, 3], size: [46, 20, 4], fill: "metal" },
    { at: [2, -9, 7], size: [42, 18, 3], fill: "structureTrim" }, // deck
  ],
} as const;

/**
 * The box on a loaded wagon, in the same vehicle-local frame.
 *
 * `deck` is where the crane must lower a spreader to, so the height the hoist stops at is
 * derived from the wagon rather than authored twice.
 */
export const CONTAINER = {
  at: [4, -8.5, 10],
  size: [38, 17, 16],
  deck: 10,
  /** Corrugation, drawn as the trim colour at reduced alpha rather than a second token. */
  ribAlpha: 0.24,
  ribWidth: 1,
  ribs: [5, 8],
} as const;

/**
 * A through engine shed. The depot road runs in one end and out the other.
 *
 * Split in the renderer rather than here: the back wall and roof go into the static layer
 * and the front wall enters the depth sort, so a locomotive standing inside is genuinely
 * occluded by the building instead of being painted on top of it.
 */
export const SHED = {
  wallThickness: 4,
  /** Height the doorways reach; the lintel is everything above it. */
  doorHeight: 40,
  /** Width of a pier between two doorways, world units. */
  pierWidth: 12,
  roofThickness: 5,
  /** How far the roof oversails the walls, world units. */
  eaves: 4,
} as const;

/**
 * The travelling gantry that straddles both loading roads.
 *
 * `height` clears the tallest thing that passes under it, which is a loaded wagon at 26
 * plus the spreader. At 46 the beam grazed a container and read as a bar laid across the
 * rake rather than as a structure over it.
 */
export const GANTRY = {
  legWidth: 12,
  legDepth: 12,
  /** The box girder, along the track. Wide enough to read as a beam, not as a wire. */
  beamWidth: 16,
  height: 86,
  beamHeight: 10,
  trolleyLength: 20,
  trolleyDepth: 22,
  trolleyHeight: 8,
  /** The spreader on the end of the hoist rope. */
  spreaderLength: 40,
  spreaderDepth: 18,
  spreaderHeight: 3,
  ropeWidth: 1.4,
} as const;

/** A signal post and its lamp. */
export const SIGNAL = {
  postWidth: 3,
  postDepth: 3,
  height: 30,
  lampRadius: 3.4,
} as const;

/**
 * Rails, ties and ballast — all of it now lying in the ground plane rather than standing
 * up in an elevation, which is what lets a road and the crossover leaving it share a
 * tangent and therefore join without a seam.
 */
export const TRACK = {
  /** Distance between adjacent roads, world units. The scene's one spacing constant. */
  ROAD_PITCH: 46,
  /** Width of the ballast shoulder, across the track. */
  ballastWidth: 30,
  /** Rail centres, across the track. */
  gauge: 9,
  railWidth: 1.7,
  tieSpacing: 9,
  tieLength: 17,
  tieWidth: 2.6,
  /** A siding is lighter track than the main line. */
  sidingScale: 0.85,
  /**
   * How long a switch blade is drawn at a crossover's foot, and how long the vee of a
   * diamond is. Cosmetic, but their absence was most of why the junctions read as two
   * pieces of track meeting rather than as one piece of railway.
   */
  bladeLength: 26,
  frogLength: 20,
} as const;
