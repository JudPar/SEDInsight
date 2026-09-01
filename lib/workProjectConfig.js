import { normalizePeriodKey } from './faultPeriods.js';

export const GEOPLUZ_PROJECT_CONFIG_FORMAT = 'GEOPLUZ_PROJECT_CONFIG';
export const GEOPLUZ_PROJECT_CONFIG_VERSION = 1;

export function createWorkProjectConfig({ id, name, description = '', sedIds = [], periodKeys = [] } = {}) {
  const normalizedSeds = [...new Set((sedIds || []).map(String).map(value => value.trim()).filter(Boolean))].sort();
  const normalizedPeriods = [...new Set((periodKeys || []).map(normalizePeriodKey).filter(Boolean))].sort();
  const now = new Date().toISOString();
  return {
    format: GEOPLUZ_PROJECT_CONFIG_FORMAT,
    version: GEOPLUZ_PROJECT_CONFIG_VERSION,
    id: id || globalThis.crypto?.randomUUID?.() || `project-${Date.now()}`,
    name: String(name || '').trim(),
    description: String(description || '').trim(),
    sed_ids: normalizedSeds,
    period_keys: normalizedPeriods,
    created_at: now,
    updated_at: now
  };
}

export function validateWorkProjectConfig(config, availableSedIds = [], availablePeriodKeys = []) {
  const errors = [];
  if (config?.format !== GEOPLUZ_PROJECT_CONFIG_FORMAT || config?.version !== GEOPLUZ_PROJECT_CONFIG_VERSION) errors.push('Formato o versión no compatible.');
  if (!String(config?.name || '').trim()) errors.push('El proyecto necesita un nombre.');
  if (!Array.isArray(config?.sed_ids) || config.sed_ids.some(id => !String(id || '').trim())) errors.push('La lista de SED no es válida.');
  if (!Array.isArray(config?.period_keys) || config.period_keys.some(key => !normalizePeriodKey(key))) errors.push('La lista de periodos no es válida.');
  const availableSeds = new Set(availableSedIds || []);
  const availablePeriods = new Set(availablePeriodKeys || []);
  const missingSeds = (Array.isArray(config?.sed_ids) ? config.sed_ids : []).filter(id => !availableSeds.has(id));
  const missingPeriods = (Array.isArray(config?.period_keys) ? config.period_keys : []).filter(key => !availablePeriods.has(key));
  return { valid: errors.length === 0, errors, missingSeds, missingPeriods };
}
