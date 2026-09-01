import { formatPeriodLabel, normalizePeriodKey } from './faultPeriods.js';

function findRows(input) {
  if (Array.isArray(input)) return input;
  for (const key of ['compensations', 'compensaciones', 'records', 'data', 'items']) if (Array.isArray(input?.[key])) return input[key];
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
  const permanent = new Set(permanentSedIds || []);
  const existing = new Set((existingRows || []).map(row => `${row.sedId ?? row.sed_id}\u0000${row.periodKey ?? row.period_key}`));
  const seen = new Set();
  const accepted = [];
  const outside = [];
  const duplicates = [];
  const invalid = [];

  rows.forEach((row, index) => {
    const sedId = String(findField(row, ['sed_id', 'sedId', 'SED']) || '').trim();
    const periodKey = normalizePeriodKey(findField(row, ['period_key', 'periodKey', 'period']));
    const compensation = normalizeCompensation(findField(row, ['compensation', 'compensacion', 'Compensación', 'monto_compensacion']));
    if (!sedId || !periodKey || !compensation.valid) return invalid.push({ index, row });
    if (!permanent.has(sedId)) return outside.push({ index, sedId, periodKey });
    const key = `${sedId}\u0000${periodKey}`;
    if (seen.has(key)) return duplicates.push({ index, sedId, periodKey });
    seen.add(key);
    accepted.push({ sed_id: sedId, period_key: periodKey, compensation: compensation.value });
  });

  const periods = [...new Set(accepted.map(row => row.period_key))].sort().map(periodKey => {
    const periodRows = accepted.filter(row => row.period_key === periodKey);
    const existingConflicts = periodRows.filter(row => existing.has(`${row.sed_id}\u0000${periodKey}`)).length;
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
    receivedSeds: new Set(rows.map(row => String(findField(row, ['sed_id', 'sedId', 'SED']) || '').trim()).filter(Boolean)).size,
    accepted: accepted.length,
    outsideUniverse: outside.length,
    duplicates: duplicates.length,
    invalid: invalid.length,
    existingConflicts: periods.reduce((sum, period) => sum + period.existingConflicts, 0),
    totalCompensation: accepted.reduce((sum, row) => sum + row.compensation, 0),
    diagnostics: { outside, duplicates, invalid }
  };
}
