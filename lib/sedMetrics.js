import { faultPeriodKey, isMonthlyPeriodKey } from './faultPeriods.js';
import { readCallCountFromRow } from './monthlyFaultImport.js';
import { normalizeSedId } from './sedUtils.js';

export function buildSedPeriodMetrics(seds, faults, compensationRows, selectedPeriodKeys) {
  const selectedPeriodList = [...new Set((selectedPeriodKeys || []).filter(isMonthlyPeriodKey))].sort();
  const selected = new Set(selectedPeriodList);
  const metrics = new Map(Object.entries(seds || {}).map(([sedId, sed]) => [normalizeSedId(sedId), {
    sedId,
    canonicalSedId: normalizeSedId(sedId),
    sedName: sed?.name || sedId,
    llaveCount: Object.keys(sed?.llaves || {}).length,
    faultCount: 0,
    callCount: 0,
    callsWithData: 0,
    callsMissing: 0,
    compensation: null,
    compensationPeriodsWithData: 0,
    compensationPeriodsExpected: selected.size,
    selectedPeriodKeys: selectedPeriodList,
    compensationByPeriod: selectedPeriodList.map(periodKey => ({ periodKey, value: null, available: false })),
    faultCountsByPeriod: new Map(selectedPeriodList.map(periodKey => [periodKey, 0])),
    callValuesByPeriod: new Map(selectedPeriodList.map(periodKey => [periodKey, []]))
  }]));

  (faults || []).forEach(fault => {
    const sedId = normalizeSedId(fault?.sed ?? fault?.sed_id);
    const metric = metrics.get(sedId);
    const periodKey = faultPeriodKey(fault);
    if (!metric || !selected.has(periodKey)) return;
    metric.faultCount += 1;
    metric.faultCountsByPeriod.set(periodKey, (metric.faultCountsByPeriod.get(periodKey) || 0) + 1);
    const calls = readCallCountFromRow(fault);
    if (!calls.valid || !calls.provided) metric.callsMissing += 1;
    else {
      metric.callCount += calls.value;
      metric.callsWithData += 1;
      metric.callValuesByPeriod.get(periodKey)?.push(calls.value);
    }
  });

  (compensationRows || []).forEach(row => {
    const sedId = normalizeSedId(row?.sedId ?? row?.sed_id);
    const periodKey = row?.periodKey ?? row?.period_key;
    const metric = metrics.get(sedId);
    if (!metric || !selected.has(periodKey)) return;
    const value = Number(row?.compensation);
    if (!Number.isFinite(value) || value < 0) return;
    metric.compensation = (metric.compensation ?? 0) + value;
    metric.compensationPeriodsWithData += 1;
    const periodEntry = metric.compensationByPeriod.find(item => item.periodKey === periodKey);
    if (periodEntry) {
      periodEntry.value = (periodEntry.value ?? 0) + value;
      periodEntry.available = true;
    }
  });

  return [...metrics.values()].map(metric => ({
    ...metric,
    callDataAvailable: metric.callsWithData > 0,
    callDataComplete: metric.callsMissing === 0,
    compensationDataAvailable: metric.compensationPeriodsWithData > 0,
    compensationDataComplete: metric.compensationPeriodsExpected > 0 && metric.compensationPeriodsWithData === metric.compensationPeriodsExpected,
    compensationPeriodsMissing: metric.compensationByPeriod.filter(item => !item.available).map(item => item.periodKey),
    faultCountByPeriod: metric.selectedPeriodKeys.map(periodKey => ({
      periodKey,
      count: metric.faultCountsByPeriod.get(periodKey) || 0
    })),
    callDiagnostics: {
      repeatedValues: [...metric.callValuesByPeriod.entries()].flatMap(([periodKey, values]) => {
        const occurrences = new Map();
        values.forEach(value => occurrences.set(value, (occurrences.get(value) || 0) + 1));
        return [...occurrences.entries()]
          .filter(([, count]) => count > 1)
          .map(([value, count]) => ({ periodKey, value, occurrences: count }));
      })
    },
    callValuesByPeriod: undefined,
    faultCountsByPeriod: undefined
  }));
}

export function reconcileSedPeriodMetrics(seds, faults, compensationRows, selectedPeriodKeys, sedId) {
  const canonicalSedId = normalizeSedId(sedId);
  const metric = buildSedPeriodMetrics(seds, faults, compensationRows, selectedPeriodKeys)
    .find(item => item.canonicalSedId === canonicalSedId);
  if (!metric) return null;
  return {
    sedId: metric.sedId,
    canonicalSedId: metric.canonicalSedId,
    selectedPeriodKeys: metric.selectedPeriodKeys,
    faultsConsidered: metric.faultCount,
    faultCountByPeriod: metric.faultCountByPeriod,
    calls: {
      recordsWithData: metric.callsWithData,
      recordsWithoutData: metric.callsMissing,
      totalKnown: metric.callCount,
      dataAvailable: metric.callDataAvailable,
      dataComplete: metric.callDataComplete,
      diagnostics: metric.callDiagnostics
    },
    compensation: {
      byPeriod: metric.compensationByPeriod,
      totalKnown: metric.compensation,
      dataAvailable: metric.compensationDataAvailable,
      dataComplete: metric.compensationDataComplete,
      periodsMissing: metric.compensationPeriodsMissing
    }
  };
}

export function sortSedPeriodMetrics(metrics, sortBy = 'faultCount') {
  const field = ['faultCount', 'callCount', 'compensation'].includes(sortBy) ? sortBy : 'faultCount';
  return [...(metrics || [])].sort((left, right) => {
    if (field === 'compensation') {
      const leftAvailable = left.compensationDataAvailable ? 1 : 0;
      const rightAvailable = right.compensationDataAvailable ? 1 : 0;
      if (leftAvailable !== rightAvailable) return rightAvailable - leftAvailable;
    }
    return (Number(right[field] ?? -1) - Number(left[field] ?? -1)) || (right.faultCount - left.faultCount) || left.sedId.localeCompare(right.sedId);
  }).map((metric, index) => ({ ...metric, rank: index + 1 }));
}

export function summarizeCompensationPeriods(rows) {
  const summaries = new Map();
  (rows || []).forEach(row => {
    const periodKey = row?.periodKey ?? row?.period_key;
    if (!isMonthlyPeriodKey(periodKey)) return;
    if (!summaries.has(periodKey)) summaries.set(periodKey, { periodKey, sedCount: 0, totalCompensation: 0 });
    const summary = summaries.get(periodKey);
    summary.sedCount += 1;
    summary.totalCompensation += Number(row?.compensation || 0);
  });
  return [...summaries.values()].sort((a, b) => b.periodKey.localeCompare(a.periodKey));
}
