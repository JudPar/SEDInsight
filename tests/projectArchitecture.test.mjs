import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEDS_CACHE_KEY, clearExpectedLocalProject, getExpectedLocalProject, getLocalProjectCacheKey, markLocalProjectExpected } from '../lib/dbCache.js';
import { isLegacyNetworkJson, parseProjectJson, ProjectParseError } from '../lib/projectFormat.js';
import { createProjectDocument, projectToInternalModel } from '../lib/projectMappers.js';
import { parseAndValidateProjectInputText, validateProject } from '../lib/projectValidation.js';

function fixture() {
  return {
    database: {
      '00001S': {
        id: '00001S',
        name: 'SED Uno',
        sedCoord: [-12.05, -77.04],
        createdAt: '2026-08-27T00:00:00.000Z',
        llaves: {
          L1: {
            id: 7,
            name: 'Circuito L1',
            lines: [{ id: 'tramo-1', length: 125, coords: [[-12.05, -77.04], [-12.051, -77.041]] }],
            analysis: {
              status: 'analizado',
              note: 'Revisión completa',
              cableGroups: [{ id: 'cg-1', name: 'Principal', calibre: '70 mm²', color: '#00897b', note: 'OK', distance: 125, lineIds: ['tramo-1'] }]
            },
            createdAt: '2026-08-27T00:00:00.000Z'
          }
        }
      }
    },
    faults: [
      {
        id: 10, coords: [-12.052, -77.042], ticket: 'TK-1', suministro: '100', sed: '00001S', llaveSistema: 'L1', sedLlave: '00001S-L1',
        falla: 'Conductor', causa: 'Deterioro', nota: 'Primera', odm: 'ODM-1', zona: 'Norte', setAlimentador: 'SET / A1', horaInicio: '08:00',
        linkCroquis: 'https://example.com/croquis.pdf', fotos: [{ name: 'foto.jpg', url: 'https://example.com/foto.jpg' }],
        coordSource: 'ORIGINAL', coordLookupSuministro: null, createdAt: '2026-08-27T00:00:00.000Z'
      },
      {
        id: 11, coords: null, ticket: 'TK-1', suministro: '200', sed: 'DESCONOCIDA', llaveSistema: 'X', sedLlave: 'DESCONOCIDA-X',
        falla: 'Otro', causa: 'Otros', nota: '', odm: '', zona: '', set: '', alimentador: '', horaInicio: '', linkCroquis: '', fotos: [],
        coordSource: null, coordLookupSuministro: null, createdAt: null
      }
    ]
  };
}

async function projectFixture() {
  const { database, faults } = fixture();
  return createProjectDocument(database, faults, { projectId: 'proyecto-prueba', projectName: 'Proyecto prueba', sourceKind: 'SUPABASE' });
}

test('exports the complete canonical project with counts and circuit analysis', async () => {
  const project = await projectFixture();
  assert.equal(project.format, 'GEOPLUZ_PROJECT');
  assert.equal(project.version, 1);
  assert.deepEqual(project.integrity.counts, { seds: 1, llaves: 1, fallas: 2 });
  assert.equal(project.llaves[0].analysis.note, 'Revisión completa');
  assert.deepEqual(project.llaves[0].analysis.cable_groups[0].line_ids, ['tramo-1']);
  assert.equal(project.fallas[0].suministro, '100');
  assert.equal(project.fallas[0].relation.status, 'resolved');
  assert.equal(project.fallas[1].relation.status, 'unresolved');
  const serialized = JSON.stringify(project);
  for (const forbidden of ['SOURCE_DATABASE_URL', 'TARGET_DATABASE_URL', 'service_role', 'database_password']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('file text and pasted text share one pipeline and produce the same model', async () => {
  const text = JSON.stringify(await projectFixture());
  const fromFile = await parseAndValidateProjectInputText(text);
  const fromPaste = await parseAndValidateProjectInputText(text);
  assert.equal(fromFile.valid, true);
  assert.deepEqual(projectToInternalModel(fromFile.project), projectToInternalModel(fromPaste.project));
});

test('valid projects allow duplicate tickets and warn about duplicate and unresolved records', async () => {
  const result = await validateProject(await projectFixture());
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some(item => item.code === 'DUPLICATE_TICKETS'));
  assert.ok(result.warnings.some(item => item.code === 'UNRESOLVED_RELATIONS'));
  assert.ok(result.warnings.some(item => item.code === 'EXTERNAL_REFERENCES'));
});

test('round-trip reconstructs SEDs, circuits, lines, analysis and every failure', async () => {
  const model = projectToInternalModel(await projectFixture());
  assert.equal(Object.keys(model.localDatabase).length, 1);
  assert.equal(model.localDatabase['00001S'].llaves.L1.lines.length, 1);
  assert.deepEqual(model.localDatabase['00001S'].llaves.L1.analysis.cableGroups[0].lineIds, ['tramo-1']);
  assert.equal(model.numberedPointsList.length, 2);
});

test('truncated JSON receives a friendly classified error', () => {
  assert.throws(() => parseProjectJson('{"format":"GEOPLUZ_PROJECT"'), error => (
    error instanceof ProjectParseError && error.code === 'TRUNCATED_JSON' && /incompleto|truncado/i.test(error.message)
  ));
});

test('wrong format and unsupported version are blocked', async () => {
  const wrongFormat = await projectFixture();
  wrongFormat.format = 'OTRO';
  assert.equal((await validateProject(wrongFormat, { verifyChecksum: false })).errors.some(item => item.code === 'INVALID_FORMAT'), true);
  const wrongVersion = await projectFixture();
  wrongVersion.version = 99;
  assert.equal((await validateProject(wrongVersion, { verifyChecksum: false })).errors.some(item => item.code === 'UNSUPPORTED_VERSION'), true);
});

test('duplicate SEDs, duplicate circuit keys and invalid coordinates are blocked', async () => {
  const project = await projectFixture();
  project.seds.push({ ...project.seds[0] });
  project.llaves.push({ ...project.llaves[0] });
  project.fallas[0].latitud = 120;
  project.integrity.counts.seds += 1;
  project.integrity.counts.llaves += 1;
  const validation = await validateProject(project, { verifyChecksum: false });
  assert.ok(validation.errors.some(item => item.code === 'DUPLICATE_SED'));
  assert.ok(validation.errors.some(item => item.code === 'DUPLICATE_LLAVE'));
  assert.ok(validation.errors.some(item => item.code === 'INVALID_COORDINATE'));
});

test('dangerous properties and unsafe URLs are rejected', async () => {
  assert.throws(() => parseProjectJson('{"__proto__":{"polluted":true}}'), error => error.code === 'UNSAFE_PROPERTY');
  const project = await projectFixture();
  project.fallas[0].link_croquis = 'javascript:alert(1)';
  const validation = await validateProject(project, { verifyChecksum: false });
  assert.ok(validation.errors.some(item => item.code === 'UNSAFE_URL'));
  project.fallas[0].link_croquis = 'https://example.com/croquis.pdf';
  project.fallas[0].fotos[0].url = 'data:image/png;base64,AAAA\" onerror=alert(1)';
  const dataUrlValidation = await validateProject(project, { verifyChecksum: false });
  assert.ok(dataUrlValidation.errors.some(item => item.code === 'UNSAFE_URL'));
});

test('legacy network JSON remains supported with an explicit incomplete-project warning', async () => {
  const legacy = fixture().database;
  assert.equal(isLegacyNetworkJson(legacy), true);
  const result = await parseAndValidateProjectInputText(JSON.stringify(legacy));
  assert.equal(result.valid, true);
  assert.equal(result.inputKind, 'LEGACY_NETWORK');
  assert.ok(result.warnings.some(item => item.code === 'LEGACY_NETWORK'));
});

test('GeoJSON is not mistaken for a full or legacy network project', () => {
  assert.equal(isLegacyNetworkJson({ type: 'FeatureCollection', features: [] }), false);
});

test('local-project cache keys cannot collide with the Base Principal cache', () => {
  assert.notEqual(getLocalProjectCacheKey('proyecto-prueba'), SEDS_CACHE_KEY);
  assert.match(getLocalProjectCacheKey('proyecto/prueba'), /^local_project:/);
});

test('local-project source marker is explicit and can be cleared before returning to Supabase', () => {
  const values = new Map();
  globalThis.sessionStorage = {
    setItem: (key, value) => values.set(key, value),
    getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key)
  };
  assert.equal(markLocalProjectExpected({ project: { id: 'local-1', name: 'Proyecto local 1' } }, { editable: true }), true);
  assert.deepEqual(getExpectedLocalProject(), { projectId: 'local-1', projectName: 'Proyecto local 1', editable: true });
  clearExpectedLocalProject();
  assert.equal(getExpectedLocalProject(), null);
  delete globalThis.sessionStorage;
});

test('editable local workspace is exposed without enabling Supabase write paths', () => {
  const pageSource = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const panelSource = readFileSync(new URL('../components/ProjectPanel.js', import.meta.url), 'utf8');
  assert.match(pageSource, /const isLocalWorkspace = dataSource\.kind === 'LOCAL_WORKSPACE'/);
  assert.match(pageSource, /if \(isLocalWorkspace\) return points;/);
  assert.match(pageSource, /async function saveFallaToSupabase[\s\S]*?if \(!isSupabaseSource\) return;/);
  assert.match(pageSource, /async function saveSedsToSupabase[\s\S]*?if \(!isSupabaseSource\) return;/);
  assert.match(panelSource, /Abrir copia editable/);
  assert.match(panelSource, /!isLocalWorkspace && <button[\s\S]*?Reemplazar Base Principal/);
});
