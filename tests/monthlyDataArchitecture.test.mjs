import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSedFaultRanking, deduplicateSelectedFaults, filterFaultsByPeriods, formatPeriodLabel, formatSelectedPeriodLabel, resolveActivePeriodSelection, selectRecentPeriods, UNASSIGNED_PERIOD_KEY } from '../lib/faultPeriods.js';
import { derivePeriodKeyFromStartTime, georeferenceMonthlyFaultRows, normalizeCallCount, normalizeFaultCause, prepareMonthlyFaultImport } from '../lib/monthlyFaultImport.js';
import { normalizeCompensation, prepareMonthlyCompensationImport } from '../lib/monthlyCompensationImport.js';
import { buildSedPeriodMetrics, sortSedPeriodMetrics, summarizeCompensationPeriods } from '../lib/sedMetrics.js';
import { createWorkProjectConfig, validateWorkProjectConfig } from '../lib/workProjectConfig.js';
import { createProjectDocument, projectToInternalModel } from '../lib/projectMappers.js';
import { getCauseCategory } from '../lib/constants.js';

const seds = {
  '00338S': { name: 'SED 338', llaves: { A: {}, B: {} } },
  '00813S': { name: 'SED 813', llaves: { C: {} } },
  '00000S': { name: 'Sin fallas', llaves: {} }
};

function monthlyInput(period = '2026-09') {
  const startTime = `${period}-01 08:00`;
  return {
    period_key: period,
    fallas: [
      { id: 'SRC-1', sed_id: '00338S', llave_code: 'A', ticket: 'T-1', latitud: -12.1, longitud: -77.1, hora_inicio: startTime },
      { id: 'SRC-2', sed_id: '00813S', llave_code: 'C', ticket: 'T-2', hora_inicio: startTime },
      { id: 'SRC-3', sed_id: 'FUERA', ticket: 'T-3', hora_inicio: startTime },
      { id: 'SRC-1', sed_id: '00338S', llave_code: 'A', ticket: 'T-1-DUP', hora_inicio: startTime },
      { id: 'INVALID', ticket: 'T-4', hora_inicio: startTime }
    ]
  };
}

test('monthly preview detects period, permanent SED, duplicates, outside rows and invalid rows', () => {
  const preview = prepareMonthlyFaultImport(monthlyInput(), Object.keys(seds));
  assert.equal(preview.valid, true);
  assert.equal(preview.periodKey, '2026-09');
  assert.equal(preview.received, 5);
  assert.equal(preview.accepted, 2);
  assert.equal(preview.recognizedSeds, 2);
  assert.equal(preview.outsideUniverse, 1);
  assert.equal(preview.duplicates, 1);
  assert.equal(preview.invalid, 1);
});

test('existing period is explicit and never silently accepted as new', () => {
  assert.equal(prepareMonthlyFaultImport(monthlyInput(), Object.keys(seds), ['2026-09']).periodExists, true);
});

test('invalid period prevents monthly import', () => {
  assert.equal(prepareMonthlyFaultImport(monthlyInput('09-2026'), Object.keys(seds)).valid, false);
});

test('period is derived from Hora de inicio without requiring period_key', () => {
  assert.equal(derivePeriodKeyFromStartTime('15/08/2026 14:32'), '2026-08');
  assert.equal(derivePeriodKeyFromStartTime('2026-09-01T03:15:00Z'), '2026-09');
  const preview = prepareMonthlyFaultImport({ fallas: [{ id: 'A', sed_id: '00338S', 'Hora de inicio': '15/08/2026 14:32' }] }, Object.keys(seds));
  assert.equal(preview.periodKey, '2026-08');
  assert.equal(preview.periods[0].rows[0].hora_inicio, '15/08/2026 14:32');
});

test('mixed-month JSON is grouped into independent period previews', () => {
  const preview = prepareMonthlyFaultImport({ fallas: [
    { id: 'A', sed_id: '00338S', hora_inicio: '31/08/2026 23:59' },
    { id: 'B', sed_id: '00813S', hora_inicio: '01/09/2026 00:01' }
  ] }, Object.keys(seds), ['2026-08']);
  assert.deepEqual(preview.periods.map(period => [period.periodKey, period.accepted, period.periodExists]), [['2026-08', 1, true], ['2026-09', 1, false]]);
  assert.equal(preview.periodCount, 2);
});

test('Hora de inicio is authoritative when an explicit period conflicts', () => {
  const preview = prepareMonthlyFaultImport({ fallas: [{ id: 'A', sed_id: '00338S', period_key: '2026-09', hora_inicio: '15/08/2026 14:32' }] }, Object.keys(seds));
  assert.equal(preview.valid, true);
  assert.equal(preview.periodKey, '2026-08');
  assert.equal(preview.rows[0].period_key, '2026-08');
});

test('monthly rows without a stable source identity are accepted with an explicit warning', () => {
  const preview = prepareMonthlyFaultImport({ period_key: '2026-09', fallas: [{ sed_id: '00338S', hora_inicio: '01/09/2026' }] }, Object.keys(seds));
  assert.equal(preview.accepted, 1);
  assert.equal(preview.ambiguousIdentities, 1);
});

test('1, 3 and 6 month presets choose the newest periods deterministically', () => {
  const periods = ['2026-01', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02'].map(periodKey => ({ periodKey }));
  assert.deepEqual(selectRecentPeriods(periods, 1), ['2026-06']);
  assert.deepEqual(selectRecentPeriods(periods, 3), ['2026-06', '2026-05', '2026-04']);
  assert.equal(selectRecentPeriods(periods, 6).length, 6);
});

test('default economic period selection uses the newest six months and formats the interval', () => {
  const periods = ['2026-04', '2026-01', '2026-06', '2026-03', '2026-05', '2026-02'].map(periodKey => ({ periodKey }));
  assert.deepEqual(selectRecentPeriods(periods), ['2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01']);
  assert.match(formatSelectedPeriodLabel(periods.map(item => item.periodKey)), /6 meses/);
});

test('manual period selection survives refreshes while the base defaults to available months up to six', () => {
  const periods = ['2026-07', '2026-09', '2026-08'].map(periodKey => ({ periodKey }));
  assert.deepEqual(resolveActivePeriodSelection(periods, [], { preserveSelection: false }), ['2026-09', '2026-08', '2026-07']);
  assert.deepEqual(resolveActivePeriodSelection(periods, ['2026-08'], { preserveSelection: true }), ['2026-08']);
  assert.deepEqual(resolveActivePeriodSelection(periods, [], { preserveSelection: true }), []);
  assert.deepEqual(resolveActivePeriodSelection(periods, ['2026-06', '2026-07'], { preserveSelection: true }), ['2026-07']);
});

test('call count distinguishes zero from missing and rejects invalid values', () => {
  assert.deepEqual(normalizeCallCount(0), { valid: true, value: 0, provided: true });
  assert.equal(normalizeCallCount(null).provided, false);
  assert.equal(normalizeCallCount('-1').valid, false);
  const preview = prepareMonthlyFaultImport({ fallas: [
    { id: 'A', sed_id: '00338S', 'Hora de inicio': '01/09/2026', Llamadas: 0 },
    { id: 'B', sed_id: '00338S', 'Hora de inicio': '02/09/2026' }
  ] }, Object.keys(seds));
  assert.equal(preview.periods[0].rows[0].call_count, 0);
  assert.equal(preview.periods[0].rows[1].call_count, null);
});

test('missing cause remains empty and never falls back to Deterioro or ENVEJECIMIENTO', () => {
  const preview = prepareMonthlyFaultImport({ fallas: [
    { id: 'A', sed_id: '00338S', hora_inicio: '01/08/2026' },
    { id: 'B', sed_id: '00338S', hora_inicio: '01/08/2026', diagnostico: ' Humedad ' }
  ] }, Object.keys(seds));

  assert.equal(preview.rows[0].causa, null);
  assert.equal(preview.rows[1].causa, 'Humedad');
  assert.equal(normalizeFaultCause(null), '');
  assert.notEqual(getCauseCategory('Deterioro').id, 'ENVEJECIMIENTO');
  assert.equal(getCauseCategory('ENVEJECIMIENTO').id, 'ENVEJECIMIENTO');
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /causa:\s*String\([^\n]+\|\|\s*'Deterioro'/);
});

test('monthly supply aliases and spreadsheet representations use the shared normalization', () => {
  const preview = prepareMonthlyFaultImport({ period_key: '2026-09', fallas: [
    { id: 'A', sed_id: '00338S', suministro: '123456', hora_inicio: '01/09/2026' },
    { id: 'B', sed_id: '00338S', suministro: ' 123456 ', hora_inicio: '01/09/2026' },
    { id: 'C', sed_id: '00338S', suministro: '123456.0', hora_inicio: '01/09/2026' },
    { id: 'D', sed_id: '00338S', NIS: '000123', hora_inicio: '01/09/2026' }
  ] }, Object.keys(seds));

  assert.equal(preview.valid, true);
  assert.deepEqual(preview.rows.map(row => row.suministro), ['123456', '123456', '123456', '000123']);
});

test('monthly rows are georeferenced read-only before the RPC and preserve existing coordinates', async () => {
  const queries = [];
  const client = {
    from: table => {
      assert.equal(table, 'suministros_coordenadas');
      return {
        select: columns => {
          assert.equal(columns, 'suministro, latitud, longitud');
          return {
            in: async (column, values) => {
              assert.equal(column, 'suministro');
              queries.push([...values].sort());
              return {
                data: [
                  { suministro: '123456', latitud: -12.05, longitud: -77.04 },
                  { suministro: '000123', latitud: -11.9, longitud: -77.1 }
                ],
                error: null
              };
            }
          };
        }
      };
    }
  };
  const preview = prepareMonthlyFaultImport({ period_key: '2026-09', fallas: [
    { id: 'A', sed_id: '00338S', suministro: '123456', hora_inicio: '01/09/2026' },
    { id: 'B', sed_id: '00338S', suministro: ' 123456 ', hora_inicio: '01/09/2026' },
    { id: 'C', sed_id: '00338S', suministro: '123456.0', hora_inicio: '01/09/2026' },
    { id: 'D', sed_id: '00338S', nis: '000123', hora_inicio: '01/09/2026' },
    { id: 'E', sed_id: '00338S', suministro: '999999', hora_inicio: '01/09/2026' },
    { id: 'F', sed_id: '00338S', suministro: '123456', latitud: -10, longitud: -70, hora_inicio: '01/09/2026' }
  ] }, Object.keys(seds));
  const { rows, summary } = await georeferenceMonthlyFaultRows(client, preview.rows);

  assert.deepEqual(queries, [['000123', '123456', '999999']]);
  assert.deepEqual(rows.slice(0, 3).map(row => [row.suministro, row.latitud, row.longitud, row.coord_source]), [
    ['123456', -12.05, -77.04, 'SUMINISTRO_LOOKUP'],
    ['123456', -12.05, -77.04, 'SUMINISTRO_LOOKUP'],
    ['123456', -12.05, -77.04, 'SUMINISTRO_LOOKUP']
  ]);
  assert.deepEqual([rows[3].suministro, rows[3].latitud, rows[3].longitud, rows[3].coord_lookup_suministro], ['000123', -11.9, -77.1, '000123']);
  assert.deepEqual([rows[4].latitud, rows[4].longitud, rows[4].coord_source], [null, null, null]);
  assert.deepEqual([rows[5].latitud, rows[5].longitud, rows[5].coord_source], [-10, -70, 'ORIGINAL']);
  assert.equal(Object.hasOwn(rows[0], 'coords'), false);
  assert.equal(summary.automatic, 4);
  assert.equal(summary.original, 1);
  assert.equal(summary.withoutReference, 1);

  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(page, /georeferenceMonthlyFaultRows\(supabase, preview\.rows\)[\s\S]*p_rows: georeferencedRows/);
});

test('compensation preview supports multiple months, zero and explicit conflicts', () => {
  assert.equal(normalizeCompensation('S/ 1.234,50').value, 1234.5);
  assert.equal(normalizeCompensation(0).value, 0);
  const preview = prepareMonthlyCompensationImport([
    { SED: '00338S', period_key: '2026-08', compensacion: 0 },
    { SED: '00813S', period_key: '2026-09', compensacion: '150,25' },
    { SED: 'FUERA', period_key: '2026-09', compensacion: 10 }
  ], Object.keys(seds), [{ sedId: '00338S', periodKey: '2026-08', compensation: 20 }]);
  assert.equal(preview.periodCount, 2);
  assert.equal(preview.accepted, 2);
  assert.equal(preview.outsideUniverse, 1);
  assert.equal(preview.existingConflicts, 1);
});

test('UI exposes separate SED reference and SED-key compensation imports wired to period-scoped RPCs', () => {
  const panel = readFileSync(new URL('../components/DataManagementPanel.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(panel, /Compensación mensual por SED \(referencia\)/);
  assert.match(panel, /Compensación mensual\/bimestral por SED–llave/);
  assert.match(panel, /prepareMonthlyCircuitCompensationImport/);
  assert.match(page, /geopluz_import_circuit_compensation_range/);
  assert.match(page, /geopluz_delete_circuit_compensation_range/);
  assert.match(page, /circuitCompensationRows: circuitMonthlyMetrics/);
});

test('SED metrics aggregate selected periods and expose missing coverage without inventing values', () => {
  const metrics = buildSedPeriodMetrics(seds, [
    { sed: '00338S', periodKey: '2026-08', callCount: 0 },
    { sed: '00338S', periodKey: '2026-09', callCount: null },
    { sed: '00813S', periodKey: '2026-09', callCount: 4 }
  ], [
    { sedId: '00338S', periodKey: '2026-08', compensation: 0 },
    { sedId: '00813S', periodKey: '2026-09', compensation: 50 }
  ], ['2026-08', '2026-09']);
  const sed338 = metrics.find(item => item.sedId === '00338S');
  assert.equal(sed338.faultCount, 2);
  assert.equal(sed338.callCount, 0);
  assert.equal(sed338.callDataComplete, false);
  assert.equal(sed338.compensation, 0);
  assert.equal(sed338.compensationDataComplete, false);
  assert.equal(sortSedPeriodMetrics(metrics, 'callCount')[0].sedId, '00813S');
  assert.deepEqual(summarizeCompensationPeriods([{ sedId: '00338S', periodKey: '2026-08', compensation: 0 }])[0], { periodKey: '2026-08', sedCount: 1, totalCompensation: 0 });
});

test('one temporal selection updates faults, calls, ranking and compensation together', () => {
  const faults = [
    { id: 1, sed: '00338S', periodKey: '2026-07', callCount: 2 },
    { id: 2, sed: '00338S', periodKey: '2026-08', callCount: 5 },
    { id: 3, sed: '00813S', periodKey: '2026-07', callCount: 9 }
  ];
  const compensation = [
    { sedId: '00338S', periodKey: '2026-07', compensation: 10 },
    { sedId: '00338S', periodKey: '2026-08', compensation: 20 },
    { sedId: '00813S', periodKey: '2026-07', compensation: 30 }
  ];
  const julyAndAugust = ['2026-07', '2026-08'];
  const augustOnly = ['2026-08'];
  const allActive = filterFaultsByPeriods(faults, julyAndAugust);
  const augustActive = filterFaultsByPeriods(faults, augustOnly);
  const allMetrics = buildSedPeriodMetrics(seds, allActive, compensation, julyAndAugust);
  const augustMetrics = buildSedPeriodMetrics(seds, augustActive, compensation, augustOnly);
  const all338 = allMetrics.find(item => item.sedId === '00338S');
  const august338 = augustMetrics.find(item => item.sedId === '00338S');

  assert.equal(allActive.length, 3);
  assert.equal(augustActive.length, 1);
  assert.deepEqual([all338.faultCount, all338.callCount, all338.compensation], [2, 7, 30]);
  assert.deepEqual([august338.faultCount, august338.callCount, august338.compensation], [1, 5, 20]);
  assert.equal(sortSedPeriodMetrics(augustMetrics, 'faultCount')[0].sedId, '00338S');
});

test('manual period selection filters faults and preserves unassigned compatibility', () => {
  const faults = [{ periodKey: '2026-05' }, { periodKey: '2026-06' }, { periodKey: null }];
  assert.deepEqual(filterFaultsByPeriods(faults, ['2026-06']), [faults[1]]);
  assert.deepEqual(filterFaultsByPeriods(faults, [UNASSIGNED_PERIOD_KEY]), [faults[2]]);
  assert.match(formatPeriodLabel(UNASSIGNED_PERIOD_KEY), /Sin periodo/);
});

test('ranking includes permanent SED with zero faults and deterministic ties', () => {
  const ranking = buildSedFaultRanking(seds, [{ sed: '00338S' }, { sed: '00338S' }, { sed: '00813S' }]);
  assert.deepEqual(ranking.map(item => [item.sedId, item.faultCount]), [['00338S', 2], ['00813S', 1], ['00000S', 0]]);
});

test('fault union removes only stable duplicates and reports ambiguous identities', () => {
  const result = deduplicateSelectedFaults([
    { periodKey: '2026-06', sourceRecordId: 'A' },
    { periodKey: '2026-06', sourceRecordId: 'A' },
    { periodKey: '2026-07', sourceRecordId: 'A' },
    { causa: 'Sin identidad' }
  ]);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.faults.length, 3);
  assert.deepEqual(result.ambiguousIndexes, [3]);
});

test('union of selected periods is deterministic and does not duplicate the same monthly fault', () => {
  const rows = [
    { periodKey: '2026-06', sourceRecordId: 'A' },
    { periodKey: '2026-06', sourceRecordId: 'A' },
    { periodKey: '2026-07', sourceRecordId: 'A' },
    { periodKey: '2026-08', sourceRecordId: 'B' }
  ];
  const selected = filterFaultsByPeriods(rows, ['2026-06', '2026-07']);
  const union = deduplicateSelectedFaults(selected);
  assert.equal(union.faults.length, 2);
  assert.equal(union.duplicatesRemoved, 1);
});

test('light project stores references only and reports missing online data', () => {
  const config = createWorkProjectConfig({ name: 'Zona norte', sedIds: ['00813S', '00338S', '00338S'], periodKeys: ['2026-06', '2026-07'] });
  assert.deepEqual(config.sed_ids, ['00338S', '00813S']);
  assert.equal(JSON.stringify(config).includes('lines_data'), false);
  assert.equal(JSON.stringify(config).includes('fallas'), false);
  const validation = validateWorkProjectConfig(config, ['00338S'], ['2026-06']);
  assert.deepEqual(validation.missingSeds, ['00813S']);
  assert.deepEqual(validation.missingPeriods, ['2026-07']);
  assert.equal(validateWorkProjectConfig({ ...config, period_keys: '2026-06' }, ['00338S'], ['2026-06']).valid, false);
});

test('complete GEOPLUZ_PROJECT round-trip preserves monthly identity fields', async () => {
  const database = { '00338S': { name: 'SED', sedCoord: null, llaves: { A: { name: 'A', lines: [], analysis: {} } } } };
  const faults = [{ id: 1, periodKey: '2026-09', sourceRecordId: 'SRC-1', callCount: 0, sed: '00338S', llaveSistema: 'A', sedLlave: '00338S-A', ticket: 'T-1', fotos: [] }];
  const project = await createProjectDocument(database, faults);
  assert.equal(project.fallas[0].period_key, '2026-09');
  assert.equal(project.fallas[0].call_count, 0);
  assert.equal(projectToInternalModel(project).numberedPointsList[0].sourceRecordId, 'SRC-1');
  assert.equal(projectToInternalModel(project).numberedPointsList[0].callCount, 0);
});

test('period-selected faults are the only input wired to circuit and SED filters', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(page, /fetchSupabaseFaultsForPeriods/);
  assert.match(page, /\.in\('period_key', monthlyKeys\)/);
  assert.match(page, /\.is\('period_key', null\)/);
  assert.match(page, /periodFilteredPoints = deduplicateSelectedFaults\(filterFaultsByPeriods/);
  assert.match(page, /faultPoints=\{periodFilteredPoints\}/);
  assert.match(page, /selectedLlavePoints = filterFaultsForCircuitView\(periodFilteredPoints/);
  assert.match(page, /analyzeCircuit\(linesData, selectedLlavePoints/);
  assert.match(page, /await handleChangeSelectedPeriods\(availablePeriods\)/);
  assert.match(page, /hasManualPeriodSelectionRef\.current/);
  assert.match(page, /selectedPeriodKeysRef\.current/);
});

test('migration is additive, period-scoped and never writes the supply master', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260901090000_monthly_fault_periods_and_work_projects.sql', import.meta.url), 'utf8');
  assert.match(sql, /alter table public\.fallas add column if not exists period_key/);
  assert.match(sql, /delete from public\.fallas where period_key = p_period_key/);
  assert.doesNotMatch(sql, /(insert into|update|delete from|truncate) public\.suministros_coordenadas/i);
  assert.match(sql, /pg_try_advisory_xact_lock/);
  assert.match(sql, /create trigger geopluz_sync_fault_period_row_count/);
  assert.match(sql, /set row_count = counts\.row_count/);
  assert.match(sql, /grant execute on function public\.geopluz_import_fault_period[\s\S]*to authenticated/);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to anon/);
});

test('call and compensation migration is additive, authenticated and period scoped', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260901120000_fault_calls_and_sed_compensation.sql', import.meta.url), 'utf8');
  assert.match(sql, /alter table public\.fallas add column if not exists call_count integer/);
  assert.match(sql, /create table if not exists public\.sed_monthly_metrics/);
  assert.match(sql, /primary key \(sed_id, period_key\)/);
  assert.match(sql, /grant select on table public\.sed_monthly_metrics to authenticated/);
  assert.match(sql, /grant execute on function public\.geopluz_import_sed_compensation_period[\s\S]*to authenticated/);
  assert.match(sql, /delete from public\.sed_monthly_metrics where period_key = p_period_key/);
  assert.match(sql, /Delete compensation for this period explicitly/);
  assert.doesNotMatch(sql, /(insert into|update|delete from|truncate) public\.suministros_coordenadas/i);
});

test('monthly RPC requires explicit replacement and verifies exact deletion count', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260901090000_monthly_fault_periods_and_work_projects.sql', import.meta.url), 'utf8');
  assert.match(sql, /and not p_replace then/);
  assert.match(sql, /v_current <> p_expected_rows/);
  assert.match(sql, /Period count changed/);
  const deletePeriodBody = sql.match(/create or replace function public\.geopluz_delete_fault_period[\s\S]*?\n\$\$;/)?.[0] || '';
  assert.match(deletePeriodBody, /delete from public\.fallas where period_key = p_period_key/);
  assert.doesNotMatch(deletePeriodBody, /delete from public\.(seds|llaves|suministros_coordenadas)/i);
});

test('local temporary datasets and portable project definitions remain browser-side capabilities', () => {
  const cache = readFileSync(new URL('../lib/dbCache.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../components/DataManagementPanel.js', import.meta.url), 'utf8');
  assert.match(cache, /WORK_PROJECT_CONFIGS_KEY/);
  assert.match(page, /sourceKind: 'LOCAL_TEMPORARY'/);
  assert.match(page, /openTemporaryWorkspaceForImport/);
  assert.match(panel, /Abrir definición portable/);
  assert.match(panel, /solo este navegador/);
});
