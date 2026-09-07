import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSedOverviewLlaves, filterFaultsForCircuitView, getStableLlaveColor } from '../lib/sedOverview.js';

const sed = {
  llaves: {
    L2: { name: 'Llave dos', lines: [{ id: 'line-2' }], analysis: { cableGroups: [] } },
    L1: { name: 'Llave uno', lines: [{ id: 'line-1a' }, { id: 'line-1b' }], analysis: { cableGroups: [] } }
  }
};

const faults = [
  { id: 1, sed: '00338S', llaveSistema: 'L1', sedLlave: '00338S-L1' },
  { id: 2, sed: '00338S', llaveSistema: 'L2', sedLlave: '00338S-L2' },
  { id: 3, sed: '', llaveSistema: '', sedLlave: 'SED-00338S' },
  { id: 3, sed: '', llaveSistema: '', sedLlave: 'SED-00338S' },
  { id: 4, sed: '00813S', llaveSistema: 'A1', sedLlave: '00813S-A1' }
];

test('SED overview exposes every llave and every line with deterministic colors', () => {
  const first = buildSedOverviewLlaves(sed, 'L1');
  const second = buildSedOverviewLlaves(sed, 'L1');

  assert.deepEqual(first.map(item => item.llaveId), ['L1', 'L2']);
  assert.equal(first.flatMap(item => item.lines).length, 3);
  assert.equal(first.find(item => item.llaveId === 'L1').isSelected, true);
  assert.deepEqual(second, first);
  assert.equal(getStableLlaveColor('L1'), getStableLlaveColor('L1'));
  assert.notEqual(getStableLlaveColor('L1'), getStableLlaveColor('L2'));
});

test('normal view keeps the existing SED and llave filter', () => {
  const visible = filterFaultsForCircuitView(faults, { sedId: '00338S', llaveId: 'L1', showFullSed: false });
  assert.deepEqual(visible.map(point => point.id), [1]);
});

test('full SED view includes every llave plus SED-only faults exactly once', () => {
  const visible = filterFaultsForCircuitView(faults, { sedId: '00338S', llaveId: 'L1', showFullSed: true });
  assert.deepEqual(visible.map(point => point.id), [1, 2, 3]);
  assert.equal(visible.filter(point => point.id === 3).length, 1);
  assert.equal(visible.find(point => point.id === 3).llaveSistema, '');
});

test('disabling full view restores the selected llave and changing SED recalculates without changing the mode', () => {
  const fullFirstSed = filterFaultsForCircuitView(faults, { sedId: '00338S', llaveId: 'L1', showFullSed: true });
  const normalFirstSed = filterFaultsForCircuitView(faults, { sedId: '00338S', llaveId: 'L1', showFullSed: false });
  const fullSecondSed = filterFaultsForCircuitView(faults, { sedId: '00813S', llaveId: 'A1', showFullSed: true });

  assert.deepEqual(fullFirstSed.map(point => point.id), [1, 2, 3]);
  assert.deepEqual(normalFirstSed.map(point => point.id), [1]);
  assert.deepEqual(fullSecondSed.map(point => point.id), [4]);
});

test('UI keeps circuit analysis scoped to selectedLlavePoints while the map receives full SED data', () => {
  const pageSource = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../components/Sidebar.js', import.meta.url), 'utf8');
  const mapSource = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');

  assert.match(pageSource, /analyzeCircuit\(linesData, selectedLlavePoints,/);
  assert.match(pageSource, /showFullSedView\s*\? fullSedPoints\.map/);
  assert.match(pageSource, /: analysisSegmentFaultView\.faults/);
  assert.match(sidebarSource, /Ver SED completa/);
  assert.match(sidebarSource, /Ver solo llave/);
  assert.match(sidebarSource, /Análisis: \{currentLlaveId\}/);
  assert.match(mapSource, /showFullSedView\s*\? sedOverviewLlaves/);
  assert.match(mapSource, /Llaves de la SED/);
});
