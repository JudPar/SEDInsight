import { faultPeriodKey, isMonthlyPeriodKey } from './faultPeriods.js';

export function buildSedPeriodMetrics(seds, faults, compensationRows, selectedPeriodKeys) {
  const selected = new Set((selectedPeriodKeys || []).filter(isMonthlyPeriodKey));
  const metrics = new Map(Object.entries(seds || {}).map(([sedId, sed]) => [sedId, {
    sedId,
    sedName: sed?.name || sedId,
    llaveCount: Object.keys(sed?.llaves || {}).length,
    faultCount: 0,
    callCount: 0,
    callsWithData: 0,
    callsMissing: 0,
    compensation: null,
    compensationPeriodsWithData: 0,
    compensationPeriodsExpected: selected.size
  }]));

  (faults || []).forEach(fault => {
    const sedId = String(fault?.sed ?? fault?.sed_id ?? '').trim();
    const metric = metrics.get(sedId);
    if (!metric || !selected.has(faultPeriodKey(fault))) return;
    metric.faultCount += 1;
    const calls = fault?.callCount ?? fault?.call_count;
    if (calls === null || calls === undefined) metric.callsMissing += 1;
    else {
      metric.callCount += Number(calls);
      metric.callsWithData += 1;
    }
  });

  (compensationRows || []).forEach(row => {
    const sedId = String(row?.sedId ?? row?.sed_id ?? '').trim();
    const periodKey = row?.periodKey ?? row?.period_key;
    const metric = metrics.get(sedId);
    if (!metric || !selected.has(periodKey)) return;
    const value = Number(row?.compensation);
    if (!Number.isFinite(value) || value < 0) return;
    metric.compensation = (metric.compensation ?? 0) + value;
    metric.compensationPeriodsWithData += 1;
  });

  return [...metrics.values()].map(metric => ({
    ...metric,
    callDataAvailable: metric.faultCount === 0 || metric.callsWithData > 0,
    callDataComplete: metric.callsMissing === 0,
    compensationDataAvailable: metric.compensationPeriodsWithData > 0,
    compensationDataComplete: metric.compensationPeriodsExpected > 0 && metric.compensationPeriodsWithData === metric.compensationPeriodsExpected
  }));
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
