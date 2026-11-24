/**
 * Pure orbital mechanics, perturbation zone physics, ground-track estimation,
 * and pairwise collision probability math for Orbital Watch.
 *
 * Mirrored identically inside /index.html so the single-file prototype has zero
 * external build dependencies while remaining deterministically unit-tested.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EARTH_RADIUS_KM = 6371;
export const EARTH_VISUAL_RADIUS = 5.0;
export const KM_PER_UNIT = EARTH_RADIUS_KM / EARTH_VISUAL_RADIUS;
export const EARTH_MU_KM3_S2 = 398600.4418;

// Base visual time compression: at 1x speed, 1 real second advances 30 orbital seconds
// (~190s per LEO orbit at 1x, ~9.5s per orbit at 20x).
export const SIM_SECONDS_PER_REAL_SEC_AT_1X = 30.0;
export const EARTH_ROTATION_RAD_PER_SIM_SEC = (2 * Math.PI) / 86164.1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type ZoneId = 'mass-belt' | 'atmo-drag' | 'rad-belt' | 'gravity-wave';

export interface PerturbationZone {
  id: ZoneId;
  name: string;
  shortLabel: string;
  color: string;
  latCenter: number;
  latHalfWidth: number;
  lonStart: number; // degrees in [-180, 180]
  arcLengthDeg: number; // defined angular length along longitude/corridor
  mode: 'fixed' | 'directional' | 'tidal';
  effectPercent: number; // e.g., +0.02, -0.03, 0.01, 0.015
  description: string;
}

export const PERTURBATION_ZONES: PerturbationZone[] = [
  {
    id: 'mass-belt',
    name: 'Mass Belt',
    shortLabel: 'MASS +2.0%',
    color: '#f59e0b',
    latCenter: 8,
    latHalfWidth: 26,
    lonStart: -55,
    arcLengthDeg: 64,
    mode: 'fixed',
    effectPercent: 0.02,
    description: '+2.0% acceleration along defined arc length on every pass',
  },
  {
    id: 'atmo-drag',
    name: 'Atmospheric Drag',
    shortLabel: 'DRAG -3.0%',
    color: '#f43f5e',
    latCenter: 42,
    latHalfWidth: 22,
    lonStart: 35,
    arcLengthDeg: 72,
    mode: 'fixed',
    effectPercent: -0.03,
    description: '-3.0% deceleration along defined band length on every entry',
  },
  {
    id: 'rad-belt',
    name: 'Radiation Belt',
    shortLabel: 'RAD ±1.0%',
    color: '#a855f7',
    latCenter: -26,
    latHalfWidth: 24,
    lonStart: -90,
    arcLengthDeg: 68,
    mode: 'directional',
    effectPercent: 0.01,
    description: '+1.0% ascending / -1.0% descending shift along corridor length',
  },
  {
    id: 'gravity-wave',
    name: 'Gravity Wave / Tide',
    shortLabel: 'TIDE ±1.5%',
    color: '#14b8a6',
    latCenter: -8,
    latHalfWidth: 28,
    lonStart: 135,
    arcLengthDeg: 76,
    mode: 'tidal',
    effectPercent: 0.015,
    description: '+1.5% crest / -1.5% trough shift along zone length',
  },
];

export interface ZonePassState {
  inZone: boolean;
  arcTraveledDeg: number;
  appliedSmoothFrac: number;
  signedEffect: number; // e.g., +0.02 or -0.015
  polarityLabel: string;
  passCount: number;
}

export interface SatelliteState {
  id: string;
  name: string;
  color: string;
  altitudeKm: number;
  inclinationDeg: number;
  raanDeg: number;
  meanAnomalyRad: number; // current orbital phase angle u
  nominalSpeedKmS: number;
  nominalAngularRateRadS: number;
  speedMultiplier: number; // starts at 1.0, modified by zones & player maneuvers
  zoneStates: Record<ZoneId, ZonePassState>;
  activeZoneId: ZoneId | null;
  activeZoneEffectText: string;
  activeZoneProgress: number; // 0..1
  latDeg: number;
  lonDeg: number;
  positionKm: Vec3;
  velocityKmS: Vec3;
}

export interface CollisionPairMetrics {
  satAId: string;
  satBId: string;
  satAName: string;
  satBName: string;
  distanceKm: number;
  relativeSpeedKmS: number;
  tcaSimSec: number;
  closestApproachKm: number;
  closingSpeedKmS: number;
  probabilityPct: number;
  riskLevel: 'nominal' | 'elevated' | 'critical';
  isImpact: boolean;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function normalizeLonDeg(lon: number): number {
  let a = ((lon + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  return a;
}

export function angularDistanceLonDeg(lonStart: number, lonTest: number): number {
  // Returns eastward angular offset in [0, 360) from lonStart to lonTest
  return ((lonTest - lonStart) % 360 + 360) % 360;
}

export function isPointInZone(latDeg: number, lonDeg: number, zone: PerturbationZone): boolean {
  if (Math.abs(latDeg - zone.latCenter) > zone.latHalfWidth) {
    return false;
  }
  const offset = angularDistanceLonDeg(zone.lonStart, lonDeg);
  return offset >= 0 && offset <= zone.arcLengthDeg;
}

/**
 * Computes 3D ECI position (km) and velocity (km/s) in Three.js Y-up coordinates
 * (Y = North Pole, X = Prime Meridian at t=0, Z = -90°E so East is +lon around +Y).
 */
export function computeOrbitKinematicsKm(
  altitudeKm: number,
  inclinationDeg: number,
  raanDeg: number,
  phaseRad: number,
  speedMultiplier: number
): { positionKm: Vec3; velocityKmS: Vec3; speedKmS: number; angularRateRadS: number } {
  const r = EARTH_RADIUS_KM + altitudeKm;
  const inc = inclinationDeg * DEG2RAD;
  const raan = raanDeg * DEG2RAD;
  const vNominal = Math.sqrt(EARTH_MU_KM3_S2 / r);
  const speedKmS = vNominal * speedMultiplier;
  const omega = speedKmS / r;

  const cosU = Math.cos(phaseRad);
  const sinU = Math.sin(phaseRad);
  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosI = Math.cos(inc);
  const sinI = Math.sin(inc);

  // Orbital plane unit basis (P along ascending node, Q perpendicular prograde eastward)
  // Using Y-up celestial frame where +X = (0°N, 0°E) and -Z = (0°N, +90°E):
  // P = (cosO, 0, -sinO)
  // East tangent at P = (-sinO, 0, -cosO), North = (0, 1, 0)
  // Q = cosI * East + sinI * North = (-sinO * cosI, sinI, -cosO * cosI)
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

  const velocityKmS: Vec3 = {
    x: speedKmS * (-sinU * px + cosU * qx),
    y: speedKmS * (-sinU * py + cosU * qy),
    z: speedKmS * (-sinU * pz + cosU * qz),
  };

  return { positionKm, velocityKmS, speedKmS, angularRateRadS: omega };
}

/**
 * Converts ECI 3D position (Y-up) into Earth-fixed geocentric latitude/longitude (deg),
 * accounting for Earth's eastward rotation angle earthRotationRad around +Y.
 */
export function eciToLatLonDeg(pos: Vec3, earthRotationRad: number): { latDeg: number; lonDeg: number } {
  const r = Math.hypot(pos.x, pos.y, pos.z) || 1;
  const latDeg = Math.asin(clamp(pos.y / r, -1, 1)) * RAD2DEG;

  // Rotate ECI vector by -earthRotationRad around +Y into ECEF
  const cosR = Math.cos(earthRotationRad);
  const sinR = Math.sin(earthRotationRad);
  const ex = pos.x * cosR - pos.z * sinR;
  const ez = pos.x * sinR + pos.z * cosR;

  // In Three.js Y-up where +X = (0°N, 0°E) and -Z = (0°N, 90°E)
  const lonDeg = normalizeLonDeg(Math.atan2(-ez, ex) * RAD2DEG);
  return { latDeg, lonDeg };
}

/**
 * Converts Earth-fixed (latDeg, lonDeg, radius) into ECEF 3D coordinates (Y-up)
 * matching Three.js SphereGeometry UV mapping (when sphere is aligned with +X = 0°E).
 */
export function latLonToEcef(latDeg: number, lonDeg: number, radius: number): Vec3 {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const cosLat = Math.cos(lat);
  return {
    x: radius * cosLat * Math.cos(lon),
    y: radius * Math.sin(lat),
    z: -radius * cosLat * Math.sin(lon),
  };
}

export function createInitialZoneStates(): Record<ZoneId, ZonePassState> {
  return {
    'mass-belt': { inZone: false, arcTraveledDeg: 0, appliedSmoothFrac: 0, signedEffect: 0.02, polarityLabel: '', passCount: 0 },
    'atmo-drag': { inZone: false, arcTraveledDeg: 0, appliedSmoothFrac: 0, signedEffect: -0.03, polarityLabel: '', passCount: 0 },
    'rad-belt': { inZone: false, arcTraveledDeg: 0, appliedSmoothFrac: 0, signedEffect: 0.01, polarityLabel: '', passCount: 0 },
    'gravity-wave': { inZone: false, arcTraveledDeg: 0, appliedSmoothFrac: 0, signedEffect: 0.015, polarityLabel: '', passCount: 0 },
  };
}

export function createSatellite(config: {
  id: string;
  name: string;
  color: string;
  altitudeKm: number;
  inclinationDeg: number;
  raanDeg: number;
  initialPhaseDeg: number;
}): SatelliteState {
  const r = EARTH_RADIUS_KM + config.altitudeKm;
  const nominalSpeedKmS = Math.sqrt(EARTH_MU_KM3_S2 / r);
  const nominalAngularRateRadS = nominalSpeedKmS / r;
  const phaseRad = config.initialPhaseDeg * DEG2RAD;
  const kin = computeOrbitKinematicsKm(config.altitudeKm, config.inclinationDeg, config.raanDeg, phaseRad, 1.0);
  const geo = eciToLatLonDeg(kin.positionKm, 0);

  return {
    id: config.id,
    name: config.name,
    color: config.color,
    altitudeKm: config.altitudeKm,
    inclinationDeg: config.inclinationDeg,
    raanDeg: config.raanDeg,
    meanAnomalyRad: phaseRad,
    nominalSpeedKmS,
    nominalAngularRateRadS,
    speedMultiplier: 1.0,
    zoneStates: createInitialZoneStates(),
    activeZoneId: null,
    activeZoneEffectText: 'Nominal Orbit (0.0%)',
    activeZoneProgress: 0,
    latDeg: geo.latDeg,
    lonDeg: geo.lonDeg,
    positionKm: kin.positionKm,
    velocityKmS: kin.velocityKmS,
  };
}

/**
 * Advances a satellite by `simDt` simulation seconds and smoothly applies any
 * active perturbation zone's percentage speed shift across that zone's defined arc length.
 */
export function stepSatellite(
  sat: SatelliteState,
  simDt: number,
  simTimeSec: number,
  earthRotationRad: number,
  zones: PerturbationZone[] = PERTURBATION_ZONES,
  satIndex = 0
): void {
  const prevLat = sat.latDeg;
  const prevLon = sat.lonDeg;

  const kinPre = computeOrbitKinematicsKm(
    sat.altitudeKm,
    sat.inclinationDeg,
    sat.raanDeg,
    sat.meanAnomalyRad,
    sat.speedMultiplier
  );

  // Advance orbital phase
  const dPhaseRad = kinPre.angularRateRadS * simDt;
  sat.meanAnomalyRad = (sat.meanAnomalyRad + dPhaseRad) % (Math.PI * 2);

  // Compute new position and ground footprint
  const kinPost = computeOrbitKinematicsKm(
    sat.altitudeKm,
    sat.inclinationDeg,
    sat.raanDeg,
    sat.meanAnomalyRad,
    sat.speedMultiplier
  );
  const geo = eciToLatLonDeg(kinPost.positionKm, earthRotationRad);

  // Angular ground arc traveled this step (great-circle approx in degrees)
  const dLat = geo.latDeg - prevLat;
  let dLon = geo.lonDeg - prevLon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  const meanLatRad = ((geo.latDeg + prevLat) * 0.5) * DEG2RAD;
  const groundArcStepDeg = Math.hypot(dLat, dLon * Math.cos(meanLatRad));
  // Fallback to orbital angular step if step is tiny or initial
  const arcStepDeg = Math.max(groundArcStepDeg, dPhaseRad * RAD2DEG * 0.85);

  let activeZone: PerturbationZone | null = null;
  let activeProgress = 0;
  let activeText = 'Nominal Orbit (0.0%)';

  for (const zone of zones) {
    const zState = sat.zoneStates[zone.id];
    const inside = isPointInZone(geo.latDeg, geo.lonDeg, zone);

    if (inside) {
      if (!zState.inZone) {
        // Fresh entry into this zone: initialize pass state
        zState.inZone = true;
        zState.arcTraveledDeg = 0;
        zState.appliedSmoothFrac = 0;
        zState.passCount += 1;

        if (zone.mode === 'fixed') {
          zState.signedEffect = zone.effectPercent;
          zState.polarityLabel = zone.effectPercent >= 0 ? 'Accel' : 'Drag';
        } else if (zone.mode === 'directional') {
          const ascending = kinPost.velocityKmS.y >= 0;
          zState.signedEffect = ascending ? Math.abs(zone.effectPercent) : -Math.abs(zone.effectPercent);
          zState.polarityLabel = ascending ? 'Asc' : 'Desc';
        } else {
          // Tidal harmonic sign locked for this transit pass
          const crest = Math.cos(simTimeSec * 0.0045 + satIndex * 1.15) >= 0;
          zState.signedEffect = crest ? Math.abs(zone.effectPercent) : -Math.abs(zone.effectPercent);
          zState.polarityLabel = crest ? 'Crest' : 'Trough';
        }
      }

      // Smoothly apply percentage speed shift proportional to zone arc length traversed
      zState.arcTraveledDeg = Math.min(zone.arcLengthDeg, zState.arcTraveledDeg + arcStepDeg);
      const rawFrac = zState.arcTraveledDeg / zone.arcLengthDeg;
      const nextSmoothFrac = smoothstep01(rawFrac);
      const deltaSmooth = Math.max(0, nextSmoothFrac - zState.appliedSmoothFrac);
      zState.appliedSmoothFrac = nextSmoothFrac;

      if (deltaSmooth > 0) {
        sat.speedMultiplier = clamp(sat.speedMultiplier + zState.signedEffect * deltaSmooth, 0.72, 1.38);
      }

      activeZone = zone;
      activeProgress = rawFrac;
      const signStr = zState.signedEffect >= 0 ? '+' : '';
      const pctStr = `${signStr}${(zState.signedEffect * 100).toFixed(1)}%`;
      activeText = `${zone.name} (${pctStr} ${zState.polarityLabel})`;
    } else if (zState.inZone) {
      // Exited zone: reset so subsequent passes re-trigger cleanly
      zState.inZone = false;
      zState.arcTraveledDeg = 0;
      zState.appliedSmoothFrac = 0;
    }
  }

  // Recompute velocity with updated speedMultiplier
  const kinFinal = computeOrbitKinematicsKm(
    sat.altitudeKm,
    sat.inclinationDeg,
    sat.raanDeg,
    sat.meanAnomalyRad,
    sat.speedMultiplier
  );

  sat.latDeg = geo.latDeg;
  sat.lonDeg = geo.lonDeg;
  sat.positionKm = kinFinal.positionKm;
  sat.velocityKmS = kinFinal.velocityKmS;
  sat.activeZoneId = activeZone ? activeZone.id : null;
  sat.activeZoneProgress = activeProgress;
  sat.activeZoneEffectText = activeText;
}

/**
 * Computes pairwise collision probability (%) using basic 3D separation distance,
 * relative velocity, and linear closest-approach threshold mathematics.
 */
export function computePairCollisionMetrics(
  satA: SatelliteState,
  satB: SatelliteState
): CollisionPairMetrics {
  const rx = satB.positionKm.x - satA.positionKm.x;
  const ry = satB.positionKm.y - satA.positionKm.y;
  const rz = satB.positionKm.z - satA.positionKm.z;

  const vx = satB.velocityKmS.x - satA.velocityKmS.x;
  const vy = satB.velocityKmS.y - satA.velocityKmS.y;
  const vz = satB.velocityKmS.z - satA.velocityKmS.z;

  const distanceKm = Math.hypot(rx, ry, rz);
  const relativeSpeedKmS = Math.hypot(vx, vy, vz);
  const rDotV = rx * vx + ry * vy + rz * vz;

  // Closing speed (positive when approaching)
  const closingSpeedKmS = distanceKm > 1e-6 ? -rDotV / distanceKm : 0;

  // Time to closest approach clamped to lookahead horizon (180 sim seconds)
  const HORIZON_SEC = 180.0;
  const vSq = vx * vx + vy * vy + vz * vz;
  const rawTca = vSq > 1e-8 ? -rDotV / vSq : 0;
  const tcaSimSec = clamp(rawTca, 0, HORIZON_SEC);

  // Predicted miss distance at closest approach
  const cx = rx + vx * tcaSimSec;
  const cy = ry + vy * tcaSimSec;
  const cz = rz + vz * tcaSimSec;
  const closestApproachKm = Math.hypot(cx, cy, cz);

  // Threshold parameters (calibrated for clear early-warning & critical conjunction readability at LEO scale)
  const CRITICAL_RADIUS_KM = 280;
  const SIGMA_MISS_KM = 950;
  const TIME_DECAY_SEC = 85;

  // 1. Closest-approach Gaussian proximity factor
  const excessMiss = Math.max(0, closestApproachKm - CRITICAL_RADIUS_KM);
  const missFactor = Math.exp(-Math.pow(excessMiss / SIGMA_MISS_KM, 2));

  // 2. Time-to-approach immediacy & closing-direction factor
  let timeFactor: number;
  if (closingSpeedKmS > 0) {
    timeFactor = Math.exp(-tcaSimSec / TIME_DECAY_SEC);
  } else {
    // Receding pair decays rapidly with current separation
    const excessDist = Math.max(0, distanceKm - CRITICAL_RADIUS_KM);
    timeFactor = 0.52 * Math.exp(-excessDist / 650);
  }

  // 3. Relative velocity hazard weighting
  const velocityFactor = clamp(0.68 + 0.32 * (relativeSpeedKmS / 12.0), 0.68, 1.15);

  let probabilityPct = clamp(100 * missFactor * timeFactor * velocityFactor, 0, 99.9);
  const isImpact = distanceKm <= CRITICAL_RADIUS_KM;
  if (isImpact) {
    probabilityPct = clamp(95 + (1 - distanceKm / CRITICAL_RADIUS_KM) * 4.9, 95, 99.9);
  }

  let riskLevel: 'nominal' | 'elevated' | 'critical' = 'nominal';
  if (probabilityPct >= 50) riskLevel = 'critical';
  else if (probabilityPct >= 15) riskLevel = 'elevated';

  return {
    satAId: satA.id,
    satBId: satB.id,
    satAName: satA.name,
    satBName: satB.name,
    distanceKm,
    relativeSpeedKmS,
    tcaSimSec,
    closestApproachKm,
    closingSpeedKmS,
    probabilityPct,
    riskLevel,
    isImpact,
  };
}

/**
 * Predicts future ground-track points (lat, lon) over `horizonSimSec`,
 * dynamically incorporating current speedMultiplier and upcoming perturbation zones.
 */
export function predictGroundTrack(
  sat: SatelliteState,
  simTimeSec: number,
  earthRotationRad: number,
  horizonSimSec = 5400,
  steps = 84,
  zones: PerturbationZone[] = PERTURBATION_ZONES,
  satIndex = 0
): Array<{ latDeg: number; lonDeg: number; speedMultiplier: number }> {
  // Deep-clone only the lightweight numerical state needed for forward propagation
  const clone: SatelliteState = {
    ...sat,
    zoneStates: {
      'mass-belt': { ...sat.zoneStates['mass-belt'] },
      'atmo-drag': { ...sat.zoneStates['atmo-drag'] },
      'rad-belt': { ...sat.zoneStates['rad-belt'] },
      'gravity-wave': { ...sat.zoneStates['gravity-wave'] },
    },
    positionKm: { ...sat.positionKm },
    velocityKmS: { ...sat.velocityKmS },
  };

  const dt = horizonSimSec / steps;
  const points: Array<{ latDeg: number; lonDeg: number; speedMultiplier: number }> = [
    { latDeg: clone.latDeg, lonDeg: clone.lonDeg, speedMultiplier: clone.speedMultiplier },
  ];

  let t = simTimeSec;
  let rot = earthRotationRad;
  for (let i = 0; i < steps; i++) {
    t += dt;
    rot += EARTH_ROTATION_RAD_PER_SIM_SEC * dt;
    stepSatellite(clone, dt, t, rot, zones, satIndex);
    points.push({
      latDeg: clone.latDeg,
      lonDeg: clone.lonDeg,
      speedMultiplier: clone.speedMultiplier,
    });
  }

  return points;
}
