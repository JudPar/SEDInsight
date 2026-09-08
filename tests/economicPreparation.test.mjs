import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisPeriod } from '../lib/faultPeriods.js';
import { prepareMonthlyFaultImport, readCallCountFromRow } from '../lib/monthlyFaultImport.js';
import { compensationPeriodMonths, formatCompensationPeriodRange, mergeCircuitCompensationPeriodRows, prepareMonthlyCircuitCompensationImport, prepareMonthlyCompensationImport, summarizeCircuitCompensationPeriods } from '../lib/monthlyCompensationImport.js';
import { buildSedPeriodMetrics, reconcileSedPeriodMetrics } from '../lib/sedMetrics.js';
import { canonicalCircuitKey, normalizeLlaveCode, normalizeSedId } from '../lib/sedUtils.js';
import { analyzeCircuit, resolveLineMounting } from '../lib/circuitAnalysis.js';
import { buildManualEdgeCatalog, createManualAnalysisUnits, resolveManualGroupEdgeRefs } from '../lib/manualAnalysisUnits.js';
import { createProjectDocument, projectToInternalModel } from '../lib/projectMappers.js';
import { validateProject } from '../lib/projectValidation.js';
import { getDrawableLineCoordinates } from '../lib/coordUtils.js';
import { buildEconomicAnalysisInput } from '../lib/economicAnalysisInput.js';

const seds = {
  '00338S': { name: 'SED 338', llaves: { A: {} } },
  '00813S': { name: 'SED 813', llaves: {} }
};

test('canonical SED identity preserves zeroes and removes only presentation noise', () => {
  assert.equal(normalizeSedId(' 00338s\u200b '), '00338S');
  assert.equal(normalizeSedId('338S'), '338S');
  assert.notEqual(normalizeSedId('00338S-A'), normalizeSedId('00338S'));
});

test('monthly imports resolve canonical SED identity without changing stored permanent id', () => {
  const faults = prepareMonthlyFaultImport({ fallas: [
    { id: 'A', sed_id: ' 00338s\u200b ', hora_inicio: '01/09/2026' }
  ] }, Object.keys(seds));
  const compensation = prepareMonthlyCompensationImport([
    { SED: '00338s', period_key: '2026-09', compensation: 0 }
  ], Object.keys(seds));
  assert.equal(faults.rows[0].sed_id, '00338S');
  assert.deepEqual(compensation.periods[0].rows[0], { sed_id: '00338S', period_key: '2026-09', compensation: 0 });
});

test('all call aliases preserve zero and distinguish missing data', () => {
  for (const key of ['call_count', 'callCount', 'Llamadas', 'cantidad_llamadas', 'cantidadLlamadas']) {
    assert.deepEqual(readCallCountFromRow({ [key]: 0 }), { valid: true, value: 0, provided: true });
  }
  assert.deepEqual(readCallCountFromRow({}), { valid: true, value: null, provided: false });
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(page, /readCallCountFromRow\(pt\)/);
  assert.match(page, /callCount: calls\.valid \? calls\.value : null/);
});

test('SED metrics do not coerce an empty call value into a known zero', () => {
  const metric = buildSedPeriodMetrics(seds, [
    { sed: '00338S', periodKey: '2026-08', callCount: '' }
  ], [], ['2026-08']).find(item => item.sedId === '00338S');
  assert.deepEqual([metric.callCount, metric.callsWithData, metric.callsMissing], [0, 0, 1]);
  assert.equal(metric.callDataAvailable, false);
});

test('SED metrics and reconciliation share canonical selected-period totals', () => {
  const faults = [
    { sed: '00338s', periodKey: '2026-07', callCount: 0 },
    { sed: '00338S\u200b', periodKey: '2026-08', callCount: null },
    { sed: '00338S', periodKey: '2026-09', callCount: 99 }
  ];
  const compensation = [
    { sedId: '00338s', periodKey: '2026-07', compensation: 0 },
    { sedId: '00338S', periodKey: '2026-08', compensation: 25 },
    { sedId: '00338S', periodKey: '2026-09', compensation: 100 }
  ];
  const selected = ['2026-07', '2026-08'];
  const metric = buildSedPeriodMetrics(seds, faults, compensation, selected).find(item => item.sedId === '00338S');
  const audit = reconcileSedPeriodMetrics(seds, faults, compensation, selected, '00338s');
  assert.deepEqual([metric.faultCount, metric.callsWithData, metric.callsMissing, metric.callCount], [2, 1, 1, 0]);
  assert.deepEqual([metric.compensation, metric.compensationDataAvailable, metric.compensationDataComplete], [25, true, true]);
  assert.deepEqual(audit.compensation.byPeriod, [
    { periodKey: '2026-07', value: 0, available: true },
    { periodKey: '2026-08', value: 25, available: true }
  ]);
  assert.equal(audit.calls.totalKnown, 0);
});

test('reconciliation exposes partial calls, absent compensation and suspicious repetition without assigning semantics', () => {
  const faults = [
    { sed: '00338S', periodKey: '2026-08', callCount: 4 },
    { sed: '00338S', periodKey: '2026-08', callCount: 4 },
    { sed: '00338S', periodKey: '2026-08', callCount: null }
  ];
  const audit = reconcileSedPeriodMetrics(seds, faults, [], ['2026-08'], '00338S');
  assert.deepEqual([audit.calls.recordsWithData, audit.calls.recordsWithoutData, audit.calls.totalKnown], [2, 1, 8]);
  assert.deepEqual(audit.calls.diagnostics.repeatedValues, [{ periodKey: '2026-08', value: 4, occurrences: 2 }]);
  assert.equal(audit.compensation.totalKnown, null);
  assert.deepEqual(audit.compensation.periodsMissing, ['2026-08']);
});

test('analysis period sums only selected calendar months and reports discontinuities', () => {
  const result = buildAnalysisPeriod(['2026-01', '2026-03'], [{ periodKey: '2026-01' }, { periodKey: '2026-03' }]);
  assert.deepEqual(result.selectedPeriodKeys, ['2026-01', '2026-03']);
  assert.equal(result.startDate, '2026-01-01');
  assert.equal(result.endDate, '2026-03-31');
  assert.equal(result.exposureDays, 62);
  assert.ok(Math.abs(result.exposureYears - 62 / 365.2425) < 1e-12);
  assert.equal(result.hasGaps, true);
  assert.deepEqual(result.gaps, [{ after: '2026-01', before: '2026-03', missingMonths: 1 }]);
  assert.equal(result.coverage.status, 'complete');
});

test('analysis period reports missing metadata separately from calendar exposure', () => {
  const result = buildAnalysisPeriod(['2026-01', '2026-02'], [{ period_key: '2026-01', row_count: 2 }]);
  assert.equal(result.exposureDays, 59);
  assert.deepEqual(result.coverage.missingPeriodKeys, ['2026-02']);
  assert.equal(result.coverage.status, 'partial');
});

test('circuit identity preserves SED and llave as separate canonical values', () => {
  assert.equal(normalizeLlaveCode(' 2sp\u200b '), '2SP');
  assert.equal(canonicalCircuitKey('00338s', '2sp'), '00338S\u00002SP');
  assert.equal(canonicalCircuitKey('00338S-2SP', ''), '');
});

test('future circuit compensation parser is monthly, canonical and does not distribute SED totals', () => {
  const preview = prepareMonthlyCircuitCompensationImport([
    { SED: '00338s', Circuito: 'a', period_key: '2026-08', compensacion: 0 },
    { SED: '00338S', Circuito: 'B', period_key: '2026-08', 'Compensaci\u00f3n': 25 },
    { SED: '00338S', period_key: '2026-08', compensacion: 90 }
  ], [
    { sedId: '00338S', llaveCode: 'A' },
    { sedId: '00338S', llaveCode: 'B' }
  ]);
  assert.equal(preview.valid, true);
  assert.equal(preview.accepted, 2);
  assert.equal(preview.invalid, 1);
  assert.deepEqual(preview.rows, [
    { sed_id: '00338S', llave_code: 'A', period_key: '2026-08', period_end_key: '2026-08', compensation: 0 },
    { sed_id: '00338S', llave_code: 'B', period_key: '2026-08', period_end_key: '2026-08', compensation: 25 }
  ]);
});

test('circuit compensation accepts one real bimonthly row and formats its range', () => {
  const preview = prepareMonthlyCircuitCompensationImport([
    { SED: '00007S', llave: '10S', inicio: '2026-01', fin: '2026-02', monto: '18,500' }
  ], [{ sedId: '00007S', llaveCode: '10S' }]);
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.rows, [{ sed_id: '00007S', llave_code: '10S', period_key: '2026-01', period_end_key: '2026-02', compensation: 18500 }]);
  assert.deepEqual(compensationPeriodMonths('2026-01', '2026-02'), ['2026-01', '2026-02']);
  assert.equal(formatCompensationPeriodRange('2026-01', '2026-02'), 'Ene–Feb 2026');
});

test('circuit compensation handles several keys and months without duplicates or destructive partial replacement', () => {
  const existing = [
    { sedId: '00338S', llaveCode: 'A', periodKey: '2026-08', compensation: 10 },
    { sedId: '00338S', llaveCode: 'B', periodKey: '2026-08', compensation: 20 },
    { sedId: '00338S', llaveCode: 'A', periodKey: '2026-07', compensation: 5 }
  ];
  const preview = prepareMonthlyCircuitCompensationImport([
    { SED: '00338S', llave: 'A', period_key: '2026-08', compensation: 30 },
    { SED: '00338S', llave: 'C', period_key: '2026-08', compensation: 40 },
    { SED: '00338S', llave: 'A', period_key: '2026-07', compensation: 7 },
    { SED: '00338S', llave: 'A', period_key: '2026-08', compensation: 999 }
  ], [{ sedId: '00338S', llaveCode: 'A' }, { sedId: '00338S', llaveCode: 'B' }, { sedId: '00338S', llaveCode: 'C' }], existing);
  assert.deepEqual([preview.periodCount, preview.accepted, preview.duplicates], [2, 3, 1]);
  const august = preview.periods.find(period => period.periodKey === '2026-08');
  assert.deepEqual([august.periodExists, august.existingPeriodRows, august.existingConflicts], [true, 2, 1]);
  const merged = mergeCircuitCompensationPeriodRows(august.rows, existing, august.periodKey);
  assert.deepEqual(merged.map(row => [row.llave_code, row.compensation]), [['A', 30], ['B', 20], ['C', 40]]);
  assert.deepEqual(summarizeCircuitCompensationPeriods(merged), [{ periodKey: '2026-08', periodEndKey: '2026-08', periodLabel: 'Agosto de 2026', circuitCount: 3, sedCount: 1, totalCompensation: 90 }]);
});

test('circuit compensation migration remains local, period-scoped and authenticated', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260906120000_circuit_monthly_compensation.sql', import.meta.url), 'utf8');
  assert.match(sql, /primary key \(sed_id, llave_code, period_key\)/);
  assert.match(sql, /foreign key \(sed_id, llave_code\) references public\.llaves\(sed_id, llave_code\)/);
  assert.match(sql, /delete from public\.circuit_monthly_metrics where period_key = p_period_key/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.doesNotMatch(sql, /(insert into|update|delete from|truncate) public\.suministros_coordenadas/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to anon/i);
});

test('bimonthly migration stores one range row and retains authenticated RPC access', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260908090000_bimonthly_circuit_compensation.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists period_end_key text/);
  assert.match(sql, /one or two consecutive months/);
  assert.match(sql, /geopluz_import_circuit_compensation_range/);
  assert.match(sql, /insert into public\.circuit_monthly_metrics\(sed_id, llave_code, period_key, period_end_key, compensation, created_by\)/);
  assert.doesNotMatch(sql, /(insert into|update|delete from|truncate) public\.suministros_coordenadas/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to anon/i);
});

test('mounting normalization uses structured data first and keeps unknown values unclassified', () => {
  assert.equal(resolveLineMounting({ mounting: ' A\u00e9reo ', properties: { Montaje: 'Subterr\u00e1neo' } }).category, 'aerial');
  assert.equal(resolveLineMounting({ properties: { Montaje: 'subterraneo' } }).category, 'underground');
  assert.equal(resolveLineMounting({ mounting: 'Especial' }).category, 'unclassified');
  assert.equal(resolveLineMounting({}).category, 'unclassified');
});

test('mounting propagates through physical segments, edges, branches and mixed analysis units', () => {
  const meter = 1 / 111195;
  const result = analyzeCircuit([
    { id: 'a', coords: [[0, 0], [20 * meter, 0]], mounting: 'A\u00e9reo' },
    { id: 'b', coords: [[20 * meter, 0], [40 * meter, 0]], properties: { Montaje: 'Subterr\u00e1neo' } }
  ], [], { rootCoordinate: [0, 0] });
  assert.deepEqual(result.physicalSegmentRecords.map(item => item.mounting), ['aerial', 'underground']);
  assert.deepEqual(result.topology.edges.map(item => item.mounting), ['aerial', 'underground']);
  const segment = result.analysisSegmentIndicators.analysisSegments[0];
  assert.equal(segment.mountingStatus, 'mixed');
  assert.ok(Math.abs(segment.aerialLengthMeters - 20) < 0.02);
  assert.ok(Math.abs(segment.undergroundLengthMeters - 20) < 0.02);
  assert.equal(segment.unclassifiedLengthMeters, 0);
  assert.ok(Math.abs(segment.lengthMeters - segment.aerialLengthMeters - segment.undergroundLengthMeters) < 1e-9);
});

test('unclassified mounting length remains explicit instead of being inferred', () => {
  const meter = 1 / 111195;
  const result = analyzeCircuit([{ id: 'x', coords: [[0, 0], [20 * meter, 0]] }], [], { rootCoordinate: [0, 0] });
  const segment = result.analysisSegmentIndicators.analysisSegments[0];
  assert.equal(segment.mountingStatus, 'unclassified');
  assert.ok(Math.abs(segment.unclassifiedLengthMeters - segment.lengthMeters) < 1e-9);
});

test('manual edge identity supports an existing-edge subsegment and detects ambiguous legacy line ids', () => {
  const meter = 1 / 111195;
  const polyline = { id: 'poly', coords: [[0, 0], [20 * meter, 0], [40 * meter, 0]] };
  const refs = buildManualEdgeCatalog([polyline]);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0].edgeId, refs[1].edgeId);
  const subsegment = resolveManualGroupEdgeRefs({ edgeRefs: [refs[1]] }, [polyline]);
  assert.deepEqual(subsegment.edgeRefs.map(ref => ref.edgeId), [refs[1].edgeId]);

  const duplicate = resolveManualGroupEdgeRefs({ lineIds: ['same'] }, [
    { id: 'same', coords: [[0, 0], [20 * meter, 0]] },
    { id: 'same', coords: [[0, meter], [20 * meter, meter]] }
  ]);
  assert.equal(duplicate.edgeRefs.length, 2);
  assert.deepEqual(duplicate.ambiguousLineIds, ['same']);
});

test('manual edge references survive canonical project round-trip', async () => {
  const meter = 1 / 111195;
  const line = { id: 'poly', coords: [[0, 0], [20 * meter, 0], [40 * meter, 0]], mounting: 'Subterr\u00e1neo' };
  const edgeRef = buildManualEdgeCatalog([line])[1];
  const database = {
    '00338S': {
      name: 'SED', sedCoord: [0, 0], llaves: {
        A: { name: 'A', lines: [line], analysis: { cableGroups: [{ id: 'manual-1', name: 'Sector', calibre: '', color: '#00897b', note: 'Prueba', analysisUnit: true, lineIds: ['poly'], edgeRefs: [edgeRef], distance: edgeRef.lengthMeters }] } }
      }
    }
  };
  const project = await createProjectDocument(database, []);
  assert.equal((await validateProject(project)).valid, true);
  const canonical = project.llaves[0].analysis.cable_groups[0];
  assert.equal(canonical.analysis_unit, true);
  assert.equal(canonical.edge_refs[0].edge_id, edgeRef.edgeId);
  const restored = projectToInternalModel(project).localDatabase['00338S'].llaves.A.analysis.cableGroups[0];
  assert.equal(restored.analysisUnit, true);
  assert.deepEqual(restored.edgeRefs, [edgeRef]);
});

test('project persistence resolves noisy SED and circuit identity canonically', async () => {
  const project = await createProjectDocument({
    '00338S': { name: 'SED', sedCoord: [0, 0], llaves: { A: { lines: [] } } }
  }, [{ sed: ' 00338s\u200b ', llaveSistema: ' a ', periodKey: '2026-08' }]);
  assert.equal(project.fallas[0].sed_id, '00338S');
  assert.equal(project.fallas[0].llave_code, 'A');
  assert.equal(project.fallas[0].relation.status, 'resolved');
});

test('explicit manual units own their edges and automatic analysis remains the non-overlapping fallback', () => {
  const meter = 1 / 111195;
  const line = { id: 'poly', coords: [[0, 0], [20 * meter, 0], [40 * meter, 0], [60 * meter, 0]] };
  const selectedRef = buildManualEdgeCatalog([line])[1];
  const marker = { __geopluz_circuit_analysis__: { cableGroups: [{ id: 'manual-middle', analysisUnit: true, name: 'Centro', calibre: '', lineIds: ['poly'], edgeRefs: [selectedRef] }] } };
  const result = analyzeCircuit([line, marker], [], { rootCoordinate: [0, 0], terminalSpurMaxMeters: 0 });
  const manual = result.analysisSegmentIndicators.analysisSegments.find(segment => segment.source === 'manual');
  const allEdges = result.analysisSegmentIndicators.analysisSegments.flatMap(segment => segment.edgeIds);
  assert.equal(manual.analysisSegmentId, 'manual:manual-middle');
  assert.deepEqual(manual.edgeIds, [selectedRef.edgeId]);
  assert.equal(new Set(allEdges).size, allEdges.length);
  assert.deepEqual(new Set(allEdges), new Set(result.topology.edges.map(edge => edge.edgeId)));
  assert.equal(result.analysisSegmentIndicators.diagnostics.manualPriorityApplied, true);
});

test('legacy calibre groups remain compatible metadata until explicitly saved as analysis units', () => {
  const meter = 1 / 111195;
  const lines = [{ id: 'x', coords: [[0, 0], [20 * meter, 0]] }];
  const topology = analyzeCircuit(lines, [], { rootCoordinate: [0, 0], terminalSpurMaxMeters: 0 }).topology;
  assert.deepEqual(createManualAnalysisUnits([{ id: 'legacy', lineIds: ['x'], calibre: 'NYY' }], lines, topology), []);
});

test('map selection is wired to deterministic edge references instead of whole-line identity', () => {
  const map = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(map, /createManualEdgeRefsForLine\(line, index\)/);
  assert.match(map, /onLineClick\?\.\(line\.id \?\? index, edgeRef\)/);
  assert.match(page, /edgeRefs: selectedManualEdgeRefs/);
  assert.match(page, /analysisUnit: true/);
  assert.match(page, /if \(!isExplicitAnalysisUnit\) return item/);
});

test('map, manual selection and technical analysis share normalized drawable coordinates', () => {
  const mercatorLine = {
    id: 'mercator',
    coords: [[-8571600, -1345000], [-8571600, -1344990]]
  };
  const drawable = getDrawableLineCoordinates(mercatorLine.coords);
  const result = analyzeCircuit([mercatorLine], [], { terminalSpurMaxMeters: 0 });
  const refs = buildManualEdgeCatalog([mercatorLine]);
  assert.equal(drawable.length, 2);
  assert.deepEqual(result.physicalSegmentRecords[0].coords, drawable);
  assert.deepEqual(result.topology.edges[0].coords, drawable);
  assert.deepEqual(refs[0].coords, drawable);
  assert.ok(result.topology.edges[0].lengthMeters > 0);
});

test('canonical drawable project lines require at least two coordinates', async () => {
  const project = await createProjectDocument({
    SED: { name: 'SED', sedCoord: [0, 0], llaves: { A: { lines: [{ id: 'point', coords: [[0, 0]] }] } } }
  }, []);
  assert.equal(project.llaves[0].lines.length, 0);
});

test('future economic input is pure, traceable and performs no SED compensation allocation', () => {
  const unit = {
    analysisSegmentId: 'manual:one', source: 'manual', faultIndexes: [0, 1, 1, 2], edgeIds: ['edge-b', 'edge-a'],
    lengthMeters: 100, aerialLengthMeters: 25, undergroundLengthMeters: 60, unclassifiedLengthMeters: 15
  };
  const faults = [
    { id: 'f-1', sed: '00338S', periodKey: '2026-07', callCount: 0 },
    { id: 'f-2', sed: '00338S', periodKey: '2026-08', Llamadas: 3 },
    { id: 'f-3', sed: '00338S', periodKey: '2026-09' }
  ];
  const input = buildEconomicAnalysisInput({
    sedId: '00338s', llaveCode: ' a ', analysisUnit: unit,
    selectedPeriodKeys: ['2026-07', '2026-08'], faults,
    circuitCompensationRows: [
      { sed_id: '00338S', llave_code: 'A', period_key: '2026-07', compensation: 0 },
      { sed_id: '00338S', llave_code: 'A', period_key: '2026-08', compensation: 20 }
    ],
    sedMetricReconciliation: { compensation: { dataAvailable: true, totalKnown: 999 } }
  });
  assert.deepEqual(input.identity, { sedId: '00338S', circuitId: 'A', analysisUnitId: 'manual:one', analysisUnitSource: 'manual' });
  assert.deepEqual(input.faults, { count: 2, indexes: [0, 1], ids: ['f-1', 'f-2'] });
  assert.deepEqual(input.calls, { totalKnown: 3, recordsWithData: 2, recordsWithoutData: 0 });
  assert.equal(input.compensation.scope, 'circuit');
  assert.equal(input.compensation.circuit.totalKnown, 20);
  assert.equal(input.compensation.allocatedToAnalysisUnit, false);
  assert.deepEqual(input.geometry.edgeIds, ['edge-a', 'edge-b']);
  assert.equal(Object.hasOwn(input, 'npv'), false);
});

test('future economic input derives the default SED compensation per fault and preserves missing calls', () => {
  const input = buildEconomicAnalysisInput({
    sedId: '00338S', circuitId: 'A',
    analysisUnit: { analysisSegmentId: 'auto', faultIndexes: [0], lengthMeters: 5 },
    selectedPeriodKeys: ['2026-08'],
    faults: [{ id: 'f', periodKey: '2026-08', call_count: null }],
    sedMetricReconciliation: {
      faultCountByPeriod: [{ periodKey: '2026-08', count: 2 }],
      compensation: {
        dataAvailable: true,
        dataComplete: true,
        totalKnown: 50,
        byPeriod: [{ periodKey: '2026-08', value: 50, available: true }],
        periodsMissing: []
      }
    }
  });
  assert.equal(input.compensation.scope, 'sed');
  assert.equal(input.compensation.automatic.compensationPerFault, 25);
  assert.equal(input.compensation.automatic.faultsCompatible, 2);
  assert.equal(input.compensation.circuit.totalKnown, null);
  assert.equal(input.compensation.allocatedToAnalysisUnit, false);
  assert.deepEqual(input.calls, { totalKnown: 0, recordsWithData: 0, recordsWithoutData: 1 });
});

test('circuit compensation has priority over SED reference and another key never leaks into the result', () => {
  const base = {
    sedId: '00338S', analysisUnit: { analysisSegmentId: 'unit', faultIndexes: [0] },
    selectedPeriodKeys: ['2026-07', '2026-08'],
    faults: [{ id: 1, periodKey: '2026-07' }, { id: 2, periodKey: '2026-08' }],
    circuitCompensationRows: [
      { sedId: '00338S', llaveCode: 'A', periodKey: '2026-07', compensation: 30 },
      { sedId: '00338S', llaveCode: 'A', periodKey: '2026-08', compensation: 50 },
      { sedId: '00338S', llaveCode: 'B', periodKey: '2026-08', compensation: 900 }
    ],
    sedMetricReconciliation: {
      faultCountByPeriod: [{ periodKey: '2026-07', count: 10 }, { periodKey: '2026-08', count: 20 }],
      compensation: { dataAvailable: true, dataComplete: true, byPeriod: [{ periodKey: '2026-07', value: 100, available: true }, { periodKey: '2026-08', value: 200, available: true }], periodsMissing: [] }
    }
  };
  const keyA = buildEconomicAnalysisInput({ ...base, llaveCode: 'A' });
  const keyC = buildEconomicAnalysisInput({ ...base, llaveCode: 'C' });
  assert.deepEqual([keyA.compensation.scope, keyA.compensation.automatic.totalKnown, keyA.compensation.automatic.compensationPerFault], ['circuit', 80, 40]);
  assert.deepEqual([keyA.compensation.automatic.faultsCompatible, keyC.compensation.scope, keyC.compensation.automatic.totalKnown, keyC.compensation.automatic.faultsCompatible, keyC.compensation.automatic.compensationPerFault], [2, 'sed', 300, 30, 10]);
  assert.equal(keyA.compensation.allocatedToAnalysisUnit, false);
});

test('economic panel identifies circuit compensation and SED reference explicitly', () => {
  const panel = readFileSync(new URL('../components/EconomicAnalysisPanel.js', import.meta.url), 'utf8');
  assert.match(panel, /Compensación de llave/);
  assert.match(panel, /Compensación SED \(referencia\)/);
});

test('monthly priority combines key data with SED fallback only for missing key months', () => {
  const input = buildEconomicAnalysisInput({
    sedId: '00338S', llaveCode: 'A', analysisUnit: { analysisSegmentId: 'unit', faultIndexes: [0, 1] },
    selectedPeriodKeys: ['2026-07', '2026-08'],
    faults: [{ periodKey: '2026-07' }, { periodKey: '2026-08' }],
    circuitCompensationRows: [{ sedId: '00338S', llaveCode: 'A', periodKey: '2026-07', compensation: 30 }],
    sedMetricReconciliation: {
      faultCountByPeriod: [{ periodKey: '2026-07', count: 10 }, { periodKey: '2026-08', count: 4 }],
      compensation: { dataAvailable: true, dataComplete: true, byPeriod: [{ periodKey: '2026-07', value: 100, available: true }, { periodKey: '2026-08', value: 80, available: true }], periodsMissing: [] }
    }
  });
  assert.equal(input.compensation.scope, 'mixed');
  assert.deepEqual(input.compensation.automatic.byPeriod.map(period => [period.periodKey, period.value, period.sourceScope, period.faultsCompatible]), [
    ['2026-07', 30, 'circuit', 1],
    ['2026-08', 80, 'sed', 4]
  ]);
  assert.deepEqual([input.compensation.automatic.totalKnown, input.compensation.automatic.faultsCompatible, input.compensation.automatic.compensationPerFault], [110, 5, 22]);
});

test('bimonthly circuit compensation is counted once and uses faults from both selected months', () => {
  const input = buildEconomicAnalysisInput({
    sedId: '00007S', llaveCode: '10S', analysisUnit: { analysisSegmentId: 'unit', faultIndexes: [0, 1, 2] },
    selectedPeriodKeys: ['2026-01', '2026-02'],
    faults: [{ periodKey: '2026-01' }, { periodKey: '2026-02' }, { periodKey: '2026-02' }],
    circuitCompensationRows: [{ sedId: '00007S', llaveCode: '10S', periodKey: '2026-01', periodEndKey: '2026-02', compensation: 18500 }],
    sedMetricReconciliation: {
      faultCountByPeriod: [{ periodKey: '2026-01', count: 10 }, { periodKey: '2026-02', count: 20 }],
      compensation: { dataAvailable: true, dataComplete: true, byPeriod: [{ periodKey: '2026-01', value: 9000, available: true }, { periodKey: '2026-02', value: 11000, available: true }] }
    }
  });
  assert.deepEqual([input.compensation.scope, input.compensation.automatic.totalKnown, input.compensation.automatic.faultsCompatible], ['circuit', 18500, 3]);
  assert.equal(input.compensation.automatic.byPeriod.length, 1);
});

test('several bimesters sum once each and an incomplete selected range falls back to SED', () => {
  const base = {
    sedId: '00007S', llaveCode: '10S', analysisUnit: { analysisSegmentId: 'unit', faultIndexes: [0, 1, 2, 3] },
    faults: [{ periodKey: '2026-01' }, { periodKey: '2026-02' }, { periodKey: '2026-03' }, { periodKey: '2026-04' }],
    circuitCompensationRows: [
      { sedId: '00007S', llaveCode: '10S', periodKey: '2026-01', periodEndKey: '2026-02', compensation: 100 },
      { sedId: '00007S', llaveCode: '10S', periodKey: '2026-03', periodEndKey: '2026-04', compensation: 200 }
    ],
    sedMetricReconciliation: {
      faultCountByPeriod: ['2026-01', '2026-02', '2026-03', '2026-04'].map(periodKey => ({ periodKey, count: 5 })),
      compensation: { dataAvailable: true, dataComplete: true, byPeriod: ['2026-01', '2026-02', '2026-03', '2026-04'].map((periodKey, index) => ({ periodKey, value: 10 + index, available: true })) }
    }
  };
  const all = buildEconomicAnalysisInput({ ...base, selectedPeriodKeys: ['2026-01', '2026-02', '2026-03', '2026-04'] });
  const januaryOnly = buildEconomicAnalysisInput({ ...base, selectedPeriodKeys: ['2026-01'] });
  assert.deepEqual([all.compensation.scope, all.compensation.automatic.totalKnown, all.compensation.automatic.faultsCompatible, all.compensation.automatic.byPeriod.length], ['circuit', 300, 4, 2]);
  assert.deepEqual([januaryOnly.compensation.scope, januaryOnly.compensation.automatic.totalKnown, januaryOnly.compensation.automatic.faultsCompatible], ['sed', 10, 5]);
});

test('an existing key compensation with no compatible circuit faults does not silently fall back to SED', () => {
  const input = buildEconomicAnalysisInput({
    sedId: '00338S', llaveCode: 'A', analysisUnit: { analysisSegmentId: 'unit', faultIndexes: [] },
    selectedPeriodKeys: ['2026-08'], faults: [],
    circuitCompensationRows: [{ sedId: '00338S', llaveCode: 'A', periodKey: '2026-08', compensation: 50 }],
    sedMetricReconciliation: {
      faultCountByPeriod: [{ periodKey: '2026-08', count: 2 }],
      compensation: { dataAvailable: true, dataComplete: true, byPeriod: [{ periodKey: '2026-08', value: 100, available: true }], periodsMissing: [] }
    }
  });
  assert.equal(input.compensation.scope, 'circuit');
  assert.equal(input.compensation.automatic.totalKnown, 50);
  assert.equal(input.compensation.automatic.compensationPerFault, null);
});

test('default SED compensation divides only by faults from periods with compensation data', () => {
  const input = buildEconomicAnalysisInput({
    sedId: '00338S', circuitId: 'A',
    analysisUnit: { analysisSegmentId: 'auto', faultIndexes: [] },
    selectedPeriodKeys: ['2026-07', '2026-08'],
    faults: [],
    sedMetricReconciliation: {
      faultCountByPeriod: [
        { periodKey: '2026-07', count: 2 },
        { periodKey: '2026-08', count: 5 }
      ],
      compensation: {
        dataAvailable: true,
        dataComplete: false,
        totalKnown: 100,
        byPeriod: [
          { periodKey: '2026-07', value: 100, available: true },
          { periodKey: '2026-08', value: null, available: false }
        ],
        periodsMissing: ['2026-08']
      }
    }
  });
  assert.equal(input.compensation.automatic.compensationPerFault, 50);
  assert.equal(input.compensation.automatic.faultsCompatible, 2);
  assert.equal(input.compensation.automatic.coverageStatus, 'partial');
});
