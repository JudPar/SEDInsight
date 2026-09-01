import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const mapSource = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');

function functionBody(source, functionName, nextFunctionName) {
  const start = source.indexOf(`async function ${functionName}`);
  const end = source.indexOf(`async function ${nextFunctionName}`, start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

test('Excel export centers the visible network before generating the workbook', () => {
  const body = functionBody(pageSource, 'handleExportExcel', 'handleExportPdf');
  assert.ok(body.indexOf('await mapRef.current?.prepareForExport?.()') >= 0);
  assert.ok(body.indexOf('prepareForExport') < body.indexOf('exportExcelBySed'));
});

test('PDF export centers the visible network before capturing the report', () => {
  const body = functionBody(pageSource, 'handleExportPdf', 'checkEditPermission');
  assert.ok(body.indexOf('await mapRef.current?.prepareForExport?.()') >= 0);
  assert.ok(body.indexOf('prepareForExport') < body.indexOf('exportPdfReport'));
});

test('map export preparation fits all currently visible network coordinates deterministically', () => {
  assert.match(mapSource, /visibleNetworkBoundsRef\.current = bounds\.map/);
  assert.match(mapSource, /prepareForExport/);
  assert.match(mapSource, /fitBounds\(bounds, \{ padding: \[50, 50\], maxZoom: 18, animate: false \}\)/);
  assert.match(mapSource, /requestAnimationFrame\(\(\) => window\.requestAnimationFrame/);
});
