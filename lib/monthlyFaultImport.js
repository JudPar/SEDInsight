import { formatPeriodLabel, normalizePeriodKey, stableFaultIdentity } from './faultPeriods.js';
import { nullableFiniteNumber } from './faultGeolocation.js';

function findRootPeriod(input) {
  return normalizePeriodKey(input?.period_key || input?.periodKey || input?.period || input?.metadata?.period_key || input?.metadata?.period);
}

function normalizeFieldName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findField(row, names) {
  for (const name of names) if (row?.[name] !== undefined && row?.[name] !== null && row?.[name] !== '') return row[name];
  const wanted = new Set(names.map(normalizeFieldName));
  const key = Object.keys(row || {}).find(candidate => wanted.has(normalizeFieldName(candidate)));
  return key ? row[key] : null;
}

export function derivePeriodKeyFromStartTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/]\d{1,2}(?:\D|$)/);
  if (match) return normalizePeriodKey(`${match[1]}-${String(Number(match[2])).padStart(2, '0')}`);
  match = text.match(/^\d{1,2}[/-](\d{1,2})[/-](\d{4})(?:\D|$)/);
  if (match) return normalizePeriodKey(`${match[2]}-${String(Number(match[1])).padStart(2, '0')}`);
  return null;
}

function resolveRowPeriod(row, rootPeriod) {
  const explicit = normalizePeriodKey(findField(row, ['period_key', 'periodKey', 'period']));
  const startTime = findField(row, ['hora_inicio', 'horaInicio', 'Hora de inicio', 'fecha_inicio', 'fechaInicio']);
  const derived = derivePeriodKeyFromStartTime(startTime);
  if (explicit && derived && explicit !== derived) return { periodKey: null, reason: 'period_conflict', explicit, derived };
  return { periodKey: derived || explicit || rootPeriod || null, reason: derived ? 'start_time' : explicit ? 'row_period' : rootPeriod ? 'root_period' : 'missing_period' };
}

export function normalizeCallCount(value) {
  if (value === null || value === undefined || String(value).trim() === '') return { valid: true, value: null, provided: false };
  if (typeof value === 'number') return { valid: Number.isFinite(value) && value >= 0 && Number.isInteger(value), value: Number.isFinite(value) && value >= 0 && Number.isInteger(value) ? value : null, provided: true };
  let text = String(value).trim().replace(/\s+/g, '');
  if (/^\d{1,3}(,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
  else if (/^\d+[.,]0+$/.test(text)) text = text.replace(',', '.');
  if (!/^\d+(?:\.0+)?$/.test(text)) return { valid: false, value: null, provided: true };
  const parsed = Number(text);
  return { valid: Number.isSafeInteger(parsed) && parsed >= 0, value: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null, provided: true };
}

function findRows(input) {
  if (Array.isArray(input)) return input;
  for (const key of ['fallas', 'records', 'data', 'items']) if (Array.isArray(input?.[key])) return input[key];
  return [];
}

function readSedId(row) {
  const direct = String(row?.sed_id || row?.sed || row?.SED || '').trim();
  if (direct) return direct;
  return String(row?.sed_llave || row?.sedLlave || '').split('-')[0]?.trim() || '';
}

function readLlave(row) {
  const direct = String(row?.llave_code || row?.llaveSistema || row?.llave || '').trim();
  if (direct) return direct;
  return String(row?.sed_llave || row?.sedLlave || '').split('-')[1]?.trim() || '';
}

function canonicalRow(row, periodKey, index) {
  const latitud = nullableFiniteNumber(row?.latitud ?? row?.lat ?? row?.coords?.[0]);
  const longitud = nullableFiniteNumber(row?.longitud ?? row?.lng ?? row?.coords?.[1]);
  const coordinatesValid = (latitud === null && longitud === null) || (latitud !== null && longitud !== null && latitud >= -90 && latitud <= 90 && longitud >= -180 && longitud <= 180);
  const sedId = readSedId(row);
  const llaveCode = readLlave(row);
  const sourceRecordId = String(row?.source_record_id ?? row?.sourceRecordId ?? row?.id ?? row?.ticket ?? '').trim();
  const calls = normalizeCallCount(findField(row, ['call_count', 'callCount', 'Llamadas', 'cantidad_llamadas', 'cantidadLlamadas']));
  return {
    valid: Boolean(row && typeof row === 'object' && sedId && coordinatesValid && calls.valid),
    invalidReason: calls.valid ? null : 'invalid_call_count',
    identityAmbiguous: !sourceRecordId,
    value: {
      period_key: periodKey,
      source_record_id: sourceRecordId || `row-${index + 1}`,
      call_count: calls.value,
      sed_id: sedId,
      llave_code: llaveCode || null,
      sed_llave: row?.sed_llave || row?.sedLlave || [sedId, llaveCode].filter(Boolean).join('-'),
      ticket: row?.ticket || null,
      suministro: row?.suministro === null || row?.suministro === undefined ? null : String(row.suministro),
      falla_real: row?.falla_real || row?.falla || row?.fallaReal || null,
      causa: row?.causa || null,
      nota: row?.nota || null,
      odm: row?.odm || null,
      zona: row?.zona || null,
      set_alimentador: row?.set_alimentador || row?.setAlimentador || [row?.set, row?.alimentador].filter(Boolean).join(' / ') || null,
      hora_inicio: findField(row, ['hora_inicio', 'horaInicio', 'Hora de inicio', 'fecha_inicio', 'fechaInicio']) || null,
      latitud,
      longitud,
      link_croquis: row?.link_croquis || row?.linkCroquis || null,
      fotos: Array.isArray(row?.fotos) ? row.fotos : [],
      coord_source: row?.coord_source || row?.coordSource || null,
      coord_lookup_suministro: row?.coord_lookup_suministro || row?.coordLookupSuministro || null,
      source_created_at: row?.created_at || row?.createdAt || null
    }
  };
}

export function prepareMonthlyFaultImport(input, permanentSedIds, existingPeriodKeys = []) {
  const rootPeriod = findRootPeriod(input);
  const rows = findRows(input);
  const permanent = new Set(permanentSedIds || []);
  const seenByPeriod = new Map();
  const acceptedRows = [];
  const outsideRows = [];
  const invalidRows = [];
  const duplicateRows = [];
  const ambiguousIdentityRows = [];
  const groups = new Map();

  function getGroup(periodKey) {
    if (!groups.has(periodKey)) groups.set(periodKey, { periodKey, received: 0, acceptedRows: [], outsideRows: [], invalidRows: [], duplicateRows: [], ambiguousIdentityRows: [] });
    return groups.get(periodKey);
  }

  rows.forEach((row, index) => {
    const resolution = resolveRowPeriod(row, rootPeriod);
    if (!resolution.periodKey) return invalidRows.push({ index, row, reason: resolution.reason, explicit: resolution.explicit, derived: resolution.derived });
    const group = getGroup(resolution.periodKey);
    group.received += 1;
    const canonical = canonicalRow(row, resolution.periodKey, index);
    if (!canonical.valid) {
      const diagnostic = { index, row, reason: canonical.invalidReason || 'invalid_record' };
      invalidRows.push(diagnostic);
      return group.invalidRows.push(diagnostic);
    }
    if (!permanent.has(canonical.value.sed_id)) {
      const diagnostic = { index, row: canonical.value };
      outsideRows.push(diagnostic);
      return group.outsideRows.push(diagnostic);
    }
    if (!seenByPeriod.has(resolution.periodKey)) seenByPeriod.set(resolution.periodKey, new Set());
    const seen = seenByPeriod.get(resolution.periodKey);
    const identity = stableFaultIdentity({
      periodKey: resolution.periodKey,
      sourceRecordId: canonical.value.source_record_id,
      ticket: canonical.value.ticket
    });
    if (seen.has(identity)) {
      const diagnostic = { index, row: canonical.value };
      duplicateRows.push(diagnostic);
      return group.duplicateRows.push(diagnostic);
    }
    seen.add(identity);
    acceptedRows.push(canonical.value);
    group.acceptedRows.push(canonical.value);
    if (canonical.identityAmbiguous) {
      const diagnostic = { index, row: canonical.value };
      ambiguousIdentityRows.push(diagnostic);
      group.ambiguousIdentityRows.push(diagnostic);
    }
  });

  const periodPreviews = [...groups.values()].sort((a, b) => a.periodKey.localeCompare(b.periodKey)).map(group => ({
    valid: group.acceptedRows.length > 0,
    periodKey: group.periodKey,
    periodLabel: formatPeriodLabel(group.periodKey),
    periodExists: (existingPeriodKeys || []).includes(group.periodKey),
    received: group.received,
    recognizedSeds: new Set(group.acceptedRows.map(row => row.sed_id)).size,
    accepted: group.acceptedRows.length,
    outsideUniverse: group.outsideRows.length,
    duplicates: group.duplicateRows.length,
    ambiguousIdentities: group.ambiguousIdentityRows.length,
    invalid: group.invalidRows.length,
    rows: group.acceptedRows,
    diagnostics: { outsideRows: group.outsideRows, invalidRows: group.invalidRows, duplicateRows: group.duplicateRows, ambiguousIdentityRows: group.ambiguousIdentityRows }
  }));
  const single = periodPreviews.length === 1 ? periodPreviews[0] : null;

  return {
    valid: Boolean(rows.length > 0 && acceptedRows.length > 0 && periodPreviews.some(period => period.valid)),
    periodKey: single?.periodKey || null,
    periodLabel: single?.periodLabel || (periodPreviews.length ? `${periodPreviews.length} periodos` : null),
    periodExists: periodPreviews.some(period => period.periodExists),
    periodCount: periodPreviews.length,
    periods: periodPreviews,
    received: rows.length,
    recognizedSeds: new Set(acceptedRows.map(row => row.sed_id)).size,
    accepted: acceptedRows.length,
    outsideUniverse: outsideRows.length,
    duplicates: duplicateRows.length,
    ambiguousIdentities: ambiguousIdentityRows.length,
    invalid: invalidRows.length,
    rows: acceptedRows,
    diagnostics: { outsideRows, invalidRows, duplicateRows, ambiguousIdentityRows }
  };
}

export function mapMonthlyRowsToInternal(rows) {
  return (rows || []).map((row, index) => ({
    id: row.id ?? null,
    number: index + 1,
    periodKey: row.period_key,
    sourceRecordId: row.source_record_id,
    callCount: row.call_count ?? null,
    coords: row.latitud !== null && row.longitud !== null ? [row.latitud, row.longitud] : null,
    ticket: row.ticket || '', suministro: row.suministro || '', falla: row.falla_real || '', causa: row.causa || '', nota: row.nota || '', odm: row.odm || '', zona: row.zona || '',
    setAlimentador: row.set_alimentador || '', horaInicio: row.hora_inicio || '', sed: row.sed_id || '', llaveSistema: row.llave_code || '', sedLlave: row.sed_llave || '',
    linkCroquis: row.link_croquis || '', fotos: row.fotos || [], coordSource: row.coord_source || null, coordLookupSuministro: row.coord_lookup_suministro || null, createdAt: row.created_at || null
  }));
}
