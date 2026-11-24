import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLISION_RADIUS_KM,
  LEVEL_CONFIGS,
  ZONE_TEMPLATES,
  computeSatKinematics,
  computeZoneTransitDelta,
  createPlacedZone,
  createPuzzleSatellites,
  evaluatePuzzlePlan,
  latLonToGridCell,
  stepPuzzleSimulation,
} from './puzzleEngine';

function findApproachCell(satIdx: number, level = 1, targetPhaseOffsetDeg = 15) {
  const cfg = LEVEL_CONFIGS[level].satellites[satIdx];
  const phase = (cfg.initialPhaseDeg + targetPhaseOffsetDeg) % 360;
  const kin = computeSatKinematics(cfg.altitudeKm, cfg.inclinationDeg, cfg.raanDeg, phase, cfg.baseSpeed);
  return latLonToGridCell(kin.latDeg, kin.lonDeg);
}

test('exact t = L / v_modified transit math holds and reverts cleanly upon zone exit', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const satCfg = LEVEL_CONFIGS[1].satellites[0]; // v = 10.0 u/s
  const sats = createPuzzleSatellites([satCfg]);
  const startCell = latLonToGridCell(sats[0].latDeg, sats[0].lonDeg);
  const zone = createPlacedZone(dragTpl, startCell.row, startCell.col, 'drag-1');

  const expected = computeZoneTransitDelta(60, 10.0, -0.03);
  assert.ok(Math.abs(expected.modifiedSpeed - 9.7) < 1e-6);
  assert.ok(Math.abs(expected.modifiedTimeSec - 60 / 9.7) < 1e-6);
  assert.ok(Math.abs(expected.deltaSec - 0.185567) < 1e-4);

  let insideTime = 0;
  let speedWhileInside = 0;
  let t = 0;
  const dt = 0.01;
  while (t < 10.0) {
    t += dt;
    stepPuzzleSimulation(sats, [zone], dt);
    if (sats[0].transits['drag-1']?.active) {
      insideTime += dt;
      speedWhileInside = sats[0].speed;
    }
    if (sats[0].transits['drag-1']?.passesCompleted === 1) break;
  }

  assert.ok(Math.abs(speedWhileInside - 9.7) < 1e-6, `Expected 9.7 u/s inside zone, got ${speedWhileInside}`);
  assert.ok(Math.abs(insideTime - expected.modifiedTimeSec) < 0.03, `Expected ~${expected.modifiedTimeSec.toFixed(2)}s transit, got ${insideTime.toFixed(2)}s`);
  assert.equal(sats[0].speed, 10.0, 'Speed must revert cleanly to baseSpeed upon exit');
});

test('Level 1 with 0 zones placed collides exactly between SAT-1 and SAT-2 at t = 12.0s', () => {
  const res = evaluatePuzzlePlan([], LEVEL_CONFIGS[1]);
  assert.equal(res.survived, false);
  assert.deepEqual(res.collidedPairIds, ['sat-1', 'sat-2']);
  assert.ok(Math.abs(res.firstClosePassSec - 12.0) < 0.4, `Expected collision near 12.0s, got ${res.firstClosePassSec}`);
});

test('Level 1 with only Atmo Drag (-3%) collides cleanly with insufficient separation (~159 km < 230 km)', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const cell1 = findApproachCell(0, 1, 12);
  const dragZone = createPlacedZone(dragTpl, cell1.row, cell1.col, 'only-drag');

  const res = evaluatePuzzlePlan([dragZone], LEVEL_CONFIGS[1]);
  assert.equal(res.survived, false, 'Single -3% Drag alone should remain just under 230 km threshold');
  assert.deepEqual(res.collidedPairIds, ['sat-1', 'sat-2']);
  assert.ok(res.firstPairMinSepKm <= COLLISION_RADIUS_KM);
});

test('Level 1 Exact Solution A: Atmo Drag (-3%, 60u) on SAT-1 + Mass Belt (+2%, 60u) on SAT-2 clears all 10 periods', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const massTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'mass-belt')!;

  const cell1 = findApproachCell(0, 1, 12);
  const cell2 = findApproachCell(1, 1, 12);

  const z1 = createPlacedZone(dragTpl, cell1.row, cell1.col, 'sol-drag');
  const z2 = createPlacedZone(massTpl, cell2.row, cell2.col, 'sol-mass');

  const res = evaluatePuzzlePlan([z1, z2], LEVEL_CONFIGS[1]);
  assert.equal(
    res.survived,
    true,
    `Expected Atmo Drag + Mass Belt to clear 10 periods, failed ${res.collidedPairIds} at t=${res.firstClosePassSec}`
  );
  assert.equal(res.firstPeriod, 10);
  assert.ok(res.globalMinSepKm > COLLISION_RADIUS_KM, `Expected min sep > ${COLLISION_RADIUS_KM} km, got ${res.globalMinSepKm}`);
});

test('Level 1 Exact Solution B: Atmo Drag (-3%, 60u) + Gravity Tide (-1.5%, 60u) survives all 10 periods', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const tideTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'gravity-tide')!;

  const cell1a = findApproachCell(0, 1, 8);
  const cell1b = findApproachCell(0, 1, 55); // sequential after 60u drag? or Gravity Tide +1.5% on SAT-2!
  const cell2 = findApproachCell(1, 1, 12);

  const zDrag = createPlacedZone(dragTpl, cell1a.row, cell1a.col, 'sol-drag');
  const zTideOpposite = createPlacedZone(tideTpl, cell2.row, cell2.col, 'sol-tide', +0.015);
  assert.notEqual(`${cell1a.row},${cell1a.col}`, `${cell1b.row},${cell1b.col}`);

  const res = evaluatePuzzlePlan([zDrag, zTideOpposite], LEVEL_CONFIGS[1]);
  assert.equal(
    res.survived,
    true,
    `Expected Drag (-3%) on SAT-1 + Tide (+1.5%) on SAT-2 to survive 10 periods, failed at t=${res.firstClosePassSec}`
  );
});

test('Level 1 wrong-polarity Tide (-1.5%) on SAT-2 cancels Drag (-3%) on SAT-1 and collides', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const tideTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'gravity-tide')!;

  const cell1 = findApproachCell(0, 1, 12);
  const cell2 = findApproachCell(1, 1, 12);

  const zDrag = createPlacedZone(dragTpl, cell1.row, cell1.col, 'drag');
  const zTideSameSign = createPlacedZone(tideTpl, cell2.row, cell2.col, 'tide-neg', -0.015);

  const res = evaluatePuzzlePlan([zDrag, zTideSameSign], LEVEL_CONFIGS[1]);
  assert.equal(res.survived, false, 'Both satellites slowed in same direction should cancel out and collide');
  assert.deepEqual(res.collidedPairIds, ['sat-1', 'sat-2']);
});

test('Level 2 (LCM Pendulum): SAT-1 (T=36s) & SAT-2 (T=30s) miss early passes then collide at t=84.0s; broken by Atmo Drag (-3%) + Mass Belt (+2%)', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const massTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'mass-belt')!;
  const radTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'rad-belt')!;

  const unsolved = evaluatePuzzlePlan([], LEVEL_CONFIGS[2]);
  assert.equal(unsolved.survived, false);
  assert.deepEqual(unsolved.collidedPairIds, ['sat-1', 'sat-2']);
  assert.ok(Math.abs(unsolved.firstClosePassSec - 84.0) < 0.5, `Expected LCM convergence near 84.0s, got ${unsolved.firstClosePassSec}`);

  // Small ±1% Radiation Belt alone cannot break the LCM convergence sufficiently
  const cell1 = findApproachCell(0, 2, 140);
  const weak = evaluatePuzzlePlan([createPlacedZone(radTpl, cell1.row, cell1.col, 'l2-rad', -0.01)], LEVEL_CONFIGS[2]);
  assert.equal(weak.survived, false, 'Weak ±1% shift should still collide at t=84.0s');

  // Shifting SAT-1 & SAT-2 timing with Drag (-3%) + Mass Belt (+2%) clears all 10 periods (0..360s)
  const cell2 = findApproachCell(1, 2, 60);
  const z1 = createPlacedZone(dragTpl, cell1.row, cell1.col, 'l2-drag');
  const z2 = createPlacedZone(massTpl, cell2.row, cell2.col, 'l2-mass');
  const solved = evaluatePuzzlePlan([z1, z2], LEVEL_CONFIGS[2]);
  assert.equal(solved.survived, true, `Expected Level 2 LCM convergence to clear all 10 periods, failed ${solved.collidedPairIds} at t=${solved.firstClosePassSec}`);
  assert.ok(solved.globalMinSepKm > COLLISION_RADIUS_KM);
});

test('Level 3 (Zeno Pursuit + 5 Perpendicular Cross-Traffic): 7 satellites, 0 single-zone solutions, solved by sequential zones', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const tideTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'gravity-tide')!;
  const radTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'rad-belt')!;
  const cfg3 = LEVEL_CONFIGS[3];

  assert.equal(cfg3.satellites.length, 7, 'Level 3 must have 2 pursuing + 5 perpendicular satellites');
  const polarCount = cfg3.satellites.filter((s) => s.inclinationDeg === 90).length;
  assert.equal(polarCount, 5, 'Level 3 must have exactly 5 perpendicular cross-traffic satellites');

  // Unsolved baseline collides cleanly
  const unsolved = evaluatePuzzlePlan([], cfg3);
  assert.equal(unsolved.survived, false);
  assert.deepEqual(unsolved.collidedPairIds, ['sat-1', 'sat-7']);

  // Single-zone adjustment along pursuit corridor is insufficient
  const single = evaluatePuzzlePlan([createPlacedZone(dragTpl, 3, 4, 'l3-single')], cfg3);
  assert.equal(single.survived, false, 'Single zone adjustment must not solve Level 3');

  // Sequential/graduated placement along pursuit corridor shapes timing & spacing to survive all 10 periods
  const seqZones = [
    createPlacedZone(dragTpl, 3, 4, 'l3-drag'),
    createPlacedZone(tideTpl, 3, 5, 'l3-tide', -0.015),
    createPlacedZone(radTpl, 4, 10, 'l3-rad', -0.01),
  ];
  const solved = evaluatePuzzlePlan(seqZones, cfg3);
  assert.equal(solved.survived, true, `Expected Level 3 sequential placement to survive 10 periods, failed ${solved.collidedPairIds} at t=${solved.firstClosePassSec}`);
  assert.ok(solved.globalMinSepKm > COLLISION_RADIUS_KM, `Expected minSep > ${COLLISION_RADIUS_KM}, got ${solved.globalMinSepKm}`);

  // Verify Tortoise (SAT-1) and Achilles (SAT-2) exhibit repeated close-pursuit + separation cycles
  const sats = createPuzzleSatellites(cfg3.satellites);
  let closeApproaches = 0;
  let inClose = false;
  for (let t = 0; t < 360; t += 0.05) {
    stepPuzzleSimulation(sats, seqZones, 0.05);
    const d12 = Math.hypot(
      sats[1].positionKm.x - sats[0].positionKm.x,
      sats[1].positionKm.y - sats[0].positionKm.y,
      sats[1].positionKm.z - sats[0].positionKm.z
    );
    if (d12 < 750 && !inClose) {
      inClose = true;
      closeApproaches += 1;
    } else if (d12 > 950 && inClose) {
      inClose = false;
    }
  }
  assert.ok(closeApproaches >= 2, `Expected repeated pursuit close-and-separate cycles, got ${closeApproaches}`);
});

test('Pause & Resume preserves exact satellite phase, velocity, and active zone timer mid-transit', () => {
  const dragTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'atmo-drag')!;
  const massTpl = ZONE_TEMPLATES.find((z) => z.typeId === 'mass-belt')!;
  const zDrag = createPlacedZone(dragTpl, 1, 2, 'drag-l1');
  const zMass = createPlacedZone(massTpl, 6, 2, 'mass-l1');
  const zones = [zDrag, zMass];

  // Uninterrupted reference run over 15.0s (300 steps of 0.05s)
  const refSats = createPuzzleSatellites(LEVEL_CONFIGS[1].satellites);
  for (let i = 0; i < 300; i++) {
    stepPuzzleSimulation(refSats, zones, 0.05);
  }

  // Paused-and-resumed run: step 90 ticks (4.5s -> SAT-1 is mid-transit inside Atmo Drag),
  // snapshot & verify active zone timer, then resume for remaining 210 ticks (10.5s).
  const pausedSats = createPuzzleSatellites(LEVEL_CONFIGS[1].satellites);
  let simSec = 0;
  for (let i = 0; i < 90; i++) {
    simSec += 0.05;
    stepPuzzleSimulation(pausedSats, zones, 0.05);
  }

  const sat1AtPause = pausedSats[0];
  const dragTransit = sat1AtPause.transits[zDrag.id];
  assert.ok(dragTransit && dragTransit.active, 'SAT-1 must be actively traversing Atmo Drag at t=4.5s');
  assert.ok(dragTransit.arcRemainingUnits > 0 && dragTransit.arcRemainingUnits < zDrag.lengthUnits);
  assert.ok(Math.abs(sat1AtPause.speed - 9.7) < 1e-6, `Expected paused speed 9.70 inside A.D, got ${sat1AtPause.speed}`);

  // Resume for remaining 210 ticks (10.5s) from frozen paused state
  for (let i = 0; i < 210; i++) {
    simSec += 0.05;
    stepPuzzleSimulation(pausedSats, zones, 0.05);
  }

  assert.ok(Math.abs(simSec - 15.0) < 1e-9);
  for (let s = 0; s < refSats.length; s++) {
    assert.ok(Math.abs(pausedSats[s].phaseDeg - refSats[s].phaseDeg) < 1e-9, `Phase mismatch on sat ${s}`);
    assert.ok(Math.abs(pausedSats[s].speed - refSats[s].speed) < 1e-9, `Speed mismatch on sat ${s}`);
    assert.deepEqual(pausedSats[s].transits, refSats[s].transits, `Transit state mismatch on sat ${s}`);
  }
});


