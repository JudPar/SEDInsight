import test from 'node:test';
import assert from 'node:assert/strict';
import { getSpiderfyPositions, groupOverlappingPoints } from '../lib/overlappingMarkers.js';

test('groups markers at exactly the same pixel', () => {
  const groups = groupOverlappingPoints([
    { key: 'a', x: 100, y: 100 },
    { key: 'b', x: 100, y: 100 },
    { key: 'c', x: 100, y: 100 }
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((item) => item.key), ['a', 'b', 'c']);
});

test('groups two markers at exactly the same pixel', () => {
  const groups = groupOverlappingPoints([
    { key: 'a', x: 50, y: 50 },
    { key: 'b', x: 50, y: 50 }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
});

test('handles many identical markers through the exact-coordinate shortcut', () => {
  const items = Array.from({ length: 2000 }, (_, index) => ({ key: String(index), x: 75, y: 90 }));
  const groups = groupOverlappingPoints(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2000);
});

test('groups visually close markers and keeps distant markers individual', () => {
  const groups = groupOverlappingPoints([
    { key: 'a', x: 10, y: 10 },
    { key: 'b', x: 34, y: 10 },
    { key: 'c', x: 100, y: 100 }
  ], 30);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.items.some((item) => item.key === 'a')).items.length, 2);
  assert.equal(groups.find((group) => group.items.some((item) => item.key === 'c')).items.length, 1);
});

test('changes grouping when projected pixel distance changes with zoom', () => {
  const lowZoom = groupOverlappingPoints([
    { key: 'a', x: 100, y: 100 },
    { key: 'b', x: 118, y: 100 }
  ], 30);
  const highZoom = groupOverlappingPoints([
    { key: 'a', x: 100, y: 100 },
    { key: 'b', x: 164, y: 100 }
  ], 30);
  assert.equal(lowZoom.length, 1);
  assert.equal(highZoom.length, 2);
});

test('spiderfy returns a distinct visual position for every marker', () => {
  const positions = getSpiderfyPositions({ x: 200, y: 200 }, 12);
  assert.equal(positions.length, 12);
  assert.equal(new Set(positions.map(({ x, y }) => `${x}:${y}`)).size, 12);
  assert.ok(positions.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

test('spiderfy calculations do not mutate real coordinates', () => {
  const items = [
    { key: 'a', coords: [-12.1, -77.1], x: 100, y: 100 },
    { key: 'b', coords: [-12.1, -77.1], x: 100, y: 100 }
  ];
  const originalCoordinates = items.map((item) => [...item.coords]);
  const [group] = groupOverlappingPoints(items);
  getSpiderfyPositions(group.center, group.items.length);
  assert.deepEqual(items.map((item) => item.coords), originalCoordinates);
});
