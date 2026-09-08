import { formatPeriodLabel, normalizePeriodKey } from './faultPeriods.js';
import { canonicalCircuitKey, cleanSedCodeNoZero, normalizeLlaveCode, normalizeSedId } from './sedUtils.js';

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

const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export function compensationPeriodMonths(startKey, endKey = startKey) {
  const start = normalizePeriodKey(startKey);
  const end = normalizePeriodKey(endKey) || start;
  if (!start || !end) return [];
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  const distance = (endYear - startYear) * 12 + endMonth - startMonth;
  if (distance < 0 || distance > 1) return [];
  return Array.from({ length: distance + 1 }, (_, index) => {
    const date = new Date(Date.UTC(startYear, startMonth - 1 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export function formatCompensationPeriodRange(startKey, endKey = startKey) {
  const months = compensationPeriodMonths(startKey, endKey);
  if (!months.length) return 'Periodo inválido';
  if (months.length === 1) return formatPeriodLabel(months[0]);
  const [startYear, startMonth] = months[0].split('-').map(Number);
  const [endYear, endMonth] = months[1].split('-').map(Number);
  return startYear === endYear
    ? `${MONTH_LABELS[startMonth - 1]}–${MONTH_LABELS[endMonth - 1]} ${startYear}`
    : `${MONTH_LABELS[startMonth - 1]} ${startYear}–${MONTH_LABELS[endMonth - 1]} ${endYear}`;
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

function normalizedCircuitSuffix(value) {
  const suffix = normalizeLlaveCode(value).split('/').pop()?.replace(/\s+/g, '') || '';
  const match = suffix.match(/^0*(\d+)([A-Z]+)$/);
  if (!match) return suffix;
  return `${Number(match[1])}${match[2]}`;
}

function compatibleCircuitSuffix(value) {
  const suffix = normalizedCircuitSuffix(value);
  const match = suffix.match(/^(\d+)(SP|S)$/);
  return match ? `${match[1]}S` : suffix;
}

function uniqueMatch(candidates) {
  return candidates.length === 1 ? { status: 'resolved', circuit: candidates[0] } :
    candidates.length > 1 ? { status: 'ambiguous', circuit: null } : null;
}

export function createPermanentCircuitResolver(permanentCircuits = []) {
  const circuits = [];
  const exact = new Map();
  permanentCircuits.forEach((circuit) => {
    const sedId = circuit?.sedId ?? circuit?.sed_id;
    const llaveCode = circuit?.llaveCode ?? circuit?.llave_code;
    const key = canonicalCircuitKey(sedId, llaveCode);
    if (!key || exact.has(key)) return;
    const normalized = {
      sed_id: String(sedId).trim(),
      llave_code: String(llaveCode).trim(),
      sedKey: normalizeSedId(sedId),
      sedAlias: cleanSedCodeNoZero(sedId),
      suffix: normalizedCircuitSuffix(llaveCode),
      compatibleSuffix: compatibleCircuitSuffix(llaveCode)
    };
    circuits.push(normalized);
    exact.set(key, normalized);
  });

  return (sedId, llaveCode) => {
    const exactCircuit = exact.get(canonicalCircuitKey(sedId, llaveCode));
    if (exactCircuit) return { status: 'exact', circuit: exactCircuit };

    const requestedSed = normalizeSedId(sedId);
    const requestedSedAlias = cleanSedCodeNoZero(sedId);
    const sameSed = circuits.filter(circuit => circuit.sedKey === requestedSed);
    const sedCandidates = sameSed.length ? sameSed : circuits.filter(circuit => circuit.sedAlias === requestedSedAlias);
    if (!sedCandidates.length) return { status: 'outside', circuit: null };

    const requestedSuffix = normalizedCircuitSuffix(llaveCode);
    const strict = uniqueMatch(sedCandidates.filter(circuit => circuit.suffix === requestedSuffix));
    if (strict) return strict;

    const requestedCompatibleSuffix = compatibleCircuitSuffix(llaveCode);
    const compatible = uniqueMatch(sedCandidates.filter(circuit => circuit.compatibleSuffix === requestedCompatibleSuffix));
    return compatible || { status: 'outside', circuit: null };
  };
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
  const resolveCircuit = createPermanentCircuitResolver(permanentCircuits);
  const existing = new Set((existingRows || []).map(row => [
    canonicalCircuitKey(row?.sedId ?? row?.sed_id, row?.llaveCode ?? row?.llave_code),
    normalizePeriodKey(row?.periodKey ?? row?.period_key),
    normalizePeriodKey(row?.periodEndKey ?? row?.period_end_key) || normalizePeriodKey(row?.periodKey ?? row?.period_key)
  ].join('\u0000')));
  const seen = new Set();
  const accepted = [];
  const outside = [];
  const duplicates = [];
  const invalid = [];
  const ambiguous = [];
  const aliasesResolved = [];

  rows.forEach((row, index) => {
    const requestedSedId = normalizeSedId(findField(row, ['sed_id', 'sedId', 'SED']));
    const requestedLlaveCode = normalizeLlaveCode(findField(row, ['llave_code', 'llaveCode', 'llave', 'circuit_id', 'circuitId', 'circuito', 'Circuito']));
    const periodKey = normalizePeriodKey(findField(row, ['period_start_key', 'periodStartKey', 'period_key', 'periodKey', 'period', 'inicio', 'desde']));
    const periodEndKey = normalizePeriodKey(findField(row, ['period_end_key', 'periodEndKey', 'period_end', 'periodEnd', 'fin', 'hasta'])) || periodKey;
    const periodMonths = compensationPeriodMonths(periodKey, periodEndKey);
    const compensation = normalizeCompensation(findField(row, ['compensation', 'compensacion', 'Compensaci\u00f3n', 'monto_compensacion', 'monto']));
    const requestedCircuitKey = canonicalCircuitKey(requestedSedId, requestedLlaveCode);
    if (!requestedCircuitKey || !periodMonths.length || !compensation.valid) return invalid.push({ index, row });
    const resolution = resolveCircuit(requestedSedId, requestedLlaveCode);
    if (resolution.status === 'ambiguous') return ambiguous.push({ index, sedId: requestedSedId, llaveCode: requestedLlaveCode, periodKey });
    if (!resolution.circuit) return outside.push({ index, sedId: requestedSedId, llaveCode: requestedLlaveCode, periodKey });
    const circuit = resolution.circuit;
    const circuitKey = canonicalCircuitKey(circuit.sed_id, circuit.llave_code);
    if (resolution.status === 'resolved') aliasesResolved.push({ index, sedId: requestedSedId, llaveCode: requestedLlaveCode, resolvedSedId: circuit.sed_id, resolvedLlaveCode: circuit.llave_code });
    const rowKey = `${circuitKey}\u0000${periodKey}\u0000${periodEndKey}`;
    if (seen.has(rowKey)) return duplicates.push({ index, sedId: requestedSedId, llaveCode: requestedLlaveCode, periodKey, periodEndKey });
    seen.add(rowKey);
    accepted.push({
      sed_id: circuit.sed_id,
      llave_code: circuit.llave_code,
      period_key: periodKey,
      period_end_key: periodEndKey,
      compensation: compensation.value
    });
  });

  const periods = [...new Set(accepted.map(row => `${row.period_key}\u0000${row.period_end_key}`))].sort().map(rangeKey => {
    const [periodKey, periodEndKey] = rangeKey.split('\u0000');
    const periodRows = accepted.filter(row => row.period_key === periodKey && row.period_end_key === periodEndKey);
    const existingPeriodRows = (existingRows || []).filter(row => normalizePeriodKey(row?.periodKey ?? row?.period_key) === periodKey &&
      (normalizePeriodKey(row?.periodEndKey ?? row?.period_end_key) || normalizePeriodKey(row?.periodKey ?? row?.period_key)) === periodEndKey).length;
    return {
      periodKey,
      periodEndKey,
      periodLabel: formatCompensationPeriodRange(periodKey, periodEndKey),
      rows: periodRows,
      accepted: periodRows.length,
      existingPeriodRows,
      periodExists: existingPeriodRows > 0,
      existingConflicts: periodRows.filter(row => existing.has(`${canonicalCircuitKey(row.sed_id, row.llave_code)}\u0000${periodKey}\u0000${periodEndKey}`)).length,
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
    aliasesResolved: aliasesResolved.length,
    ambiguous: ambiguous.length,
    duplicates: duplicates.length,
    invalid: invalid.length,
    existingConflicts: periods.reduce((sum, period) => sum + period.existingConflicts, 0),
    totalCompensation: accepted.reduce((sum, row) => sum + row.compensation, 0),
    rows: accepted,
    diagnostics: { outside, duplicates, invalid, ambiguous, aliasesResolved }
  };
}

export function summarizeCircuitCompensationPeriods(rows = []) {
  const periods = new Map();
  rows.forEach((row) => {
    const sedId = normalizeSedId(row?.sedId ?? row?.sed_id);
    const llaveCode = normalizeLlaveCode(row?.llaveCode ?? row?.llave_code);
    const periodKey = normalizePeriodKey(row?.periodKey ?? row?.period_key);
    const periodEndKey = normalizePeriodKey(row?.periodEndKey ?? row?.period_end_key) || periodKey;
    const compensation = normalizeCompensation(row?.compensation);
    if (!sedId || !llaveCode || !compensationPeriodMonths(periodKey, periodEndKey).length || !compensation.valid) return;
    const rangeKey = `${periodKey}\u0000${periodEndKey}`;
    if (!periods.has(rangeKey)) periods.set(rangeKey, { periodKey, periodEndKey, circuitCount: 0, sedIds: new Set(), totalCompensation: 0 });
    const period = periods.get(rangeKey);
    period.circuitCount += 1;
    period.sedIds.add(sedId);
    period.totalCompensation += compensation.value;
  });
  return [...periods.values()].map(period => ({
    periodKey: period.periodKey,
    periodEndKey: period.periodEndKey,
    periodLabel: formatCompensationPeriodRange(period.periodKey, period.periodEndKey),
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
