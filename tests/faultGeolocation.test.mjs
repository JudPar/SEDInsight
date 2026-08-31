import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COORD_SOURCE,
  applyCoordinateLookup,
  georeferenceFaultBatch,
  markCoordinatesManual,
  normalizeSuministro,
  nullableFiniteNumber
} from '../lib/faultGeolocation.js';

test('nullable finite numbers preserve null, empty, zero, numeric strings and reject invalid values', () => {
  assert.equal(nullableFiniteNumber(null), null);
  assert.equal(nullableFiniteNumber(undefined), null);
  assert.equal(nullableFiniteNumber(''), null);
  assert.equal(nullableFiniteNumber('   '), null);
  assert.equal(nullableFiniteNumber(0), 0);
  assert.equal(nullableFiniteNumber('-12.123'), -12.123);
  assert.equal(nullableFiniteNumber(-12.123), -12.123);
  assert.equal(nullableFiniteNumber(Number.NaN), null);
  assert.equal(nullableFiniteNumber(Number.POSITIVE_INFINITY), null);
});

const reference = new Map([
  ['123456', { latitud: -12.05, longitud: -77.04 }],
  ['000123', { latitud: -11.9, longitud: -77.1 }]
]);

test('keeps a valid original coordinate pair', () => {
  const { faults, summary } = applyCoordinateLookup([{ suministro: '123456', coords: [-12, -77] }], reference);
  assert.deepEqual(faults[0].coords, [-12, -77]);
  assert.equal(faults[0].coordSource, COORD_SOURCE.ORIGINAL);
  assert.equal(summary.original, 1);
});

test('fills a missing pair from the supply reference', () => {
  const { faults } = applyCoordinateLookup([{ suministro: '123456', coords: null }], reference);
  assert.deepEqual(faults[0].coords, [-12.05, -77.04]);
  assert.equal(faults[0].coordSource, COORD_SOURCE.LOOKUP);
  assert.equal(faults[0].coordLookupSuministro, '123456');
});

test('leaves a fault without coordinates when no reference exists', () => {
  const { faults, summary } = applyCoordinateLookup([{ suministro: '999999', coords: null }], reference);
  assert.equal(faults[0].coords, null);
  assert.equal(faults[0].coordSource, null);
  assert.equal(summary.withoutReference, 1);
});

test('replaces a partial pair completely instead of mixing sources', () => {
  const { faults } = applyCoordinateLookup([{ suministro: '123456', latitud: -10, longitud: null }], reference);
  assert.deepEqual(faults[0].coords, [-12.05, -77.04]);
});

test('trims surrounding spaces in supply values', () => {
  assert.equal(normalizeSuministro(' 123456 '), '123456');
});

test('removes only an Excel integer decimal suffix', () => {
  assert.equal(normalizeSuministro('123456.00'), '123456');
  assert.equal(normalizeSuministro('12.30'), '12.30');
});

test('preserves leading zeroes', () => {
  assert.equal(normalizeSuministro('000123'), '000123');
});

test('deduplicates supplies and applies one lookup result to every fault', async () => {
  let queryCount = 0;
  const client = {
    from: () => ({
      select: () => ({
        in: async () => {
          queryCount += 1;
          return { data: [{ suministro: '123456', latitud: -12.05, longitud: -77.04 }], error: null };
        }
      })
    })
  };
  const { faults } = await georeferenceFaultBatch(client, [
    { suministro: '123456', coords: null },
    { suministro: '123456', coords: null }
  ]);
  assert.equal(queryCount, 1);
  assert.deepEqual(faults.map((fault) => fault.coords), [[-12.05, -77.04], [-12.05, -77.04]]);
});

test('marks a moved automatic point as manual and preserves lookup supply', () => {
  const moved = markCoordinatesManual({
    coords: [-12.05, -77.04],
    coordSource: COORD_SOURCE.LOOKUP,
    coordLookupSuministro: '123456'
  }, [-12.06, -77.05]);
  assert.equal(moved.coordSource, COORD_SOURCE.MANUAL);
  assert.equal(moved.coordLookupSuministro, '123456');
});

test('a lookup error assigns no inferred coordinates and reports the failure', async () => {
  const client = {
    from: () => ({
      select: () => ({ in: async () => ({ data: null, error: new Error('network unavailable') }) })
    })
  };
  const { faults, summary } = await georeferenceFaultBatch(client, [
    { suministro: '123456', coords: null },
    { suministro: '123456', coords: [-12, -77] }
  ]);
  assert.equal(faults[0].coords, null);
  assert.deepEqual(faults[1].coords, [-12, -77]);
  assert.equal(summary.lookupFailed, true);
});
