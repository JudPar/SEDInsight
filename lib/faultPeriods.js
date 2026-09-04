export const UNASSIGNED_PERIOD_KEY = '__unassigned__';

export function isMonthlyPeriodKey(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '').trim());
}

export function normalizePeriodKey(value) {
  const key = String(value || '').trim();
  return isMonthlyPeriodKey(key) ? key : null;
}

export function formatPeriodLabel(periodKey, locale = 'es-PE') {
  if (periodKey === UNASSIGNED_PERIOD_KEY) return 'Sin periodo (datos existentes)';
  const normalized = normalizePeriodKey(periodKey);
  if (!normalized) return String(periodKey || 'Periodo desconocido');
  const [year, month] = normalized.split('-').map(Number);
  const label = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function sortPeriodKeys(periodKeys, direction = 'desc') {
  const factor = direction === 'asc' ? 1 : -1;
  return [...new Set((periodKeys || []).filter(isMonthlyPeriodKey))].sort((a, b) => a.localeCompare(b) * factor);
}

export function selectRecentPeriods(periods, count = 2, { includeUnassigned = false } = {}) {
  const keys = sortPeriodKeys((periods || []).map(item => typeof item === 'string' ? item : item?.periodKey || item?.period_key));
  const selected = keys.slice(0, Math.max(0, count));
  if (includeUnassigned) selected.push(UNASSIGNED_PERIOD_KEY);
  return selected;
}

export function resolveActivePeriodSelection(periods, currentSelection, { preserveSelection = false, defaultCount = 2 } = {}) {
  const availableKeys = new Set((periods || []).map(item => typeof item === 'string' ? item : item?.periodKey ?? item?.period_key));
  if (preserveSelection) return [...new Set(currentSelection || [])].filter(key => availableKeys.has(key));
  const hasMonthlyPeriods = [...availableKeys].some(isMonthlyPeriodKey);
  return selectRecentPeriods(periods, defaultCount, {
    includeUnassigned: !hasMonthlyPeriods && availableKeys.has(UNASSIGNED_PERIOD_KEY)
  });
}

export function formatSelectedPeriodLabel(periodKeys, locale = 'es-PE') {
  const keys = sortPeriodKeys(periodKeys, 'asc');
  if (keys.length === 0) return 'Sin periodos seleccionados';
  if (keys.length === 1) return formatPeriodLabel(keys[0], locale);
  const first = formatPeriodLabel(keys[0], locale);
  const last = formatPeriodLabel(keys[keys.length - 1], locale);
  return `${first} - ${last} (${keys.length} meses)`;
}

export function faultPeriodKey(fault) {
  return normalizePeriodKey(fault?.periodKey ?? fault?.period_key) || UNASSIGNED_PERIOD_KEY;
}

export function filterFaultsByPeriods(faults, selectedPeriodKeys) {
  const selected = new Set(selectedPeriodKeys || []);
  if (selected.size === 0) return [];
  return (faults || []).filter(fault => selected.has(faultPeriodKey(fault)));
}

export function stableFaultIdentity(fault) {
  const period = faultPeriodKey(fault);
  const source = String(fault?.sourceRecordId ?? fault?.source_record_id ?? '').trim();
  if (source) return `${period}:source:${source}`;
  const ticket = String(fault?.ticket || '').trim().toLowerCase();
  if (ticket) return `${period}:ticket:${ticket}`;
  const id = fault?.id ?? fault?.source_id;
  if (id !== null && id !== undefined && id !== '') return `${period}:id:${id}`;
  return null;
}

export function deduplicateSelectedFaults(faults) {
  const seen = new Set();
  const ambiguous = [];
  const unique = [];
  (faults || []).forEach((fault, index) => {
    const identity = stableFaultIdentity(fault);
    if (!identity) {
      ambiguous.push(index);
      unique.push(fault);
    } else if (!seen.has(identity)) {
      seen.add(identity);
      unique.push(fault);
    }
  });
  return { faults: unique, ambiguousIndexes: ambiguous, duplicatesRemoved: (faults || []).length - unique.length };
}

export function buildSedFaultRanking(seds, faults) {
  const counts = new Map();
  (faults || []).forEach(fault => {
    const sedId = String(fault?.sed || fault?.sed_id || '').trim();
    if (sedId && Object.hasOwn(seds || {}, sedId)) counts.set(sedId, (counts.get(sedId) || 0) + 1);
  });
  return Object.entries(seds || {}).map(([sedId, sed]) => ({
    sedId,
    sedName: sed?.name || sedId,
    faultCount: counts.get(sedId) || 0,
    llaveCount: Object.keys(sed?.llaves || {}).length
  })).sort((a, b) => (b.faultCount - a.faultCount) || a.sedId.localeCompare(b.sedId))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function summarizePeriods(faults) {
  const counts = new Map();
  (faults || []).forEach(fault => {
    const key = faultPeriodKey(fault);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}
