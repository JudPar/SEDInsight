export const ECONOMIC_MODEL_VERSION = 1;
export const COSTO_AEREO_DEFAULT = 70000;
export const COSTO_SUBTERRANEO_DEFAULT = 540000;
export const DEFAULT_DISCOUNT_RATE = 0.12;
export const DEFAULT_HORIZON_YEARS = 10;
export const DEFAULT_AVOIDABLE_FAULT_FACTOR = 0.9;
export const DEFAULT_ESCALATION_RATE = 0;
export const POISSON_HORIZON_MONTHS = [2, 6, 12];

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteRate(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > -1 ? number : null;
}

function positiveInteger(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function calculateFaultRate(faultCount, exposureYears) {
  const faults = finiteNonNegative(faultCount);
  const exposure = Number(exposureYears);
  if (faults === null || !Number.isFinite(exposure) || exposure <= 0) return null;
  return faults / exposure;
}

export function calculatePoissonProbability(lambda, months) {
  const annualRate = finiteNonNegative(lambda);
  const horizonMonths = finiteNonNegative(months);
  if (annualRate === null || horizonMonths === null) return null;
  const expectedFaults = annualRate * horizonMonths / 12;
  return {
    months: horizonMonths,
    expectedFaults,
    probabilityAtLeastOne: 1 - Math.exp(-expectedFaults)
  };
}

export function calculateFinancialIndicators({ capex, annualBenefit, discountRate, horizonYears, escalationRate = 0 } = {}) {
  const investment = finiteNonNegative(capex);
  const benefit = finiteNonNegative(annualBenefit);
  const rate = finiteRate(discountRate, null);
  const escalation = finiteRate(escalationRate, 0);
  const horizon = positiveInteger(horizonYears, null);
  if (investment === null || benefit === null || rate === null || escalation === null || horizon === null) {
    return { available: false, reason: 'INVALID_FINANCIAL_INPUTS', pvBenefits: null, npv: null, irr: null, simplePaybackYears: null, discountedPaybackYears: null, benefitCostRatio: null, yearlyCashFlows: [] };
  }

  const yearlyCashFlows = [];
  let pvBenefits = 0;
  let discountedCumulative = 0;
  let discountedPaybackYears = investment === 0 ? 0 : null;
  for (let year = 1; year <= horizon; year += 1) {
    const annualCashFlow = benefit * (1 + escalation) ** (year - 1);
    const discountedBenefit = annualCashFlow / (1 + rate) ** year;
    const before = discountedCumulative;
    discountedCumulative += discountedBenefit;
    pvBenefits += discountedBenefit;
    if (discountedPaybackYears === null && discountedBenefit > 0 && discountedCumulative >= investment) {
      discountedPaybackYears = (year - 1) + (investment - before) / discountedBenefit;
    }
    yearlyCashFlows.push({ year, benefit: annualCashFlow, discountedBenefit, discountedCumulative });
  }

  const npv = -investment + pvBenefits;
  const simplePaybackYears = investment === 0 ? 0 : benefit > 0 ? investment / benefit : null;
  const benefitCostRatio = investment > 0 ? pvBenefits / investment : null;
  const irr = calculateIrr([-investment, ...yearlyCashFlows.map(item => item.benefit)]);
  return {
    available: true,
    reason: null,
    pvBenefits,
    npv,
    irr,
    simplePaybackYears,
    discountedPaybackYears,
    benefitCostRatio,
    yearlyCashFlows
  };
}

function npvAtRate(cashFlows, rate) {
  return cashFlows.reduce((total, cashFlow, index) => total + cashFlow / (1 + rate) ** index, 0);
}

export function calculateIrr(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2 || cashFlows.some(value => !Number.isFinite(value))) return null;
  if (!cashFlows.some(value => value < 0) || !cashFlows.some(value => value > 0)) return null;
  let low = -0.999999;
  let high = 1;
  let lowValue = npvAtRate(cashFlows, low);
  let highValue = npvAtRate(cashFlows, high);
  while (Math.sign(lowValue) === Math.sign(highValue) && high < 1000000) {
    high *= 2;
    highValue = npvAtRate(cashFlows, high);
  }
  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue) || Math.sign(lowValue) === Math.sign(highValue)) return null;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const middle = (low + high) / 2;
    const value = npvAtRate(cashFlows, middle);
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) < 1e-8) return middle;
    if (Math.sign(value) === Math.sign(lowValue)) {
      low = middle;
      lowValue = value;
    } else {
      high = middle;
      highValue = value;
    }
  }
  return (low + high) / 2;
}

function calculateInterventionCost(geometry, assumptions, warnings) {
  const aerialLengthMeters = finiteNonNegative(geometry?.aerialLengthMeters) ?? 0;
  const undergroundLengthMeters = finiteNonNegative(geometry?.undergroundLengthMeters) ?? 0;
  const unclassifiedLengthMeters = finiteNonNegative(geometry?.unclassifiedLengthMeters) ?? 0;
  const aerialCostPerKm = finiteNonNegative(assumptions.aerialCostPerKm);
  const undergroundCostPerKm = finiteNonNegative(assumptions.undergroundCostPerKm);
  const unclassifiedCostPerKm = finiteNonNegative(assumptions.unclassifiedCostPerKm);
  let complete = true;
  if (geometry?.geometryReliability === 'unverified_crs' || geometry?.geometryReliability === 'invalid') {
    warnings.push({ code: 'UNVERIFIED_GEOMETRY_CRS', message: 'La longitud procede de una geometria con CRS no verificado.' });
    complete = false;
  }
  if (aerialLengthMeters > 0 && aerialCostPerKm === null) {
    warnings.push({ code: 'MISSING_AERIAL_COST', message: 'Falta el costo por km de red aerea.' });
    complete = false;
  }
  if (undergroundLengthMeters > 0 && undergroundCostPerKm === null) {
    warnings.push({ code: 'MISSING_UNDERGROUND_COST', message: 'Falta el costo por km de red subterranea.' });
    complete = false;
  }
  if (unclassifiedLengthMeters > 0 && unclassifiedCostPerKm === null) {
    warnings.push({ code: 'UNCLASSIFIED_LENGTH_UNCOSTED', message: 'Existe longitud sin clasificar y no tiene costo manual asignado.' });
    complete = false;
  }
  const components = {
    aerial: { lengthMeters: aerialLengthMeters, costPerKm: aerialCostPerKm, cost: aerialLengthMeters === 0 ? 0 : aerialCostPerKm === null ? null : aerialLengthMeters / 1000 * aerialCostPerKm },
    underground: { lengthMeters: undergroundLengthMeters, costPerKm: undergroundCostPerKm, cost: undergroundLengthMeters === 0 ? 0 : undergroundCostPerKm === null ? null : undergroundLengthMeters / 1000 * undergroundCostPerKm },
    unclassified: { lengthMeters: unclassifiedLengthMeters, costPerKm: unclassifiedCostPerKm, cost: unclassifiedLengthMeters === 0 ? 0 : unclassifiedCostPerKm === null ? null : unclassifiedLengthMeters / 1000 * unclassifiedCostPerKm }
  };
  return {
    available: complete,
    total: complete ? Object.values(components).reduce((total, component) => total + component.cost, 0) : null,
    components
  };
}

export function simulateEconomicAnalysis(input = {}, assumptions = {}) {
  const warnings = [];
  const discountRate = finiteRate(assumptions.discountRate, DEFAULT_DISCOUNT_RATE);
  const horizonYears = positiveInteger(assumptions.horizonYears, DEFAULT_HORIZON_YEARS);
  const avoidableFaultFactor = finiteNonNegative(assumptions.avoidableFaultFactor ?? DEFAULT_AVOIDABLE_FAULT_FACTOR);
  const escalationRate = finiteRate(assumptions.escalationRate, DEFAULT_ESCALATION_RATE);
  const lambda = calculateFaultRate(input?.faults?.count, input?.period?.exposureYears);
  if (lambda === null) warnings.push({ code: 'INVALID_TECHNICAL_PERIOD', message: 'No existe una exposicion tecnica valida para calcular lambda.' });
  const poisson = Object.fromEntries(POISSON_HORIZON_MONTHS.map(months => [months, lambda === null ? null : calculatePoissonProbability(lambda, months)]));

  const automaticCompensation = finiteNonNegative(input?.compensation?.circuit?.compensationPerFault);
  const manualMode = assumptions.compensationMode === 'manual';
  const manualCompensation = finiteNonNegative(assumptions.manualCompensationPerFault);
  const compensationPerFault = manualMode ? manualCompensation : automaticCompensation;
  const compensationSource = manualMode
    ? automaticCompensation !== null ? 'manual_override' : 'manual'
    : automaticCompensation !== null ? 'automatic' : 'unavailable';
  if (input?.compensation?.circuit?.coverageStatus === 'partial') warnings.push({ code: 'PARTIAL_COMPENSATION_COVERAGE', message: 'La compensacion automatica tiene cobertura economica parcial.' });
  if (compensationSource === 'manual' || compensationSource === 'manual_override') warnings.push({ code: 'MANUAL_COMPENSATION', message: 'La compensacion por falla es un supuesto manual.' });
  if (compensationPerFault === null) warnings.push({ code: 'MISSING_COMPENSATION_PER_FAULT', message: 'No existe compensacion promedio por falla disponible.' });

  const interventionCost = calculateInterventionCost(input?.geometry, assumptions, warnings);
  const annualCompensationExposure = lambda !== null && compensationPerFault !== null ? lambda * compensationPerFault : null;
  const validAvoidableFactor = avoidableFaultFactor !== null && avoidableFaultFactor <= 1;
  if (!validAvoidableFactor) warnings.push({ code: 'INVALID_AVOIDABLE_FACTOR', message: 'El factor de fallas evitables debe estar entre 0 y 1.' });
  const annualAvoidedBenefit = annualCompensationExposure !== null && validAvoidableFactor
    ? annualCompensationExposure * avoidableFaultFactor
    : null;
  const financial = interventionCost.available && annualAvoidedBenefit !== null
    ? calculateFinancialIndicators({ capex: interventionCost.total, annualBenefit: annualAvoidedBenefit, discountRate, horizonYears, escalationRate })
    : { available: false, reason: 'INCOMPLETE_ECONOMIC_INPUTS', pvBenefits: null, npv: null, irr: null, simplePaybackYears: null, discountedPaybackYears: null, benefitCostRatio: null, yearlyCashFlows: [] };

  return {
    economicModelVersion: ECONOMIC_MODEL_VERSION,
    screeningOnly: true,
    inputsUsed: {
      identity: input?.identity || null,
      period: input?.period || null,
      faults: input?.faults || null,
      calls: input?.calls || null,
      geometry: input?.geometry || null,
      assumptions: {
        aerialCostPerKm: finiteNonNegative(assumptions.aerialCostPerKm),
        undergroundCostPerKm: finiteNonNegative(assumptions.undergroundCostPerKm),
        unclassifiedCostPerKm: finiteNonNegative(assumptions.unclassifiedCostPerKm),
        compensationMode: manualMode ? 'manual' : 'automatic',
        manualCompensationPerFault: manualMode ? manualCompensation : null,
        avoidableFaultFactor: validAvoidableFactor ? avoidableFaultFactor : null,
        discountRate,
        horizonYears,
        escalationRate
      }
    },
    lambda: { available: lambda !== null, value: lambda, faultCount: input?.faults?.count ?? null, exposureDays: input?.period?.exposureDays ?? null, exposureYears: input?.period?.exposureYears ?? null, periodKeys: input?.period?.selectedPeriodKeys || [] },
    poisson,
    compensationPerFault: {
      available: compensationPerFault !== null,
      value: compensationPerFault,
      source: compensationSource,
      automaticValue: automaticCompensation,
      compatiblePeriodKeys: input?.compensation?.circuit?.compatiblePeriodKeys || [],
      compatibleCompensation: input?.compensation?.circuit?.totalKnown ?? null,
      circuitFaultsCompatible: input?.compensation?.circuit?.circuitFaultsCompatible ?? null,
      coverageStatus: input?.compensation?.circuit?.coverageStatus || 'unavailable'
    },
    interventionCost,
    annualCompensationExposure,
    annualAvoidedBenefit,
    financial,
    warnings,
    traceability: input?.traceability || null
  };
}

export function createEconomicSimulationSnapshot(simulation, { note = '', createdAt = new Date().toISOString() } = {}) {
  if (!simulation || simulation.economicModelVersion !== ECONOMIC_MODEL_VERSION) return null;
  return {
    economicModelVersion: ECONOMIC_MODEL_VERSION,
    createdAt,
    analysisUnitId: simulation.inputsUsed?.identity?.analysisUnitId || null,
    sedId: simulation.inputsUsed?.identity?.sedId || null,
    circuitId: simulation.inputsUsed?.identity?.circuitId || null,
    period: simulation.lambda ? {
      selectedPeriodKeys: simulation.lambda.periodKeys,
      exposureDays: simulation.lambda.exposureDays,
      exposureYears: simulation.lambda.exposureYears
    } : null,
    geometry: simulation.inputsUsed?.geometry || null,
    faults: simulation.inputsUsed?.faults || null,
    lambda: simulation.lambda?.value ?? null,
    compensation: simulation.compensationPerFault,
    assumptions: simulation.inputsUsed?.assumptions || null,
    results: {
      interventionCost: simulation.interventionCost?.total ?? null,
      annualCompensationExposure: simulation.annualCompensationExposure,
      annualAvoidedBenefit: simulation.annualAvoidedBenefit,
      npv: simulation.financial?.npv ?? null,
      irr: simulation.financial?.irr ?? null,
      simplePaybackYears: simulation.financial?.simplePaybackYears ?? null,
      discountedPaybackYears: simulation.financial?.discountedPaybackYears ?? null,
      benefitCostRatio: simulation.financial?.benefitCostRatio ?? null
    },
    note: String(note || '')
  };
}
