/**
 * Pure deterministic puzzle simulation engine for Orbital Watch (Logic-First Edition).
 *
 * Units & Arithmetic:
 * - 1 full orbit = 360 u (1 u = 1° of orbital arc)
 * - Grid = 18 longitude columns × 8 latitude rows (20° × 20° per cell)
 * - Nominal satellite speed v = 10.0 u/s -> Period T = 360 / 10.0 = 36.0 s
 * - Target victory duration = 10.0 periods = 360.0 s collision-free
 * - Speed changes apply strictly over a placed zone's exact arc length L:
 *     v_mod = v * (1 + effectPct)
 *     t_zone = L / v_mod
 *     Δt = (L / v_mod) - (L / v)
 *   Upon exiting arc length L, satellite speed reverts cleanly to baseSpeed v.
 *
 * Mirrored identically inside /index.html so the single-file CDN build works standalone.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EARTH_RADIUS_KM = 6371;
export const EARTH_VISUAL_RADIUS = 5.0;
export const KM_PER_UNIT = EARTH_RADIUS_KM / EARTH_VISUAL_RADIUS;

export const ORBIT_ARC_UNITS = 360.0;
export const TARGET_PERIODS = 10.0;
export const COLLISION_RADIUS_KM = 230; // ~0.181 visual units (hull-to-hull orbital conjunction)

export const GRID_COLS = 18; // 20° per column (-180..+180)
export const GRID_ROWS = 8;  // 20° per row (-80..+80)
export const CELL_DEG = 20;
export const GRID_LAT_MIN = -80;
export const GRID_LAT_MAX = 80;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ZoneTemplate {
  typeId: 'atmo-drag' | 'mass-belt' | 'gravity-tide' | 'rad-belt';
  name: string;
  shortName: string;
  mapCode: 'A.D' | 'M.B' | 'G.T' | 'R.B';
  color: string;
  lengthUnits: number; // Exact active orbital arc length L
  defaultEffectPct: number;
  allowSignFlip: boolean; // True for ±1% Radiation Belt and ±1.5% Gravity Tide
  maxCount: number; // Limited inventory count per level
}

export const ZONE_TEMPLATES: ZoneTemplate[] = [
  {
    typeId: 'atmo-drag',
    name: 'Atmospheric Drag',
    shortName: 'Atmo Drag',
    mapCode: 'A.D',
    color: '#f43f5e',
    lengthUnits: 60,
    defaultEffectPct: -0.03,
    allowSignFlip: false,
    maxCount: 1,
  },
  {
    typeId: 'mass-belt',
    name: 'Mass Belt',
    shortName: 'Mass Belt',
    mapCode: 'M.B',
    color: '#f59e0b',
    lengthUnits: 60,
    defaultEffectPct: 0.02,
    allowSignFlip: false,
    maxCount: 1,
  },
  {
    typeId: 'gravity-tide',
    name: 'Gravity Tide',
    shortName: 'Gravity Tide',
    mapCode: 'G.T',
    color: '#14b8a6',
    lengthUnits: 60,
    defaultEffectPct: -0.015,
    allowSignFlip: true,
    maxCount: 1,
  },
  {
    typeId: 'rad-belt',
    name: 'Radiation Belt',
    shortName: 'Radiation Belt',
    mapCode: 'R.B',
    color: '#a855f7',
    lengthUnits: 40,
    defaultEffectPct: 0.01,
    allowSignFlip: true,
    maxCount: 1,
  },
];

export interface PlacedZone {
  id: string;
  typeId: ZoneTemplate['typeId'];
  name: string;
  shortName: string;
  mapCode: ZoneTemplate['mapCode'];
  color: string;
  row: number;         // 0..7
  col: number;         // 0..17
  lengthUnits: number; // Exact active arc length L in orbital units
  effectPct: number;   // Fixed modifier while inside L (e.g. -0.03, +0.02, ±0.015, ±0.01)
  latMin: number;
  latMax: number;
  lonStart: number;
  lonEnd: number;
}

export interface SatZoneTransit {
  active: boolean;
  wasInsideCell: boolean;
  arcRemainingUnits: number;
  passesCompleted: number;
}

export interface PuzzleSatConfig {
  id: string;
  code: string;
  name: string;
  color: string;
  altitudeKm: number;
  inclinationDeg: number;
  raanDeg: number;
  initialPhaseDeg: number;
  baseSpeed: number; // u/s (e.g., 10.0 u/s -> T = 36.0 s)
}

export interface PuzzleSatState extends PuzzleSatConfig {
  periodSec: number;
  phaseDeg: number; // 0..360
  speed: number;    // current u/s (baseSpeed outside zones, modified strictly inside L)
  latDeg: number;
  lonDeg: number;
  positionKm: Vec3;
  velocityKmPerSec: Vec3;
  activeZoneLabel: string;
  activeZoneColor: string | null;
  transits: Record<string, SatZoneTransit>;
}

export interface LevelConfig {
  level: number;
  title: string;
  subtitle?: string;
  collisionPairIds: [string, string];
  pursuitPairIds?: [string, string];
  collisionNodeLabel: string;
  collisionNodeLatLon: { lat: number; lon: number };
  predictedCollisionSec: number;
  satellites: PuzzleSatConfig[];
}

/**
 * Level 1: 5 satellites total (UNCHANGED).
 * SAT-1 (phase 240°, v=10.0 u/s, T=36.0s) and SAT-2 (phase 60°, v=10.0 u/s, T=36.0s)
 * both reach Node X (0°N, 30°W) after exactly 120 u -> t_collision = 12.00 s (Period 0.33).
 *
 * Level 2: Periodic Synchronization / Pendulum Convergence (LCM Puzzle).
 * SAT-1 (T1 = 36.0s, v = 10.0 u/s) and SAT-2 (T2 = 30.0s, v = 12.0 u/s) have different orbital periods.
 * They miss at Pass 1 (12s vs 24s) and Pass 2 (48s vs 54s), then synchronize at Node Y (0°N, 20°W)
 * at t = 84.0s and repeat every LCM(36, 30) = 180s (t = 264.0s).
 *
 * Level 3: Tortoise and Achilles / Zeno Pursuit + 5 Perpendicular Cross-Traffic (7 satellites total).
 * SAT-1 (Tortoise, v = 10.0 u/s, inc = 1.5°) leads SAT-2 (Achilles, v = 12.5 u/s, inc = 6.5°) along
 * the equatorial pursuit corridor; Achilles repeatedly closes in (~580 km) and pulls away while both
 * cross 5 perpendicular polar satellites (SAT-3..SAT-7, inc = 90°). Sequential/graduated perturbation
 * zones along the grid are required (0 single-zone solutions exist).
 */
export const LEVEL_CONFIGS: Record<number, LevelConfig> = {
  1: {
    level: 1,
    title: 'Level 1',
    subtitle: 'Direct Conjunction',
    collisionPairIds: ['sat-1', 'sat-2'],
    collisionNodeLabel: 'Node X (0°N, 30°W)',
    collisionNodeLatLon: { lat: 0, lon: -30 },
    predictedCollisionSec: 12.0,
    satellites: [
      { id: 'sat-1', code: 'SAT-1', name: 'Aegis',    color: '#38bdf8', altitudeKm: 540,  inclinationDeg: 46, raanDeg: -30, initialPhaseDeg: 240, baseSpeed: 10.0 },
      { id: 'sat-2', code: 'SAT-2', name: 'Helios',   color: '#f59e0b', altitudeKm: 540,  inclinationDeg: 46, raanDeg: 150, initialPhaseDeg: 60,  baseSpeed: 10.0 },
      { id: 'sat-3', code: 'SAT-3', name: 'Polaris',  color: '#a78bfa', altitudeKm: 820,  inclinationDeg: 18, raanDeg: 20,  initialPhaseDeg: 140, baseSpeed: 10.0 },
      { id: 'sat-4', code: 'SAT-4', name: 'Vanguard', color: '#34d399', altitudeKm: 1100, inclinationDeg: 74, raanDeg: 85,  initialPhaseDeg: 25,  baseSpeed: 10.0 },
      { id: 'sat-5', code: 'SAT-5', name: 'Meridian', color: '#fb7185', altitudeKm: 1380, inclinationDeg: 62, raanDeg: -55, initialPhaseDeg: 215, baseSpeed: 10.0 },
    ],
  },
  2: {
    level: 2,
    title: 'Level 2',
    subtitle: 'Pendulum LCM Convergence',
    collisionPairIds: ['sat-1', 'sat-2'],
    collisionNodeLabel: 'Node Y (0°N, 20°W)',
    collisionNodeLatLon: { lat: 0, lon: -20 },
    predictedCollisionSec: 84.0,
    satellites: [
      { id: 'sat-1', code: 'SAT-1', name: 'Aegis',    color: '#38bdf8', altitudeKm: 540,  inclinationDeg: 46, raanDeg: -20,  initialPhaseDeg: 240, baseSpeed: 10.0 },
      { id: 'sat-2', code: 'SAT-2', name: 'Helios',   color: '#f59e0b', altitudeKm: 540,  inclinationDeg: 46, raanDeg: 160,  initialPhaseDeg: 252, baseSpeed: 12.0 },
      { id: 'sat-3', code: 'SAT-3', name: 'Polaris',  color: '#a78bfa', altitudeKm: 900,  inclinationDeg: 24, raanDeg: 55,   initialPhaseDeg: 40,  baseSpeed: 10.0 },
      { id: 'sat-4', code: 'SAT-4', name: 'Vanguard', color: '#34d399', altitudeKm: 1180, inclinationDeg: 74, raanDeg: -95,  initialPhaseDeg: 185, baseSpeed: 10.0 },
      { id: 'sat-5', code: 'SAT-5', name: 'Meridian', color: '#fb7185', altitudeKm: 1460, inclinationDeg: 32, raanDeg: 120,  initialPhaseDeg: 300, baseSpeed: 10.0 },
    ],
  },
  3: {
    level: 3,
    title: 'Level 3',
    subtitle: 'Zeno Pursuit & Cross-Traffic',
    collisionPairIds: ['sat-1', 'sat-7'],
    pursuitPairIds: ['sat-1', 'sat-2'],
    collisionNodeLabel: 'Node Z (0°N, 0°)',
    collisionNodeLatLon: { lat: 0, lon: 0 },
    predictedCollisionSec: 15.85,
    satellites: [
      { id: 'sat-1', code: 'SAT-1', name: 'Tortoise', color: '#38bdf8', altitudeKm: 540, inclinationDeg: 1.5, raanDeg: 0,    initialPhaseDeg: 200, baseSpeed: 10.0 },
      { id: 'sat-2', code: 'SAT-2', name: 'Achilles', color: '#f59e0b', altitudeKm: 540, inclinationDeg: 6.5, raanDeg: 0,    initialPhaseDeg: 140, baseSpeed: 12.5 },
      { id: 'sat-3', code: 'SAT-3', name: 'Cross-1',  color: '#a78bfa', altitudeKm: 540, inclinationDeg: 90,  raanDeg: -144, initialPhaseDeg: 57,  baseSpeed: 10.0 },
      { id: 'sat-4', code: 'SAT-4', name: 'Cross-2',  color: '#34d399', altitudeKm: 540, inclinationDeg: 90,  raanDeg: -108, initialPhaseDeg: 93,  baseSpeed: 10.0 },
      { id: 'sat-5', code: 'SAT-5', name: 'Cross-3',  color: '#fb7185', altitudeKm: 540, inclinationDeg: 90,  raanDeg: -72,  initialPhaseDeg: 129, baseSpeed: 10.0 },
      { id: 'sat-6', code: 'SAT-6', name: 'Cross-4',  color: '#22d3ee', altitudeKm: 540, inclinationDeg: 90,  raanDeg: -36,  initialPhaseDeg: 165, baseSpeed: 10.0 },
      { id: 'sat-7', code: 'SAT-7', name: 'Cross-5',  color: '#e879f9', altitudeKm: 540, inclinationDeg: 90,  raanDeg: 0,    initialPhaseDeg: 201, baseSpeed: 10.0 },
    ],
  },
};

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function normalizeLonDeg(lon: number): number {
  let a = ((lon + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  return a;
}

export function angularDistanceLonDeg(lonStart: number, lonTest: number): number {
  return ((lonTest - lonStart) % 360 + 360) % 360;
}

export function latLonToGridCell(latDeg: number, lonDeg: number): { row: number; col: number } {
  const clampedLat = clamp(latDeg, GRID_LAT_MIN, GRID_LAT_MAX - 0.0001);
  const row = clamp(Math.floor((clampedLat - GRID_LAT_MIN) / CELL_DEG), 0, GRID_ROWS - 1);
  const normLon = normalizeLonDeg(lonDeg);
  const col = clamp(Math.floor((normLon + 180) / CELL_DEG), 0, GRID_COLS - 1);
  return { row, col };
}

export function createPlacedZone(
  template: ZoneTemplate,
  row: number,
  col: number,
  id: string,
  effectPct: number = template.defaultEffectPct
): PlacedZone {
  const safeRow = clamp(Math.floor(row), 0, GRID_ROWS - 1);
  const safeCol = ((Math.floor(col) % GRID_COLS) + GRID_COLS) % GRID_COLS;
  const latMin = GRID_LAT_MIN + safeRow * CELL_DEG;
  const latMax = latMin + CELL_DEG;
  const lonStart = -180 + safeCol * CELL_DEG;
  const lonEnd = lonStart + CELL_DEG;

  return {
    id,
    typeId: template.typeId,
    name: template.name,
    shortName: template.shortName,
    mapCode: template.mapCode,
    color: template.color,
    row: safeRow,
    col: safeCol,
    lengthUnits: template.lengthUnits,
    effectPct,
    latMin,
    latMax,
    lonStart,
    lonEnd,
  };
}

export function isLatLonInGridCell(latDeg: number, lonDeg: number, zone: Pick<PlacedZone, 'latMin' | 'latMax' | 'lonStart'>): boolean {
  if (latDeg < zone.latMin || latDeg > zone.latMax) return false;
  const offset = angularDistanceLonDeg(zone.lonStart, lonDeg);
  return offset >= 0 && offset <= CELL_DEG;
}

export function computeZoneTransitDelta(lengthUnits: number, baseSpeed: number, effectPct: number): {
  modifiedSpeed: number;
  baseTimeSec: number;
  modifiedTimeSec: number;
  deltaSec: number;
} {
  const modifiedSpeed = baseSpeed * (1 + effectPct);
  const baseTimeSec = lengthUnits / baseSpeed;
  const modifiedTimeSec = lengthUnits / modifiedSpeed;
  const deltaSec = modifiedTimeSec - baseTimeSec;
  return { modifiedSpeed, baseTimeSec, modifiedTimeSec, deltaSec };
}

export function computeSatKinematics(
  altitudeKm: number,
  inclinationDeg: number,
  raanDeg: number,
  phaseDeg: number,
  speedUnitsPerSec: number
): { positionKm: Vec3; velocityKmPerSec: Vec3; latDeg: number; lonDeg: number } {
  const r = EARTH_RADIUS_KM + altitudeKm;
  const u = phaseDeg * DEG2RAD;
  const inc = inclinationDeg * DEG2RAD;
  const raan = raanDeg * DEG2RAD;

  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosI = Math.cos(inc);
  const sinI = Math.sin(inc);

  const px = cosO;
  const py = 0;
  const pz = -sinO;
  const qx = -sinO * cosI;
  const qy = sinI;
  const qz = -cosO * cosI;

  const positionKm: Vec3 = {
    x: r * (cosU * px + sinU * qx),
    y: r * (cosU * py + sinU * qy),
    z: r * (cosU * pz + sinU * qz),
  };

  const vMag = r * speedUnitsPerSec * DEG2RAD;
  const velocityKmPerSec: Vec3 = {
    x: vMag * (-sinU * px + cosU * qx),
    y: vMag * (-sinU * py + cosU * qy),
    z: vMag * (-sinU * pz + cosU * qz),
  };

  const latDeg = Math.asin(clamp(positionKm.y / r, -1, 1)) * RAD2DEG;
  const lonDeg = normalizeLonDeg(Math.atan2(-positionKm.z, positionKm.x) * RAD2DEG);

  return { positionKm, velocityKmPerSec, latDeg, lonDeg };
}

export function createPuzzleSatellites(configs: PuzzleSatConfig[] = LEVEL_CONFIGS[1].satellites): PuzzleSatState[] {
  return configs.map((cfg) => {
    const kin = computeSatKinematics(cfg.altitudeKm, cfg.inclinationDeg, cfg.raanDeg, cfg.initialPhaseDeg, cfg.baseSpeed);
    return {
      ...cfg,
      periodSec: ORBIT_ARC_UNITS / cfg.baseSpeed,
      phaseDeg: cfg.initialPhaseDeg,
      speed: cfg.baseSpeed,
      latDeg: kin.latDeg,
      lonDeg: kin.lonDeg,
      positionKm: kin.positionKm,
      velocityKmPerSec: kin.velocityKmPerSec,
      activeZoneLabel: 'Nominal',
      activeZoneColor: null,
      transits: {},
    };
  });
}

export interface StepResult {
  collidedPair: {
    satA: PuzzleSatState;
    satB: PuzzleSatState;
    distanceKm: number;
    arrivalDeltaSec: number;
    requiredDeltaSec: number;
  } | null;
  minSeparationKm: number;
  riskPairs: { satA: PuzzleSatState; satB: PuzzleSatState; distanceKm: number; critical: boolean }[];
}

export function estimateRequiredDeltaSec(satA: PuzzleSatState, satB: PuzzleSatState): number {
  const vx = satB.velocityKmPerSec.x - satA.velocityKmPerSec.x;
  const vy = satB.velocityKmPerSec.y - satA.velocityKmPerSec.y;
  const vz = satB.velocityKmPerSec.z - satA.velocityKmPerSec.z;
  const vA = Math.hypot(satA.velocityKmPerSec.x, satA.velocityKmPerSec.y, satA.velocityKmPerSec.z);
  const vB = Math.hypot(satB.velocityKmPerSec.x, satB.velocityKmPerSec.y, satB.velocityKmPerSec.z);
  const crossX = satA.velocityKmPerSec.y * satB.velocityKmPerSec.z - satA.velocityKmPerSec.z * satB.velocityKmPerSec.y;
  const crossY = satA.velocityKmPerSec.z * satB.velocityKmPerSec.x - satA.velocityKmPerSec.x * satB.velocityKmPerSec.z;
  const crossZ = satA.velocityKmPerSec.x * satB.velocityKmPerSec.y - satA.velocityKmPerSec.y * satB.velocityKmPerSec.x;
  const crossMag = Math.hypot(crossX, crossY, crossZ);
  const relSpeed = Math.hypot(vx, vy, vz);
  // Miss distance per second of arrival offset at crossing point: (|vA x vB|) / |vA - vB|
  const missRateKmPerSec = relSpeed > 1e-3 ? crossMag / relSpeed : Math.min(vA, vB);
  if (missRateKmPerSec < 50) return 0.5;
  return COLLISION_RADIUS_KM / missRateKmPerSec;
}

/**
 * Advances all satellites by `dt` seconds.
 * Speed modifiers apply strictly while traversing a zone's exact arc length L
 * and revert cleanly to baseSpeed upon exit.
 */
export function stepPuzzleSimulation(
  satellites: PuzzleSatState[],
  placedZones: PlacedZone[],
  dt: number
): StepResult {
  for (const sat of satellites) {
    // Determine active zone speed strictly from zones currently being traversed
    let modifierProduct = 1.0;
    let activeLabel = 'Nominal';
    let activeColor: string | null = null;

    for (const zone of placedZones) {
      const tr = sat.transits[zone.id];
      if (tr && tr.active) {
        modifierProduct *= 1 + zone.effectPct;
        const sign = zone.effectPct >= 0 ? '+' : '';
        activeLabel = `${zone.shortName} ${sign}${(zone.effectPct * 100).toFixed(zone.effectPct * 100 % 1 === 0 ? 0 : 1)}%`;
        activeColor = zone.color;
      }
    }

    sat.speed = sat.baseSpeed * modifierProduct;
    const dArcUnits = sat.speed * dt;
    sat.phaseDeg = (sat.phaseDeg + dArcUnits) % 360;

    const kin = computeSatKinematics(sat.altitudeKm, sat.inclinationDeg, sat.raanDeg, sat.phaseDeg, sat.speed);
    sat.latDeg = kin.latDeg;
    sat.lonDeg = kin.lonDeg;
    sat.positionKm = kin.positionKm;
    sat.velocityKmPerSec = kin.velocityKmPerSec;

    // Update zone entry/exit along exact length L
    for (const zone of placedZones) {
      let tr = sat.transits[zone.id];
      if (!tr) {
        tr = {
          active: false,
          wasInsideCell: false,
          arcRemainingUnits: 0,
          passesCompleted: 0,
        };
        sat.transits[zone.id] = tr;
      }

      if (tr.active) {
        tr.arcRemainingUnits -= dArcUnits;
        if (tr.arcRemainingUnits <= 1e-6) {
          tr.active = false;
          tr.arcRemainingUnits = 0;
          tr.passesCompleted += 1;
        }
      }

      const insideCell = isLatLonInGridCell(sat.latDeg, sat.lonDeg, zone);
      if (insideCell && !tr.wasInsideCell && !tr.active) {
        tr.active = true;
        tr.arcRemainingUnits = zone.lengthUnits;
      }
      tr.wasInsideCell = insideCell;
    }

    // Recompute immediate next-frame display speed after exit/entry so HUD reflects clean reversion
    let nextMod = 1.0;
    activeLabel = 'Nominal';
    activeColor = null;
    for (const zone of placedZones) {
      const tr = sat.transits[zone.id];
      if (tr && tr.active) {
        nextMod *= 1 + zone.effectPct;
        const sign = zone.effectPct >= 0 ? '+' : '';
        const pctStr = Math.abs(zone.effectPct * 100) % 1 === 0 ? Math.round(zone.effectPct * 100) : (zone.effectPct * 100).toFixed(1);
        activeLabel = `${zone.shortName} ${sign}${pctStr}%`;
        activeColor = zone.color;
      }
    }
    sat.speed = sat.baseSpeed * nextMod;
    sat.activeZoneLabel = activeLabel;
    sat.activeZoneColor = activeColor;
  }

  let minSeparationKm = Infinity;
  let collidedPair: StepResult['collidedPair'] = null;
  const riskPairs: StepResult['riskPairs'] = [];

  for (let i = 0; i < satellites.length; i++) {
    for (let j = i + 1; j < satellites.length; j++) {
      const a = satellites[i];
      const b = satellites[j];
      const rx = b.positionKm.x - a.positionKm.x;
      const ry = b.positionKm.y - a.positionKm.y;
      const rz = b.positionKm.z - a.positionKm.z;
      const d = Math.hypot(rx, ry, rz);
      if (d < minSeparationKm) minSeparationKm = d;

      if (d < 1400) {
        riskPairs.push({ satA: a, satB: b, distanceKm: d, critical: d < 500 });
      }

      if (d <= COLLISION_RADIUS_KM && !collidedPair) {
        const reqDt = estimateRequiredDeltaSec(a, b);
        const curDt = (d / COLLISION_RADIUS_KM) * reqDt;
        collidedPair = {
          satA: a,
          satB: b,
          distanceKm: d,
          arrivalDeltaSec: curDt,
          requiredDeltaSec: reqDt,
        };
      }
    }
  }

  return { collidedPair, minSeparationKm, riskPairs };
}

export interface PreRunPrediction {
  survived: boolean;
  firstClosePassSec: number;
  firstPeriod: number;
  firstPairMinSepKm: number;
  globalMinSepKm: number;
  arrivalDeltaSec: number;
  requiredDeltaSec: number;
  sat1DeltaSec: number;
  sat2DeltaSec: number;
  collidedPairIds: [string, string] | null;
}

/**
 * Deterministic static pre-run prediction & full 10-period verifier.
 * Evaluates exact mathematical outcome of the current placedZones configuration
 * without running live visuals.
 */
export function evaluatePuzzlePlan(
  placedZones: PlacedZone[],
  levelCfg: LevelConfig = LEVEL_CONFIGS[1],
  dt = 0.05
): PreRunPrediction {
  const sats = createPuzzleSatellites(levelCfg.satellites);
  const targetSimSec = (ORBIT_ARC_UNITS / levelCfg.satellites[0].baseSpeed) * TARGET_PERIODS;
  const pairA = sats.find((s) => s.id === levelCfg.collisionPairIds[0])!;
  const pairB = sats.find((s) => s.id === levelCfg.collisionPairIds[1])!;
  const nodePos = computeSatKinematics(
    pairA.altitudeKm,
    0,
    levelCfg.collisionNodeLatLon.lon,
    0,
    pairA.baseSpeed
  ).positionKm;

  let t = 0;
  let globalMinSepKm = Infinity;
  let firstPairCpaKm = Infinity;
  let firstPairCpaSec = levelCfg.predictedCollisionSec;
  let reqDtAtClose = 0.275;

  let bestNodeDistA = Infinity;
  let prevDistA = Infinity;
  let tNodeA = levelCfg.predictedCollisionSec;
  let bestNodeSampleA: { prev: number; min: number; t: number; next: number } | null = null;

  let bestNodeDistB = Infinity;
  let prevDistB = Infinity;
  let tNodeB = levelCfg.predictedCollisionSec;
  let bestNodeSampleB: { prev: number; min: number; t: number; next: number } | null = null;

  let firstCollision: {
    t: number;
    period: number;
    pairIds: [string, string];
    distanceKm: number;
    reqDt: number;
  } | null = null;

  const baselineT = levelCfg.predictedCollisionSec;
  const windowMin = Math.max(0, baselineT - 6.0);
  const windowMax = baselineT + 6.0;

  while (t < targetSimSec - 1e-6) {
    const step = Math.min(dt, targetSimSec - t);
    t += step;
    const res = stepPuzzleSimulation(sats, placedZones, step);
    if (res.minSeparationKm < globalMinSepKm) globalMinSepKm = res.minSeparationKm;

    if (t >= windowMin && t <= windowMax) {
      const dNodeA = Math.hypot(
        pairA.positionKm.x - nodePos.x,
        pairA.positionKm.y - nodePos.y,
        pairA.positionKm.z - nodePos.z
      );
      if (bestNodeSampleA && bestNodeSampleA.next === Infinity) {
        bestNodeSampleA.next = dNodeA;
        const denom = 2 * (bestNodeSampleA.prev - 2 * bestNodeSampleA.min + bestNodeSampleA.next);
        if (Math.abs(denom) > 1e-6) {
          tNodeA = bestNodeSampleA.t + ((bestNodeSampleA.prev - bestNodeSampleA.next) / denom) * step;
        }
      }
      if (dNodeA < bestNodeDistA) {
        bestNodeDistA = dNodeA;
        tNodeA = t;
        bestNodeSampleA = { prev: prevDistA, min: dNodeA, t, next: Infinity };
      }
      prevDistA = dNodeA;

      const dNodeB = Math.hypot(
        pairB.positionKm.x - nodePos.x,
        pairB.positionKm.y - nodePos.y,
        pairB.positionKm.z - nodePos.z
      );
      if (bestNodeSampleB && bestNodeSampleB.next === Infinity) {
        bestNodeSampleB.next = dNodeB;
        const denom = 2 * (bestNodeSampleB.prev - 2 * bestNodeSampleB.min + bestNodeSampleB.next);
        if (Math.abs(denom) > 1e-6) {
          tNodeB = bestNodeSampleB.t + ((bestNodeSampleB.prev - bestNodeSampleB.next) / denom) * step;
        }
      }
      if (dNodeB < bestNodeDistB) {
        bestNodeDistB = dNodeB;
        tNodeB = t;
        bestNodeSampleB = { prev: prevDistB, min: dNodeB, t, next: Infinity };
      }
      prevDistB = dNodeB;

      const pairDist = Math.hypot(
        pairB.positionKm.x - pairA.positionKm.x,
        pairB.positionKm.y - pairA.positionKm.y,
        pairB.positionKm.z - pairA.positionKm.z
      );
      if (pairDist < firstPairCpaKm) {
        firstPairCpaKm = pairDist;
        firstPairCpaSec = t;
        reqDtAtClose = estimateRequiredDeltaSec(pairA, pairB);
      }
    }

    if (res.collidedPair && !firstCollision) {
      firstCollision = {
        t,
        period: t / res.collidedPair.satA.periodSec,
        pairIds: [res.collidedPair.satA.id, res.collidedPair.satB.id],
        distanceKm: res.collidedPair.distanceKm,
        reqDt: res.collidedPair.requiredDeltaSec,
      };
      // If collision happened after the target arrival window, stop immediately
      if (t > windowMax) break;
    }

    if (firstCollision && t > windowMax) break;
  }

  const sat1DeltaSec = tNodeA - baselineT;
  const sat2DeltaSec = tNodeB - baselineT;
  const arrivalDeltaSec = Math.abs(tNodeA - tNodeB);

  if (firstCollision) {
    return {
      survived: false,
      firstClosePassSec: firstCollision.t,
      firstPeriod: firstCollision.period,
      firstPairMinSepKm: firstCollision.t <= windowMax ? firstPairCpaKm : firstCollision.distanceKm,
      globalMinSepKm: firstCollision.distanceKm,
      arrivalDeltaSec,
      requiredDeltaSec: firstCollision.reqDt,
      sat1DeltaSec,
      sat2DeltaSec,
      collidedPairIds: firstCollision.pairIds,
    };
  }

  return {
    survived: true,
    firstClosePassSec: firstPairCpaSec,
    firstPeriod: targetSimSec / pairA.periodSec,
    firstPairMinSepKm: firstPairCpaKm,
    globalMinSepKm,
    arrivalDeltaSec,
    requiredDeltaSec: reqDtAtClose,
    sat1DeltaSec,
    sat2DeltaSec,
    collidedPairIds: null,
  };
}
