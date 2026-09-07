import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { reportFixture } from './fixtures/reportFixture.mjs';
import { buildReportModel, fitReportImage, groupExactReportCoordinates, reportSpiderOffsets } from '../lib/reportModel.js';
import { buildReportMapLayout } from '../lib/reportMap.js';
import { buildReportWorkbook } from '../lib/excelUtils.js';
import { buildReportPdf } from '../lib/pdfUtils.js';

test('report grouping uses canonical exact equality, never geographic or screen proximity', () => {
  const { model } = reportFixture();
  const groups = groupExactReportCoordinates(model.faults);
  assert.deepEqual(groups.map(g => g.members.map(f => f.number)), [[1, 2], [3], [4]]);
  assert.notDeepEqual(groups[1].coordinate, groups[2].coordinate);
  assert.deepEqual(groups[0].coordinate, [-12, -76.9995]);
});

test('report relocation preserves original coordinates and table-marker numbering without mutating inputs', () => {
  const { args } = reportFixture(); const before = structuredClone(args);
  const model = buildReportModel(args);
  assert.deepEqual(args, before);
  assert.deepEqual(model.faults[0].originalCoordinates, [[-12.0001, -76.9995]]);
  assert.deepEqual(model.faults[0].displayCoordinates, [[-12, -76.9995]]);
  assert.equal(model.faults[0].relocatedViaClient, true);
  assert.deepEqual(model.faults.map(f => f.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(groupExactReportCoordinates(model.faults).flatMap(g => g.members.map(m => m.number)), [1, 2, 3, 4]);
});

test('spiderfy is a graphic multi-ring layout with no change to anchor', () => {
  const offsets = reportSpiderOffsets(25);
  assert.equal(offsets.length, 25);
  assert.equal(new Set(offsets.map(p => JSON.stringify(p))).size, 25);
  assert.ok(Math.hypot(offsets[24].x, offsets[24].y) > Math.hypot(offsets[0].x, offsets[0].y));
  assert.deepEqual(reportSpiderOffsets(1), [{ x: 0, y: 0 }]);
});

test('both image placements preserve the fixed map aspect ratio exactly', () => {
  for (const limits of [[273, 158], [880, 550], [120, 400]]) {
    const fitted = fitReportImage(1600, 1000, ...limits);
    assert.ok(Math.abs(fitted.width / fitted.height - 1.6) < 1e-12);
    assert.ok(fitted.width <= limits[0] + 1e-12 && fitted.height <= limits[1] + 1e-12);
  }
  assert.throws(() => fitReportImage(0, 100, 200, 300));
});

test('report map frames geometry, keeps Cliente visible and highlights only existing analyzed edges', () => {
  const { model } = reportFixture();
  const layout = buildReportMapLayout(model, { analysis: true });
  assert.ok(model.network.some(line => line.id === 'supply'));
  assert.ok(layout.highlighted.every(edge => edge.usage !== 'CLIENTE'));
  for (const edge of layout.highlighted) for (const coordinate of edge.coords) {
    const p = layout.project(coordinate);
    assert.ok(p.x > 0 && p.x < layout.width && p.y > 40 && p.y < layout.height - layout.footerHeight);
  }
  assert.equal(model.analysis.metrics.lengthMeters, model.analysis.edges.reduce((sum, e) => sum + e.lengthMeters, 0));
});

test('zero visible faults remain zero; stale economic selection is omitted', () => {
  const { args } = reportFixture();
  assert.equal(buildReportModel({ ...args, faults: [] }).faults.length, 0);
  assert.equal(buildReportModel({ ...args, selectedPeriodKeys: ['2026-07'] }).economic, null);
  assert.equal(buildReportModel({ ...args, llaveId: 'B' }).economic, null);
  const overview = buildReportModel({ ...args, llaveId: '', analysisLlaveId: 'A', selectedSegment: null });
  assert.match(overview.analysis.name, /Llave A/);
  assert.equal(overview.economic, null);
});

test('Excel contains linked formulas, source assumptions and faithful cached web results after round-trip', async () => {
  const { model, simulation } = reportFixture();
  const workbook = buildReportWorkbook(model);
  const roundTrip = new ExcelJS.Workbook(); await roundTrip.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.deepEqual(roundTrip.worksheets.map(sheet => sheet.name), ['01_Resumen', '02_Memoria_Calculo', '03_Fallas', '04_Tramo_Analizado', '05_Supuestos']);
  const memory = roundTrip.getWorksheet('02_Memoria_Calculo');
  for (const [row, expected] of [[5, simulation.lambda.value], [6, simulation.compensationPerFault.value], [10, simulation.interventionCost.total], [14, simulation.financial.npv], [15, simulation.financial.irr], [17, simulation.financial.discountedPaybackYears]]) {
    assert.ok(memory.getCell(`B${row}`).formula);
    assert.equal(memory.getCell(`B${row}`).result, expected ?? 'No disponible');
  }
  assert.match(memory.getCell('B15').formula, /IRR\(E40:E140\)/);
  assert.match(memory.getCell('D41').formula, /05_Supuestos/);
  assert.match(memory.getCell('B6').formula, /B13.*B14/);
  assert.equal(roundTrip.getWorksheet('03_Fallas').getCell('A5').value, 1);
  assert.equal(roundTrip.getWorksheet('03_Fallas').getCell('I5').value, '-12, -76.9995');
  assert.equal(roundTrip.getWorksheet('03_Fallas').getCell('J5').value, '-12.0001, -76.9995');
});

test('workbook missing compensation and zero investment do not masquerade as valid financial outputs', () => {
  const { model } = reportFixture({ unavailable: true });
  const memory = buildReportWorkbook(model).getWorksheet('02_Memoria_Calculo');
  assert.equal(memory.getCell('B6').result, 'No disponible');
  assert.equal(memory.getCell('B14').result, 'No disponible');
  const manual = reportFixture({ compensationMode: 'manual' }).model;
  assert.equal(buildReportWorkbook(manual).getWorksheet('02_Memoria_Calculo').getCell('B6').result, 300);
});

test('PDF paginates all faults and includes analysis, economics and original-coordinate traceability', () => {
  const { model } = reportFixture();
  model.faults = Array.from({ length: 80 }, (_, i) => ({ ...model.faults[i % 5], number: i + 1 }));
  const doc = buildReportPdf(model);
  const pdf = doc.output();
  assert.ok(doc.getNumberOfPages() >= 7);
  assert.match(pdf, /21949A-TEST-01/);
  assert.match(pdf, /Original:/);
  assert.match(pdf, /VAN/);
});

test('export wiring uses one snapshot and never captures the interactive UI or unfiltered fallback', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const start = page.indexOf('async function handleExportReport');
  const exportCode = page.slice(start, page.indexOf('async function checkEditPermission', start));
  assert.match(exportCode, /buildReportModel/);
  assert.match(exportCode, /faults: visibleFaultPoints/);
  assert.doesNotMatch(exportCode, /prepareForExport|numberedPointsList/);
  for (const file of ['excelUtils.js', 'pdfUtils.js']) {
    const code = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /html2canvas|querySelector/);
    assert.match(code, /renderReportMaps\(model\)/);
  }
  const presentation = readFileSync(new URL('../app/presentacion/page.js', import.meta.url), 'utf8');
  assert.match(presentation, /buildReportModel\(\{/);
  assert.match(presentation, /exportExcelBySed\(model\)/);
  assert.match(presentation, /exportPdfReport\(model\)/);
  assert.doesNotMatch(presentation, /filteredPoints\.length > 0 \? filteredPoints : numberedPointsList/);
});
