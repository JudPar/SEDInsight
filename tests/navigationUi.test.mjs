import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  filterLlaveIdsByStatus,
  filterSedsByCircuitStatus,
  resolvePresentationLlaveSelection,
  resolvePresentationSedSelection,
  sortLlaveIds
} from '../lib/navigationSort.js';
import { getDrawableLineCoordinates } from '../lib/coordUtils.js';

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing source section: ${start}`);
  return source.slice(startIndex, endIndex);
}

test('llaves use stable natural alphanumeric ordering', () => {
  assert.deepEqual(sortLlaveIds(['T-10', 'T-2', 'T-03', 'T-01']), ['T-01', 'T-2', 'T-03', 'T-10']);
});

test('status filter visibly limits SED and llave navigation options', () => {
  const database = {
    SED1: { llaves: { 'T-10': { analysis: { status: 'en_proceso' } }, 'T-02': { analysis: { status: 'cargado' } } } },
    SED2: { llaves: { 'T-01': { analysis: { status: 'analizado' } } } }
  };

  assert.deepEqual(filterLlaveIdsByStatus(database.SED1.llaves, 'cargado'), ['T-02']);
  assert.deepEqual(Object.keys(filterSedsByCircuitStatus(database, 'cargado')), ['SED1']);
  assert.deepEqual(filterLlaveIdsByStatus(database.SED1.llaves, 'todos'), ['T-02', 'T-10']);
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
  assert.match(hud, /filterLlaveIdsByStatus/);
  assert.match(hud, /Todas las llaves/);
  assert.match(hud, /circuit-status-chip/);
  assert.match(hud, /filterLlaveIdsByStatus/);
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

test('SED and llave changes preserve the current edit or presentation mode', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const sedSelection = sourceSection(page, 'const handleSedSelect', 'const handlePresentationSedSelect');
  const llaveSelection = sourceSection(page, 'const handleEditLlaveSelect', 'const handleToggleFullSedView');

  assert.doesNotMatch(sedSelection, /setIsPresentationMode/);
  assert.doesNotMatch(llaveSelection, /setIsPresentationMode/);
  assert.match(sedSelection, /runNavigationTransition\('Cargando SED\.\.\.'/);
  assert.match(llaveSelection, /runNavigationTransition\('Cargando circuito\.\.\.'/);
});

test('dynamic SED URL synchronization does not navigate away from the mounted GEOPLUZ view', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(page, /replaceBrowserPath\(nextPath\)/);
  assert.doesNotMatch(page, /useRouter|usePathname|router\.replace\(nextPath/);
});

test('mode toggles repeatedly change only the explicit presentation flag', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const enterEdit = sourceSection(page, 'async function handleEnterEditMode', 'function handleEnterPresentationMode');
  const enterPresentation = sourceSection(page, 'function handleEnterPresentationMode', 'async function handleImportMonthly');

  assert.match(enterEdit, /setIsPresentationMode\(false\)/);
  assert.match(enterPresentation, /setIsPresentationMode\(true\)/);
  assert.doesNotMatch(`${enterEdit}${enterPresentation}`, /setCurrentSedId|setCurrentLlaveId|setShowFullSedView/);
});

test('loading feedback covers navigation and circuit analysis and always clears analysis loading', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const analysis = sourceSection(page, 'async function handleAnalyzeCurrentCircuit', 'function handleSelectAnalysisSegment');

  assert.match(page, /frontend-loading-status/);
  assert.match(page, /Analizando circuito\.\.\./);
  assert.match(page, /isNavigationPending/);
  assert.match(analysis, /try\s*\{/);
  assert.match(analysis, /finally\s*\{\s*setIsAnalyzingCircuit\(false\)/);
});

test('sidebar owns one stable vertical scroll area for dynamically growing analysis', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const sidebar = sourceSection(css, '#sidebar, .sidebar {', '.header-brand {');
  const content = sourceSection(css, '.sidebar-content {', '/* === CARDS === */');

  assert.match(sidebar, /min-height:\s*0/);
  assert.match(sidebar, /overflow:\s*hidden/);
  assert.match(content, /overflow-y:\s*auto/);
  assert.match(content, /overflow-x:\s*hidden/);
  assert.match(content, /min-height:\s*0/);
  assert.match(css, /\.sidebar-section\s*\{[^}]*flex:\s*0 0 auto/s);
});

test('editing sidebar behaves as a collapsed single-section accordion and follows the opened item', () => {
  const sidebar = readFileSync(new URL('../components/Sidebar.js', import.meta.url), 'utf8');
  const projectPanel = readFileSync(new URL('../components/ProjectPanel.js', import.meta.url), 'utf8');
  const dataPanel = readFileSync(new URL('../components/DataManagementPanel.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

  assert.match(sidebar, /\[openSection, setOpenSection\] = useState\(null\)/);
  assert.match(sidebar, /setOpenSection\(current => current === sectionId \? null : sectionId\)/);
  for (const sectionId of ['projects', 'data-management', 'temporary-data', 'navigation', 'circuit-analysis', 'report-export']) {
    assert.match(sidebar, new RegExp(`openSection === '${sectionId}'`));
  }
  assert.match(projectPanel, /open=\{expanded\}/);
  assert.match(dataPanel, /open=\{expanded\}/);
  assert.match(sidebar, /container\.scrollTo\(\{/);
  assert.match(sidebar, /behavior: 'smooth'/);
  assert.match(css, /scroll-behavior:\s*smooth/);
  assert.doesNotMatch(`${sidebar}${projectPanel}${dataPanel}`, /className="sidebar-section"\s+open>/);
});

test('map drawing rejects incomplete geometry instead of throwing during mode changes', () => {
  assert.deepEqual(getDrawableLineCoordinates(null), []);
  assert.deepEqual(getDrawableLineCoordinates([]), []);
  assert.deepEqual(getDrawableLineCoordinates([[-12, -77]]), []);
  assert.deepEqual(getDrawableLineCoordinates([[-12, -77], null]), []);
  assert.deepEqual(getDrawableLineCoordinates([[-12, -77], ['bad', -77]]), []);
  assert.deepEqual(getDrawableLineCoordinates([[-12, -77], [-12.1, -77.1]]), [[-12, -77], [-12.1, -77.1]]);

  const map = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');
  assert.match(map, /Array\.isArray\(llaveData\?\.lines\)/);
});
