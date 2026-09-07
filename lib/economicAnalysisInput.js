import { buildAnalysisPeriod, faultPeriodKey } from './faultPeriods.js';
import { readCallCountFromRow } from './monthlyFaultImport.js';
import { normalizeCompensation } from './monthlyCompensationImport.js';
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
  const byPeriod = new Map(selectedPeriodKeys.map(periodKey => [periodKey, { periodKey, value: null, available: false }]));
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (normalizeSedId(row?.sedId ?? row?.sed_id) !== sedId ||
        normalizeLlaveCode(row?.llaveCode ?? row?.llave_code ?? row?.circuitId ?? row?.circuit_id) !== llaveCode) return;
    const periodKey = row?.periodKey ?? row?.period_key;
    if (!selected.has(periodKey)) return;
    const compensation = normalizeCompensation(row?.compensation);
    if (!compensation.valid) return;
    const period = byPeriod.get(periodKey);
    period.value = (period.value ?? 0) + compensation.value;
    period.available = true;
  });
  const periods = [...byPeriod.values()];
  const available = periods.filter(period => period.available);
  const compatiblePeriodKeys = available.map(period => period.periodKey);
  const compatibleSet = new Set(compatiblePeriodKeys);
  const circuitFaultsCompatible = (Array.isArray(circuitFaults) ? circuitFaults : [])
    .filter(fault => compatibleSet.has(faultPeriodKey(fault))).length;
  const totalKnown = available.length ? available.reduce((total, period) => total + period.value, 0) : null;
  return {
    byPeriod: periods,
    totalKnown,
    dataAvailable: available.length > 0,
    dataComplete: periods.length > 0 && available.length === periods.length,
    coverageStatus: !available.length ? 'unavailable' : available.length === periods.length ? 'complete' : 'partial',
    compatiblePeriodKeys,
    periodsMissing: periods.filter(period => !period.available).map(period => period.periodKey),
    circuitFaultsCompatible,
    compensationPerFault: totalKnown !== null && circuitFaultsCompatible > 0 ? totalKnown / circuitFaultsCompatible : null
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
      scope: circuitCompensation.dataAvailable ? 'circuit' : sedContext?.dataAvailable ? 'sed_context_only' : 'unavailable',
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
      compensationSource: circuitCompensation.dataAvailable ? 'circuit_monthly_metrics' : sedContext?.dataAvailable ? 'sed_monthly_metrics_context_only' : null,
      geometrySource: 'analysisUnit'
    }
  };
}
