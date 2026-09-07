import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEconomicAnalysisInput } from '../lib/economicAnalysisInput.js';
import { createProjectDocument, projectToInternalModel } from '../lib/projectMappers.js';
import { validateProject } from '../lib/projectValidation.js';
import {
  COSTO_AEREO_DEFAULT,
  COSTO_SUBTERRANEO_DEFAULT,
  calculateFaultRate,
  calculateFinancialIndicators,
  calculateIrr,
  calculatePoissonProbability,
  createEconomicSimulationSnapshot,
  simulateEconomicAnalysis
} from '../lib/economicSimulation.js';

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function technicalInput(overrides = {}) {
  return {
    identity: { sedId: '00338S', circuitId: 'A', analysisUnitId: 'manual:one', analysisUnitSource: 'manual' },
    period: { selectedPeriodKeys: ['2026-01'], exposureDays: 182.62125, exposureYears: 0.5 },
    faults: { count: 4, indexes: [0, 1, 2, 3], ids: ['1', '2', '3', '4'] },
    calls: { totalKnown: 0, recordsWithData: 0, recordsWithoutData: 4 },
    compensation: { circuit: { compensationPerFault: 2500, totalKnown: 10000, circuitFaultsCompatible: 4, compatiblePeriodKeys: ['2026-01'], coverageStatus: 'complete' } },
    geometry: { totalLengthMeters: 200, aerialLengthMeters: 120, undergroundLengthMeters: 80, unclassifiedLengthMeters: 0, geometryReliability: 'canonical_wgs84', edgeIds: ['e1', 'e2'] },
    traceability: { periodSource: 'selectedPeriodKeys' },
    ...overrides
  };
}

test('configured intervention cost defaults use soles per kilometer', () => {
  assert.equal(COSTO_AEREO_DEFAULT, 70000);
  assert.equal(COSTO_SUBTERRANEO_DEFAULT, 540000);
});

test('lambda and Poisson use the technical exposure only', () => {
  const lambda = calculateFaultRate(4, 0.5);
  assert.equal(lambda, 8);
  const twoMonths = calculatePoissonProbability(lambda, 2);
  close(twoMonths.expectedFaults, 8 * 2 / 12);
  close(twoMonths.probabilityAtLeastOne, 1 - Math.exp(-8 * 2 / 12));
  assert.equal(calculateFaultRate(4, 0), null);
  assert.equal(calculateFaultRate(4, Number.NaN), null);
  assert.deepEqual(calculatePoissonProbability(0, 12), { months: 12, expectedFaults: 0, probabilityAtLeastOne: 0 });
});

test('financial regression matches the known constant-benefit case', () => {
  const result = calculateFinancialIndicators({ capex: 100000, annualBenefit: 20000, discountRate: 0.12, horizonYears: 10 });
  close(result.pvBenefits, 113004.461524, 0.01);
  close(result.npv, 13004.461524, 0.01);
  close(result.benefitCostRatio, 1.13004461524, 1e-8);
  close(result.irr, 0.1509841448, 1e-6);
  close(result.simplePaybackYears, 5, 1e-12);
  close(result.discountedPaybackYears, 8.092, 0.01);
});

test('financial edge cases never return NaN or Infinity', () => {
  const noBenefit = calculateFinancialIndicators({ capex: 100, annualBenefit: 0, discountRate: 0.12, horizonYears: 10 });
  assert.equal(noBenefit.irr, null);
  assert.equal(noBenefit.simplePaybackYears, null);
  assert.equal(noBenefit.discountedPaybackYears, null);
  const noCapex = calculateFinancialIndicators({ capex: 0, annualBenefit: 20, discountRate: 0.12, horizonYears: 10 });
  assert.equal(noCapex.irr, null);
  assert.equal(noCapex.simplePaybackYears, 0);
  assert.equal(noCapex.benefitCostRatio, null);
  const zeroRate = calculateFinancialIndicators({ capex: 100, annualBenefit: 60, discountRate: 0, horizonYears: 1 });
  assert.equal(zeroRate.npv, -40);
  assert.equal(zeroRate.discountedPaybackYears, null);
  const negative = calculateFinancialIndicators({ capex: 100000, annualBenefit: 5000, discountRate: 0.12, horizonYears: 10 });
  assert.ok(negative.npv < 0);
  assert.equal(negative.discountedPaybackYears, null);
  assert.equal(calculateIrr([-100, 0, 0]), null);
});

test('mixed intervention cost uses aerial and underground lengths separately', () => {
  const result = simulateEconomicAnalysis(technicalInput(), {
    aerialCostPerKm: 100000,
    undergroundCostPerKm: 300000
  });
  assert.equal(result.interventionCost.available, true);
  assert.equal(result.interventionCost.components.aerial.cost, 12000);
  assert.equal(result.interventionCost.components.underground.cost, 24000);
  assert.equal(result.interventionCost.total, 36000);
  assert.equal(result.lambda.value, 8);
  close(result.poisson[2].probabilityAtLeastOne, 1 - Math.exp(-8 * 2 / 12));
});

test('unclassified length is visible and blocks cost until a manual cost is supplied', () => {
  const input = technicalInput({ geometry: { totalLengthMeters: 20, aerialLengthMeters: 0, undergroundLengthMeters: 0, unclassifiedLengthMeters: 20, geometryReliability: 'canonical_wgs84', edgeIds: ['e'] } });
  const unavailable = simulateEconomicAnalysis(input, {});
  assert.equal(unavailable.interventionCost.available, false);
  assert.ok(unavailable.warnings.some(warning => warning.code === 'UNCLASSIFIED_LENGTH_UNCOSTED'));
  const resolved = simulateEconomicAnalysis(input, { unclassifiedCostPerKm: 50000 });
  assert.equal(resolved.interventionCost.total, 1000);
});

test('unverified CRS blocks preliminary cost instead of inventing a reliable length', () => {
  const input = technicalInput({ geometry: { ...technicalInput().geometry, geometryReliability: 'unverified_crs' } });
  const result = simulateEconomicAnalysis(input, { aerialCostPerKm: 100, undergroundCostPerKm: 100 });
  assert.equal(result.interventionCost.available, false);
  assert.ok(result.warnings.some(warning => warning.code === 'UNVERIFIED_GEOMETRY_CRS'));
});

test('manual compensation is explicit and can override an automatic value', () => {
  const automatic = simulateEconomicAnalysis(technicalInput(), { aerialCostPerKm: 1, undergroundCostPerKm: 1 });
  assert.deepEqual([automatic.compensationPerFault.value, automatic.compensationPerFault.source], [2500, 'automatic']);
  const overridden = simulateEconomicAnalysis(technicalInput(), {
    aerialCostPerKm: 1,
    undergroundCostPerKm: 1,
    compensationMode: 'manual',
    manualCompensationPerFault: 3000
  });
  assert.deepEqual([overridden.compensationPerFault.value, overridden.compensationPerFault.source], [3000, 'manual_override']);
});

test('missing compensation leaves dependent results unavailable', () => {
  const input = technicalInput({ compensation: { circuit: { compensationPerFault: null, coverageStatus: 'unavailable', compatiblePeriodKeys: [] } } });
  const result = simulateEconomicAnalysis(input, { aerialCostPerKm: 1, undergroundCostPerKm: 1 });
  assert.equal(result.compensationPerFault.available, false);
  assert.equal(result.annualCompensationExposure, null);
  assert.equal(result.financial.available, false);
});

test('SED compensation average is used automatically when circuit compensation is unavailable', () => {
  const input = technicalInput({
    compensation: {
      automatic: { compensationPerFault: 250, totalKnown: 1000, faultsCompatible: 4, compatiblePeriodKeys: ['2026-01'], coverageStatus: 'complete', sourceScope: 'sed' },
      circuit: { compensationPerFault: null, coverageStatus: 'unavailable', compatiblePeriodKeys: [] },
      sedContext: { dataAvailable: true, totalKnown: 1000 }
    }
  });
  const result = simulateEconomicAnalysis(input, { aerialCostPerKm: 1, undergroundCostPerKm: 1 });
  assert.equal(result.compensationPerFault.source, 'automatic');
  assert.equal(result.compensationPerFault.sourceScope, 'sed');
  assert.equal(result.compensationPerFault.value, 250);
});

test('compatible circuit compensation uses circuit faults from matching months, never selected-unit faults', () => {
  const faults = [
    { id: 'march-unit', periodKey: '2026-03' },
    { id: 'july-1', periodKey: '2026-07' },
    { id: 'july-2', periodKey: '2026-07' },
    { id: 'august-1', periodKey: '2026-08' }
  ];
  const input = buildEconomicAnalysisInput({
    sedId: '00338S', circuitId: 'A',
    analysisUnit: { analysisSegmentId: 'segment', faultIndexes: [0], lengthMeters: 10 },
    selectedPeriodKeys: ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
    faults,
    circuitCompensationRows: [
      { sed_id: '00338S', llave_code: 'A', period_key: '2026-07', compensation: 100 },
      { sed_id: '00338S', llave_code: 'A', period_key: '2026-08', compensation: 200 }
    ]
  });
  assert.equal(input.faults.count, 1);
  assert.deepEqual(input.compensation.circuit.compatiblePeriodKeys, ['2026-07', '2026-08']);
  assert.equal(input.compensation.circuit.circuitFaultsCompatible, 3);
  assert.equal(input.compensation.circuit.compensationPerFault, 100);
  assert.equal(input.compensation.circuit.coverageStatus, 'partial');
});

test('registered zero compensation is available but zero compatible faults prevents division', () => {
  const withFault = buildEconomicAnalysisInput({
    sedId: '00338S', circuitId: 'A', analysisUnit: { faultIndexes: [0] }, selectedPeriodKeys: ['2026-08'],
    faults: [{ periodKey: '2026-08' }],
    circuitCompensationRows: [{ sed_id: '00338S', llave_code: 'A', period_key: '2026-08', compensation: 0 }]
  });
  assert.equal(withFault.compensation.circuit.dataAvailable, true);
  assert.equal(withFault.compensation.circuit.compensationPerFault, 0);
  const withoutFault = buildEconomicAnalysisInput({
    sedId: '00338S', circuitId: 'A', analysisUnit: { faultIndexes: [] }, selectedPeriodKeys: ['2026-08'], faults: [],
    circuitCompensationRows: [{ sed_id: '00338S', llave_code: 'A', period_key: '2026-08', compensation: 0 }]
  });
  assert.equal(withoutFault.compensation.circuit.compensationPerFault, null);
});

test('avoidable factor affects only the selected segment benefit', () => {
  const result = simulateEconomicAnalysis(technicalInput(), {
    aerialCostPerKm: 100000,
    undergroundCostPerKm: 300000,
    avoidableFaultFactor: 0.7
  });
  assert.equal(result.annualCompensationExposure, 20000);
  assert.equal(result.annualAvoidedBenefit, 14000);
});

test('snapshot freezes model version, assumptions, results and note', () => {
  const simulation = simulateEconomicAnalysis(technicalInput(), { aerialCostPerKm: 100000, undergroundCostPerKm: 300000 });
  const snapshot = createEconomicSimulationSnapshot(simulation, { note: 'Revisar empalmes', createdAt: '2026-09-06T12:00:00.000Z' });
  assert.equal(snapshot.economicModelVersion, 1);
  assert.equal(snapshot.createdAt, '2026-09-06T12:00:00.000Z');
  assert.equal(snapshot.analysisUnitId, 'manual:one');
  assert.equal(snapshot.assumptions.aerialCostPerKm, 100000);
  assert.equal(snapshot.results.interventionCost, 36000);
  assert.equal(snapshot.note, 'Revisar empalmes');
});

test('economic snapshots survive canonical project validation and round-trip', async () => {
  const snapshot = createEconomicSimulationSnapshot(
    simulateEconomicAnalysis(technicalInput(), { aerialCostPerKm: 100000, undergroundCostPerKm: 300000 }),
    { note: 'Congelada', createdAt: '2026-09-06T12:00:00.000Z' }
  );
  const database = {
    '00338S': { name: 'SED', sedCoord: [0, 0], llaves: { A: { lines: [], analysis: { status: 'analizado', economicSimulations: [snapshot] } } } }
  };
  const project = await createProjectDocument(database, []);
  assert.equal(project.llaves[0].analysis.economic_simulations[0].economicModelVersion, 1);
  assert.equal((await validateProject(project)).valid, true);
  const restored = projectToInternalModel(project).localDatabase['00338S'].llaves.A.analysis.economicSimulations[0];
  assert.deepEqual(restored, snapshot);
});

test('UI exposes screening controls without automatic renewal language', () => {
  const panel = readFileSync(new URL('../components/EconomicAnalysisPanel.js', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../components/Sidebar.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(sidebar, /Analizar econ/);
  assert.match(panel, /Costo preliminar de intervenci/);
  assert.match(panel, /VAN preliminar/);
  assert.match(panel, /TIR preliminar/);
  assert.match(panel, /Restaurar valor calculado/);
  assert.match(panel, /Actualizando datos econ.micos del periodo/);
  assert.match(panel, /70, 90, 100/);
  assert.match(sidebar, /showEconomicAnalysis && selectedAnalysisSegment/);
  assert.doesNotMatch(panel, /PROYECTO APROBADO|PRIORIDAD #1|RENOVAR ESTE TRAMO/i);
  assert.match(page, /economicSimulations:/);
});
