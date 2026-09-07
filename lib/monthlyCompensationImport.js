import { formatPeriodLabel, normalizePeriodKey } from './faultPeriods.js';
import { canonicalCircuitKey, normalizeLlaveCode, normalizeSedId } from './sedUtils.js';

function findRows(input) {
  if (Array.isArray(input)) return input;
  for (const key of ['compensations', 'compensaciones', 'circuit_compensations', 'compensaciones_por_llave', 'records', 'data', 'items']) if (Array.isArray(input?.[key])) return input[key];
  return [];
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

export function normalizeCompensation(value) {
  if (value === null || value === undefined || String(value).trim() === '') return { valid: false, value: null, provided: false };
  if (typeof value === 'number') return { valid: Number.isFinite(value) && value >= 0, value: Number.isFinite(value) && value >= 0 ? value : null, provided: true };
  let text = String(value).trim().replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
  if (!text || text.startsWith('-')) return { valid: false, value: null, provided: true };
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    text = text.replace(thousands, '').replace(decimal, '.');
  } else if (comma >= 0) {
    const decimals = text.length - comma - 1;
    text = decimals > 0 && decimals <= 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  } else if (dot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, '');
  }
  const parsed = Number(text);
  return { valid: Number.isFinite(parsed) && parsed >= 0, value: Number.isFinite(parsed) && parsed >= 0 ? parsed : null, provided: true };
}

export function prepareMonthlyCompensationImport(input, permanentSedIds, existingRows = []) {
  const rows = findRows(input);
  const permanent = new Map();
  (permanentSedIds || []).forEach((sedId) => {
    const canonical = normalizeSedId(sedId);
    if (canonical && !permanent.has(canonical)) permanent.set(canonical, String(sedId).trim());
  });
  const existing = new Set((existingRows || []).map(row => `${normalizeSedId(row.sedId ?? row.sed_id)}\u0000${row.periodKey ?? row.period_key}`));
  const seen = new Set();
  const accepted = [];
  const outside = [];
  const duplicates = [];
  const invalid = [];

  rows.forEach((row, index) => {
    const requestedSedId = normalizeSedId(findField(row, ['sed_id', 'sedId', 'SED']));
    const sedId = permanent.get(requestedSedId);
    const periodKey = normalizePeriodKey(findField(row, ['period_key', 'periodKey', 'period']));
    const compensation = normalizeCompensation(findField(row, ['compensation', 'compensacion', 'Compensación', 'monto_compensacion']));
    if (!requestedSedId || !periodKey || !compensation.valid) return invalid.push({ index, row });
    if (!sedId) return outside.push({ index, sedId: requestedSedId, periodKey });
    const key = `${requestedSedId}\u0000${periodKey}`;
    if (seen.has(key)) return duplicates.push({ index, sedId, periodKey });
    seen.add(key);
    accepted.push({ sed_id: sedId, period_key: periodKey, compensation: compensation.value });
  });

  const periods = [...new Set(accepted.map(row => row.period_key))].sort().map(periodKey => {
    const periodRows = accepted.filter(row => row.period_key === periodKey);
    const existingConflicts = periodRows.filter(row => existing.has(`${normalizeSedId(row.sed_id)}\u0000${periodKey}`)).length;
    return {
      periodKey,
      periodLabel: formatPeriodLabel(periodKey),
      rows: periodRows,
      accepted: periodRows.length,
      existingConflicts,
      totalCompensation: periodRows.reduce((sum, row) => sum + row.compensation, 0)
    };
  });

  return {
    valid: accepted.length > 0,
    received: rows.length,
    periods,
    periodCount: periods.length,
    receivedSeds: new Set(rows.map(row => normalizeSedId(findField(row, ['sed_id', 'sedId', 'SED']))).filter(Boolean)).size,
    accepted: accepted.length,
    outsideUniverse: outside.length,
    duplicates: duplicates.length,
    invalid: invalid.length,
    existingConflicts: periods.reduce((sum, period) => sum + period.existingConflicts, 0),
    totalCompensation: accepted.reduce((sum, row) => sum + row.compensation, 0),
    diagnostics: { outside, duplicates, invalid }
  };
}

export function prepareMonthlyCircuitCompensationImport(input, permanentCircuits, existingRows = []) {
  const rows = findRows(input);
  const circuits = new Map();
  (permanentCircuits || []).forEach((circuit) => {
    const sedId = circuit?.sedId ?? circuit?.sed_id;
    const llaveCode = circuit?.llaveCode ?? circuit?.llave_code;
    const key = canonicalCircuitKey(sedId, llaveCode);
    if (key && !circuits.has(key)) circuits.set(key, {
      sed_id: String(sedId).trim(),
      llave_code: String(llaveCode).trim()
    });
  });
  const existing = new Set((existingRows || []).map(row => [
    canonicalCircuitKey(row?.sedId ?? row?.sed_id, row?.llaveCode ?? row?.llave_code),
    normalizePeriodKey(row?.periodKey ?? row?.period_key)
  ].join('\u0000')));
  const seen = new Set();
  const accepted = [];
  const outside = [];
  const duplicates = [];
  const invalid = [];

  rows.forEach((row, index) => {
    const requestedSedId = normalizeSedId(findField(row, ['sed_id', 'sedId', 'SED']));
    const requestedLlaveCode = normalizeLlaveCode(findField(row, ['llave_code', 'llaveCode', 'llave', 'circuit_id', 'circuitId', 'circuito', 'Circuito']));
    const periodKey = normalizePeriodKey(findField(row, ['period_key', 'periodKey', 'period']));
    const compensation = normalizeCompensation(findField(row, ['compensation', 'compensacion', 'Compensaci\u00f3n', 'monto_compensacion']));
    const circuitKey = canonicalCircuitKey(requestedSedId, requestedLlaveCode);
    if (!circuitKey || !periodKey || !compensation.valid) return invalid.push({ index, row });
    const circuit = circuits.get(circuitKey);
    if (!circuit) return outside.push({ index, sedId: requestedSedId, llaveCode: requestedLlaveCode, periodKey });
    const rowKey = `${circuitKey}\u0000${periodKey}`;
    if (seen.has(rowKey)) return duplicates.push({ index, sedId: requestedSedId, llaveCode: requestedLlaveCode, periodKey });
    seen.add(rowKey);
    accepted.push({ ...circuit, period_key: periodKey, compensation: compensation.value });
  });

  const periods = [...new Set(accepted.map(row => row.period_key))].sort().map(periodKey => {
    const periodRows = accepted.filter(row => row.period_key === periodKey);
    const existingPeriodRows = (existingRows || []).filter(row => normalizePeriodKey(row?.periodKey ?? row?.period_key) === periodKey).length;
    return {
      periodKey,
      periodLabel: formatPeriodLabel(periodKey),
      rows: periodRows,
      accepted: periodRows.length,
      existingPeriodRows,
      periodExists: existingPeriodRows > 0,
      existingConflicts: periodRows.filter(row => existing.has(`${canonicalCircuitKey(row.sed_id, row.llave_code)}\u0000${periodKey}`)).length,
      totalCompensation: periodRows.reduce((sum, row) => sum + row.compensation, 0)
    };
  });
  return {
    valid: accepted.length > 0,
    received: rows.length,
    accepted: accepted.length,
    periodCount: periods.length,
    periods,
    outsideUniverse: outside.length,
    duplicates: duplicates.length,
    invalid: invalid.length,
    existingConflicts: periods.reduce((sum, period) => sum + period.existingConflicts, 0),
    totalCompensation: accepted.reduce((sum, row) => sum + row.compensation, 0),
    rows: accepted,
    diagnostics: { outside, duplicates, invalid }
  };
}

export function summarizeCircuitCompensationPeriods(rows = []) {
  const periods = new Map();
  rows.forEach((row) => {
    const sedId = normalizeSedId(row?.sedId ?? row?.sed_id);
    const llaveCode = normalizeLlaveCode(row?.llaveCode ?? row?.llave_code);
    const periodKey = normalizePeriodKey(row?.periodKey ?? row?.period_key);
    const compensation = normalizeCompensation(row?.compensation);
    if (!sedId || !llaveCode || !periodKey || !compensation.valid) return;
    if (!periods.has(periodKey)) periods.set(periodKey, { periodKey, circuitCount: 0, sedIds: new Set(), totalCompensation: 0 });
    const period = periods.get(periodKey);
    period.circuitCount += 1;
    period.sedIds.add(sedId);
    period.totalCompensation += compensation.value;
  });
  return [...periods.values()].map(period => ({
    periodKey: period.periodKey,
    circuitCount: period.circuitCount,
    sedCount: period.sedIds.size,
    totalCompensation: period.totalCompensation
  })).sort((left, right) => right.periodKey.localeCompare(left.periodKey));
}

// The RPC replaces a complete month. Preserve unaffected circuits and replace only imported keys.
export function mergeCircuitCompensationPeriodRows(incomingRows = [], existingRows = [], periodKey) {
  const incomingKeys = new Set(incomingRows.map(row => canonicalCircuitKey(row?.sed_id ?? row?.sedId, row?.llave_code ?? row?.llaveCode)).filter(Boolean));
  const preserved = existingRows.filter(row => normalizePeriodKey(row?.period_key ?? row?.periodKey) === periodKey)
    .filter(row => !incomingKeys.has(canonicalCircuitKey(row?.sed_id ?? row?.sedId, row?.llave_code ?? row?.llaveCode)))
    .map(row => ({
      sed_id: String(row?.sed_id ?? row?.sedId).trim(),
      llave_code: String(row?.llave_code ?? row?.llaveCode).trim(),
      period_key: periodKey,
      compensation: Number(row.compensation)
    }));
  return [...preserved, ...incomingRows].sort((left, right) => canonicalCircuitKey(left.sed_id, left.llave_code).localeCompare(canonicalCircuitKey(right.sed_id, right.llave_code)));
}
