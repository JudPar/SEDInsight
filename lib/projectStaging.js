import { PROJECT_IMPORT_BATCH_SIZES, mapProjectForSupabase } from './projectImport.js';

export const STAGING_TABLES = Object.freeze({
  seds: 'project_staging_seds',
  llaves: 'project_staging_llaves',
  fallas: 'project_staging_fallas'
});

export class ProjectLifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectLifecycleError';
    this.code = code;
    this.phase = details.phase || 'staging';
    this.importId = details.importId || null;
    this.progress = details.progress || { seds: 0, llaves: 0, fallas: 0 };
    this.cleanupSucceeded = details.cleanupSucceeded ?? null;
    this.cleanupError = details.cleanupError || null;
    this.cause = details.cause;
  }
}

const TECHNICAL_ERROR_FIELDS = Object.freeze(['code', 'message', 'details', 'hint']);

function sanitizeTechnicalErrorValue(value) {
  if (value === null || value === undefined) return null;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text
    .split(/\r?\n/)
    .filter(line => !/^\s*at\s+/i.test(line))
    .join(' ')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@([^\s]+)/gi, '$1[REDACTED]@$2')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gi, '[REDACTED_KEY]')
    .replace(/\b(password|passwd|pwd|token|api[_-]?key|apikey|authorization|secret)\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[REDACTED]')
    .trim();
  if (!text) return null;
  return text.slice(0, 1000);
}

export function getLifecycleTechnicalDetails(error) {
  const cause = error?.cause;
  if (!cause || (typeof cause !== 'object' && typeof cause !== 'function')) return null;
  const details = {};
  TECHNICAL_ERROR_FIELDS.forEach((field) => {
    const value = sanitizeTechnicalErrorValue(cause[field]);
    if (value) details[field] = value;
  });
  return Object.keys(details).length ? details : null;
}

export function createSupabaseLifecycleRepository(client) {
  if (!client?.from || !client?.rpc) throw new ProjectLifecycleError('SUPABASE_UNAVAILABLE', 'Supabase no está configurado.');
  return {
    async createImport(manifest) {
      const { data, error } = await client.from('project_imports').insert(manifest).select('import_id').single();
      if (error) throw error;
      return data?.import_id;
    },
    async insert(table, rows) {
      if (!rows.length) return 0;
      const { data, error } = await client.from(table).insert(rows).select('import_id');
      if (error) throw error;
      return Array.isArray(data) ? data.length : 0;
    },
    async validate(importId) {
      const { data, error } = await client.rpc('geopluz_validate_project_staging', { p_import_id: importId });
      if (error) throw error;
      return data;
    },
    async discard(importId) {
      const { data, error } = await client.rpc('geopluz_discard_project_staging', { p_import_id: importId });
      if (error) throw error;
      return data === true;
    },
    async finalize(importId, expectedCounts) {
      const { data, error } = await client.rpc('geopluz_replace_current_project', {
        p_import_id: importId,
        p_expected_current_seds: expectedCounts.seds,
        p_expected_current_llaves: expectedCounts.llaves,
        p_expected_current_fallas: expectedCounts.fallas
      });
      if (error) throw error;
      return data;
    },
    async deleteCurrent(expectedCounts) {
      const { data, error } = await client.rpc('geopluz_delete_current_project', {
        p_expected_current_seds: expectedCounts.seds,
        p_expected_current_llaves: expectedCounts.llaves,
        p_expected_current_fallas: expectedCounts.fallas
      });
      if (error) throw error;
      return data;
    }
  };
}

export function mapProjectForStaging(project, importId, ownerId) {
  const target = mapProjectForSupabase(project);
  return {
    manifest: {
      owner_id: ownerId,
      project_id: project.project.id,
      project_name: project.project.name,
      checksum: project.integrity.checksum,
      expected_seds: project.integrity.counts.seds,
      expected_llaves: project.integrity.counts.llaves,
      expected_fallas: project.integrity.counts.fallas
    },
    seds: target.seds.map((row, index) => ({
      import_id: importId,
      owner_id: ownerId,
      id: row.id,
      name: row.name,
      sed_coord: row.sed_coord,
      source_created_at: project.seds[index].created_at
    })),
    llaves: target.llaves.map((row, index) => ({
      import_id: importId,
      owner_id: ownerId,
      source_id: project.llaves[index].source_id,
      sed_id: row.sed_id,
      llave_code: row.llave_code,
      name: row.name,
      lines_data: row.lines_data,
      source_created_at: project.llaves[index].created_at
    })),
    fallas: target.fallas.map((row, index) => ({
      import_id: importId,
      owner_id: ownerId,
      record_ref: project.fallas[index].record_ref,
      source_id: project.fallas[index].source_id,
      relation: project.fallas[index].relation,
      sed_id: row.sed_id,
      llave_code: row.llave_code,
      sed_llave: row.sed_llave,
      ticket: row.ticket,
      suministro: row.suministro,
      falla_real: row.falla_real,
      causa: row.causa,
      nota: row.nota,
      odm: row.odm,
      zona: row.zona,
      set_alimentador: row.set_alimentador,
      hora_inicio: row.hora_inicio,
      latitud: row.latitud,
      longitud: row.longitud,
      link_croquis: row.link_croquis,
      fotos: row.fotos,
      coord_source: row.coord_source,
      coord_lookup_suministro: row.coord_lookup_suministro,
      source_created_at: project.fallas[index].created_at
    }))
  };
}

async function insertStagingPhase(repository, tableKey, rows, batchSize, progress, importId, onProgress) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    try {
      const inserted = await repository.insert(STAGING_TABLES[tableKey], batch);
      if (inserted !== batch.length) throw new Error(`Se confirmaron ${inserted} de ${batch.length} registros.`);
      progress[tableKey] += inserted;
      onProgress?.({ phase: tableKey, progress: { ...progress }, importId });
    } catch (cause) {
      throw new ProjectLifecycleError('STAGING_BATCH_FAILED', `Falló la carga de staging en ${tableKey}.`, {
        phase: tableKey, importId, progress: { ...progress }, cause
      });
    }
  }
}

export async function stageProject(repository, project, ownerId, options = {}) {
  if (!ownerId) throw new ProjectLifecycleError('AUTH_REQUIRED', 'Se requiere un usuario autenticado para crear staging.');
  const progress = { seds: 0, llaves: 0, fallas: 0 };
  const batchSizes = { ...PROJECT_IMPORT_BATCH_SIZES, ...(options.batchSizes || {}) };
  let importId;
  try {
    importId = await repository.createImport({
      owner_id: ownerId,
      project_id: project.project.id,
      project_name: project.project.name,
      checksum: project.integrity.checksum,
      expected_seds: project.integrity.counts.seds,
      expected_llaves: project.integrity.counts.llaves,
      expected_fallas: project.integrity.counts.fallas
    });
  } catch (cause) {
    throw new ProjectLifecycleError('STAGING_CREATE_FAILED', 'No se pudo crear la sesión de staging.', { cause, progress });
  }
  if (!importId) throw new ProjectLifecycleError('STAGING_CREATE_FAILED', 'Supabase no devolvió el import_id de staging.', { progress });

  try {
    const rows = mapProjectForStaging(project, importId, ownerId);
    await insertStagingPhase(repository, 'seds', rows.seds, batchSizes.seds, progress, importId, options.onProgress);
    await insertStagingPhase(repository, 'llaves', rows.llaves, batchSizes.llaves, progress, importId, options.onProgress);
    await insertStagingPhase(repository, 'fallas', rows.fallas, batchSizes.fallas, progress, importId, options.onProgress);

    options.onProgress?.({ phase: 'validation', progress: { ...progress }, importId });
    let validation;
    try {
      validation = await repository.validate(importId);
    } catch (cause) {
      throw new ProjectLifecycleError('STAGING_VALIDATION_FAILED', 'No se pudo validar el staging.', {
        phase: 'validation', importId, progress: { ...progress }, cause
      });
    }
    if (!validation?.valid) {
      throw new ProjectLifecycleError('STAGING_INVALID', validation?.error || 'El staging no pasó la validación.', {
        phase: 'validation', importId, progress: { ...progress }
      });
    }

    return { importId, validation, progress: { ...progress } };
  } catch (error) {
    let cleanupSucceeded = false;
    let cleanupError = null;
    try {
      cleanupSucceeded = await repository.discard(importId);
    } catch (cause) {
      cleanupError = cause;
    }
    if (error instanceof ProjectLifecycleError) {
      error.cleanupSucceeded = cleanupSucceeded;
      error.cleanupError = cleanupError;
      error.importId = cleanupSucceeded ? null : importId;
      throw error;
    }
    throw new ProjectLifecycleError('STAGING_FAILED', 'No se pudo preparar el staging.', {
      importId: cleanupSucceeded ? null : importId,
      progress: { ...progress }, cleanupSucceeded, cleanupError, cause: error
    });
  }
}

export async function discardStaging(repository, importId) {
  if (!importId) return false;
  try {
    return await repository.discard(importId);
  } catch (cause) {
    throw new ProjectLifecycleError('STAGING_DISCARD_FAILED', 'No se pudo descartar la carga de staging.', { phase: 'cleanup', importId, cause });
  }
}

export async function finalizeStagedProject(repository, importId, expectedCounts) {
  try {
    const result = await repository.finalize(importId, expectedCounts);
    if (!result?.success) throw new Error('La RPC no confirmó la finalización.');
    return result;
  } catch (cause) {
    throw new ProjectLifecycleError('FINALIZATION_FAILED', 'La finalización fue rechazada y PostgreSQL revirtió la transacción.', { phase: 'finalization', importId, cause });
  }
}

export async function deleteCurrentProject(repository, expectedCounts) {
  try {
    const result = await repository.deleteCurrent(expectedCounts);
    if (!result?.success) throw new Error('La RPC no confirmó el borrado.');
    return result;
  } catch (cause) {
    throw new ProjectLifecycleError('DELETE_PROJECT_FAILED', 'El borrado fue rechazado y PostgreSQL revirtió la transacción.', { phase: 'delete', cause });
  }
}
