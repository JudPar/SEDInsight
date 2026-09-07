import { analyzeCircuit } from '../../lib/circuitAnalysis.js';
import { buildReportModel } from '../../lib/reportModel.js';
import { simulateEconomicAnalysis } from '../../lib/economicSimulation.js';

export function reportFixture({ compensationMode = 'automatic', unavailable = false } = {}) {
  const lines = [
    { id: 'network', usage: 'Servicio Particular', cableType: 'N2XY 3x70', coords: [[-12, -77], [-12, -76.999], [-11.9995, -76.999]] },
    { id: 'supply', usage: 'Cliente', coords: [[-12.0001, -76.9995], [-12, -76.9995]] }
  ];
  const faults = [
    { id: 1, ticket: '21949A-TEST-01', originalIndex: 0, coords: [-12.0001, -76.9995], causa: 'Humedad', suministro: '00123', periodKey: '2026-08', horaInicio: '15/08/2026 14:32', callCount: 2 },
    { id: 2, ticket: '21949A-TEST-02', originalIndex: 1, coords: [-12.0001, -76.9995], causa: 'Humedad', suministro: '00123', periodKey: '2026-08', horaInicio: '18/08/2026 09:00', callCount: 3 },
    { id: 3, ticket: '21949A-TEST-03', originalIndex: 2, coords: [-12, -76.9992], causa: 'Terceros', periodKey: '2026-08' },
    { id: 4, ticket: '21949A-TEST-04', originalIndex: 3, coords: [-12, -76.99920001], causa: 'Terceros', periodKey: '2026-08' },
    { id: 5, ticket: '21949A-TEST-05', originalIndex: 4, coords: null, periodKey: '2026-08' }
  ];
  const analysis = analyzeCircuit(lines, faults);
  const selectedSegment = analysis.analysisSegmentIndicators.analysisSegments[0];
  const input = {
    identity: { analysisUnitId: selectedSegment.analysisSegmentId, sedId: '21949A', circuitId: 'A' },
    period: { selectedPeriodKeys: ['2026-08'], exposureDays: 31, exposureYears: 31 / 365.2425 },
    faults: { count: selectedSegment.faultCount, indexes: selectedSegment.faultIndexes }, calls: { totalKnown: 5, recordsWithData: 2, recordsWithoutData: 2 },
    geometry: { totalLengthMeters: selectedSegment.lengthMeters, aerialLengthMeters: 0, undergroundLengthMeters: selectedSegment.lengthMeters, unclassifiedLengthMeters: 0, geometryReliability: 'canonical_wgs84' },
    compensation: { automatic: { compensationPerFault: unavailable ? null : 200, totalKnown: unavailable ? null : 1000, faultsCompatible: unavailable ? 0 : 5, compatiblePeriodKeys: ['2026-08'], sourceScope: 'sed', coverageStatus: unavailable ? 'unavailable' : 'complete' } },
    traceability: { periodSource: 'selectedPeriodKeys', geometrySource: 'analysisUnit', compensationSource: 'sed_monthly_metrics_average_per_fault' }
  };
  const assumptions = { aerialCostPerKm: 70000, undergroundCostPerKm: 540000, unclassifiedCostPerKm: null, compensationMode, manualCompensationPerFault: compensationMode === 'manual' ? 300 : null, avoidableFaultFactor: 0.9, discountRate: 0.12, horizonYears: 10, escalationRate: 0 };
  const simulation = simulateEconomicAnalysis(input, assumptions);
  const args = { sedId: '21949A', llaveId: 'A', selectedPeriodKeys: ['2026-08'], emittedAt: '2026-09-07T12:00:00.000Z',
    network: [{ llaveId: 'A', lines }], faults, circuitFaults: faults, sedCoordinate: [-12, -77], analysis, selectedSegment,
    conclusion: 'Conclusión de prueba: inspeccionar el recorrido identificado. Sin recomendación automática.', economic: simulation, economicNote: 'Muestra sintética de validación', calls: input.calls, compensation: input.compensation };
  return { model: buildReportModel(args), args, input, simulation, assumptions };
}
