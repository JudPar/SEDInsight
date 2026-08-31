import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProjectDocument } from '../lib/projectMappers.js';
import { createSupabaseLifecycleRepository, deleteCurrentProject, discardStaging, finalizeStagedProject, getLifecycleTechnicalDetails, mapProjectForStaging, ProjectLifecycleError, stageProject } from '../lib/projectStaging.js';

const migrationUrl = new URL('../supabase/migrations/20260828_project_staging_and_lifecycle.sql', import.meta.url);
const auditMigrationUrl = new URL('../supabase/migrations/20260828070000_distinguish_project_import_audit.sql', import.meta.url);
const deleteSafeUpdateMigrationUrl = new URL('../supabase/migrations/20260831090000_fix_delete_current_project_safeupdate.sql', import.meta.url);
const pageUrl = new URL('../app/page.js', import.meta.url);
const panelUrl = new URL('../components/ProjectPanel.js', import.meta.url);
const directImporterUrl = new URL('../lib/projectImport.js', import.meta.url);

class MemoryStagingRepository {
  constructor() {
    this.nextId = 1;
    this.imports = new Map();
    this.rows = { project_staging_seds: [], project_staging_llaves: [], project_staging_fallas: [] };
    this.invalidImport = null;
    this.finalizations = [];
    this.failFinalize = false;
  }
  async createImport(manifest) {
    const importId = `00000000-0000-0000-0000-${String(this.nextId++).padStart(12, '0')}`;
    this.imports.set(importId, { ...manifest, importId });
    return importId;
  }
  async insert(table, rows) {
    this.rows[table].push(...structuredClone(rows));
    return rows.length;
  }
  async validate(importId) {
    if (this.invalidImport === importId) return { valid: false, error: 'Staging inválido sintético' };
    const manifest = this.imports.get(importId);
    const count = table => this.rows[table].filter(row => row.import_id === importId).length;
    const result = { seds: count('project_staging_seds'), llaves: count('project_staging_llaves'), fallas: count('project_staging_fallas') };
    return {
      valid: result.seds === manifest.expected_seds && result.llaves === manifest.expected_llaves && result.fallas === manifest.expected_fallas,
      ...result
    };
  }
  async discard(importId) {
    if (!this.imports.delete(importId)) return false;
    Object.keys(this.rows).forEach(table => { this.rows[table] = this.rows[table].filter(row => row.import_id !== importId); });
    return true;
  }
  async finalize(importId, expectedCounts) {
    this.finalizations.push({ importId, expectedCounts: { ...expectedCounts } });
    if (this.failFinalize) throw new Error('Synthetic transactional rollback');
    return {
      success: true,
      operation: expectedCounts.seds === 0 && expectedCounts.llaves === 0 && expectedCounts.fallas === 0 ? 'import' : 'replace',
      seds: 1,
      llaves: 1,
      fallas: 2
    };
  }
}

async function lifecycleProject(name = 'Proyecto B') {
  return createProjectDocument({
    '00001S': {
      name: 'SED Uno', sedCoord: [-12.05, -77.04], llaves: {
        L1: { id: 90, name: 'Llave 1', lines: [{ id: 't1', length: 20, coords: [[-12.05, -77.04], [-12.051, -77.041]] }], analysis: { status: 'analizado', note: 'OK', cableGroups: [] } }
      }
    }
  }, [
    { id: 800, ticket: 'T-1', sed: '00001S', llaveSistema: 'L1', sedLlave: '00001S-L1', coords: [-12.052, -77.042], fotos: [], coordSource: 'ORIGINAL' },
    { id: 801, ticket: 'T-1', sed: 'SIN-SED', llaveSistema: 'X', sedLlave: 'SIN-SED-X', coords: null, fotos: [] }
  ], { projectId: name.toLowerCase().replaceAll(' ', '-'), projectName: name, sourceKind: 'SUPABASE' });
}

test('staging loads canonical rows in batches and validates exact counts', async () => {
  const repository = new MemoryStagingRepository();
  const result = await stageProject(repository, await lifecycleProject(), 'user-1', { batchSizes: { seds: 1, llaves: 1, fallas: 1 } });
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.progress, { seds: 1, llaves: 1, fallas: 2 });
  const stagedFault = repository.rows.project_staging_fallas[0];
  assert.equal(stagedFault.source_id, 800);
  assert.equal(stagedFault.record_ref, 'falla:000001');
  assert.equal(stagedFault.relation.status, 'resolved');
});

test('independent import_id values never mix and cleanup removes only one staging load', async () => {
  const repository = new MemoryStagingRepository();
  const first = await stageProject(repository, await lifecycleProject('Proyecto Uno'), 'user-1');
  const second = await stageProject(repository, await lifecycleProject('Proyecto Dos'), 'user-1');
  assert.notEqual(first.importId, second.importId);
  await discardStaging(repository, first.importId);
  assert.equal(repository.imports.has(first.importId), false);
  assert.equal(repository.imports.has(second.importId), true);
  assert.equal(repository.rows.project_staging_fallas.every(row => row.import_id === second.importId), true);
});

test('invalid staging leaves the main database untouched and cleans its own import automatically', async () => {
  const repository = new MemoryStagingRepository();
  const originalValidate = repository.validate.bind(repository);
  repository.validate = async importId => {
    repository.invalidImport = importId;
    return originalValidate(importId);
  };
  await assert.rejects(
    stageProject(repository, await lifecycleProject(), 'user-1'),
    error => error instanceof ProjectLifecycleError && error.code === 'STAGING_INVALID' && error.cleanupSucceeded === true && error.importId === null
  );
  assert.equal(repository.imports.size, 0);
  assert.equal(repository.rows.project_staging_fallas.length, 0);
});

test('empty and populated databases finalize through the same staging RPC path', async () => {
  const repository = new MemoryStagingRepository();
  const emptyStage = await stageProject(repository, await lifecycleProject('Importación'), 'user-1');
  const imported = await finalizeStagedProject(repository, emptyStage.importId, { seds: 0, llaves: 0, fallas: 0 });
  assert.equal(imported.operation, 'import');

  const replaceStage = await stageProject(repository, await lifecycleProject('Reemplazo'), 'user-1');
  const replaced = await finalizeStagedProject(repository, replaceStage.importId, { seds: 36, llaves: 40, fallas: 839 });
  assert.equal(replaced.operation, 'replace');
  assert.deepEqual(repository.finalizations.map(item => item.expectedCounts), [
    { seds: 0, llaves: 0, fallas: 0 },
    { seds: 36, llaves: 40, fallas: 839 }
  ]);
});

test('a finalization error preserves valid staging for diagnosis and retry', async () => {
  const repository = new MemoryStagingRepository();
  const staged = await stageProject(repository, await lifecycleProject(), 'user-1');
  repository.failFinalize = true;
  await assert.rejects(
    finalizeStagedProject(repository, staged.importId, { seds: 36, llaves: 40, fallas: 839 }),
    error => error instanceof ProjectLifecycleError && error.code === 'FINALIZATION_FAILED' && error.importId === staged.importId
  );
  assert.equal(repository.imports.has(staged.importId), true);
});

test('staging mapper keeps historical numeric IDs as metadata only', async () => {
  const project = await lifecycleProject();
  const rows = mapProjectForStaging(project, 'import-1', 'user-1');
  assert.equal(rows.llaves[0].source_id, 90);
  assert.equal(rows.fallas[0].source_id, 800);
  assert.equal(Object.hasOwn(rows.llaves[0], 'id'), false);
  assert.equal(Object.hasOwn(rows.fallas[0], 'id'), false);
});

test('migration restricts staging by owner and DELETE remains unavailable to anon', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();
  assert.match(sql, /alter table public\.project_staging_seds enable row level security/);
  assert.match(sql, /owner_id = auth\.uid\(\)/);
  assert.match(sql, /grant delete on table public\.seds, public\.llaves, public\.fallas to authenticated/);
  assert.doesNotMatch(sql, /grant delete[^;]+to anon/);
  assert.match(sql, /revoke all on table public\.project_imports[^;]+from public, anon, authenticated/);
});

test('replacement and delete RPCs use one destructive lock, explicit order and sequence-safe generated IDs', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();
  assert.equal((sql.match(/pg_try_advisory_xact_lock\(7142, 20260828\)/g) || []).length, 2);
  assert.equal((sql.match(/lock table public\.seds, public\.llaves, public\.fallas in share row exclusive mode nowait/g) || []).length, 2);
  assert.doesNotMatch(sql, /lock table[^;]+suministros_coordenadas/);
  const replaceStart = sql.indexOf('create or replace function public.geopluz_replace_current_project');
  const deleteStart = sql.indexOf('create or replace function public.geopluz_delete_current_project');
  const replaceBody = sql.slice(replaceStart, deleteStart);
  assert.ok(replaceBody.indexOf('delete from public.fallas') < replaceBody.indexOf('delete from public.llaves'));
  assert.ok(replaceBody.indexOf('delete from public.llaves') < replaceBody.indexOf('delete from public.seds'));
  assert.ok(replaceBody.indexOf('insert into public.seds') < replaceBody.indexOf('insert into public.llaves'));
  assert.ok(replaceBody.indexOf('insert into public.llaves') < replaceBody.indexOf('insert into public.fallas'));
  assert.match(replaceBody, /insert into public\.llaves\(sed_id, llave_code, name, lines_data, created_at\)/);
  assert.match(replaceBody, /insert into public\.fallas\(\s*sed_id, llave_code/);
  assert.doesNotMatch(sql, /\bsetval\s*\(/);
  assert.match(replaceBody, /current project counts changed; confirmation must be repeated/);
  assert.match(sql.slice(deleteStart), /delete from public\.fallas;[\s\S]*delete from public\.llaves;[\s\S]*delete from public\.seds;/);
});

test('destructive RPC SQL cannot write the global supply master and records minimal audit metadata', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();
  assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+public\.suministros_coordenadas/);
  assert.match(sql, /select count\(\*\) into v_supply_before from public\.suministros_coordenadas/);
  assert.match(sql, /create table public\.project_operation_audit/);
  assert.match(sql, /operation, user_id, old_counts, new_counts, project_id, import_id/);
  assert.doesNotMatch(sql, /(password|jwt|service_role)/);
});

test('security-definer RPCs require auth.uid, fixed search_path and minimum EXECUTE grants', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();
  assert.ok((sql.match(/security definer/g) || []).length >= 3);
  assert.ok((sql.match(/set search_path = pg_catalog/g) || []).length >= 4);
  assert.match(sql, /if v_user_id is null then[\s\S]*authentication required/);
  assert.match(sql, /revoke all on function public\.geopluz_replace_current_project[^;]+from public, anon/);
  assert.match(sql, /grant execute on function public\.geopluz_replace_current_project[^;]+to authenticated/);
});

test('migration DDL and destructive table changes are transactionally rollback-safe', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase().trim();
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;$/);
  assert.doesNotMatch(sql, /\btruncate\b/);

  const replaceStart = sql.indexOf('create or replace function public.geopluz_replace_current_project');
  const deleteStart = sql.indexOf('create or replace function public.geopluz_delete_current_project');
  const replaceBody = sql.slice(replaceStart, deleteStart);
  const deleteBody = sql.slice(deleteStart);
  assert.match(replaceBody, /delete from public\.fallas;[\s\S]*raise exception using errcode = 'p0001', message = 'replacement count verification failed'/);
  assert.match(deleteBody, /delete from public\.fallas;[\s\S]*raise exception using errcode = 'p0001', message = 'project deletion verification failed'/);
  assert.match(replaceBody, /insert into public\.project_operation_audit[\s\S]*delete from public\.project_imports/);
});

test('incremental delete RPC uses explicit non-null primary-key predicates', async () => {
  const sql = (await readFile(deleteSafeUpdateMigrationUrl, 'utf8')).toLowerCase();
  assert.match(sql, /^begin;/);
  assert.match(sql, /delete from public\.fallas where id is not null;/);
  assert.match(sql, /delete from public\.llaves where id is not null;/);
  assert.match(sql, /delete from public\.seds where id is not null;/);
  assert.doesNotMatch(sql, /\btruncate\b|where\s+true/);
  assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from)\s+public\.suministros_coordenadas/);
  assert.match(sql.trim(), /commit;$/);
});

test('staging ownership is enforced by manifest foreign keys, RLS and scoped cleanup', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();
  assert.equal((sql.match(/foreign key \(import_id, owner_id\) references public\.project_imports\(import_id, owner_id\) on delete cascade/g) || []).length, 3);
  assert.equal((sql.match(/owner_id = auth\.uid\(\)/g) || []).length >= 13, true);
  assert.match(sql, /delete from public\.project_imports where import_id = p_import_id and owner_id = auth\.uid\(\)/);
  assert.doesNotMatch(sql, /grant (?:update|delete|insert)[^;]+project_operation_audit[^;]+to authenticated/);
});

test('lifecycle repository sends only the expected import id and count guards to RPCs', async () => {
  const calls = [];
  const client = {
    from() { throw new Error('Not used in this test'); },
    async rpc(name, payload) {
      calls.push({ name, payload });
      return { data: { success: true }, error: null };
    }
  };
  const repository = createSupabaseLifecycleRepository(client);
  await repository.finalize('import-a', { seds: 3, llaves: 4, fallas: 5 });
  await repository.deleteCurrent({ seds: 6, llaves: 7, fallas: 8 });
  assert.deepEqual(calls, [
    {
      name: 'geopluz_replace_current_project',
      payload: {
        p_import_id: 'import-a',
        p_expected_current_seds: 3,
        p_expected_current_llaves: 4,
        p_expected_current_fallas: 5
      }
    },
    {
      name: 'geopluz_delete_current_project',
      payload: {
        p_expected_current_seds: 6,
        p_expected_current_llaves: 7,
        p_expected_current_fallas: 8
      }
    }
  ]);
});

test('delete diagnostics expose the four supported technical fields', () => {
  const details = getLifecycleTechnicalDetails({ cause: {
    code: '55P03',
    message: 'could not obtain lock on relation',
    details: 'Lock was held by another transaction',
    hint: 'Retry after the active operation finishes'
  } });

  assert.deepEqual(details, {
    code: '55P03',
    message: 'could not obtain lock on relation',
    details: 'Lock was held by another transaction',
    hint: 'Retry after the active operation finishes'
  });
});

test('delete diagnostics omit unavailable fields and missing causes', () => {
  assert.deepEqual(getLifecycleTechnicalDetails({ cause: { code: '40001', hint: 'Retry' } }), {
    code: '40001', hint: 'Retry'
  });
  assert.equal(getLifecycleTechnicalDetails(new Error('Outer message only')), null);
  assert.equal(getLifecycleTechnicalDetails({ cause: {} }), null);
});

test('delete diagnostics redact credentials, keys, tokens and stack lines', () => {
  const details = getLifecycleTechnicalDetails({ cause: {
    code: 'XX000',
    message: 'postgresql://admin:super-secret@db.example.test/main Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    details: 'apikey=private-key token=private-token\n    at deleteCurrentProject (secret.js:10)',
    hint: 'Use sb_secret_privatevalue'
  } });
  const rendered = JSON.stringify(details);

  for (const secret of ['admin', 'super-secret', 'private-key', 'private-token', 'eyJhbGciOiJIUzI1NiJ9', 'sb_secret_privatevalue', 'secret.js']) {
    assert.doesNotMatch(rendered, new RegExp(secret));
  }
  assert.match(rendered, /REDACTED/);
});

test('successful project deletion flow returns the original RPC result unchanged', async () => {
  const expected = { success: true, seds: 0, llaves: 0, fallas: 0 };
  const repository = { async deleteCurrent(counts) {
    assert.deepEqual(counts, { seds: 36, llaves: 40, fallas: 839 });
    return expected;
  } };

  assert.equal(await deleteCurrentProject(repository, { seds: 36, llaves: 40, fallas: 839 }), expected);
});

test('incremental audit migration records IMPORT for an empty base and REPLACE otherwise', async () => {
  const sql = (await readFile(auditMigrationUrl, 'utf8')).toLowerCase();
  assert.match(sql, /check \(operation in \('import', 'replace', 'delete'\)\)/);
  assert.match(sql, /when v_old_seds = 0 and v_old_llaves = 0 and v_old_fallas = 0 then 'import'/);
  assert.match(sql, /else 'replace'/);
  assert.match(sql, /'operation', v_operation/);
  assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+public\.suministros_coordenadas/);
  assert.doesNotMatch(sql, /\b(auth\.users|storage\.)\b/);
});

test('GEOPLUZ_PROJECT UI has no reachable direct batch-import path', async () => {
  const page = await readFile(pageUrl, 'utf8');
  const panel = await readFile(panelUrl, 'utf8');
  const directImporter = await readFile(directImporterUrl, 'utf8');
  assert.doesNotMatch(page, /importProjectToSupabase|handleImportProject/);
  assert.doesNotMatch(panel, /onImportProject/);
  assert.match(directImporter, /@deprecated compatibility-only batch importer/i);
  assert.match(page, /stageProject\(repository, project, session\.user\.id/);
  assert.match(page, /finalizeStagedProject\(repository, importId, freshCounts\)/);
  assert.match(panel, /\['empty', 'blocked'\]\.includes\(databaseState\.phase\)/);
  assert.match(panel, /onFinalizeProject\(staging\.importId, databaseState\.counts, result\.preview\.counts\)/);
  assert.match(panel, /if \(!confirmed\) \{[\s\S]*await handleDiscardPreparedStaging\(\)/);
  assert.match(panel, /if \(!skipStagingDiscard && staging\?\.importId\)/);
});

test('individual SED and circuit deletion never deletes related failures heuristically', async () => {
  const source = await readFile(pageUrl, 'utf8');
  const sedStart = source.indexOf('async function handleDeleteSed');
  const llaveStart = source.indexOf('async function handleDeleteLlave');
  const nextStart = source.indexOf('// Reubicaci', llaveStart);
  const sedBody = source.slice(sedStart, llaveStart);
  const llaveBody = source.slice(llaveStart, nextStart);
  assert.match(sedBody, /from\('fallas'\)\.select\('\*', \{ count: 'exact', head: true \}\)\.eq\('sed_id', sedId\)/);
  assert.match(sedBody, /from\('seds'\)\.delete\(\)\.eq\('id', sedId\)/);
  assert.doesNotMatch(sedBody, /from\('fallas'\)\.delete\(\)/);
  assert.match(llaveBody, /from\('fallas'\)\.select\('\*', \{ count: 'exact', head: true \}\)\.eq\('sed_id', sedId\)\.eq\('llave_code', llaveCode\)/);
  assert.match(llaveBody, /from\('llaves'\)\.delete\(\)\.eq\('sed_id', sedId\)\.eq\('llave_code', llaveCode\)/);
  assert.doesNotMatch(llaveBody, /from\('fallas'\)\.delete\(\)/);
});
