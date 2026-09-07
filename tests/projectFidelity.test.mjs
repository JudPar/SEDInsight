import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyzeCircuit,
  analyzeCircuitPhase1,
  assignFaultsToPhysicalSegments,
  calculateGeographicLineLength,
  classifyFaultAssignmentConfidence,
  findNearestPointOnPolyline,
  getLineCalibreDisplay,
  hydrateLlave,
  normalizeCalibreLabel,
  resolveFaultAnalyticalCoordinate,
  resolveLineCalibre,
  resolveLineUsage
} from '../lib/circuitAnalysis.js';
import { classifyExternalReference, safeExternalNavigationUrl } from '../lib/externalAssetSafety.js';
import { buildAnalysisBranchFaultView, calculateBranchIndicators, calculateParetoPriority, describeParetoCandidates, resolveAnalysisBranch } from '../lib/branchIndicators.js';
import { buildCircuitTopology, NODE_SNAP_TOLERANCE_METERS, TERMINAL_SPUR_MAX_METERS } from '../lib/circuitTopology.js';
import { applyAnalyticalFaultCoordinates, buildAnalysisSegmentFaultView, resolveAnalysisSegment } from '../lib/analysisSegments.js';
import { buildManualEdgeCatalog, createManualAnalysisUnits, findUniqueAnalyticalEdgePath } from '../lib/manualAnalysisUnits.js';
import { mapProjectForSupabase } from '../lib/projectImport.js';
import { createProjectDocument, projectToInternalModel } from '../lib/projectMappers.js';
import { assertProjectReadyForDownload, validateProject } from '../lib/projectValidation.js';

const ANALYSIS_MARKER = '__geopluz_circuit_analysis__';

test('two analytical edge clicks resolve the unique tree path without side branches', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'a', coords: [[0, -30 * meter], [0, 0]] },
    { id: 'b', coords: [[0, 0], [0, 30 * meter]] },
    { id: 'c', coords: [[0, 30 * meter], [0, 60 * meter]] },
    { id: 'side', coords: [[0, 30 * meter], [30 * meter, 30 * meter]] }
  ];
  const result = analyzeCircuit(lines, [], { terminalSpurMaxMeters: 0 });
  const catalog = buildManualEdgeCatalog(lines);
  const byLine = lineId => catalog.find(ref => ref.lineId === lineId).edgeId;
  const path = findUniqueAnalyticalEdgePath(result.topology, byLine('a'), byLine('c'));

  assert.equal(path.status, 'found');
  assert.deepEqual(path.edgeIds, [byLine('a'), byLine('b'), byLine('c')]);
  assert.ok(!path.edgeIds.includes(byLine('side')));
  assert.deepEqual(findUniqueAnalyticalEdgePath(result.topology, byLine('a'), byLine('c')), path);
});

test('path selection rejects disconnected and non-radial analytical sectors', () => {
  const meter = 1 / 111195.08;
  const disconnected = [
    { id: 'left', coords: [[0, 0], [0, 20 * meter]] },
    { id: 'right', coords: [[0, 100 * meter], [0, 120 * meter]] }
  ];
  const disconnectedResult = analyzeCircuit(disconnected, [], { terminalSpurMaxMeters: 0 });
  const disconnectedRefs = buildManualEdgeCatalog(disconnected);
  assert.equal(findUniqueAnalyticalEdgePath(
    disconnectedResult.topology,
    disconnectedRefs[0].edgeId,
    disconnectedRefs[1].edgeId
  ).status, 'not_found');

  const cycle = [
    { id: 'south', coords: [[0, 0], [0, 20 * meter]] },
    { id: 'east', coords: [[0, 20 * meter], [20 * meter, 20 * meter]] },
    { id: 'north', coords: [[20 * meter, 20 * meter], [20 * meter, 0]] },
    { id: 'west', coords: [[20 * meter, 0], [0, 0]] }
  ];
  const cycleResult = analyzeCircuit(cycle, [], { terminalSpurMaxMeters: 0 });
  const cycleRefs = buildManualEdgeCatalog(cycle);
  assert.equal(findUniqueAnalyticalEdgePath(cycleResult.topology, cycleRefs[0].edgeId, cycleRefs[2].edgeId).status, 'ambiguous');
});

test('manual analysis restores a unique real intra-node connector without adding lateral edges', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'left', coords: [[0, -25 * meter], [0, 0]] },
    { id: 'connector', coords: [[0, 0], [0, meter]] },
    { id: 'right', coords: [[0, meter], [0, 26 * meter]] },
    { id: 'lateral', coords: [[0, meter], [25 * meter, meter]] }
  ];
  const base = analyzeCircuit(lines, [], { snapToleranceMeters: 2, terminalSpurMaxMeters: 0 });
  const refs = buildManualEdgeCatalog(lines);
  const leftRef = refs.find(ref => ref.lineId === 'left');
  const rightRef = refs.find(ref => ref.lineId === 'right');
  const connectorRef = refs.find(ref => ref.lineId === 'connector');
  const lateralRef = refs.find(ref => ref.lineId === 'lateral');
  const units = createManualAnalysisUnits([{
    id: 'selected-route',
    analysisUnit: true,
    edgeRefs: [leftRef, rightRef]
  }], lines, base.topology);

  assert.deepEqual(units[0].edgeIds, [leftRef.edgeId, rightRef.edgeId].sort());
  assert.deepEqual(units[0].connectorEdgeIds, [connectorRef.edgeId]);
  assert.ok(!units[0].connectorEdgeIds.includes(lateralRef.edgeId));
  assert.deepEqual(units[0].gaps, []);

  const marker = { [ANALYSIS_MARKER]: { cableGroups: [{ id: 'selected-route', analysisUnit: true, edgeRefs: [leftRef, rightRef] }] } };
  const analyzed = analyzeCircuit([...lines, marker], [], { snapToleranceMeters: 2, terminalSpurMaxMeters: 0 });
  const manual = analyzed.analysisSegmentIndicators.analysisSegments.find(segment => segment.analysisSegmentId === 'manual:selected-route');
  assert.deepEqual(manual.connectorEdgeIds, [connectorRef.edgeId]);
  assert.equal(manual.gaps.length, 0);
});

test('analytical Cliente relocation changes only the marker coordinate and preserves origin', () => {
  const originalFault = { id: 'fault', coords: [0, 0.0001], suministro: '123' };
  const assignment = {
    faultIndex: 0,
    analyticallyRelocated: true,
    originalCoordinate: [0, 0.0001],
    analyticalCoordinate: [0, 0]
  };
  const visible = applyAnalyticalFaultCoordinates([originalFault], { assignments: [assignment] });

  assert.deepEqual(originalFault.coords, [0, 0.0001]);
  assert.deepEqual(visible[0].coords, [0, 0.0001]);
  assert.deepEqual(visible[0].mapCoords, [0, 0]);
  assert.deepEqual(visible[0].originalCoordinate, [0, 0.0001]);
  assert.equal(visible[0].relocatedViaClient, true);

  const ambiguous = applyAnalyticalFaultCoordinates([originalFault], { assignments: [{
    faultIndex: 0,
    analyticallyRelocated: false,
    clientRelocationStatus: 'ambiguous',
    analyticalCoordinate: [0, 0.0001]
  }] });
  assert.equal(ambiguous[0], originalFault);
});

test('map renders relocated Cliente faults at the analytical coordinate with traceability text', () => {
  const source = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');
  assert.match(source, /const visibleCoords = pt\.mapCoords \|\| pt\.coords/);
  assert.match(source, /Ubicación ajustada desde suministro/);
});

function databaseWithLinesData(linesData) {
  return {
    S1: {
      id: 'S1',
      name: 'SED 1',
      sedCoord: [-12, -77],
      llaves: { L1: hydrateLlave({ id: 1, name: 'L1', lines_data: linesData }) }
    }
  };
}

test('export keeps 90 missing coordinate pairs and 749 real pairs without creating 0,0', async () => {
  const faults = [
    ...Array.from({ length: 90 }, (_, index) => ({ ticket: `NULL-${index}`, coords: null, fotos: [] })),
    ...Array.from({ length: 749 }, (_, index) => ({ ticket: `GPS-${index}`, coords: [-12 - index / 100000, -77], fotos: [] }))
  ];
  const project = await createProjectDocument({}, faults);
  assert.equal(project.fallas.filter(item => item.latitud === null && item.longitud === null).length, 90);
  assert.equal(project.fallas.filter(item => item.latitud !== null && item.longitud !== null).length, 749);
  assert.equal(project.fallas.filter(item => item.latitud === 0 && item.longitud === 0).length, 0);
  const restored = mapProjectForSupabase(project).fallas;
  assert.equal(restored.filter(item => item.latitud === null && item.longitud === null).length, 90);
});

test('lines_data preserves absent, null and empty optional properties exactly', async () => {
  const groups = [
    { id: 'absent', name: 'A', calibre: '1', color: '#000', distance: 1, lineIds: [] },
    { id: 'null', name: 'B', calibre: '2', color: '#111', note: null, distance: 2, lineIds: [] },
    { id: 'empty', name: 'C', calibre: '3', color: '#222', note: '', distance: 3, lineIds: [] }
  ];
  const linesData = [
    { id: 'line-1', coords: [[-12, -77], [-12.1, -77.1]], metadata: { branch: 'A', optional: null } },
    { [ANALYSIS_MARKER]: { status: 'analizado', note: '', cableGroups: groups, custom: { keep: true } } }
  ];
  const project = await createProjectDocument(databaseWithLinesData(linesData), []);
  const exportedGroups = project.llaves[0].analysis.cable_groups;
  assert.equal(Object.hasOwn(exportedGroups[0], 'note'), false);
  assert.equal(exportedGroups[1].note, null);
  assert.equal(exportedGroups[2].note, '');
  assert.deepEqual(project.llaves[0].lines_data, linesData);

  const validation = await validateProject(project);
  assert.equal(validation.valid, true);
  const restoredLinesData = mapProjectForSupabase(project).llaves[0].lines_data;
  assert.deepEqual(restoredLinesData, linesData);

  const local = projectToInternalModel(project);
  const roundTrip = await createProjectDocument(local.localDatabase, local.numberedPointsList);
  assert.deepEqual(roundTrip.llaves[0].lines_data, linesData);
  assert.equal(Object.hasOwn(roundTrip.llaves[0].analysis.cable_groups[0], 'note'), false);
});

test('canonical export preserves 2610 original records while exposing only 2572 drawable lines', async () => {
  const localDatabase = {
    REAL: { id: 'REAL', name: 'Regresion real', sedCoord: [-12, -77], llaves: {} }
  };
  let recordIndex = 0;

  for (let llaveIndex = 0; llaveIndex < 19; llaveIndex += 1) {
    const recordCount = 137 + (llaveIndex < 7 ? 1 : 0);
    const records = Array.from({ length: recordCount }, (_, lineIndex) => {
      const originalIndex = recordIndex;
      recordIndex += 1;
      const metadata = { originalIndex, source: 'round-trip-real', keep: { nested: true } };
      if (lineIndex < 2) {
        return {
          id: `device-${llaveIndex}-${lineIndex}`,
          coords: [],
          length: lineIndex === 0 ? 4 : 0,
          properties: { 'Tipo Dispositivo': lineIndex === 0 ? 'Toma' : 'Seccionador unipolar' },
          metadata
        };
      }
      return {
        id: `line-${llaveIndex}-${lineIndex}`,
        coords: [[-12, -77], [-12, -76.9999]],
        length: 10,
        properties: { 'Tipo de Red': 'BT' },
        metadata
      };
    });
    const llave = { id: llaveIndex + 1, name: `L${llaveIndex + 1}`, lines: records };
    if (llaveIndex % 2 === 1) llave.linesData = structuredClone(records);
    localDatabase.REAL.llaves[`L${llaveIndex + 1}`] = llave;
  }

  assert.equal(recordIndex, 2610);
  const options = { projectId: 'round-trip-real', projectName: 'Round-trip real', sourceKind: 'LOCAL_TEMPORARY' };
  const project = await createProjectDocument(localDatabase, [], options);
  const exportedLines = project.llaves.flatMap(llave => llave.lines);
  const preservedLines = project.llaves.flatMap(llave => llave.lines_data.filter(item => !item?.[ANALYSIS_MARKER]));

  assert.equal(exportedLines.length, 2572);
  assert.equal(preservedLines.length, 2610);
  assert.equal(exportedLines.some(line => line.coords.length === 0), false);
  assert.equal(preservedLines.filter(line => Array.isArray(line.coords) && line.coords.length === 0).length, 38);
  assert.deepEqual(preservedLines.find(line => line.id === 'device-0-0').metadata, {
    originalIndex: 0,
    source: 'round-trip-real',
    keep: { nested: true }
  });
  assert.equal((await validateProject(project)).valid, true);
  await assertProjectReadyForDownload(project);

  const restored = projectToInternalModel(project);
  const secondExport = await createProjectDocument(restored.localDatabase, restored.numberedPointsList, options);
  assert.equal((await validateProject(secondExport)).valid, true);
  assert.deepEqual(secondExport.seds, project.seds);
  assert.deepEqual(secondExport.llaves, project.llaves);
  assert.deepEqual(secondExport.fallas, project.fallas);
  assert.deepEqual(secondExport.external_assets, project.external_assets);
  assert.equal(secondExport.integrity.checksum, project.integrity.checksum);
});

test('download validation rejects an invalid canonical project with a clear diagnostic', async () => {
  const project = await createProjectDocument(databaseWithLinesData([
    { id: 'line-1', coords: [[-12, -77], [-12.1, -77.1]], length: 10 }
  ]), []);
  project.llaves[0].lines[0].coords = [];

  await assert.rejects(
    () => assertProjectReadyForDownload(project),
    error => error?.code === 'INVALID_PROJECT_EXPORT' &&
      error.message.includes('no fue descargado') &&
      error.message.includes('$.llaves[0].lines[0].coords')
  );
});

test('phase 1 circuit analysis deduplicates only exact id and geometry pairs', () => {
  const electricalProperties = { 'ID Circuito': 'C-1', 'Tipo de Red': 'BT', Longitud: 9999 };
  const firstGeometry = [[-12, -77], [-12, -76.999]];
  const linesData = [
    { id: 'segment-1', coords: firstGeometry, length: 100, properties: electricalProperties },
    { id: 'segment-1', coords: firstGeometry, length: 100, properties: electricalProperties },
    { id: 'segment-1', coords: [[-12, -77], [-12.001, -77]], length: 50, properties: electricalProperties },
    { id: 'road-1', coords: [[-12, -77], [-12, -76.998]], length: 0, properties: { Via: 'Prueba' } },
    { id: 'invalid-length', coords: [[-12, -77], [-12, -76.997]], length: '20', properties: electricalProperties },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { id: 'g1', calibre: ' NYY  3x10 ', lineIds: ['segment-1'] },
      { id: 'g2', calibre: 'nyy 3 X 10', lineIds: ['segment-1'] }
    ] } }
  ];

  const result = analyzeCircuitPhase1(linesData);
  assert.equal(result.originalRecords, 5);
  assert.equal(result.physicalSegments, 4);
  assert.equal(result.duplicatesIgnored, 1);
  assert.equal(result.originalStoredLengthMeters, 250);
  assert.equal(result.storedLengthMeters, 150);
  assert.equal(result.zeroStoredLengthSegments, 1);
  assert.equal(result.invalidStoredLengthSegments, 1);
  assert.equal(result.detectedCalibres, 1);
  assert.equal(result.lengthByCalibre[0].normalizedLabel, 'NYY 3X10');
  assert.deepEqual(result.lengthByCalibre[0].originalLabels.sort(), [' NYY  3x10 ', 'nyy 3 X 10'].sort());
  assert.equal(result.lengthByCalibre[0].segmentCount, 2);
  assert.equal(result.lengthByCalibre[0].storedLengthMeters, 150);
  assert.equal(result.lengthByCalibre[0].ambiguousLineIds, 1);
  assert.equal(result.ambiguousCalibreLineIds, 1);
  assert.equal(result.segmentsWithoutCalibre, 2);
  assert.equal(result.nonElectricalCandidates, 1);
  assert.ok(result.warnings.some(warning => warning.code === 'AMBIGUOUS_CALIBRE_REFERENCES'));
  assert.deepEqual(analyzeCircuitPhase1(linesData), result);
});

test('phase 1 geographic length uses consecutive lat lon vertices in meters', () => {
  const firstLeg = calculateGeographicLineLength([[0, 0], [1, 0]]);
  const secondLeg = calculateGeographicLineLength([[1, 0], [1, 1]]);
  const distance = calculateGeographicLineLength([[0, 0], [1, 0], [1, 1]]);
  assert.ok(Math.abs(firstLeg - 111195.08) < 1);
  assert.ok(Math.abs(distance - (firstLeg + secondLeg)) < 1e-6);
  assert.equal(calculateGeographicLineLength([[0, 0]]), null);
  assert.equal(calculateGeographicLineLength([[95, 0], [0, 0]]), null);
  assert.equal(normalizeCalibreLabel(' NA2XY  3 - 1 x 120 '), 'NA2XY 3-1X120');
  assert.notEqual(normalizeCalibreLabel('NYY 3x10'), normalizeCalibreLabel('NKY 3x10'));
});

test('phase 1 always excludes its marker and tolerates malformed records', () => {
  const linesData = [
    { [ANALYSIS_MARKER]: null },
    {},
    { id: 'zero', coords: [[0, 0], [0, 0]], length: 0 }
  ];

  const result = analyzeCircuitPhase1(linesData);
  assert.equal(result.originalRecords, 2);
  assert.equal(result.physicalSegments, 2);
  assert.equal(result.invalidStoredLengthSegments, 1);
  assert.equal(result.zeroStoredLengthSegments, 1);
  assert.deepEqual(analyzeCircuitPhase1(linesData), result);
});

test('structured usage has priority, properties Uso is the fallback and missing usage stays unclassified', () => {
  assert.deepEqual(resolveLineUsage({ usage: '  Cliente  ', properties: { Uso: 'Servicio Particular' } }), {
    source: 'line.usage',
    raw: '  Cliente  ',
    displayLabel: 'Cliente',
    normalizedLabel: 'CLIENTE'
  });
  assert.deepEqual(resolveLineUsage({ properties: { Uso: '  Servicio   Particular ' } }), {
    source: 'properties.Uso',
    raw: '  Servicio   Particular ',
    displayLabel: 'Servicio Particular',
    normalizedLabel: 'SERVICIO PARTICULAR'
  });
  assert.deepEqual(resolveLineUsage({}), {
    source: null,
    raw: null,
    displayLabel: null,
    normalizedLabel: ''
  });
});

test('Cliente remains in the original network but is excluded before topology, calibre and fault assignment', () => {
  const lines = [
    { id: 'network', usage: 'Servicio Particular', cableType: 'NYY 3x10', coords: [[0, 0], [0, 0.0005], [0, 0.001]], length: 100 },
    { id: 'client', usage: 'Cliente', cableType: 'CLIENT CABLE', coords: [[0, 0.0005], [0.00005, 0.0005]], length: 5 },
    { id: 'secondary', usage: 'Secundario', cableType: 'NYY 3x10', coords: [[0, 0.001], [0.00018, 0.001]], length: 20 }
  ];
  const fault = { id: 'F-CLIENT', coords: [0.00005, 0.0005], causa: 'Prueba' };
  const result = analyzeCircuit(lines, [fault], { rootCoordinate: [0, 0] });
  const baseline = analyzeCircuit([lines[0], lines[2]], [fault], { rootCoordinate: [0, 0] });
  const assignment = result.faultAssignment.assignments[0];

  assert.equal(result.originalRecords, 3);
  assert.equal(result.registeredPhysicalSegments, 3);
  assert.equal(result.physicalSegments, 2);
  assert.equal(result.analysisExcludedClientSegments, 1);
  assert.equal(result.analysisExclusions[0].reason, 'CLIENT_SERVICE');
  assert.equal(result.originalPhysicalSegmentRecords.find(item => item.lineId === 'client').analysisExcluded, true);
  assert.equal(result.physicalSegmentRecords.some(item => item.lineId === 'client'), false);
  assert.equal(result.topology.originalEdges.some(edge => edge.usage === 'CLIENTE'), false);
  assert.equal(result.topology.originalEdges.some(edge => edge.usage === 'SECUNDARIO'), true);
  assert.deepEqual(result.topology, baseline.topology);
  assert.equal(result.lengthByCalibre.some(item => item.normalizedLabel === 'CLIENT CABLE'), false);
  assert.equal(assignment.lineId, 'network');
  assert.ok(assignment.distanceMeters < 0.01);
  assert.deepEqual(assignment.originalCoordinate, fault.coords);
  assert.deepEqual(assignment.analyticalCoordinate, lines[1].coords[0]);
  assert.equal(assignment.analyticallyRelocated, true);
  assert.equal(assignment.analyticalCoordinateSource, 'CLIENT_SERVICE_ENDPOINT');
  assert.equal(result.faultAssignment.analyticallyRelocated, 1);
  assert.equal(result.registeredStoredLengthMeters, 125);
  assert.equal(result.analyzableStoredLengthMeters, 120);
  assert.equal(result.excludedClientStoredLengthMeters, 5);
});

test('networks without usage preserve the previous analytical behavior and terminal-spur fallback', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'main-west', coords: [[0, 0], [0, -30 * meter]], length: 30 },
    { id: 'main-east', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'short-spur', coords: [[0, 0], [10 * meter, 0]], length: 10 }
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.registeredPhysicalSegments, 3);
  assert.equal(result.physicalSegments, 3);
  assert.equal(result.analysisExcludedClientSegments, 0);
  assert.equal(result.usageSummary.otherOrUnknown.segmentCount, 3);
  assert.equal(result.topology.terminalSpurCount, 1);
});

test('21949A usage regression leaves zero Cliente edges in the analytical graph', () => {
  const makeLine = (index, usage, length = 20) => ({
    id: `21949A-${index}`,
    usage,
    cableType: 'Conductor BT Estándar',
    coords: [[index * 0.001, 0], [index * 0.001, 0.0002]],
    length
  });
  const lines = [
    ...Array.from({ length: 354 }, (_, index) => makeLine(index, 'Servicio Particular')),
    ...Array.from({ length: 135 }, (_, index) => makeLine(354 + index, 'Cliente', 5)),
    ...Array.from({ length: 2 }, (_, index) => makeLine(489 + index, 'Secundario', 1))
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.originalRecords, 491);
  assert.equal(result.registeredPhysicalSegments, 491);
  assert.equal(result.analysisExcludedClientSegments, 135);
  assert.equal(result.physicalSegments, 356);
  assert.equal(result.usageSummary.serviceParticular.segmentCount, 354);
  assert.equal(result.usageSummary.client.segmentCount, 135);
  assert.equal(result.usageSummary.secondary.segmentCount, 2);
  assert.equal(result.topology.originalEdges.filter(edge => edge.usage === 'CLIENTE').length, 0);
  assert.equal(result.topology.originalEdges.filter(edge => edge.usage === 'SECUNDARIO').length, 2);
  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, result.topology.branchCount);
  assert.equal(result.analysisSegmentIndicators.diagnostics.calibreCuts, 0);
});

test('usage and Cliente geometry survive canonical project round-trip unchanged', async () => {
  const linesData = [
    { id: 'client', usage: 'Cliente', cableType: 'CNX 2x6', coords: [[-12, -77], [-12.00001, -77]], properties: { Uso: 'Cliente', keep: true } },
    { id: 'network', properties: { Uso: 'Servicio Particular', keep: true }, coords: [[-12, -77], [-12, -76.999]] }
  ];
  const project = await createProjectDocument(databaseWithLinesData(linesData), []);
  const restored = projectToInternalModel(project);
  const secondExport = await createProjectDocument(restored.localDatabase, restored.numberedPointsList);

  assert.equal((await validateProject(project)).valid, true);
  assert.deepEqual(project.llaves[0].lines_data, linesData);
  assert.deepEqual(secondExport.llaves[0].lines_data, linesData);
  assert.equal(secondExport.llaves[0].lines_data[0].usage, 'Cliente');
  assert.equal(secondExport.llaves[0].lines_data[0].cableType, 'CNX 2x6');
  const mapSource = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');
  assert.match(mapSource, /Array\.isArray\(entry\?\.lines\) \? entry\.lines : \[\]/);
  assert.doesNotMatch(mapSource, /filter\([^\n]*usage/);
});

test('circuit analysis summary distinguishes registered, excluded and analyzable usage', () => {
  const source = readFileSync(new URL('../components/Sidebar.js', import.meta.url), 'utf8');
  assert.match(source, /Uso de red/);
  assert.match(source, /Servicio Particular:/);
  assert.match(source, /Cliente excluidos:/);
  assert.match(source, /Longitud total registrada:/);
  assert.match(source, /Longitud analizable:/);
});

test('phase 2 projects onto the middle of a segment instead of using only vertices', () => {
  const line = [[0, 0], [0, 0.001]];
  const onLine = findNearestPointOnPolyline([0, 0.0005], line);
  const nearMiddle = findNearestPointOnPolyline([0.0001, 0.0005], line);

  assert.ok(onLine.distanceMeters < 1e-9);
  assert.ok(nearMiddle.distanceMeters > 11 && nearMiddle.distanceMeters < 12);
  assert.ok(Math.abs(nearMiddle.nearestPoint[0]) < 1e-12);
  assert.ok(Math.abs(nearMiddle.nearestPoint[1] - 0.0005) < 1e-12);
});

test('phase 2 clamps a projection to the evaluated segment endpoints', () => {
  const nearest = findNearestPointOnPolyline([0, 0.002], [[0, 0], [0, 0.001]]);

  assert.ok(nearest.distanceMeters > 111 && nearest.distanceMeters < 112);
  assert.ok(Math.abs(nearest.nearestPoint[0]) < 1e-12);
  assert.ok(Math.abs(nearest.nearestPoint[1] - 0.001) < 1e-12);
});

test('phase 2 evaluates every consecutive segment in a polyline', () => {
  const polyline = [[0, 0], [0, 0.001], [0.001, 0.001]];
  const nearest = findNearestPointOnPolyline([0.0005, 0.0011], polyline);

  assert.ok(nearest.distanceMeters > 11 && nearest.distanceMeters < 12);
  assert.ok(Math.abs(nearest.nearestPoint[0] - 0.0005) < 1e-12);
  assert.ok(Math.abs(nearest.nearestPoint[1] - 0.001) < 1e-12);
});

test('phase 2 enforces high/review distance bands and keeps farther faults unassigned', () => {
  const physicalSegments = [{
    segmentKey: 'physical-a',
    lineId: 'line-a',
    coords: [[0, 0], [0, 0.001]]
  }];
  const faults = [
    { id: 1, coords: [0.000027, 0.0005] },
    { id: 2, coords: [0.000072, 0.0005] },
    { id: 3, coords: [0.000099, 0.0005] },
    { id: 4, coords: [0.009, 0.0005] },
    { id: 5, coords: null }
  ];

  const result = assignFaultsToPhysicalSegments(faults, physicalSegments);
  assert.equal(result.totalFaults, 5);
  assert.equal(result.assigned, 2);
  assert.equal(result.missingCoordinates, 1);
  assert.equal(result.highConfidence, 1);
  assert.equal(result.reviewConfidence, 1);
  assert.equal(result.lowConfidence, 0);
  assert.equal(result.tooFarFromNetwork, 2);
  assert.deepEqual(result.assignments.map(item => item.confidence), ['high', 'review', undefined, undefined, undefined]);
  assert.equal(result.assignments[2].unassigned_reason, 'TOO_FAR_FROM_NETWORK');
  assert.equal(result.assignments[2].segmentKey, undefined);
  assert.equal(result.assignments[2].nearestSegmentKey, 'physical-a');
  assert.ok(result.assignments[2].distanceMeters > 10);
  assert.ok(result.assignments[3].distanceMeters > 900);
  assert.equal(result.assignments[4].unassigned_reason, 'missing_coordinates');

  const analyzed = analyzeCircuit([{ id: 'network', coords: physicalSegments[0].coords, length: 111 }], [faults[2]]);
  assert.equal(analyzed.branchIndicators.faultsAssignedToBranches, 0);
  assert.equal(analyzed.analysisSegmentIndicators.faultsAssignedToAnalysisSegments, 0);
  assert.equal(analyzed.branchIndicators.priorityCandidates.length, 0);
});

test('phase 2 confidence boundaries are inclusive at 5 and 10 meters', () => {
  assert.equal(classifyFaultAssignmentConfidence(5), 'high');
  assert.equal(classifyFaultAssignmentConfidence(5.000001), 'review');
  assert.equal(classifyFaultAssignmentConfidence(10), 'review');
  assert.equal(classifyFaultAssignmentConfidence(10.000001), null);
});

test('Cliente endpoint relocation preserves the original coordinate and never assigns the Cliente segment', () => {
  const meter = 1 / 111195.08;
  const network = { segmentKey: 'network', lineId: 'network', usage: 'SERVICIO PARTICULAR', coords: [[0, 0], [0, 30 * meter]] };
  const client = { segmentKey: 'client', lineId: 'client', usage: 'CLIENTE', analysisExclusionReason: 'CLIENT_SERVICE', coords: [[0, 0], [-8 * meter, 0]] };
  const fault = { id: 'supply-fault', coords: [-8 * meter, 0.5 * meter] };
  const result = assignFaultsToPhysicalSegments([fault], [network], { clientSegments: [client] });
  const assignment = result.assignments[0];

  assert.deepEqual(assignment.originalCoordinate, fault.coords);
  assert.deepEqual(assignment.analyticalCoordinate, [0, 0]);
  assert.equal(assignment.analyticallyRelocated, true);
  assert.equal(assignment.segmentKey, 'network');
  assert.notEqual(assignment.segmentKey, 'client');
  assert.ok(assignment.distanceMeters < 0.01);
});

test('multiple Cliente endpoints with different analytical targets remain unassigned as ambiguous', () => {
  const meter = 1 / 111195.08;
  const point = [0, 0];
  const clients = [
    { segmentKey: 'client-a', usage: 'CLIENTE', coords: [point, [0, 8 * meter]] },
    { segmentKey: 'client-b', usage: 'CLIENTE', coords: [point, [8 * meter, 0]] }
  ];
  const resolution = resolveFaultAnalyticalCoordinate(point, clients);
  const result = assignFaultsToPhysicalSegments([{ id: 'ambiguous', coords: point }], [
    ...clients,
    { segmentKey: 'network', coords: [[0, 8 * meter], [0, 30 * meter]] }
  ]);

  assert.equal(resolution.clientRelocationStatus, 'ambiguous');
  assert.equal(resolution.clientTargetCount, 2);
  assert.equal(result.assignments[0].unassigned_reason, 'AMBIGUOUS_CLIENT_CONNECTION');
  assert.equal(result.assignments[0].segmentKey, undefined);
  assert.equal(result.ambiguousClientConnections, 1);
});

test('normal faults and networks without usage retain their original analytical coordinate', () => {
  const result = assignFaultsToPhysicalSegments([{ id: 'normal', latitud: 0, longitud: 0.00005 }], [{
    segmentKey: 'legacy-network',
    coords: [[0, 0], [0, 0.001]]
  }]);
  assert.deepEqual(result.assignments[0].originalCoordinate, [0, 0.00005]);
  assert.deepEqual(result.assignments[0].analyticalCoordinate, [0, 0.00005]);
  assert.equal(result.assignments[0].analyticallyRelocated, false);
  assert.equal(result.assignments[0].confidence, 'high');
});

test('phase 2 classifies only exact projections on degree-three endpoints as junction faults', () => {
  const meter = 1 / 111195.08;
  const segments = [
    { segmentKey: 'west', coords: [[0, -30 * meter], [0, 0]] },
    { segmentKey: 'east', coords: [[0, 0], [0, 30 * meter]] },
    { segmentKey: 'north', coords: [[0, 0], [30 * meter, 0]] }
  ];
  const topology = buildCircuitTopology(segments);
  const junctionNode = topology.nodes.find(node => node.degree === 3);
  const faults = [
    { id: 'interior', coords: [0, -15 * meter] },
    { id: 'terminal', coords: [0, -31 * meter] },
    { id: 'junction', coords: [-meter, 0] }
  ];
  const result = assignFaultsToPhysicalSegments(faults, segments, {
    eligibleEdgeIds: topology.edges.map(edge => edge.edgeId),
    topology
  });
  const expectedCandidateBranchIds = topology.branches
    .filter(branch => branch.startNodeId === junctionNode.nodeId || branch.endNodeId === junctionNode.nodeId)
    .map(branch => branch.branchId)
    .sort((left, right) => left.localeCompare(right));

  assert.ok(result.assignments[0].projectionParameter > 0 && result.assignments[0].projectionParameter < 1);
  assert.equal(result.assignments[0].junctionFault, undefined);
  assert.equal(result.assignments[1].projectionParameter, 0);
  assert.equal(result.assignments[1].junctionFault, undefined);
  assert.ok(result.assignments[2].projectionParameter === 0 || result.assignments[2].projectionParameter === 1);
  assert.equal(result.assignments[2].junctionFault, true);
  assert.equal(result.assignments[2].nodeId, junctionNode.nodeId);
  assert.deepEqual(result.assignments[2].candidateBranchIds, expectedCandidateBranchIds);
  assert.equal(result.assigned, 3);
  assert.equal(result.branchAssigned, 2);
  assert.equal(result.junctionFaults, 1);

  const degreeTwoSegments = [
    { segmentKey: 'left', coords: [[0, -30 * meter], [0, 0]] },
    { segmentKey: 'right', coords: [[0, 0], [0, 30 * meter]] }
  ];
  const degreeTwoTopology = buildCircuitTopology(degreeTwoSegments);
  const degreeTwoResult = assignFaultsToPhysicalSegments([{ id: 'passage', coords: [-meter, 0] }], degreeTwoSegments, {
    eligibleEdgeIds: degreeTwoTopology.edges.map(edge => edge.edgeId),
    topology: degreeTwoTopology
  });
  assert.equal(degreeTwoResult.assignments[0].junctionFault, undefined);
});

test('junction faults remain accounted for but do not enter branch indicators, filters or Pareto', () => {
  const meter = 1 / 111195.08;
  const segments = [
    { segmentKey: 'west', coords: [[0, -30 * meter], [0, 0]] },
    { segmentKey: 'east', coords: [[0, 0], [0, 30 * meter]] },
    { segmentKey: 'north', coords: [[0, 0], [30 * meter, 0]] }
  ];
  const faults = [
    { id: 'junction', coords: [-meter, 0], causa: 'Humedad' },
    { id: 'interior', coords: [0, 15 * meter], causa: 'Humedad' },
    { id: 'missing', coords: null, causa: 'Humedad' }
  ];
  const topology = buildCircuitTopology(segments);
  const assignment = assignFaultsToPhysicalSegments(faults, segments, {
    eligibleEdgeIds: topology.edges.map(edge => edge.edgeId),
    topology
  });
  const indicators = calculateBranchIndicators(topology, assignment, faults);
  const branchWithInteriorFault = indicators.branches.find(branch => branch.faultCount === 1);
  const junctionEdgeBranch = topology.branches.find(branch => branch.edgeIds.includes(assignment.assignments[0].edgeId));
  const filtered = buildAnalysisBranchFaultView(faults, assignment, branchWithInteriorFault, true);

  assert.equal(assignment.totalFaults, 3);
  assert.equal(indicators.faultsAssignedToBranches, 1);
  assert.equal(indicators.junctionFaults, 1);
  assert.equal(indicators.missingCoordinates, 1);
  assert.equal(indicators.branches.reduce((total, branch) => total + branch.faultCount, 0), 1);
  assert.equal(indicators.priorityCandidates.length, 1);
  assert.equal(indicators.priorityCandidates[0].branchId, branchWithInteriorFault.branchId);
  assert.notEqual(indicators.priorityCandidates[0].branchId, junctionEdgeBranch.branchId);
  assert.deepEqual(filtered.faults.map(fault => fault.id), ['interior']);
  assert.equal(filtered.assignments.length, 1);
  assert.equal(filtered.assignments[0].junctionFault, undefined);
  assert.equal(indicators.faultsAssignedToBranches + indicators.junctionFaults + indicators.missingCoordinates, assignment.totalFaults);
  assert.deepEqual(calculateBranchIndicators(topology, assignment, faults), indicators);
  assert.deepEqual(assignFaultsToPhysicalSegments(faults, segments, {
    eligibleEdgeIds: topology.edges.map(edge => edge.edgeId),
    topology
  }), assignment);
});

test('phase 2 uses deduplicated physical keys and distinguishes equal line ids with different geometry', () => {
  const firstGeometry = [[0, 0], [0, 0.001]];
  const secondGeometry = [[0.001, 0], [0.001, 0.001]];
  const linesData = [
    { id: 'shared-id', coords: firstGeometry, length: 100 },
    { id: 'shared-id', coords: firstGeometry, length: 100 },
    { id: 'shared-id', coords: secondGeometry, length: 100 }
  ];
  const faults = [{ id: 'fault-near-second', coords: [0.00101, 0.0005] }];

  const result = analyzeCircuit(linesData, faults);
  assert.equal(result.physicalSegments, 2);
  assert.equal(result.duplicatesIgnored, 1);
  assert.equal(result.physicalSegmentRecords.length, 2);
  assert.notEqual(result.physicalSegmentRecords[0].segmentKey, result.physicalSegmentRecords[1].segmentKey);
  assert.equal(result.faultAssignment.assignments.length, 1);
  assert.equal(result.faultAssignment.assignments[0].lineId, 'shared-id');
  assert.equal(result.faultAssignment.assignments[0].segmentKey, result.physicalSegmentRecords[1].segmentKey);
  assert.deepEqual(analyzeCircuit(linesData, faults), result);
});

test('phase 3 builds one branch for a simple line and calculates its length', () => {
  const topology = buildCircuitTopology([{
    segmentKey: 'simple',
    lineId: 'line-1',
    coords: [[0, 0], [0, 0.001], [0, 0.002]]
  }]);

  assert.equal(topology.nodeCount, 3);
  assert.equal(topology.edgeCount, 2);
  assert.equal(topology.terminalCount, 2);
  assert.equal(topology.bifurcationCount, 0);
  assert.equal(topology.branchCount, 1);
  assert.deepEqual(topology.branches[0].segmentKeys, ['simple']);
  assert.ok(topology.branches[0].lengthMeters > 222 && topology.branches[0].lengthMeters < 223);
});

test('phase 3 detects a Y bifurcation and its three branches', () => {
  const topology = buildCircuitTopology([
    { segmentKey: 'east', coords: [[0, 0], [0, 0.001]] },
    { segmentKey: 'north', coords: [[0, 0], [0.001, 0]] },
    { segmentKey: 'west', coords: [[0, 0], [0, -0.001]] }
  ]);

  assert.equal(topology.nodeCount, 4);
  assert.equal(topology.edgeCount, 3);
  assert.equal(topology.bifurcationCount, 1);
  assert.equal(topology.terminalCount, 3);
  assert.equal(topology.branchCount, 3);
});

test('phase 3 splits a polyline at a bifurcation using stable edge identities', () => {
  const physicalSegments = [
    { segmentKey: 'trunk', coords: [[0, -0.001], [0, 0], [0, 0.001]] },
    { segmentKey: 'spur', coords: [[0, 0], [0.001, 0]] }
  ];
  const topology = buildCircuitTopology(physicalSegments);
  const branchEdgeIds = topology.branches.flatMap(branch => branch.edgeIds);
  const trunkEdgeIds = topology.edges.filter(edge => edge.segmentKey === 'trunk').map(edge => edge.edgeId);

  assert.equal(topology.branchCount, 3);
  assert.equal(trunkEdgeIds.length, 2);
  assert.notEqual(trunkEdgeIds[0], trunkEdgeIds[1]);
  assert.equal(branchEdgeIds.length, topology.edges.length);
  assert.equal(new Set(branchEdgeIds).size, topology.edges.length);
  trunkEdgeIds.forEach(edgeId => assert.equal(branchEdgeIds.filter(value => value === edgeId).length, 1));
  assert.equal(topology.branches.filter(branch => branch.segmentKeys.includes('trunk')).length, 2);

  const branchLength = topology.branches.reduce((total, branch) => total + branch.lengthMeters, 0);
  const edgeLength = topology.edges.reduce((total, edge) => total + edge.lengthMeters, 0);
  assert.ok(Math.abs(branchLength - edgeLength) < 1e-9);

  const assignments = assignFaultsToPhysicalSegments([
    { id: 'west-fault', coords: [0.00001, -0.0005] },
    { id: 'east-fault', coords: [0.00001, 0.0005] }
  ], physicalSegments).assignments;
  assert.notEqual(assignments[0].edgeId, assignments[1].edgeId);
  assignments.forEach(assignment => assert.ok(branchEdgeIds.includes(assignment.edgeId)));
});

test('phase 3 snaps nearby endpoints in meters but keeps endpoints outside tolerance separate', () => {
  const oneMeterInLongitude = 1 / 111195.08;
  const first = { segmentKey: 'first', coords: [[0, 0], [0, 0.001]] };
  const nearSecond = { segmentKey: 'near', coords: [[0, 0.001 + 1.5 * oneMeterInLongitude], [0, 0.002]] };
  const farSecond = { segmentKey: 'far', coords: [[0, 0.001 + 3 * oneMeterInLongitude], [0, 0.002]] };

  const snapped = buildCircuitTopology([first, nearSecond]);
  const separated = buildCircuitTopology([first, farSecond]);
  assert.equal(snapped.snapToleranceMeters, NODE_SNAP_TOLERANCE_METERS);
  assert.equal(snapped.nodeCount, 3);
  assert.equal(snapped.componentCount, 1);
  assert.equal(snapped.branchCount, 1);
  assert.equal(separated.nodeCount, 4);
  assert.equal(separated.componentCount, 2);
  assert.equal(separated.disconnectedComponents, 1);
  assert.equal(separated.branchCount, 2);
});

test('phase 3 snapping prevents transitive chains wider than the tolerance', () => {
  const oneMeterInLongitude = 1 / 111195.08;
  const topology = buildCircuitTopology([
    { segmentKey: 'a', coords: [[0, 0], [0.001, 0]] },
    { segmentKey: 'b', coords: [[0, 1.5 * oneMeterInLongitude], [0.001, 0.001]] },
    { segmentKey: 'c', coords: [[0, 3 * oneMeterInLongitude], [0.001, 0.002]] }
  ]);

  assert.equal(topology.nodeCount, 5);
  assert.equal(topology.componentCount, 2);
  assert.deepEqual(
    buildCircuitTopology([
      { segmentKey: 'a', coords: [[0, 0], [0.001, 0]] },
      { segmentKey: 'b', coords: [[0, 1.5 * oneMeterInLongitude], [0.001, 0.001]] },
      { segmentKey: 'c', coords: [[0, 3 * oneMeterInLongitude], [0.001, 0.002]] }
    ]),
    topology
  );
});

test('phase 3 creates every edge of a multi-vertex polyline', () => {
  const topology = buildCircuitTopology([{
    segmentKey: 'polyline',
    coords: [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0.002]]
  }]);

  assert.equal(topology.nodeCount, 4);
  assert.equal(topology.edgeCount, 3);
  assert.equal(topology.branchCount, 1);
  assert.equal(topology.branches[0].edgeIds.length, 3);
});

test('phase 3 reports disconnected components', () => {
  const topology = buildCircuitTopology([
    { segmentKey: 'component-a', coords: [[0, 0], [0, 0.001]] },
    { segmentKey: 'component-b', coords: [[1, 1], [1, 1.001]] }
  ]);

  assert.equal(topology.componentCount, 2);
  assert.equal(topology.disconnectedComponents, 1);
  assert.equal(topology.branches.length, 2);
});

test('phase 3 preserves distinct segment keys when line ids are equal', () => {
  const topology = buildCircuitTopology([
    { segmentKey: 'physical-a', lineId: 'shared', coords: [[0, 0], [0, 0.001]] },
    { segmentKey: 'physical-b', lineId: 'shared', coords: [[0, 0.001], [0, 0.002]] }
  ]);

  assert.deepEqual(new Set(topology.edges.map(edge => edge.segmentKey)), new Set(['physical-a', 'physical-b']));
  assert.deepEqual(topology.branches[0].segmentKeys, ['physical-a', 'physical-b']);
});

test('phase 3 detects a root only when a valid SED coordinate is available', () => {
  const segments = [{ segmentKey: 'rooted', coords: [[0, 0], [0, 0.001], [0, 0.002]] }];
  const unknown = buildCircuitTopology(segments);
  const detected = buildCircuitTopology(segments, { rootCoordinate: [0, 0.00101] });

  assert.equal(unknown.rootStatus, 'unknown');
  assert.equal(unknown.rootNodeId, null);
  assert.equal(detected.rootStatus, 'detected');
  assert.equal(detected.rootNodeId, 'node-2');
  assert.equal(detected.branchCount, 2);
});

test('phase 3 topology construction is deterministic', () => {
  const segments = [
    { segmentKey: 'a', coords: [[-12, -77], [-12, -76.99999], [-12, -76.999]] },
    { segmentKey: 'b', coords: [[-12, -77], [-12.001, -77]] }
  ];
  const options = { rootCoordinate: [-12, -77], snapToleranceMeters: 2 };

  assert.deepEqual(buildCircuitTopology(segments, options), buildCircuitTopology(segments, options));
});

test('analytical topology ignores several short terminal spurs and rejoins the mainline', () => {
  const meter = 1 / 111195.08;
  const main = { segmentKey: 'main', coords: [[0, 0], [0, 30 * meter], [0, 60 * meter], [0, 90 * meter], [0, 120 * meter]] };
  const spurs = [30, 60, 90].map((longitudeMeters, index) => ({
    segmentKey: `spur-${index + 1}`,
    coords: [[0, longitudeMeters * meter], [10 * meter, longitudeMeters * meter]]
  }));
  const topology = buildCircuitTopology([main, ...spurs]);

  assert.equal(topology.terminalSpurMaxMeters, TERMINAL_SPUR_MAX_METERS);
  assert.equal(topology.originalBranchCount, 7);
  assert.equal(topology.terminalSpurCount, 3);
  assert.equal(topology.excludedSpurEdgeIds.length, 3);
  assert.equal(topology.branchCount, 1);
  assert.equal(topology.branches[0].edgeIds.length, 4);
  assert.ok(Math.abs(topology.excludedSpurLengthMeters - 30) < 0.01);
});

test('terminal spur classification uses total chain length and preserves chains over the limit', () => {
  const meter = 1 / 111195.08;
  const main = { segmentKey: 'main', coords: [[0, -30 * meter], [0, 0], [0, 30 * meter]] };
  const shortMultiEdge = { segmentKey: 'short-chain', coords: [[0, 0], [5 * meter, 0], [10 * meter, 0]] };
  const shortTopology = buildCircuitTopology([main, shortMultiEdge]);
  const longTopology = buildCircuitTopology([
    main,
    { segmentKey: 'long-chain', coords: [[0, 0], [10 * meter, 0], [20 * meter, 0]] }
  ]);

  assert.equal(shortTopology.terminalSpurCount, 1);
  assert.equal(shortTopology.terminalSpurs[0].edgeIds.length, 2);
  assert.ok(Math.abs(shortTopology.terminalSpurs[0].lengthMeters - 10) < 0.01);
  assert.equal(longTopology.terminalSpurCount, 0);
  assert.equal(longTopology.branchCount, 3);
});

test('real bifurcations with long branches remain in the analytical graph', () => {
  const meter = 1 / 111195.08;
  const topology = buildCircuitTopology([
    { segmentKey: 'west', coords: [[0, 0], [0, -30 * meter]] },
    { segmentKey: 'east', coords: [[0, 0], [0, 30 * meter]] },
    { segmentKey: 'north', coords: [[0, 0], [30 * meter, 0]] }
  ]);

  assert.equal(topology.terminalSpurCount, 0);
  assert.equal(topology.bifurcationCount, 1);
  assert.equal(topology.branchCount, 3);
});

test('terminal spur exclusion is not recursive', () => {
  const meter = 1 / 111195.08;
  const topology = buildCircuitTopology([
    { segmentKey: 'left', coords: [[0, 0], [0, -30 * meter]] },
    { segmentKey: 'right', coords: [[0, 0], [0, 30 * meter]] },
    { segmentKey: 'main-stub', coords: [[0, 0], [0, 10 * meter]] },
    { segmentKey: 'service-north', coords: [[0, 10 * meter], [5 * meter, 10 * meter]] },
    { segmentKey: 'service-south', coords: [[0, 10 * meter], [-5 * meter, 10 * meter]] }
  ]);

  assert.equal(topology.terminalSpurCount, 2);
  assert.ok(topology.edges.some(edge => edge.segmentKey === 'main-stub'));
  assert.ok(!topology.excludedSpurEdgeIds.some(edgeId => topology.originalEdges.find(edge => edge.edgeId === edgeId)?.segmentKey === 'main-stub'));
});

test('fault assignment excludes service spurs and branch metrics use only analytical edges', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'main', coords: [[0, -30 * meter], [0, 0], [0, 30 * meter]], length: 60 },
    { id: 'service', coords: [[0, 0], [10 * meter, 0]], length: 10 }
  ];
  const fault = { id: 'near-service', coords: [9 * meter, 0], causa: 'Humedad' };
  const result = analyzeCircuit(lines, [fault]);
  const assignment = result.faultAssignment.assignments[0];
  const branch = result.branchIndicators.branches[0];
  const analyticalLength = result.topology.edges.reduce((total, edge) => total + edge.lengthMeters, 0);

  assert.equal(result.topology.terminalSpurCount, 1);
  assert.ok(!result.topology.excludedSpurEdgeIds.includes(assignment.edgeId));
  assert.ok(result.topology.edges.some(edge => edge.edgeId === assignment.edgeId && edge.segmentKey !== undefined));
  assert.ok(Math.abs(assignment.distanceMeters - 9) < 0.05);
  assert.ok(Math.abs(branch.lengthMeters - analyticalLength) < 1e-9);
  assert.ok(Math.abs(branch.lengthMeters - 60) < 0.05);
  assert.ok(Math.abs(branch.faultsPerKm - (1 / (branch.lengthMeters / 1000))) < 1e-9);
});

test('terminal spur analytical result is deterministic', () => {
  const meter = 1 / 111195.08;
  const segments = [
    { segmentKey: 'main', coords: [[0, -30 * meter], [0, 0], [0, 30 * meter]] },
    { segmentKey: 'spur', coords: [[0, 0], [10 * meter, 0]] }
  ];
  assert.deepEqual(buildCircuitTopology(segments), buildCircuitTopology(segments));
});

test('intra-node edge is diagnostic-only and a false degree-four node becomes passage', () => {
  const meter = 1 / 111195.08;
  const segments = [
    { segmentKey: 'left', coords: [[0, -30 * meter], [0, 0]] },
    { segmentKey: 'intra-node', coords: [[0, 0], [0, meter]] },
    { segmentKey: 'right', coords: [[0, meter], [0, 31 * meter]] }
  ];
  const topology = buildCircuitTopology(segments);
  const intraNodeEdge = topology.originalEdges.find(edge => edge.segmentKey === 'intra-node');
  const snappedNode = topology.originalNodes.find(node => node.degree === 4);
  const analyticalNode = topology.nodes.find(node => node.nodeId === snappedNode.nodeId);

  assert.ok(intraNodeEdge);
  assert.equal(intraNodeEdge.startNodeId, intraNodeEdge.endNodeId);
  assert.deepEqual(topology.excludedIntraNodeEdgeIds, [intraNodeEdge.edgeId]);
  assert.equal(topology.intraNodeEdgeCount, 1);
  assert.ok(topology.originalEdges.includes(intraNodeEdge));
  assert.ok(!topology.edges.some(edge => edge.edgeId === intraNodeEdge.edgeId));
  assert.equal(snappedNode.degree, 4);
  assert.equal(analyticalNode.degree, 2);
  assert.equal(analyticalNode.kind, 'passage');
  assert.equal(topology.branchCount, 1);
  assert.deepEqual(new Set(topology.branches[0].segmentKeys), new Set(['left', 'right']));
});

test('faults leave intra-node edges and Pareto only receives analytical branches deterministically', () => {
  const meter = 1 / 111195.08;
  const segments = [
    { segmentKey: 'left', coords: [[0, -30 * meter], [0, 0]] },
    { segmentKey: 'intra-node', coords: [[0, 0], [0, meter]] },
    { segmentKey: 'right', coords: [[0, meter], [0, 31 * meter]] }
  ];
  const faults = [{ id: 'near-intra-node', coords: [0.5 * meter, 0.5 * meter], causa: 'Humedad' }];
  const topology = buildCircuitTopology(segments);
  const initial = assignFaultsToPhysicalSegments(faults, segments);
  const reassigned = assignFaultsToPhysicalSegments(faults, segments, {
    eligibleEdgeIds: topology.edges.map(edge => edge.edgeId)
  });
  const indicators = calculateBranchIndicators(topology, reassigned, faults);

  assert.ok(topology.excludedIntraNodeEdgeIds.includes(initial.assignments[0].edgeId));
  assert.ok(!topology.excludedIntraNodeEdgeIds.includes(reassigned.assignments[0].edgeId));
  assert.equal(reassigned.assigned, 1);
  assert.equal(indicators.faultsAssignedToBranches, 1);
  assert.equal(indicators.branches.length, 1);
  assert.equal(indicators.priorityStatus, 'single');
  assert.equal(indicators.priorityCandidates[0].branchId, indicators.branches[0].branchId);
  assert.deepEqual(buildCircuitTopology(segments), topology);
  assert.deepEqual(assignFaultsToPhysicalSegments(faults, segments, { eligibleEdgeIds: topology.edges.map(edge => edge.edgeId) }), reassigned);
});

test('phase 4 aggregates faults, confidence and normalized causes by branch edge', () => {
  const topology = {
    branches: [
      { branchId: 'branch-a', edgeIds: ['edge-a'], segmentKeys: ['segment-a'], lengthMeters: 1000 },
      { branchId: 'branch-b', edgeIds: ['edge-b'], segmentKeys: ['segment-b'], lengthMeters: 500 }
    ],
    unbranchedEdgeIds: ['edge-cycle']
  };
  const faultAssignment = {
    assignments: [
      { faultId: 1, faultIndex: 0, edgeId: 'edge-a', confidence: 'high' },
      { faultId: 2, faultIndex: 1, edgeId: 'edge-a', confidence: 'review' },
      { faultId: 3, faultIndex: 2, edgeId: 'edge-a', confidence: 'low' },
      { faultId: 4, faultIndex: 3, edgeId: 'edge-b', confidence: 'high' },
      { faultId: 5, faultIndex: 4, unassigned_reason: 'missing_coordinates' },
      { faultId: 6, faultIndex: 5, edgeId: 'edge-cycle', confidence: 'low' },
      { faultId: 1, faultIndex: 0, edgeId: 'edge-b', confidence: 'high' },
      { faultId: 5, faultIndex: 4, unassigned_reason: 'missing_coordinates' }
    ]
  };
  const faults = [
    { causa: 'Ingreso de agua' },
    { causa: 'HUMEDAD' },
    { causa: 'Corrosión del conductor' },
    { causa: 'Óxido' },
    { causa: 'No aplica' },
    { causa: 'Sobrecarga' }
  ];

  const result = calculateBranchIndicators(topology, faultAssignment, faults);
  const branchA = result.branches.find(branch => branch.branchId === 'branch-a');
  const branchB = result.branches.find(branch => branch.branchId === 'branch-b');

  assert.equal(result.totalBranches, 2);
  assert.equal(result.faultsAssignedToBranches, 4);
  assert.equal(result.unbranchedFaults, 1);
  assert.equal(result.missingCoordinates, 1);
  assert.equal(result.faultsOutsideBranches, 1);
  assert.equal(branchA.faultCount, 3);
  assert.equal(branchB.faultCount, 1);
  assert.equal(branchA.faultsPerKm, 3);
  assert.equal(branchB.faultsPerKm, 2);
  assert.ok(Math.abs(branchA.faultShare + branchB.faultShare - 100) < 1e-9);
  assert.equal(branchA.highConfidenceFaults, 1);
  assert.equal(branchA.reviewConfidenceFaults, 1);
  assert.equal(branchA.lowConfidenceFaults, 1);
  assert.deepEqual(branchA.causes.map(cause => [cause.id, cause.count]), [['HUMEDAD', 2], ['CORROSIÓN', 1]]);
  assert.equal(result.branchWithMostFaults, 'branch-a');
  assert.equal(result.branchWithHighestFaultsPerKm, 'branch-a');
  assert.equal(result.branches[0].branchId, 'branch-a');
  assert.deepEqual(calculateBranchIndicators(topology, faultAssignment, faults), result);
});

test('phase 4 returns null density and a warning for a zero-length branch', () => {
  const topology = {
    branches: [{ branchId: 'branch-zero', edgeIds: ['edge-zero'], segmentKeys: ['segment-zero'], lengthMeters: 0 }],
    unbranchedEdgeIds: []
  };
  const faultAssignment = {
    assignments: [{ faultId: 1, faultIndex: 0, edgeId: 'edge-zero', confidence: 'low' }]
  };

  const result = calculateBranchIndicators(topology, faultAssignment, [{ causa: 'Pendiente' }]);
  assert.equal(result.branches[0].lengthKm, 0);
  assert.equal(result.branches[0].faultsPerKm, null);
  assert.equal(result.branches[0].faultCount, 1);
  assert.equal(result.branches[0].lowConfidenceFaults, 1);
  assert.ok(result.warnings.some(warning => warning.code === 'INVALID_BRANCH_LENGTH'));
  assert.equal(result.branchWithHighestFaultsPerKm, null);
});

test('phase 4 selects count and density leaders separately with deterministic ties', () => {
  const topology = {
    branches: [
      { branchId: 'branch-c', edgeIds: ['edge-c'], segmentKeys: ['c'], lengthMeters: 100 },
      { branchId: 'branch-a', edgeIds: ['edge-a'], segmentKeys: ['a'], lengthMeters: 2000 },
      { branchId: 'branch-b', edgeIds: ['edge-b'], segmentKeys: ['b'], lengthMeters: 100 }
    ],
    unbranchedEdgeIds: []
  };
  const faultAssignment = {
    assignments: [
      { faultId: 1, faultIndex: 0, edgeId: 'edge-a', confidence: 'high' },
      { faultId: 2, faultIndex: 1, edgeId: 'edge-a', confidence: 'high' },
      { faultId: 3, faultIndex: 2, edgeId: 'edge-b', confidence: 'high' },
      { faultId: 4, faultIndex: 3, edgeId: 'edge-c', confidence: 'high' }
    ]
  };

  const result = calculateBranchIndicators(topology, faultAssignment, [{}, {}, {}, {}]);
  assert.equal(result.branchWithMostFaults, 'branch-a');
  assert.equal(result.branchWithHighestFaultsPerKm, 'branch-b');
  assert.equal(result.branches[0].branchId, 'branch-b');
  assert.equal(result.branches[1].branchId, 'branch-c');
});

test('phase 5A resolves branch edges and filters faults without duplicates', () => {
  const branchIndicators = {
    branches: [
      { branchId: 'branch-a', edgeIds: ['edge-a1', 'edge-a2'] },
      { branchId: 'branch-b', edgeIds: ['edge-b1'] }
    ]
  };
  const faults = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const faultAssignment = {
    assignments: [
      { faultId: 1, faultIndex: 0, edgeId: 'edge-a1' },
      { faultId: 2, faultIndex: 1, edgeId: 'edge-b1' },
      { faultId: 3, faultIndex: 2, unassigned_reason: 'missing_coordinates' },
      { faultId: 1, faultIndex: 0, edgeId: 'edge-a2' }
    ]
  };

  const selected = resolveAnalysisBranch(branchIndicators, 'branch-a');
  assert.equal(selected.branchId, 'branch-a');
  assert.deepEqual(selected.edgeIds, ['edge-a1', 'edge-a2']);

  const filtered = buildAnalysisBranchFaultView(faults, faultAssignment, selected, true);
  assert.deepEqual(filtered.faults, [{ id: 1 }]);
  assert.equal(filtered.assignments.length, 1);
  assert.equal(filtered.assignments[0].faultIndex, 0);

  const restored = buildAnalysisBranchFaultView(faults, faultAssignment, selected, false);
  assert.deepEqual(restored.faults, faults);
  assert.equal(resolveAnalysisBranch(branchIndicators, 'branch-missing'), null);
  assert.deepEqual(buildAnalysisBranchFaultView(faults, faultAssignment, selected, true), filtered);
});

test('phase 5B returns a single Pareto candidate when one branch dominates', () => {
  const branches = [
    { branchId: 'branch-a', faultCount: 5, faultsPerKm: 10, lengthKm: 1 },
    { branchId: 'branch-b', faultCount: 4, faultsPerKm: 9, lengthKm: 1 }
  ];
  const result = calculateParetoPriority(branches);

  assert.equal(result.priorityStatus, 'single');
  assert.deepEqual(result.priorityCandidates.map(branch => branch.branchId), ['branch-a']);
  assert.ok(Math.abs(result.circuitAverageFaultsPerKm - 4.5) < 1e-9);
  assert.ok(Math.abs(result.priorityCandidates[0].faultsPerKmToCircuitAverage - (10 / 4.5)) < 1e-9);
});

test('phase 5B keeps conflicting Pareto candidates without forcing a winner', () => {
  const result = calculateParetoPriority([
    { branchId: 'more-faults', faultCount: 5, faultsPerKm: 5, lengthKm: 1 },
    { branchId: 'more-density', faultCount: 3, faultsPerKm: 10, lengthKm: 1 }
  ]);

  assert.equal(result.priorityStatus, 'multiple');
  assert.deepEqual(result.priorityCandidates.map(branch => branch.branchId), ['more-faults', 'more-density']);
});

test('phase 5B removes dominated branches from a three-branch comparison', () => {
  const result = calculateParetoPriority([
    { branchId: 'branch-a', faultCount: 5, faultsPerKm: 5, lengthKm: 1 },
    { branchId: 'branch-b', faultCount: 3, faultsPerKm: 10, lengthKm: 1 },
    { branchId: 'branch-c', faultCount: 2, faultsPerKm: 4, lengthKm: 1 }
  ]);

  assert.equal(result.priorityStatus, 'multiple');
  assert.deepEqual(result.priorityCandidates.map(branch => branch.branchId), ['branch-a', 'branch-b']);
});

test('phase 5B excludes branches without faults or density data', () => {
  const result = calculateParetoPriority([
    { branchId: 'without-faults', faultCount: 0, faultsPerKm: 0, lengthKm: 1 },
    { branchId: 'without-density', faultCount: 2, faultsPerKm: null, lengthKm: 0 }
  ]);

  assert.equal(result.priorityStatus, 'insufficient_data');
  assert.deepEqual(result.priorityCandidates, []);
});

test('phase 5B preserves exact ties as multiple candidates deterministically', () => {
  const branches = [
    { branchId: 'branch-a', faultCount: 3, faultsPerKm: 6, lengthKm: 0.5 },
    { branchId: 'branch-b', faultCount: 3, faultsPerKm: 6, lengthKm: 0.5 }
  ];
  const result = calculateParetoPriority(branches);

  assert.equal(result.priorityStatus, 'multiple');
  assert.deepEqual(result.priorityCandidates.map(branch => branch.branchId), ['branch-a', 'branch-b']);
  assert.deepEqual(calculateParetoPriority(branches), result);
  assert.equal(calculateParetoPriority([]).priorityStatus, 'insufficient_data');
});

test('Pareto presentation labels explain count, density and recurrent normalized cause', () => {
  const descriptions = describeParetoCandidates([
    { branchId: 'more-faults', faultCount: 4, faultsPerKm: 8, causes: [{ label: 'HUMEDAD', count: 4 }] },
    { branchId: 'more-density', faultCount: 2, faultsPerKm: 12, causes: [{ label: 'CORROSIÓN', count: 1 }, { label: 'OTRO', count: 1 }] }
  ]);

  assert.deepEqual(descriptions, [
    { branchId: 'more-faults', reasons: ['Mayor concentración de fallas'], recurrentCause: 'Causa recurrente: HUMEDAD' },
    { branchId: 'more-density', reasons: ['Mayor densidad de fallas'], recurrentCause: null }
  ]);
});

test('Pareto presentation keeps exact ties descriptive without choosing a winner', () => {
  const descriptions = describeParetoCandidates([
    { branchId: 'branch-a', faultCount: 3, faultsPerKm: 6, causes: [{ label: 'HUMEDAD', count: 3 }] },
    { branchId: 'branch-b', faultCount: 3, faultsPerKm: 6, causes: [{ label: 'HUMEDAD', count: 2 }, { label: 'OTRO', count: 1 }] }
  ]);

  assert.deepEqual(descriptions.map(item => item.reasons), [
    ['Mayor concentración de fallas', 'Mayor densidad de fallas'],
    ['Mayor concentración de fallas', 'Mayor densidad de fallas']
  ]);
  assert.equal(descriptions[0].recurrentCause, 'Causa recurrente: HUMEDAD');
  assert.equal(descriptions[1].recurrentCause, null);
  assert.deepEqual(describeParetoCandidates([]), []);
});

test('analysis segments stop at a degree-three bifurcation and preserve fault accounting', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'west', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'east', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'north', coords: [[0, 0], [30 * meter, 0]], length: 30 }
  ];
  const faults = [
    { id: 'west-fault', coords: [0, -15 * meter], causa: 'Humedad' },
    { id: 'east-fault', coords: [0, 15 * meter], causa: 'Humedad' },
    { id: 'junction', coords: [-meter, 0], causa: 'Humedad' },
    { id: 'missing', coords: null, causa: 'Humedad' }
  ];
  const result = analyzeCircuit(lines, faults);
  const indicators = result.analysisSegmentIndicators;
  const westSegment = indicators.analysisSegments.find(segment => segment.edgeIds.some(edgeId => edgeId.includes('west')));

  assert.equal(result.topology.nodes.find(node => node.degree === 3)?.kind, 'bifurcation');
  assert.equal(indicators.totalAnalysisSegments, 3);
  assert.ok(indicators.analysisSegments.every(segment => segment.branchIds.length === 1));
  assert.equal(indicators.analysisSegments.reduce((total, segment) => total + segment.faultCount, 0), 2);
  assert.equal(indicators.faultsAssignedToAnalysisSegments, 2);
  assert.equal(indicators.faultsOutsideAnalysisSegments, 2);
  assert.equal(indicators.faultsAssignedToAnalysisSegments + indicators.faultsOutsideAnalysisSegments, faults.length);
  assert.equal(new Set(indicators.analysisSegments.flatMap(segment => segment.edgeIds)).size, result.topology.edges.length);
  assert.equal(indicators.diagnostics.acceptedContinuities.length, 0);
  assert.equal(indicators.diagnostics.calibreCuts, 0);
  assert.equal(indicators.priorityCandidates.length, 2);
  assert.deepEqual(analyzeCircuit(lines, faults).analysisSegmentIndicators, indicators);

  const selected = resolveAnalysisSegment(indicators, westSegment.analysisSegmentId);
  const filtered = buildAnalysisSegmentFaultView(faults, result.faultAssignment, selected, true);
  assert.deepEqual(filtered.faults.map(fault => fault.id), ['west-fault']);
});

for (const deflectionDegrees of [0, 45, 90, 120]) {
  test(`analysis segments preserve a unique degree-two continuation through a ${deflectionDegrees}-degree turn`, () => {
    const meter = 1 / 111195.08;
    const radians = deflectionDegrees * Math.PI / 180;
    const lines = [
      { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
      { id: 'outgoing', coords: [[0, 0], [Math.sin(radians) * 30 * meter, Math.cos(radians) * 30 * meter]], length: 30 }
    ];
    const result = analyzeCircuit(lines, [], { rootCoordinate: [0, 0] });
    const accepted = result.analysisSegmentIndicators.diagnostics.acceptedContinuities;

    assert.equal(result.topology.nodes.find(node => node.nodeId === result.topology.rootNodeId)?.degree, 2);
    assert.equal(result.topology.branchCount, 2);
    assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 1);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].continuityReason, 'degree-2');
    assert.equal(accepted[0].degree, 2);
  });
}

test('analysis segments preserve a unique degree-two continuation with equal known calibre', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'outgoing', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming', 'outgoing'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, [], { rootCoordinate: [0, 0] });

  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 1);
  assert.equal(result.analysisSegmentIndicators.analysisSegments[0].calibreLabel, 'N2XY 3X70');
});

test('analysis segments preserve a unique degree-two continuation with incomplete calibre data', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'outgoing', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, [], { rootCoordinate: [0, 0] });
  const [segment] = result.analysisSegmentIndicators.analysisSegments;

  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 1);
  assert.equal(segment.calibreStatus, 'mixed');
  assert.ok(segment.unknownCalibreLengthMeters > 29.9);
});

test('analysis segments continue through a degree-two known calibre change and report mixed calibre', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'outgoing', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming'] },
      { calibre: 'NYY 3x16', lineIds: ['outgoing'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, [], { rootCoordinate: [0, 0] });

  assert.equal(result.topology.branchCount, 2);
  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 1);
  assert.equal(result.analysisSegmentIndicators.diagnostics.acceptedContinuities.length, 1);
  assert.equal(result.analysisSegmentIndicators.analysisSegments[0].calibreStatus, 'mixed');
  assert.equal(result.analysisSegmentIndicators.analysisSegments[0].calibreLabel, 'Mixto');
  assert.deepEqual(result.analysisSegmentIndicators.analysisSegments[0].calibres.map(item => item.label), ['N2XY 3X70', 'NYY 3X16']);
});

test('analysis segments stop at a bifurcation while retaining calibre as information', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'west', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'east', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'north', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { id: 'west-calibre', calibre: 'NYY 3x10', lineIds: ['west'] },
      { id: 'east-calibre', calibre: 'NYY 3x16', lineIds: ['east'] },
      { id: 'north-calibre', calibre: 'NYY 3x25', lineIds: ['north'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.equal(result.analysisSegmentIndicators.diagnostics.calibreCuts, 0);
  assert.deepEqual(new Set(result.analysisSegmentIndicators.analysisSegments.map(segment => segment.calibreLabel)),
    new Set(['NYY 3X10', 'NYY 3X16', 'NYY 3X25']));
});

test('analysis segments restore an original intra-node connector once without changing topology degree', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'left', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'connector', coords: [[0, 0], [0, meter]], length: 1 },
    { id: 'right', coords: [[0, meter], [0, 31 * meter]], length: 30 }
  ];
  const result = analyzeCircuit(lines, []);
  const [segment] = result.analysisSegmentIndicators.analysisSegments;

  assert.equal(result.topology.intraNodeEdgeCount, 1);
  assert.equal(segment.connectorEdgeIds.length, 1);
  assert.equal(segment.connectorEdgeIds[0], result.topology.excludedIntraNodeEdgeIds[0]);
  assert.equal(new Set(result.analysisSegmentIndicators.analysisSegments.flatMap(item => item.connectorEdgeIds)).size, 1);
  assert.ok(Math.abs(segment.lengthMeters - 61) < 0.1);
  assert.deepEqual(segment.gaps, []);
});

test('analysis segments can restore a deterministic chain of intra-node connectors', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'left', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'connector-a', coords: [[0, 0], [0, 0.7 * meter]], length: 0.7 },
    { id: 'connector-b', coords: [[0, 0.7 * meter], [0, 1.4 * meter]], length: 0.7 },
    { id: 'right', coords: [[0, 1.4 * meter], [0, 31.4 * meter]], length: 30 }
  ];
  const result = analyzeCircuit(lines, []);
  const [segment] = result.analysisSegmentIndicators.analysisSegments;

  assert.equal(result.topology.intraNodeEdgeCount, 2);
  assert.equal(segment.connectorEdgeIds.length, 2);
  assert.deepEqual(new Set(segment.connectorEdgeIds), new Set(result.topology.excludedIntraNodeEdgeIds));
  assert.ok(Math.abs(segment.lengthMeters - 61.4) < 0.1);
  assert.deepEqual(segment.gaps, []);
});

test('00338S regression keeps Cliente and intra-node geometry from creating cuts and ignores calibre changes at degree two', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'left', usage: 'Servicio Particular', cableType: 'N2XY 3x70', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'intra', usage: 'Servicio Particular', cableType: 'N2XY 3x70', coords: [[0, 0], [0, meter]], length: 1 },
    { id: 'right', usage: 'Servicio Particular', cableType: 'NYY 3x16', coords: [[0, meter], [0, 31 * meter]], length: 30 },
    { id: 'client', usage: 'Cliente', cableType: 'CNX 2x6', coords: [[0, 0], [5 * meter, 0]], length: 5 }
  ];
  const first = analyzeCircuit(lines, [], { rootCoordinate: [0, 0] });
  const second = analyzeCircuit(lines, [], { rootCoordinate: [0, 0] });
  const [segment] = first.analysisSegmentIndicators.analysisSegments;

  assert.equal(first.analysisExcludedClientSegments, 1);
  assert.equal(first.topology.intraNodeEdgeCount, 1);
  assert.equal(first.topology.nodes.find(node => node.nodeId === first.topology.rootNodeId)?.degree, 2);
  assert.equal(first.analysisSegmentIndicators.totalAnalysisSegments, 1);
  assert.equal(segment.calibreStatus, 'mixed');
  assert.equal(segment.calibreLabel, 'Mixto');
  assert.ok(segment.lengthMeters > 60 && segment.lengthMeters < 62);
  assert.equal(first.analysisSegmentIndicators.diagnostics.calibreCuts, 0);
  assert.deepEqual(second.analysisSegmentIndicators, first.analysisSegmentIndicators);
});

test('analysis segments stop at a bifurcation even when continuations are angularly identical', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'west', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'east-a', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'east-b', coords: [[0, 0], [0, 40 * meter]], length: 40 }
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.topology.branchCount, 3);
  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.ok(result.analysisSegmentIndicators.diagnostics.continuity.some(item =>
    item.status === 'stopped' && item.reason === 'bifurcation' && item.degree === 3));
});

test('analysis segments never use matching calibre to cross a bifurcation', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'same', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'different', coords: [[0, 0], [3 * meter, 30 * meter]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming', 'same'] },
      { calibre: 'NYY 3x16', lineIds: ['different'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);
  assert.equal(result.topology.bifurcationCount, 1);
  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.ok(result.analysisSegmentIndicators.analysisSegments.every(segment => segment.branchIds.length === 1));
  assert.equal(result.analysisSegmentIndicators.diagnostics.acceptedContinuities.length, 0);
});

test('analysis segments never use same calibre or a sharp turn to cross a bifurcation', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'straight-different', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'turn-same', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming', 'turn-same'] },
      { calibre: 'NYY 3x16', lineIds: ['straight-different'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);
  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.equal(result.analysisSegmentIndicators.diagnostics.acceptedContinuities.length, 0);
});

test('analysis segments do not use calibre when two adjacent alternatives share it', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'same-a', coords: [[0, 0], [2 * meter, 30 * meter]], length: 30 },
    { id: 'same-b', coords: [[0, 0], [-2 * meter, 30 * meter]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming', 'same-a', 'same-b'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.equal(result.analysisSegmentIndicators.diagnostics.acceptedContinuities.length, 0);
});

test('analysis segments keep a boundary when a plausible alternative has unknown calibre', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'same', coords: [[0, 0], [2 * meter, 30 * meter]], length: 30 },
    { id: 'unknown', coords: [[0, 0], [-2 * meter, 30 * meter]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming', 'same'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.equal(result.analysisSegmentIndicators.diagnostics.acceptedContinuities.length, 0);
});

test('analysis segments do not use angular plausibility or calibre at degree four', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'different', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'same-turn', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { id: 'unknown-back', coords: [[0, 0], [0, -40 * meter]], length: 40 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['incoming', 'same-turn'] },
      { calibre: 'NYY 3x16', lineIds: ['different'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.topology.nodes.find(node => node.degree === 4)?.kind, 'bifurcation');
  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 4);
  assert.equal(result.analysisSegmentIndicators.diagnostics.acceptedContinuities.length, 0);
});

test('analysis segments do not use calibre continuity from an unknown incoming branch', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'incoming-unknown', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'known-turn', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { id: 'known-straight', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['known-turn'] },
      { calibre: 'NYY 3x16', lineIds: ['known-straight'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);

  assert.ok(!result.analysisSegmentIndicators.diagnostics.acceptedContinuities.some(item =>
    item.continuityReason === 'calibre'));
});

test('analysis segments remain separated by bifurcation, not by different calibres', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'left', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'right', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'north', coords: [[0, 0], [30 * meter, 0]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['left'] },
      { calibre: 'NYY 3x16', lineIds: ['right'] },
      { calibre: 'NYY 3x10', lineIds: ['north'] }
    ] } }
  ];
  const result = analyzeCircuit(lines, []);

  assert.equal(result.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.equal(result.analysisSegmentIndicators.diagnostics.calibreCuts, 0);
});

test('analysis segments keep unknown connector length separate from known calibre', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'left', coords: [[0, -30 * meter], [0, 0]], length: 30 },
    { id: 'connector', coords: [[0, 0], [0, meter]], length: 1 },
    { id: 'right', coords: [[0, meter], [0, 31 * meter]], length: 30 },
    { [ANALYSIS_MARKER]: { cableGroups: [
      { calibre: 'N2XY 3x70', lineIds: ['left', 'right'] }
    ] } }
  ];
  const first = analyzeCircuit(lines, []).analysisSegmentIndicators;
  const second = analyzeCircuit(lines, []).analysisSegmentIndicators;
  const [segment] = first.analysisSegments;

  assert.equal(segment.calibreStatus, 'mixed');
  assert.equal(segment.calibreLabel, 'Mixto');
  assert.ok(Math.abs(segment.calibres[0].lengthMeters - 60) < 0.1);
  assert.ok(Math.abs(segment.unknownCalibreLengthMeters - 1) < 0.1);
  assert.deepEqual(second, first);
});

test('structured cableType has priority over manual calibre and reports conflicts', () => {
  const line = { id: 'structured', cableType: 'NYY 3 x 10', coords: [[0, 0], [0, 0.001]], length: 100 };
  const groups = [{ calibre: 'NYY 3x16', lineIds: ['structured'] }];
  const resolution = resolveLineCalibre(line, groups);
  const result = analyzeCircuitPhase1([line, { [ANALYSIS_MARKER]: { cableGroups: groups } }]);

  assert.equal(resolution.source, 'structured');
  assert.equal(resolution.normalizedLabel, 'NYY 3X10');
  assert.equal(resolution.displayLabel, 'NYY 3 x 10');
  assert.equal(resolution.conflict, true);
  assert.equal(result.calibreConflicts.length, 1);
  assert.equal(result.physicalSegmentRecords[0].calibreLabel, 'NYY 3X10');
  assert.ok(result.warnings.some(warning => warning.code === 'CALIBRE_CONFLICT'));
});

test('manual cable group is the fallback when cableType is absent', () => {
  const line = { id: 'manual', coords: [[0, 0], [0, 0.001]], length: 100 };
  const resolution = resolveLineCalibre(line, [{ calibre: 'N2XY 3x70', lineIds: ['manual'] }]);

  assert.equal(resolution.source, 'cableGroup');
  assert.equal(resolution.normalizedLabel, 'N2XY 3X70');
  assert.equal(getLineCalibreDisplay(line, [{ calibre: 'N2XY 3x70', lineIds: ['manual'] }]), 'N2XY 3x70');
});

test('missing structured and manual calibre remains No informado', () => {
  const resolution = resolveLineCalibre({ id: 'unknown' }, []);
  assert.equal(resolution.source, 'unknown');
  assert.equal(resolution.normalizedLabel, '');
  assert.equal(resolution.displayLabel, 'No informado');
});

test('structured calibre propagates deterministically through physical segment, edge, branch and analysis segment', () => {
  const meter = 1 / 111195.08;
  const lines = [
    { id: 'west', cableType: 'NYY 3 x 10', coords: [[0, 0], [0, -30 * meter]], length: 30 },
    { id: 'east', cableType: 'NYY 3 x 10', coords: [[0, 0], [0, 30 * meter]], length: 30 },
    { id: 'north', cableType: 'NYY 3 x 16', coords: [[0, 0], [30 * meter, 0]], length: 30 }
  ];
  const first = analyzeCircuit(lines, []);
  const second = analyzeCircuit(lines, []);
  const westRecord = first.physicalSegmentRecords.find(segment => segment.lineId === 'west');
  const westEdge = first.topology.edges.find(edge => edge.segmentKey === westRecord.segmentKey);
  const westBranch = first.topology.branches.find(branch => branch.edgeIds.includes(westEdge.edgeId));
  const westAnalysisSegment = first.analysisSegmentIndicators.analysisSegments.find(segment => segment.edgeIds.includes(westEdge.edgeId));

  assert.equal(westRecord.calibreLabel, 'NYY 3X10');
  assert.equal(westEdge.calibreLabel, 'NYY 3X10');
  assert.equal(westBranch.calibreLabel, 'NYY 3X10');
  assert.equal(westAnalysisSegment.calibreLabel, 'NYY 3X10');
  assert.equal(first.analysisSegmentIndicators.totalAnalysisSegments, 3);
  assert.deepEqual(second, first);
});

test('segment inspection includes the resolved cable calibre label', () => {
  const source = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');
  assert.match(source, /getLineCalibreDisplay\(line, entryCableGroups\)/);
  assert.match(source, /Calibre \/ Tipo de cable:/);
});

async function projectWithCroquis(linkCroquis) {
  return createProjectDocument({}, [{ ticket: 'LINK', coords: null, linkCroquis, fotos: [] }]);
}

test('legacy croquis is preserved as warning while HTTP and HTTPS remain navigable', async () => {
  for (const value of ['http://example.com/croquis', 'https://example.com/croquis']) {
    const project = await projectWithCroquis(value);
    const validation = await validateProject(project);
    assert.equal(validation.valid, true);
    assert.ok(safeExternalNavigationUrl(value));
  }

  const legacy = 'referencia/croquis/legacy';
  const project = await projectWithCroquis(legacy);
  const validation = await validateProject(project);
  assert.equal(validation.valid, true);
  assert.equal(project.fallas[0].link_croquis, legacy);
  assert.ok(validation.warnings.some(item => item.code === 'LEGACY_EXTERNAL_ASSET_REFERENCE'));
  assert.equal(validation.preview.legacyExternalReferences, 1);
  assert.equal(safeExternalNavigationUrl(legacy), null);
});

test('dangerous schemes and invalid types never become navigable', async () => {
  assert.equal(classifyExternalReference('javascript:alert(1)').kind, 'unsafe-scheme');
  assert.equal(safeExternalNavigationUrl('javascript:alert(1)'), null);
  const dangerous = await projectWithCroquis('javascript:alert(1)');
  assert.ok((await validateProject(dangerous, { verifyChecksum: false })).errors.some(item => item.code === 'UNSAFE_URL'));
  const invalidType = await projectWithCroquis('safe-legacy');
  invalidType.fallas[0].link_croquis = { unexpected: true };
  assert.ok((await validateProject(invalidType, { verifyChecksum: false })).errors.some(item => item.code === 'INVALID_TYPE'));
});
