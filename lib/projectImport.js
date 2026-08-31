import { serializeLlaveLines } from './circuitAnalysis.js';

export const PROJECT_TABLES = Object.freeze(['seds', 'llaves', 'fallas']);
export const PROJECT_IMPORT_BATCH_SIZES = Object.freeze({ seds: 200, llaves: 200, fallas: 300 });

export class ProjectImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectImportError';
    this.code = code;
    this.phase = details.phase || 'preflight';
    this.progress = details.progress || { seds: 0, llaves: 0, fallas: 0 };
    this.counts = details.counts || null;
    this.cause = details.cause;
  }
}

function cloneValue(value) {
  if (value === undefined) return null;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function withoutNullCreatedAt(record, createdAt) {
  return createdAt ? { ...record, created_at: createdAt } : record;
}

export function createSupabaseProjectRepository(client) {
  if (!client?.from) throw new ProjectImportError('SUPABASE_UNAVAILABLE', 'Supabase no está configurado.', { phase: 'preflight' });
  return {
    async count(table) {
      const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
      if (error) throw error;
      if (!Number.isInteger(count)) throw new Error(`Supabase no devolvió un conteo exacto para ${table}.`);
      return count;
    },
    async insert(table, rows) {
      if (!rows.length) return 0;
      const { data, error } = await client.from(table).insert(rows).select('id');
      if (error) throw error;
      return Array.isArray(data) ? data.length : 0;
    }
  };
}

export async function getMainDatabaseState(repository) {
  try {
    const [seds, llaves, fallas] = await Promise.all(PROJECT_TABLES.map(table => repository.count(table)));
    return { seds, llaves, fallas, isEmpty: seds === 0 && llaves === 0 && fallas === 0 };
  } catch (cause) {
    throw new ProjectImportError('DATABASE_CHECK_FAILED', 'No se pudo comprobar el estado real de la Base Principal.', { phase: 'preflight', cause });
  }
}

export function canImportProjectToMain(databaseState) {
  return databaseState?.isEmpty === true;
}

export function mapProjectForSupabase(project) {
  const seds = project.seds.map(sed => withoutNullCreatedAt({
    id: sed.id,
    name: sed.name,
    sed_coord: cloneValue(sed.sed_coord)
  }, sed.created_at));

  const llaves = project.llaves.map(llave => {
    if (Array.isArray(llave.lines_data)) {
      return withoutNullCreatedAt({
        sed_id: llave.sed_id,
        llave_code: llave.llave_code,
        name: llave.name,
        lines_data: cloneValue(llave.lines_data)
      }, llave.created_at);
    }
    const analysis = cloneValue(llave.analysis || {});
    if (Object.hasOwn(analysis, 'cable_groups')) {
      analysis.cableGroups = analysis.cable_groups.map(group => {
        const result = cloneValue(group || {});
        if (Object.hasOwn(result, 'line_ids')) {
          result.lineIds = cloneValue(result.line_ids);
          delete result.line_ids;
        }
        return result;
      });
      delete analysis.cable_groups;
    }
    return withoutNullCreatedAt({
      sed_id: llave.sed_id,
      llave_code: llave.llave_code,
      name: llave.name,
      lines_data: serializeLlaveLines({
        lines: cloneValue(llave.lines),
        analysis
      })
    }, llave.created_at);
  });

  const fallas = project.fallas.map(falla => withoutNullCreatedAt({
    sed_id: falla.sed_id,
    llave_code: falla.llave_code,
    sed_llave: falla.sed_llave,
    ticket: falla.ticket,
    suministro: falla.suministro,
    falla_real: falla.falla_real,
    causa: falla.causa,
    nota: falla.nota,
    odm: falla.odm,
    zona: falla.zona,
    set_alimentador: falla.set_alimentador,
    hora_inicio: falla.hora_inicio,
    latitud: falla.latitud,
    longitud: falla.longitud,
    link_croquis: falla.link_croquis,
    fotos: cloneValue(falla.fotos),
    coord_source: falla.coord_source,
    coord_lookup_suministro: falla.coord_lookup_suministro
  }, falla.created_at));

  return { seds, llaves, fallas };
}

function assertCounts(actual, expected, phase, progress) {
  const mismatch = PROJECT_TABLES.some(table => actual[table] !== expected[table]);
  if (mismatch) {
    throw new ProjectImportError(
      'PHASE_COUNT_MISMATCH',
      `La verificación posterior a ${phase} no coincide con el proyecto.`,
      { phase, progress: { ...progress }, counts: actual }
    );
  }
}

async function verifyRemoteCounts(repository, expected, phase, progress) {
  let actual;
  try {
    actual = await getMainDatabaseState(repository);
  } catch (cause) {
    throw new ProjectImportError(
      'VERIFICATION_FAILED',
      `No se pudieron verificar los conteos después de ${phase}.`,
      { phase, progress: { ...progress }, cause }
    );
  }
  assertCounts(actual, expected, phase, progress);
  return actual;
}

async function insertPhase(repository, table, rows, batchSize, progress, onProgress) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    try {
      const inserted = await repository.insert(table, batch);
      if (inserted !== batch.length) throw new Error(`Se confirmaron ${inserted} de ${batch.length} registros.`);
      progress[table] += inserted;
      onProgress?.({ phase: table, progress: { ...progress }, total: rows.length });
    } catch (cause) {
      throw new ProjectImportError(
        'BATCH_FAILED',
        `Falló un lote durante la importación de ${table}.`,
        { phase: table, progress: { ...progress }, cause }
      );
    }
  }
}

/**
 * @deprecated Compatibility-only batch importer. Complete GEOPLUZ_PROJECT
 * documents must use projectStaging.stageProject() + finalizeStagedProject().
 * This function is intentionally not referenced by the application UI.
 */
export async function importProjectToSupabase(repository, project, options = {}) {
  const progress = { seds: 0, llaves: 0, fallas: 0 };
  const rows = mapProjectForSupabase(project);
  const expected = project.integrity.counts;
  const batchSizes = { ...PROJECT_IMPORT_BATCH_SIZES, ...(options.batchSizes || {}) };

  const initialState = await getMainDatabaseState(repository);
  if (!initialState.isEmpty) {
    throw new ProjectImportError(
      'DATABASE_NOT_EMPTY',
      'La Base Principal ya contiene datos. La importación directa está bloqueada.',
      { phase: 'preflight', progress, counts: initialState }
    );
  }

  options.onProgress?.({ phase: 'seds', progress: { ...progress }, total: rows.seds.length });
  await insertPhase(repository, 'seds', rows.seds, batchSizes.seds, progress, options.onProgress);
  let remoteCounts = await verifyRemoteCounts(repository, { seds: expected.seds, llaves: 0, fallas: 0 }, 'seds', progress);

  options.onProgress?.({ phase: 'llaves', progress: { ...progress }, total: rows.llaves.length });
  await insertPhase(repository, 'llaves', rows.llaves, batchSizes.llaves, progress, options.onProgress);
  remoteCounts = await verifyRemoteCounts(repository, { seds: expected.seds, llaves: expected.llaves, fallas: 0 }, 'llaves', progress);

  options.onProgress?.({ phase: 'fallas', progress: { ...progress }, total: rows.fallas.length });
  await insertPhase(repository, 'fallas', rows.fallas, batchSizes.fallas, progress, options.onProgress);
  remoteCounts = await verifyRemoteCounts(repository, expected, 'verification', progress);

  return { success: true, expected: { ...expected }, counts: remoteCounts, progress: { ...progress } };
}
