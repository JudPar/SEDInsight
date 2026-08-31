import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../lib/projectMappers.js';
import { parseAndValidateProjectInputText } from '../lib/projectValidation.js';
import {
  canImportProjectToMain,
  getMainDatabaseState,
  importProjectToSupabase,
  mapProjectForSupabase,
  ProjectImportError
} from '../lib/projectImport.js';

class MemoryProjectRepository {
  constructor(seed = {}, failure = null) {
    this.rows = {
      seds: [...(seed.seds || [])],
      llaves: [...(seed.llaves || [])],
      fallas: [...(seed.fallas || [])]
    };
    this.failure = failure;
    this.insertCalls = { seds: 0, llaves: 0, fallas: 0 };
    this.tablesAccessed = [];
  }

  async count(table) {
    this.tablesAccessed.push(table);
    return this.rows[table].length;
  }

  async insert(table, rows) {
    this.tablesAccessed.push(table);
    this.insertCalls[table] += 1;
    if (this.failure?.table === table && this.failure.call === this.insertCalls[table]) throw new Error('Fallo sintético de lote');
    this.rows[table].push(...rows.map((row, index) => ({ ...row, ...(table === 'seds' ? {} : { generated_id: this.rows[table].length + index + 1 }) })));
    return rows.length;
  }
}

async function createImportFixture() {
  const database = {
    '00001S': {
      name: 'SED Uno', sedCoord: [-12.05, -77.04], createdAt: '2026-08-27T00:00:00.000Z',
      llaves: {
        L1: {
          id: 51, name: 'Circuito L1', createdAt: '2026-08-27T00:00:00.000Z',
          lines: [{ id: 't1', length: 100, coords: [[-12.05, -77.04], [-12.051, -77.041]] }],
          analysis: { status: 'analizado', note: 'Completo', cableGroups: [{ id: 'g1', name: 'Troncal', calibre: '70 mm²', color: '#00897b', note: 'Principal', distance: 100, lineIds: ['t1'] }] }
        },
        L2: {
          id: 52, name: 'Circuito L2', createdAt: null,
          lines: [{ id: 't2', length: 80, coords: [[-12.05, -77.04], [-12.049, -77.039]] }],
          analysis: { status: 'cargado', note: '', cableGroups: [] }
        }
      }
    }
  };
  const baseFault = {
    coords: [-12.052, -77.042], ticket: 'DUPLICADO', suministro: '100', sed: '00001S', llaveSistema: 'L1', sedLlave: '00001S-L1',
    falla: 'Conductor', causa: 'Deterioro', nota: 'Nota', odm: 'ODM-1', zona: 'Norte', setAlimentador: 'SET / A1', horaInicio: '08:00',
    linkCroquis: 'https://example.com/croquis.pdf', fotos: [{ name: 'foto.jpg', url: 'https://example.com/foto.jpg' }],
    coordSource: 'SUMINISTRO_LOOKUP', coordLookupSuministro: '100', createdAt: '2026-08-27T00:00:00.000Z'
  };
  const faults = [
    { ...baseFault, id: 701 },
    { ...baseFault, id: 702, coords: [-12.053, -77.043], suministro: '101', coordLookupSuministro: '101' },
    { ...baseFault, id: 703, ticket: 'SIN-RELACION', sed: 'DESCONOCIDA', llaveSistema: 'X', sedLlave: 'DESCONOCIDA-X', coords: null, coordSource: null, coordLookupSuministro: null }
  ];
  return createProjectDocument(database, faults, { projectId: 'import-test', projectName: 'Import test', sourceKind: 'SUPABASE' });
}

test('remote empty-state check enables import only when all three project tables are empty', async () => {
  const empty = await getMainDatabaseState(new MemoryProjectRepository());
  assert.deepEqual(empty, { seds: 0, llaves: 0, fallas: 0, isEmpty: true });
  assert.equal(canImportProjectToMain(empty), true);

  const populated = await getMainDatabaseState(new MemoryProjectRepository({ fallas: [{ id: 1 }] }));
  assert.equal(populated.isEmpty, false);
  assert.equal(canImportProjectToMain(populated), false);
});

test('canonical mapper preserves project data but never reuses numeric llave or falla IDs', async () => {
  const mapped = mapProjectForSupabase(await createImportFixture());
  assert.equal(mapped.seds.length, 1);
  assert.equal(mapped.llaves.length, 2);
  assert.equal(mapped.fallas.length, 3);
  assert.equal(Object.hasOwn(mapped.llaves[0], 'id'), false);
  assert.equal(Object.hasOwn(mapped.llaves[0], 'source_id'), false);
  assert.equal(Object.hasOwn(mapped.fallas[0], 'id'), false);
  assert.equal(Object.hasOwn(mapped.fallas[0], 'source_id'), false);
  assert.equal(mapped.fallas[0].coord_source, 'SUMINISTRO_LOOKUP');
  assert.equal(mapped.fallas[0].created_at, '2026-08-27T00:00:00.000Z');
  assert.equal(mapped.fallas[2].sed_id, 'DESCONOCIDA');
  assert.equal(mapped.fallas.filter(row => row.ticket === 'DUPLICADO').length, 2);
  assert.ok(mapped.llaves[0].lines_data.some(line => line.__geopluz_circuit_analysis__?.cableGroups?.[0]?.lineIds?.[0] === 't1'));
});

test('empty database imports in SED, llave, falla order using batches and verifies exact totals', async () => {
  const repository = new MemoryProjectRepository();
  const project = await createImportFixture();
  const report = await importProjectToSupabase(repository, project, { batchSizes: { seds: 1, llaves: 1, fallas: 2 } });
  assert.equal(report.success, true);
  assert.deepEqual(report.counts, { seds: 1, llaves: 2, fallas: 3, isEmpty: false });
  assert.deepEqual(report.progress, { seds: 1, llaves: 2, fallas: 3 });
  assert.deepEqual(repository.insertCalls, { seds: 1, llaves: 2, fallas: 2 });
  assert.equal(repository.tablesAccessed.includes('suministros_coordenadas'), false);
});

test('file and pasted text use the same validated model and produce the same import result', async () => {
  const text = JSON.stringify(await createImportFixture());
  const fileResult = await parseAndValidateProjectInputText(text);
  const pasteResult = await parseAndValidateProjectInputText(text);
  assert.deepEqual(mapProjectForSupabase(fileResult.project), mapProjectForSupabase(pasteResult.project));
  const fileImport = await importProjectToSupabase(new MemoryProjectRepository(), fileResult.project);
  const pasteImport = await importProjectToSupabase(new MemoryProjectRepository(), pasteResult.project);
  assert.deepEqual(fileImport.counts, pasteImport.counts);
});

test('database with existing data is blocked before the first insert', async () => {
  const repository = new MemoryProjectRepository({ seds: [{ id: 'EXISTENTE' }] });
  await assert.rejects(
    importProjectToSupabase(repository, await createImportFixture()),
    error => error instanceof ProjectImportError && error.code === 'DATABASE_NOT_EMPTY' && error.counts.seds === 1
  );
  assert.deepEqual(repository.insertCalls, { seds: 0, llaves: 0, fallas: 0 });
});

test('a failed batch stops immediately and reports phase and confirmed partial progress', async () => {
  const repository = new MemoryProjectRepository({}, { table: 'fallas', call: 2 });
  await assert.rejects(
    importProjectToSupabase(repository, await createImportFixture(), { batchSizes: { seds: 1, llaves: 2, fallas: 1 } }),
    error => (
      error instanceof ProjectImportError &&
      error.code === 'BATCH_FAILED' &&
      error.phase === 'fallas' &&
      error.progress.seds === 1 &&
      error.progress.llaves === 2 &&
      error.progress.fallas === 1
    )
  );
  assert.equal(repository.rows.fallas.length, 1);
  assert.equal(repository.insertCalls.fallas, 2);
});
