'use client';

import { useMemo, useState } from 'react';
import {
  COSTO_AEREO_DEFAULT,
  COSTO_SUBTERRANEO_DEFAULT,
  DEFAULT_AVOIDABLE_FAULT_FACTOR,
  DEFAULT_DISCOUNT_RATE,
  DEFAULT_ESCALATION_RATE,
  DEFAULT_HORIZON_YEARS,
  createEconomicSimulationSnapshot,
  simulateEconomicAnalysis
} from '@/lib/economicSimulation';

function numericInput(value) {
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCurrency(value) {
  return Number.isFinite(value)
    ? `S/ ${value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : 'No disponible';
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toLocaleString('es-PE', { maximumFractionDigits: digits }) : 'No disponible';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toLocaleString('es-PE', { maximumFractionDigits: 2 })}%` : 'No disponible';
}

export default function EconomicAnalysisPanel({ input, canSave = false, storedSimulations = [], onSaveSnapshot }) {
  const automaticCompensation = input?.compensation?.circuit?.compensationPerFault;
  const [aerialCost, setAerialCost] = useState(COSTO_AEREO_DEFAULT ?? '');
  const [undergroundCost, setUndergroundCost] = useState(COSTO_SUBTERRANEO_DEFAULT ?? '');
  const [unclassifiedCost, setUnclassifiedCost] = useState('');
  const [compensationMode, setCompensationMode] = useState('automatic');
  const [manualCompensation, setManualCompensation] = useState('');
  const [avoidablePercent, setAvoidablePercent] = useState(String(DEFAULT_AVOIDABLE_FAULT_FACTOR * 100));
  const [discountPercent, setDiscountPercent] = useState(String(DEFAULT_DISCOUNT_RATE * 100));
  const [horizonYears, setHorizonYears] = useState(String(DEFAULT_HORIZON_YEARS));
  const [escalationPercent, setEscalationPercent] = useState(String(DEFAULT_ESCALATION_RATE * 100));
  const [poissonMonths, setPoissonMonths] = useState(2);
  const [note, setNote] = useState('');
  const [saveFeedback, setSaveFeedback] = useState('');

  const assumptions = useMemo(() => ({
    aerialCostPerKm: numericInput(aerialCost),
    undergroundCostPerKm: numericInput(undergroundCost),
    unclassifiedCostPerKm: numericInput(unclassifiedCost),
    compensationMode,
    manualCompensationPerFault: numericInput(manualCompensation),
    avoidableFaultFactor: numericInput(avoidablePercent) === null ? null : numericInput(avoidablePercent) / 100,
    discountRate: numericInput(discountPercent) === null ? null : numericInput(discountPercent) / 100,
    horizonYears: numericInput(horizonYears),
    escalationRate: numericInput(escalationPercent) === null ? null : numericInput(escalationPercent) / 100
  }), [aerialCost, undergroundCost, unclassifiedCost, compensationMode, manualCompensation, avoidablePercent, discountPercent, horizonYears, escalationPercent]);
  const simulation = useMemo(() => simulateEconomicAnalysis(input, assumptions), [input, assumptions]);
  const selectedPoisson = simulation.poisson?.[poissonMonths];
  const financial = simulation.financial;
  const automaticAvailable = Number.isFinite(automaticCompensation);
  const compensationDisplay = compensationMode === 'automatic' && automaticAvailable ? String(automaticCompensation) : manualCompensation;
  const cost = simulation.interventionCost;

  async function saveSimulation() {
    const snapshot = createEconomicSimulationSnapshot(simulation, { note });
    if (!snapshot || !onSaveSnapshot) return;
    const saved = await onSaveSnapshot(snapshot);
    if (saved === false) return;
    setSaveFeedback('Simulación guardada');
    window.setTimeout(() => setSaveFeedback(''), 1800);
  }

  if (!input) {
    return (
      <div className="economic-analysis-panel" role="status" style={{ marginTop: '7px', padding: '7px', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--card-bg)' }}>
        Actualizando datos económicos del periodo...
      </div>
    );
  }

  return (
    <div className="economic-analysis-panel" style={{ marginTop: '7px', padding: '7px', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--card-bg)' }}>
      <div style={{ fontWeight: 800, marginBottom: '5px' }}>Análisis económico preliminar · screening</div>

      <details open>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Datos observados</summary>
        <div style={{ marginTop: '4px', display: 'grid', gap: '2px' }}>
          <div>SED / circuito: <b>{input.identity.sedId} / {input.identity.circuitId}</b></div>
          <div>Unidad: <b>{input.identity.analysisUnitId}</b></div>
          <div>Longitud: {formatNumber(input.geometry.totalLengthMeters)} m</div>
          <div>Aérea / subterránea / sin clasificar: {formatNumber(input.geometry.aerialLengthMeters)} / {formatNumber(input.geometry.undergroundLengthMeters)} / {formatNumber(input.geometry.unclassifiedLengthMeters)} m</div>
          <div>Fallas observadas: {input.faults.count}</div>
          <div>Periodo: {input.period.selectedPeriodKeys.join(', ') || 'No disponible'}</div>
          <div>Exposición: {input.period.exposureDays || 0} días · {formatNumber(input.period.exposureYears, 4)} años</div>
          <div>λ: {simulation.lambda.available ? `${formatNumber(simulation.lambda.value, 4)} fallas/año` : 'No disponible'}</div>
          <div>Llamadas: {input.calls.recordsWithData ? `${input.calls.totalKnown} conocidas (${input.calls.recordsWithData} registros)` : 'No disponible'}</div>
          <div>Meses económicos compatibles: {simulation.compensationPerFault.compatiblePeriodKeys.join(', ') || 'Ninguno'}</div>
        </div>
      </details>

      <details open style={{ marginTop: '6px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Supuestos editables</summary>
        <div style={{ marginTop: '4px', display: 'grid', gap: '5px' }}>
          <label>Costo aéreo/km<input className="input-control" type="number" min="0" value={aerialCost} onChange={event => setAerialCost(event.target.value)} placeholder="Ingresar S/ por km" /></label>
          <label>Costo subterráneo/km<input className="input-control" type="number" min="0" value={undergroundCost} onChange={event => setUndergroundCost(event.target.value)} placeholder="Ingresar S/ por km" /></label>
          {input.geometry.unclassifiedLengthMeters > 0 && <label>Costo manual para longitud sin clasificar/km<input className="input-control" type="number" min="0" value={unclassifiedCost} onChange={event => setUnclassifiedCost(event.target.value)} placeholder="Ingresar S/ por km" /></label>}
          <label>Compensación promedio por falla
            <input className="input-control" type="number" min="0" value={compensationDisplay} onChange={event => { setCompensationMode('manual'); setManualCompensation(event.target.value); }} placeholder="Ingresar supuesto manual" />
          </label>
          <div style={{ color: 'var(--text-muted)' }}>
            {simulation.compensationPerFault.source === 'automatic' && `Calculada automáticamente con ${simulation.compensationPerFault.circuitFaultsCompatible} fallas del circuito.`}
            {simulation.compensationPerFault.source === 'manual' && 'Valor ingresado manualmente para esta simulación.'}
            {simulation.compensationPerFault.source === 'manual_override' && 'Override manual del valor calculado.'}
            {simulation.compensationPerFault.source === 'unavailable' && 'Sin dato automático compatible; puede ingresar un supuesto manual.'}
            {simulation.compensationPerFault.coverageStatus === 'partial' && ' Cobertura económica parcial.'}
          </div>
          {compensationMode === 'manual' && automaticAvailable && <button className="btn btn-outline" type="button" onClick={() => { setCompensationMode('automatic'); setManualCompensation(''); }}>Restaurar valor calculado</button>}
          <label>Factor de fallas evitables (%)<input className="input-control" type="number" min="0" max="100" value={avoidablePercent} onChange={event => setAvoidablePercent(event.target.value)} /></label>
          <div style={{ display: 'flex', gap: '4px' }}>{[70, 90, 100].map(value => <button key={value} className="btn btn-outline" type="button" onClick={() => setAvoidablePercent(String(value))}>{value}%</button>)}</div>
          <label>Tasa de descuento real (%)<input className="input-control" type="number" min="0" step="0.1" value={discountPercent} onChange={event => setDiscountPercent(event.target.value)} /></label>
          <label>Horizonte (años)<input className="input-control" type="number" min="1" step="1" value={horizonYears} onChange={event => setHorizonYears(event.target.value)} /></label>
          <label>Inflación/escalamiento (%)<input className="input-control" type="number" step="0.1" value={escalationPercent} onChange={event => setEscalationPercent(event.target.value)} /></label>
        </div>
      </details>

      <details open style={{ marginTop: '6px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Resultados</summary>
        <div style={{ marginTop: '4px', display: 'grid', gap: '3px' }}>
          <div>Costo preliminar de intervención: <b>{formatCurrency(cost.total)}</b></div>
          <div style={{ color: 'var(--text-muted)' }}>Aérea: {formatNumber(cost.components.aerial.lengthMeters)} m × {formatCurrency(cost.components.aerial.costPerKm)}/km = {formatCurrency(cost.components.aerial.cost)}</div>
          <div style={{ color: 'var(--text-muted)' }}>Subterránea: {formatNumber(cost.components.underground.lengthMeters)} m × {formatCurrency(cost.components.underground.costPerKm)}/km = {formatCurrency(cost.components.underground.cost)}</div>
          {cost.components.unclassified.lengthMeters > 0 && <div style={{ color: 'var(--text-muted)' }}>Sin clasificar: {formatNumber(cost.components.unclassified.lengthMeters)} m × {formatCurrency(cost.components.unclassified.costPerKm)}/km = {formatCurrency(cost.components.unclassified.cost)}</div>}
          <div>Compensación promedio/falla: <b>{formatCurrency(simulation.compensationPerFault.value)}</b></div>
          <div>Exposición anual estimada: <b>{formatCurrency(simulation.annualCompensationExposure)}</b></div>
          <div>Ahorro anual estimado por compensaciones evitables: <b>{formatCurrency(simulation.annualAvoidedBenefit)}</b></div>
          <div>VAN preliminar: <b>{formatCurrency(financial.npv)}</b>{Number.isFinite(financial.npv) ? ` · ${financial.npv > 0 ? 'positivo' : financial.npv < 0 ? 'negativo' : 'igual a cero'}` : ''}</div>
          <div>TIR preliminar: <b>{formatPercent(financial.irr)}</b>{Number.isFinite(financial.irr) && Number.isFinite(simulation.inputsUsed.assumptions.discountRate) ? ` · ${financial.irr >= simulation.inputsUsed.assumptions.discountRate ? 'por encima' : 'por debajo'} de la tasa` : ''}</div>
          <div>Payback simple: <b>{Number.isFinite(financial.simplePaybackYears) ? `${formatNumber(financial.simplePaybackYears)} años` : simulation.annualAvoidedBenefit === 0 ? 'No recuperable con los beneficios considerados' : 'No disponible'}</b></div>
          <div>Payback descontado: <b>{Number.isFinite(financial.discountedPaybackYears)
            ? `${formatNumber(financial.discountedPaybackYears)} años`
            : financial.available
              ? `No recuperado dentro del horizonte de ${simulation.inputsUsed.assumptions.horizonYears || '-'} años`
              : 'No disponible'}</b></div>
          <div>Relación B/C: <b>{formatNumber(financial.benefitCostRatio, 4)}</b>{Number.isFinite(financial.benefitCostRatio) ? ` · ${financial.benefitCostRatio > 1 ? '> 1' : financial.benefitCostRatio < 1 ? '< 1' : '= 1'}` : ''}</div>
          <div style={{ marginTop: '3px' }}>Probabilidad estimada de al menos una nueva falla:</div>
          <div style={{ display: 'flex', gap: '4px' }}>{[2, 6, 12].map(months => <button key={months} className="btn btn-outline" type="button" onClick={() => setPoissonMonths(months)}>{months} meses</button>)}</div>
          <div><b>{selectedPoisson ? formatPercent(selectedPoisson.probabilityAtLeastOne) : 'No disponible'}</b>{selectedPoisson ? ` · E[N] ${formatNumber(selectedPoisson.expectedFaults, 3)}` : ''}</div>
        </div>
      </details>

      <details style={{ marginTop: '6px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Calidad y trazabilidad</summary>
        <div style={{ marginTop: '4px', color: 'var(--text-muted)' }}>
          <div>λ calculada con {simulation.lambda.faultCount ?? 0} fallas durante {simulation.lambda.exposureDays ?? 0} días.</div>
          {simulation.compensationPerFault.compatiblePeriodKeys.length > 0 && <div>Compensación calculada con los meses {simulation.compensationPerFault.compatiblePeriodKeys.join(', ')}.</div>}
          {simulation.warnings.map(warning => <div key={warning.code}>• {warning.message}</div>)}
        </div>
      </details>

      <div style={{ marginTop: '7px' }}>
        <label>Notas del analista<textarea className="input-control" rows="3" value={note} onChange={event => setNote(event.target.value)} placeholder="Observaciones técnicas para esta simulación" /></label>
        <button className="btn btn-green" type="button" disabled={!canSave} onClick={saveSimulation}>Guardar simulación</button>
        {saveFeedback && <span role="status" style={{ marginLeft: '6px', color: 'var(--accent-green)' }}>{saveFeedback}</span>}
        {storedSimulations.length > 0 && <div style={{ marginTop: '4px', color: 'var(--text-muted)' }}>{storedSimulations.length} simulación(es) guardada(s) para esta unidad.</div>}
      </div>

      <p style={{ margin: '7px 0 0', color: 'var(--text-muted)', fontSize: '9px' }}>
        Análisis económico preliminar para screening. Los resultados dependen de los supuestos utilizados y no sustituyen una evaluación técnica, presupuestal o regulatoria detallada.
      </p>
    </div>
  );
}
