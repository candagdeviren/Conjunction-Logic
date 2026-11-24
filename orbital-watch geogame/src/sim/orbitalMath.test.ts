import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERTURBATION_ZONES,
  computePairCollisionMetrics,
  createSatellite,
  eciToLatLonDeg,
  isPointInZone,
  latLonToEcef,
  predictGroundTrack,
  stepSatellite,
} from './orbitalMath';

test('eciToLatLonDeg and latLonToEcef round-trip accurately', () => {
  const sample = latLonToEcef(37.5, -122.4, 6911);
  const geo = eciToLatLonDeg(sample, 0);
  assert.ok(Math.abs(geo.latDeg - 37.5) < 1e-4, `lat mismatch: ${geo.latDeg}`);
  assert.ok(Math.abs(geo.lonDeg - (-122.4)) < 1e-4, `lon mismatch: ${geo.lonDeg}`);

  // When Earth rotates eastward by +90 deg (pi/2), a fixed ECI point shifts -90 deg in longitude
  const rotated = eciToLatLonDeg({ x: 6911, y: 0, z: 0 }, Math.PI / 2);
  assert.ok(Math.abs(rotated.latDeg) < 1e-4);
  assert.ok(Math.abs(rotated.lonDeg - (-90)) < 1e-4, `expected -90, got ${rotated.lonDeg}`);
});

test('perturbation zone containment handles antimeridian wrap on Gravity Wave zone', () => {
  const gravityZone = PERTURBATION_ZONES.find((z) => z.id === 'gravity-wave')!;
  // Gravity Wave starts at lon 135 with arcLength 76 deg -> spans 135..180 and -180..-149
  assert.equal(isPointInZone(0, 150, gravityZone), true);
  assert.equal(isPointInZone(-5, -160, gravityZone), true);
  assert.equal(isPointInZone(0, -100, gravityZone), false);
  assert.equal(isPointInZone(50, 150, gravityZone), false);
});

test('Mass Belt smoothly applies +2.0% speed across its defined arc length and re-triggers on next pass', () => {
  const massZone = PERTURBATION_ZONES.find((z) => z.id === 'mass-belt')!;
  // Equatorial satellite starting just west of Mass Belt (lonStart = -55, arc = 64 -> ends at +9)
  const sat = createSatellite({
    id: 'test-mass',
    name: 'Test Mass',
    color: '#38bdf8',
    altitudeKm: 540,
    inclinationDeg: 5,
    raanDeg: 0,
    initialPhaseDeg: 295, // lon = -65 deg
  });

  // Step through entire first pass (with Earth rotation held at 0 for clean arc integration)
  let simTime = 0;
  let midSpeed = 1.0;
  for (let i = 0; i < 600; i++) {
    simTime += 5;
    stepSatellite(sat, 5, simTime, 0, [massZone], 0);
    if (sat.activeZoneId === 'mass-belt' && sat.activeZoneProgress > 0.45 && sat.activeZoneProgress < 0.55) {
      midSpeed = sat.speedMultiplier;
    }
    if (sat.zoneStates['mass-belt'].passCount === 1 && !sat.zoneStates['mass-belt'].inZone) {
      break;
    }
  }

  assert.equal(sat.zoneStates['mass-belt'].passCount, 1);
  assert.ok(midSpeed > 1.005 && midSpeed < 1.015, `expected smooth mid-pass speed ~1.01, got ${midSpeed}`);
  assert.ok(
    Math.abs(sat.speedMultiplier - 1.02) < 0.002,
    `expected +2.0% total after full pass, got ${sat.speedMultiplier}`
  );

  // Continue into second full orbit pass to confirm re-triggering
  for (let i = 0; i < 1600; i++) {
    simTime += 5;
    stepSatellite(sat, 5, simTime, 0, [massZone], 0);
    const currentPassCount: number = sat.zoneStates['mass-belt'].passCount;
    if (currentPassCount === 2 && !sat.zoneStates['mass-belt'].inZone) {
      break;
    }
  }

  assert.equal(Number(sat.zoneStates['mass-belt'].passCount), 2);
  assert.ok(
    Math.abs(sat.speedMultiplier - 1.04) < 0.003,
    `expected +4.0% after 2 passes, got ${sat.speedMultiplier}`
  );
});

test('Atmospheric Drag smoothly applies -3.0% deceleration across band length', () => {
  const dragZone = PERTURBATION_ZONES.find((z) => z.id === 'atmo-drag')!;
  const sat = createSatellite({
    id: 'test-drag',
    name: 'Test Drag',
    color: '#f43f5e',
    altitudeKm: 540,
    inclinationDeg: 45,
    raanDeg: 350,
    initialPhaseDeg: 10,
  });

  let simTime = 0;
  for (let i = 0; i < 1200; i++) {
    simTime += 5;
    stepSatellite(sat, 5, simTime, 0, [dragZone], 0);
    if (sat.zoneStates['atmo-drag'].passCount === 1 && !sat.zoneStates['atmo-drag'].inZone) {
      break;
    }
  }

  assert.equal(sat.zoneStates['atmo-drag'].passCount, 1);
  assert.ok(
    sat.speedMultiplier < 0.995 && sat.speedMultiplier >= 0.969,
    `expected smooth drag deceleration up to -3%, got ${sat.speedMultiplier}`
  );
});

test('Radiation Belt applies +1% ascending and -1% descending shifts', () => {
  const radZone = PERTURBATION_ZONES.find((z) => z.id === 'rad-belt')!;
  const sat = createSatellite({
    id: 'test-rad',
    name: 'Test Rad',
    color: '#a855f7',
    altitudeKm: 540,
    inclinationDeg: 55,
    raanDeg: 290,
    initialPhaseDeg: 210, // approaching southern hemisphere
  });

  let simTime = 0;
  let sawAscending = false;
  let sawDescending = false;
  for (let i = 0; i < 4000; i++) {
    simTime += 5;
    stepSatellite(sat, 5, simTime, 0, [radZone], 0);
    if (sat.activeZoneId === 'rad-belt') {
      if (sat.activeZoneEffectText.includes('+1.0%')) sawAscending = true;
      if (sat.activeZoneEffectText.includes('-1.0%')) sawDescending = true;
    }
  }

  assert.ok(sawAscending || sawDescending, 'Satellite should transit Radiation Belt with ±1.0% effect');
});

test('collision probability increases sharply for converging close approaches and stays near zero when far apart', () => {
  const satA = createSatellite({
    id: 'sat-a',
    name: 'Aegis',
    color: '#38bdf8',
    altitudeKm: 540,
    inclinationDeg: 51.6,
    raanDeg: 0,
    initialPhaseDeg: 0,
  });
  const satB = createSatellite({
    id: 'sat-b',
    name: 'Helios',
    color: '#f59e0b',
    altitudeKm: 540,
    inclinationDeg: 51.6,
    raanDeg: 180,
    initialPhaseDeg: 0,
  });

  // Opposite sides of Earth (~13,800 km apart)
  const farMetrics = computePairCollisionMetrics(satA, satB);
  assert.ok(farMetrics.distanceKm > 10000);
  assert.ok(farMetrics.probabilityPct < 0.5, `expected ~0% when far, got ${farMetrics.probabilityPct}`);
  assert.equal(farMetrics.riskLevel, 'nominal');

  // Converging crossing trajectory ~30 seconds before ~80 km closest approach (initial sep ~460 km)
  satA.positionKm = { x: 6911, y: -225, z: 0 };
  satA.velocityKmS = { x: 0, y: 7.5, z: 0 };
  satB.positionKm = { x: 6911, y: 225, z: 80 };
  satB.velocityKmS = { x: 0, y: -7.5, z: 0 };

  const converging = computePairCollisionMetrics(satA, satB);
  assert.ok(converging.closingSpeedKmS > 10, 'should be closing rapidly');
  assert.ok(converging.closestApproachKm < 120, `expected <120km miss, got ${converging.closestApproachKm}`);
  assert.ok(converging.probabilityPct > 40, `expected elevated/critical >40%, got ${converging.probabilityPct}`);

  // Same separation, but receding instead of closing -> strictly lower risk
  satB.velocityKmS = { x: 0, y: 7.5, z: 0 };
  satA.velocityKmS = { x: 0, y: -7.5, z: 0 };
  const receding = computePairCollisionMetrics(satA, satB);
  assert.ok(
    receding.probabilityPct < converging.probabilityPct,
    `receding (${receding.probabilityPct}) should be < converging (${converging.probabilityPct})`
  );

  // Critical physical impact threshold (< 280 km) -> >= 95% probability and isImpact = true
  satA.positionKm = { x: 6911, y: 0, z: 0 };
  satB.positionKm = { x: 6911, y: 120, z: 60 };
  const impact = computePairCollisionMetrics(satA, satB);
  assert.equal(impact.isImpact, true);
  assert.ok(impact.probabilityPct >= 95);
  assert.equal(impact.riskLevel, 'critical');
});

test('predictGroundTrack dynamically reflects speedMultiplier changes', () => {
  const sat = createSatellite({
    id: 'sat-1',
    name: 'Aegis',
    color: '#38bdf8',
    altitudeKm: 540,
    inclinationDeg: 51.6,
    raanDeg: 10,
    initialPhaseDeg: 0,
  });

  const baseline = predictGroundTrack(sat, 0, 0, 2400, 40);
  sat.speedMultiplier = 1.08; // e.g., boosted via Mass Belt / maneuver
  const boosted = predictGroundTrack(sat, 0, 0, 2400, 40);

  const lastBase = baseline[baseline.length - 1];
  const lastBoost = boosted[boosted.length - 1];
  const deltaDeg = Math.hypot(lastBase.latDeg - lastBoost.latDeg, lastBase.lonDeg - lastBoost.lonDeg);

  assert.ok(deltaDeg > 5, `expected noticeable ground-track shift (>5 deg), got ${deltaDeg}`);
});
