import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolvePresentationLlaveSelection,
  resolvePresentationSedSelection,
  sortLlaveIds
} from '../lib/navigationSort.js';

test('llaves use stable natural alphanumeric ordering', () => {
  assert.deepEqual(sortLlaveIds(['T-10', 'T-2', 'T-03', 'T-01']), ['T-01', 'T-2', 'T-03', 'T-10']);
});

test('selecting any SED starts in full SED view with no stale llave', () => {
  assert.deepEqual(resolvePresentationSedSelection('00007S'), {
    sedId: '00007S',
    llaveId: '',
    showFullSedView: true
  });
  assert.deepEqual(resolvePresentationSedSelection('ONE-KEY'), {
    sedId: 'ONE-KEY',
    llaveId: '',
    showFullSedView: true
  });
});

test('a llave selects its circuit and Todas las llaves restores the full SED', () => {
  assert.deepEqual(resolvePresentationLlaveSelection('00007S', 'T-03'), {
    sedId: '00007S',
    llaveId: 'T-03',
    showFullSedView: false
  });
  assert.deepEqual(resolvePresentationLlaveSelection('00007S', ''), {
    sedId: '00007S',
    llaveId: '',
    showFullSedView: true
  });
});

test('presentation HUD orders SED search, llave selector and status filter without redundant title', () => {
  const hud = readFileSync(new URL('../components/PresentationHUD.js', import.meta.url), 'utf8');
  const searchPosition = hud.indexOf('<SearchableSedSelect');
  const llavePosition = hud.indexOf('className="hud-llave-select"');
  const statusPosition = hud.indexOf('className="hud-status-select"');

  assert.ok(searchPosition >= 0 && searchPosition < llavePosition && llavePosition < statusPosition);
  assert.match(hud, /compact/);
  assert.match(hud, /sortLlaveIds/);
  assert.match(hud, /Todas las llaves/);
  assert.doesNotMatch(hud, /hud-title|SED \{cleanSed\}/);
});

test('editing and presentation selectors share natural sorting without changing analysis scope', () => {
  const sidebar = readFileSync(new URL('../components/Sidebar.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

  assert.match(sidebar, /sortLlaveIds\(Object\.keys\(seds\[currentSedId\]\.llaves\)\)/);
  assert.match(page, /analyzeCircuit\(linesData, selectedLlavePoints,/);
  assert.match(page, /showFullSedView \? fullSedPoints : analysisSegmentFaultView\.faults/);
  assert.match(page, /points=\{visibleFaultPoints\}/);
});
