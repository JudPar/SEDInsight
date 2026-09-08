import { buildAnalysisPeriod, faultPeriodKey } from './faultPeriods.js';
import { readCallCountFromRow } from './monthlyFaultImport.js';
import { normalizeCompensation } from './monthlyCompensationImport.js';
import { compensationPeriodMonths } from './monthlyCompensationImport.js';
import { normalizeLlaveCode, normalizeSedId } from './sedUtils.js';

function uniqueSortedIntegers(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Number.isInteger))].sort((left, right) => left - right);
}

function summarizeCalls(faults) {
  return faults.reduce((summary, fault) => {
    const calls = readCallCountFromRow(fault);
    if (!calls.valid || !calls.provided) summary.recordsWithoutData += 1;
    else {
      summary.recordsWithData += 1;
      summary.totalKnown += calls.value;
    }
    return summary;
  }, { totalKnown: 0, recordsWithData: 0, recordsWithoutData: 0 });
}

function summarizeCircuitCompensation(rows, sedId, llaveCode, selectedPeriodKeys, circuitFaults) {
  const selected = new Set(selectedPeriodKeys);
  const records = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (normalizeSedId(row?.sedId ?? row?.sed_id) !== sedId ||
        normalizeLlaveCode(row?.llaveCode ?? row?.llave_code ?? row?.circuitId ?? row?.circuit_id) !== llaveCode) return;
    const periodKey = row?.periodKey ?? row?.period_key;
    const periodEndKey = row?.periodEndKey ?? row?.period_end_key ?? periodKey;
    const periodKeys = compensationPeriodMonths(periodKey, periodEndKey);
    if (!periodKeys.length || !periodKeys.every(key => selected.has(key))) return;
    const compensation = normalizeCompensation(row?.compensation);
    if (!compensation.valid) return;
    records.push({ periodKey, periodEndKey, periodKeys, value: compensation.value, available: true });
  });
  const faultCountByPeriod = selectedPeriodKeys.map(periodKey => ({
    periodKey,
    count: (Array.isArray(circuitFaults) ? circuitFaults : []).filter(fault => faultPeriodKey(fault) === periodKey).length
  }));
  const faultCounts = new Map(faultCountByPeriod.map(period => [period.periodKey, period.count]));
  const nonOverlapping = [];
  const covered = new Set();
  records.sort((left, right) => `${left.periodKey}\u0000${left.periodEndKey}`.localeCompare(`${right.periodKey}\u0000${right.periodEndKey}`)).forEach((record) => {
    if (record.periodKeys.some(key => covered.has(key))) return;
    record.periodKeys.forEach(key => covered.add(key));
    nonOverlapping.push({ ...record, faultsCompatible: record.periodKeys.reduce((total, key) => total + (faultCounts.get(key) || 0), 0) });
  });
  const compatiblePeriodKeys = [...covered].sort();
  const circuitFaultsCompatible = nonOverlapping.reduce((total, period) => total + period.faultsCompatible, 0);
  const totalKnown = nonOverlapping.length ? nonOverlapping.reduce((total, period) => total + period.value, 0) : null;
  return {
    byPeriod: nonOverlapping,
    totalKnown,
    dataAvailable: nonOverlapping.length > 0,
    dataComplete: selectedPeriodKeys.length > 0 && covered.size === selectedPeriodKeys.length,
    coverageStatus: !nonOverlapping.length ? 'unavailable' : covered.size === selectedPeriodKeys.length ? 'complete' : 'partial',
    compatiblePeriodKeys,
    periodsMissing: selectedPeriodKeys.filter(period => !covered.has(period)),
    faultCountByPeriod,
    circuitFaultsCompatible,
    compensationPerFault: totalKnown !== null && circuitFaultsCompatible > 0 ? totalKnown / circuitFaultsCompatible : null
  };
}

function summarizeSedCompensation(reconciliation) {
  const compensation = reconciliation?.compensation;
  const availablePeriods = (Array.isArray(compensation?.byPeriod) ? compensation.byPeriod : [])
    .filter(period => period?.available && Number.isFinite(Number(period?.value)));
  const faultCounts = new Map((Array.isArray(reconciliation?.faultCountByPeriod) ? reconciliation.faultCountByPeriod : [])
    .map(period => [period?.periodKey, Number(period?.count) || 0]));
  const compatiblePeriodKeys = availablePeriods.map(period => period.periodKey);
  const faultsCompatible = compatiblePeriodKeys.reduce((total, periodKey) => total + (faultCounts.get(periodKey) || 0), 0);
  const totalKnown = availablePeriods.length
    ? availablePeriods.reduce((total, period) => total + Number(period.value), 0)
    : null;
  return {
    byPeriod: Array.isArray(compensation?.byPeriod) ? compensation.byPeriod.map(period => ({ ...period })) : [],
    totalKnown,
    dataAvailable: availablePeriods.length > 0,
    dataComplete: Boolean(compensation?.dataComplete),
    coverageStatus: !availablePeriods.length ? 'unavailable' : compensation?.dataComplete ? 'complete' : 'partial',
    compatiblePeriodKeys,
    periodsMissing: Array.isArray(compensation?.periodsMissing) ? compensation.periodsMissing : [],
    faultCountByPeriod: [...faultCounts].map(([periodKey, count]) => ({ periodKey, count })),
    faultsCompatible,
    compensationPerFault: totalKnown !== null && faultsCompatible > 0 ? totalKnown / faultsCompatible : null
  };
}

function prioritizeMonthlyCompensation(circuit, sed, selectedPeriodKeys) {
  const sedPeriods = new Map((sed.byPeriod || []).map(period => [period.periodKey, period]));
  const sedFaults = new Map((sed.faultCountByPeriod || []).map(period => [period.periodKey, period.count]));
  const coveredByCircuit = new Set((circuit.byPeriod || []).flatMap(period => period.periodKeys || [period.periodKey]));
  const byPeriod = (circuit.byPeriod || []).map(period => ({ ...period, sourceScope: 'circuit' }));
  selectedPeriodKeys.forEach((periodKey) => {
    if (coveredByCircuit.has(periodKey)) return;
    const sedPeriod = sedPeriods.get(periodKey);
    byPeriod.push(sedPeriod?.available
      ? { periodKey, periodEndKey: periodKey, periodKeys: [periodKey], value: sedPeriod.value, available: true, sourceScope: 'sed', faultsCompatible: sedFaults.get(periodKey) || 0 }
      : { periodKey, periodEndKey: periodKey, periodKeys: [periodKey], value: null, available: false, sourceScope: null, faultsCompatible: 0 });
  });
  byPeriod.sort((left, right) => `${left.periodKey}\u0000${left.periodEndKey}`.localeCompare(`${right.periodKey}\u0000${right.periodEndKey}`));
  const available = byPeriod.filter(period => period.available);
  const scopes = new Set(available.map(period => period.sourceScope));
  const coveredMonths = new Set(available.flatMap(period => period.periodKeys || [period.periodKey]));
  const totalKnown = available.length ? available.reduce((total, period) => total + Number(period.value), 0) : null;
  const faultsCompatible = available.reduce((total, period) => total + period.faultsCompatible, 0);
  return {
    byPeriod,
    totalKnown,
    dataAvailable: available.length > 0,
    dataComplete: selectedPeriodKeys.length > 0 && selectedPeriodKeys.every(period => coveredMonths.has(period)),
    coverageStatus: !available.length ? 'unavailable' : selectedPeriodKeys.every(period => coveredMonths.has(period)) ? 'complete' : 'partial',
    compatiblePeriodKeys: [...coveredMonths].sort(),
    periodsMissing: selectedPeriodKeys.filter(period => !coveredMonths.has(period)),
    faultsCompatible,
    compensationPerFault: totalKnown !== null && faultsCompatible > 0 ? totalKnown / faultsCompatible : null,
    sourceScope: scopes.size === 1 ? [...scopes][0] : scopes.size > 1 ? 'mixed' : null
  };
}

/**
 * Builds the traceable technical input for a future economic simulation.
 * It deliberately performs no financial, reliability or allocation formula.
 */
export function buildEconomicAnalysisInput({
  sedId,
  llaveCode,
  circuitId,
  analysisUnit,
  selectedPeriodKeys = [],
  availablePeriods = [],
  faults = [],
  circuitCompensationRows = [],
  sedMetricReconciliation = null
} = {}) {
  const canonicalSedId = normalizeSedId(sedId);
  const canonicalLlaveCode = normalizeLlaveCode(llaveCode ?? circuitId);
  const period = buildAnalysisPeriod(selectedPeriodKeys, availablePeriods);
  const selectedPeriods = new Set(period.selectedPeriodKeys);
  const faultIndexes = uniqueSortedIntegers(analysisUnit?.faultIndexes);
  const selectedFaultEntries = faultIndexes
    .map(index => ({ index, fault: faults[index] }))
    .filter(entry => entry.fault && selectedPeriods.has(faultPeriodKey(entry.fault)));
  const selectedFaults = selectedFaultEntries.map(entry => entry.fault);
  const circuitCompensation = summarizeCircuitCompensation(
    circuitCompensationRows,
    canonicalSedId,
    canonicalLlaveCode,
    period.selectedPeriodKeys,
    faults
  );
  const sedContext = sedMetricReconciliation?.compensation || null;
  const sedCompensation = summarizeSedCompensation(sedMetricReconciliation);
  const automaticCompensation = prioritizeMonthlyCompensation(circuitCompensation, sedCompensation, period.selectedPeriodKeys);

  return {
    identity: {
      sedId: canonicalSedId,
      circuitId: canonicalLlaveCode,
      analysisUnitId: analysisUnit?.analysisSegmentId ?? analysisUnit?.analysisUnitId ?? null,
      analysisUnitSource: analysisUnit?.source || 'automatic'
    },
    period,
    faults: {
      count: selectedFaultEntries.length,
      indexes: selectedFaultEntries.map(entry => entry.index),
      ids: selectedFaults.map(fault => fault?.id ?? fault?.sourceRecordId ?? fault?.source_record_id ?? null)
    },
    calls: summarizeCalls(selectedFaults),
    compensation: {
      scope: automaticCompensation.sourceScope || (sedContext?.dataAvailable ? 'sed_context_only' : 'unavailable'),
      automatic: automaticCompensation,
      circuit: circuitCompensation,
      sedContext,
      allocatedToAnalysisUnit: false
    },
    geometry: {
      totalLengthMeters: Number(analysisUnit?.lengthMeters) || 0,
      aerialLengthMeters: Number(analysisUnit?.aerialLengthMeters) || 0,
      undergroundLengthMeters: Number(analysisUnit?.undergroundLengthMeters) || 0,
      unclassifiedLengthMeters: Number(analysisUnit?.unclassifiedLengthMeters) || 0,
      geometryReliability: analysisUnit?.geometryReliability || 'unknown',
      edgeIds: [...new Set(Array.isArray(analysisUnit?.edgeIds) ? analysisUnit.edgeIds : [])].sort()
    },
    traceability: {
      periodSource: 'selectedPeriodKeys',
      faultSource: 'analysisUnit.faultIndexes',
      callSource: 'fault.call_count',
      compensationSource: automaticCompensation.sourceScope === 'circuit'
        ? 'circuit_monthly_metrics'
        : automaticCompensation.sourceScope === 'sed'
          ? 'sed_monthly_metrics_average_per_fault'
          : automaticCompensation.sourceScope === 'mixed'
            ? 'circuit_monthly_metrics_with_sed_fallback'
          : null,
      geometrySource: 'analysisUnit'
    }
  };
}
