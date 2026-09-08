'use client';

import { useMemo, useState } from 'react';
import { formatPeriodLabel, isMonthlyPeriodKey, selectRecentPeriods, UNASSIGNED_PERIOD_KEY } from '@/lib/faultPeriods';
import { prepareMonthlyFaultImport } from '@/lib/monthlyFaultImport';
import { detectCompensationImportKind, prepareMonthlyCircuitCompensationImport, prepareMonthlyCompensationImport, summarizeCircuitCompensationPeriods } from '@/lib/monthlyCompensationImport';
import { sortSedPeriodMetrics, summarizeCompensationPeriods } from '@/lib/sedMetrics';
import { parseProjectJson } from '@/lib/projectFormat';
import { createWorkProjectConfig, validateWorkProjectConfig } from '@/lib/workProjectConfig';

function downloadConfig(config) {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${String(config.name || 'proyecto').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.geopluz-config.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatLoadDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('es-PE') : '-';
}

export default function DataManagementPanel({
  expanded = false,
  onSectionToggle,
  sectionRef,
  seds,
  faultPoints,
  periods,
  selectedPeriodKeys,
  onChangeSelectedPeriods,
  ranking,
  onSelectSed,
  periodSupport,
  onImportMonthly,
  onDeletePeriod,
  compensationRows = [],
  onImportCompensation,
  onDeleteCompensationPeriod,
  circuitCompensationRows = [],
  circuitCompensationSupport = false,
  onImportCircuitCompensation,
  onDeleteCircuitCompensationPeriod,
  workProjects,
  onSaveWorkProject,
  onOpenWorkProject,
  onDeleteWorkProject,
  localProjects,
  onRemoveLocalProject
}) {
  const [monthlyText, setMonthlyText] = useState('');
  const [monthlyPreview, setMonthlyPreview] = useState(null);
  const [monthlyError, setMonthlyError] = useState('');
  const [monthlyBusy, setMonthlyBusy] = useState(false);
  const [compensationText, setCompensationText] = useState('');
  const [compensationPreview, setCompensationPreview] = useState(null);
  const [compensationError, setCompensationError] = useState('');
  const [compensationNotice, setCompensationNotice] = useState('');
  const [compensationBusy, setCompensationBusy] = useState(false);
  const [circuitCompensationText, setCircuitCompensationText] = useState('');
  const [circuitCompensationPreview, setCircuitCompensationPreview] = useState(null);
  const [circuitCompensationError, setCircuitCompensationError] = useState('');
  const [circuitCompensationBusy, setCircuitCompensationBusy] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [projectSedIds, setProjectSedIds] = useState([]);
  const [projectError, setProjectError] = useState('');
  const [rankingSearch, setRankingSearch] = useState('');
  const [rankingSort, setRankingSort] = useState('faultCount');
  const [portableConfigText, setPortableConfigText] = useState('');
  const periodKeys = periods.map(period => period.periodKey);
  const selectedSet = useMemo(() => new Set(selectedPeriodKeys), [selectedPeriodKeys]);
  const totals = useMemo(() => ({
    seds: Object.keys(seds || {}).length,
    llaves: Object.values(seds || {}).reduce((sum, sed) => sum + Object.keys(sed?.llaves || {}).length, 0),
    fallas: faultPoints.length
  }), [seds, faultPoints]);
  const onlineFaultTotal = useMemo(() => periods.reduce((sum, period) => sum + Number(period.rowCount || 0), 0), [periods]);
  const sortedRanking = useMemo(() => sortSedPeriodMetrics(ranking, rankingSort), [ranking, rankingSort]);
  const filteredRanking = useMemo(() => {
    const query = rankingSearch.trim().toLocaleLowerCase('es');
    if (!query) return sortedRanking;
    return sortedRanking.filter(item => `${item.sedId} ${item.sedName || ''}`.toLocaleLowerCase('es').includes(query));
  }, [sortedRanking, rankingSearch]);
  const compensationPeriods = useMemo(() => summarizeCompensationPeriods(compensationRows), [compensationRows]);
  const permanentCircuits = useMemo(() => Object.entries(seds || {}).flatMap(([sedId, sed]) =>
    Object.keys(sed?.llaves || {}).map(llaveCode => ({ sedId, llaveCode }))), [seds]);
  const circuitCompensationPeriods = useMemo(() => summarizeCircuitCompensationPeriods(circuitCompensationRows), [circuitCompensationRows]);
  const lastNetworkUpdate = useMemo(() => {
    const timestamps = Object.values(seds || {}).flatMap(sed => [sed?.createdAt, ...Object.values(sed?.llaves || {}).map(llave => llave?.createdAt)]).filter(Boolean);
    const latest = timestamps.map(value => new Date(value)).filter(value => !Number.isNaN(value.getTime())).sort((a, b) => b - a)[0];
    return latest ? latest.toLocaleDateString('es-PE') : 'No informada';
  }, [seds]);

  function applyPreset(count) {
    const hasMonthlyPeriods = periods.some(period => isMonthlyPeriodKey(period.periodKey));
    onChangeSelectedPeriods(selectRecentPeriods(periods, count, { includeUnassigned: !hasMonthlyPeriods && periods.some(period => period.periodKey === UNASSIGNED_PERIOD_KEY) }));
  }

  function togglePeriod(periodKey) {
    const next = new Set(selectedSet);
    if (next.has(periodKey)) next.delete(periodKey); else next.add(periodKey);
    onChangeSelectedPeriods([...next]);
  }

  function previewMonthly() {
    setMonthlyError('');
    try {
      const parsed = parseProjectJson(monthlyText);
      const preview = prepareMonthlyFaultImport(parsed, Object.keys(seds || {}), periodKeys);
      setMonthlyPreview(preview);
      if (!preview.valid) setMonthlyError('El JSON no contiene un periodo YYYY-MM y registros válidos del universo permanente.');
    } catch (error) {
      setMonthlyPreview(null);
      setMonthlyError(error?.message || 'No se pudo leer el JSON mensual.');
    }
  }

  async function confirmMonthlyImport() {
    if (!monthlyPreview?.valid || !periodSupport) return;
    const importablePeriods = (monthlyPreview.periods || []).filter(period => period.valid);
    const existing = importablePeriods.filter(period => period.periodExists);
    const message = existing.length
      ? `${existing.map(period => period.periodLabel).join(', ')} ya existe(n). ¿Reemplazar esos periodos completamente e importar ${monthlyPreview.accepted} fallas?`
      : `¿Guardar ${monthlyPreview.accepted} fallas distribuidas en ${importablePeriods.length} periodo(s)?`;
    if (!window.confirm(message)) return;
    setMonthlyBusy(true);
    setMonthlyError('');
    try {
      for (const period of importablePeriods) await onImportMonthly(period, { replace: period.periodExists });
      setMonthlyText('');
      setMonthlyPreview(null);
    } catch (error) {
      setMonthlyError(error?.message || 'No se pudo guardar el periodo.');
    } finally {
      setMonthlyBusy(false);
    }
  }

  async function removePeriod(period) {
    if (period.periodKey === UNASSIGNED_PERIOD_KEY) return;
    const compensation = compensationPeriods.find(item => item.periodKey === period.periodKey);
    if (compensation) return setMonthlyError(`El periodo tiene compensación para ${compensation.sedCount} SED. Elimínala explícitamente antes de borrar sus fallas.`);
    if (!window.confirm(`¿Eliminar solamente ${period.label}?\n\nSe eliminarán ${period.rowCount} fallas. La red y los demás meses permanecerán intactos.`)) return;
    if (periods.filter(item => item.periodKey !== UNASSIGNED_PERIOD_KEY).length <= 6 && !window.confirm('Quedarán menos de 6 meses online. ¿Continuar de todos modos?')) return;
    setMonthlyBusy(true);
    try { await onDeletePeriod(period); } catch (error) { setMonthlyError(error?.message || 'No se pudo eliminar el periodo.'); } finally { setMonthlyBusy(false); }
  }

  function previewCompensation() {
    setCompensationError('');
    setCompensationNotice('');
    try {
      const parsed = parseProjectJson(compensationText);
      if (detectCompensationImportKind(parsed) === 'circuit') {
        const circuitPreview = prepareMonthlyCircuitCompensationImport(parsed, permanentCircuits, circuitCompensationRows);
        setCompensationPreview(null);
        setCircuitCompensationText(compensationText);
        setCircuitCompensationPreview(circuitPreview);
        setCircuitCompensationError(circuitPreview.valid ? '' : 'No hay filas válidas con SED, llave, inicio, fin y compensación (mensual o bimestral).');
        setCompensationNotice(circuitPreview.valid
          ? `Formato SED–llave detectado: ${circuitPreview.accepted} filas listas en la sección siguiente.`
          : 'Formato SED–llave detectado, pero ninguna fila coincide de forma válida con la Base Principal.');
        return;
      }
      const preview = prepareMonthlyCompensationImport(parsed, Object.keys(seds || {}), compensationRows);
      setCompensationPreview(preview);
      if (!preview.valid) setCompensationError('No hay filas válidas con SED, periodo YYYY-MM y compensación.');
    } catch (error) {
      setCompensationPreview(null);
      setCompensationError(error?.message || 'No se pudo leer el JSON de compensación.');
    }
  }

  async function confirmCompensationImport() {
    if (!compensationPreview?.valid || !periodSupport) return;
    const replacing = compensationPreview.periods.some(period => period.existingConflicts > 0);
    const message = replacing
      ? `Hay ${compensationPreview.existingConflicts} registros existentes. ¿Reemplazar únicamente las SED/periodos incluidos en este JSON?`
      : `¿Guardar compensación para ${compensationPreview.accepted} combinaciones SED/periodo?`;
    if (!window.confirm(message)) return;
    setCompensationBusy(true);
    setCompensationError('');
    try {
      for (const period of compensationPreview.periods) await onImportCompensation(period, { replace: period.existingConflicts > 0 });
      setCompensationText('');
      setCompensationPreview(null);
    } catch (error) {
      setCompensationError(error?.message || 'No se pudo guardar la compensación.');
    } finally {
      setCompensationBusy(false);
    }
  }

  async function removeCompensationPeriod(period) {
    if (!window.confirm(`¿Eliminar solamente la compensación de ${formatPeriodLabel(period.periodKey)} para ${period.sedCount} SED? Las fallas no se modificarán.`)) return;
    setCompensationBusy(true);
    try { await onDeleteCompensationPeriod(period); }
    catch (error) { setCompensationError(error?.message || 'No se pudo eliminar la compensación.'); }
    finally { setCompensationBusy(false); }
  }

  function previewCircuitCompensation() {
    setCircuitCompensationError('');
    try {
      const parsed = parseProjectJson(circuitCompensationText);
      const preview = prepareMonthlyCircuitCompensationImport(parsed, permanentCircuits, circuitCompensationRows);
      setCircuitCompensationPreview(preview);
      if (!preview.valid) setCircuitCompensationError('No hay filas válidas con SED, llave, inicio, fin y compensación (mensual o bimestral).');
    } catch (error) {
      setCircuitCompensationPreview(null);
      setCircuitCompensationError(error?.message || 'No se pudo leer el JSON de compensación por llave.');
    }
  }

  async function confirmCircuitCompensationImport() {
    if (!circuitCompensationPreview?.valid || !circuitCompensationSupport) return;
    const replacing = circuitCompensationPreview.periods.some(period => period.periodExists);
    const message = replacing
      ? 'Ya existe compensación de llaves en uno o más periodos. Se actualizarán las llaves del JSON y se conservarán las demás del mismo periodo. ¿Continuar?'
      : `¿Guardar compensación para ${circuitCompensationPreview.accepted} combinaciones SED–llave/periodo?`;
    if (!window.confirm(message)) return;
    setCircuitCompensationBusy(true);
    setCircuitCompensationError('');
    try {
      for (const period of circuitCompensationPreview.periods) await onImportCircuitCompensation(period, { replace: period.periodExists });
      setCircuitCompensationText('');
      setCircuitCompensationPreview(null);
    } catch (error) {
      setCircuitCompensationError(error?.message || 'No se pudo guardar la compensación por llave.');
    } finally { setCircuitCompensationBusy(false); }
  }

  async function removeCircuitCompensationPeriod(period) {
    if (!window.confirm(`¿Eliminar solamente la compensación de llave de ${period.periodLabel} para ${period.circuitCount} llaves? La compensación SED y las fallas no se modificarán.`)) return;
    setCircuitCompensationBusy(true);
    try { await onDeleteCircuitCompensationPeriod(period); }
    catch (error) { setCircuitCompensationError(error?.message || 'No se pudo eliminar la compensación por llave.'); }
    finally { setCircuitCompensationBusy(false); }
  }

  async function saveProject() {
    setProjectError('');
    const config = createWorkProjectConfig({ name: projectName, description: projectDescription, sedIds: projectSedIds, periodKeys: selectedPeriodKeys.filter(key => key !== UNASSIGNED_PERIOD_KEY) });
    if (!config.name || config.sed_ids.length === 0 || config.period_keys.length === 0) return setProjectError('Indica nombre y selecciona al menos una SED y un periodo mensual.');
    try {
      await onSaveWorkProject(config);
      setProjectName(''); setProjectDescription(''); setProjectSedIds([]);
    } catch (error) { setProjectError(error?.message || 'No se pudo guardar el proyecto.'); }
  }

  async function openPortableConfig() {
    setProjectError('');
    try {
      const config = parseProjectJson(portableConfigText);
      const validation = validateWorkProjectConfig(config, Object.keys(seds || {}), periodKeys);
      if (!validation.valid) throw new Error(validation.errors.join(' '));
      await onOpenWorkProject(config);
      setPortableConfigText('');
    } catch (error) {
      setProjectError(error?.message || 'No se pudo abrir la definicion ligera.');
    }
  }

  async function removeLocalDataset(project) {
    if (!window.confirm(`¿Eliminar la copia local "${project.projectName}" de este navegador?`)) return;
    try {
      await onRemoveLocalProject(project.projectId);
    } catch (error) {
      setProjectError(error?.message || 'No se pudo eliminar la copia local.');
    }
  }

  return <details ref={sectionRef} className="sidebar-section" open={expanded}>
    <summary onClick={(event) => { event.preventDefault(); onSectionToggle?.(); }}><span><i className="fa-solid fa-database"></i> Gestión de datos</span><i className="fa-solid fa-chevron-down section-chevron"></i></summary>
    <div className="section-block data-management-panel">
      <div className="data-summary-grid">
        <div><span>Red permanente</span><b>{totals.seds} SED · {totals.llaves} llaves</b></div>
        <div><span>Fallas seleccionadas</span><b>{totals.fallas}</b></div>
        <div><span>Fallas online totales</span><b>{onlineFaultTotal}</b></div>
        <div><span>Meses disponibles</span><b>{periods.filter(item => item.periodKey !== UNASSIGNED_PERIOD_KEY).length}</b></div>
        <div><span>Origen</span><b>{periodSupport ? '☁ Online mensual' : 'Modo compatible'}</b></div>
        <div><span>Actualización de red</span><b>{lastNetworkUpdate}</b></div>
      </div>

      <div className="card-title"><i className="fa-solid fa-calendar-days"></i> Periodo de fallas</div>
      <div className="period-presets"><button onClick={() => applyPreset(1)}>1 mes</button><button onClick={() => applyPreset(2)}>2 meses</button><button onClick={() => applyPreset(3)}>3 meses</button><button onClick={() => applyPreset(6)}>6 meses</button></div>
      <div className="period-list">{periods.map(period => <label key={period.periodKey}><input type="checkbox" checked={selectedSet.has(period.periodKey)} onChange={() => togglePeriod(period.periodKey)} /><span>{period.label}<small>Carga: {formatLoadDate(period.createdAt)}</small></span><b>{period.rowCount}</b>{periodSupport && period.periodKey !== UNASSIGNED_PERIOD_KEY && <button type="button" onClick={(event) => { event.preventDefault(); removePeriod(period); }} title="Eliminar solo este periodo"><i className="fa-solid fa-trash-can"></i></button>}</label>)}</div>

      <div className="card-title"><i className="fa-solid fa-ranking-star"></i> Indicadores por SED</div>
      <div className="ranking-summary">{ranking.length} SED analizadas · {ranking.reduce((sum, item) => sum + item.faultCount, 0)} fallas seleccionadas</div>
      <div className="period-presets"><button onClick={() => setRankingSort('faultCount')}>Fallas</button><button onClick={() => setRankingSort('callCount')}>Llamadas</button><button onClick={() => setRankingSort('compensation')}>Compensación</button></div>
      <input className="input-control" value={rankingSearch} onChange={event => setRankingSearch(event.target.value)} placeholder="Buscar SED" />
      <div className="sed-ranking"><div className="sed-ranking-head"><span>#</span><span>SED</span><span>Fallas</span><span>Llamadas</span><span>Comp. SED</span></div>{filteredRanking.map(item => <button key={item.sedId} onClick={() => onSelectSed(item.sedId)}><span>{item.rank}</span><strong>{item.sedId}</strong><span>{item.faultCount}</span><span title={item.callDataComplete ? '' : 'Cobertura parcial'}>{item.callDataAvailable ? item.callCount : 'Sin dato'}{item.callDataAvailable && !item.callDataComplete ? '*' : ''}</span><span title={item.compensationDataComplete ? 'Compensación SED (referencia) con cobertura completa' : 'Compensación SED (referencia) con cobertura parcial'}>{item.compensationDataAvailable ? `S/ ${item.compensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}${item.compensationDataComplete ? '' : '*'}` : 'Sin dato'}</span></button>)}</div>

      <div className="card-title"><i className="fa-solid fa-paste"></i> Cargar fallas mensuales</div>
      <textarea className="input-control monthly-json-input" value={monthlyText} onChange={event => { setMonthlyText(event.target.value); setMonthlyPreview(null); }} placeholder='Pega JSON con fallas y "Hora de inicio"; los meses se detectan automáticamente' />
      <button className="btn btn-cyan" onClick={previewMonthly} disabled={!monthlyText.trim() || monthlyBusy}>Validar y previsualizar</button>
      {monthlyPreview && <div className="monthly-preview"><b>{monthlyPreview.periodLabel || 'Periodo inválido'}</b><span>Recibidas: {monthlyPreview.received}</span><span>SED reconocidas: {monthlyPreview.recognizedSeds}</span><span>Universo permanente: {monthlyPreview.accepted}</span><span>Fuera del universo: {monthlyPreview.outsideUniverse}</span><span>Duplicados: {monthlyPreview.duplicates}</span><span>Identidad ambigua: {monthlyPreview.ambiguousIdentities}</span><span>Inválidos: {monthlyPreview.invalid}</span><div className="monthly-period-groups">{(monthlyPreview.periods || []).map(period => <div key={period.periodKey}><strong>{period.periodLabel}{period.periodExists ? ' · existente' : ''}</strong><span>{period.accepted} aceptadas · {period.outsideUniverse} fuera · {period.duplicates} duplicadas · {period.invalid} inválidas</span></div>)}</div>{monthlyPreview.periodExists && <strong>Los periodos existentes requerirán reemplazo completo.</strong>}<button className="btn btn-green" onClick={confirmMonthlyImport} disabled={!monthlyPreview.valid || !periodSupport || monthlyBusy}>{periodSupport ? `Guardar ${monthlyPreview.periods?.filter(period => period.valid).length || 0} periodo(s)` : 'Requiere aplicar migración'}</button></div>}
      {monthlyError && <div className="project-validation-errors"><p>{monthlyError}</p></div>}

      <div className="card-title"><i className="fa-solid fa-coins"></i> Compensación mensual por SED (referencia)</div>
      <textarea className="input-control monthly-json-input" value={compensationText} onChange={event => { setCompensationText(event.target.value); setCompensationPreview(null); setCompensationNotice(''); }} placeholder='Pega JSON con SED y periodo; si incluye llave se detectará automáticamente' />
      <button className="btn btn-cyan" onClick={previewCompensation} disabled={!compensationText.trim() || compensationBusy}>Validar compensación</button>
      {compensationPreview && <div className="monthly-preview"><b>{compensationPreview.periodCount} periodo(s) · {compensationPreview.accepted} SED/periodo</b><span>Total: S/ {compensationPreview.totalCompensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}</span><span>Fuera del universo: {compensationPreview.outsideUniverse}</span><span>Duplicados: {compensationPreview.duplicates}</span><span>Inválidos: {compensationPreview.invalid}</span>{compensationPreview.periods.map(period => <div key={period.periodKey}><strong>{period.periodLabel}{period.existingConflicts ? ` · ${period.existingConflicts} existentes` : ''}</strong><span> · {period.accepted} SED · S/ {period.totalCompensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}</span></div>)}<button className="btn btn-green" onClick={confirmCompensationImport} disabled={!compensationPreview.valid || !periodSupport || compensationBusy}>Guardar compensación</button></div>}
      {compensationPeriods.length > 0 && <div className="work-project-list">{compensationPeriods.map(period => <div key={period.periodKey}><div><b>{formatPeriodLabel(period.periodKey)}</b><span>{period.sedCount} SED · S/ {period.totalCompensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}</span></div><button onClick={() => removeCompensationPeriod(period)} disabled={compensationBusy} title="Eliminar solo compensación"><i className="fa-solid fa-trash-can"></i></button></div>)}</div>}
      {compensationError && <div className="project-validation-errors"><p>{compensationError}</p></div>}
      {compensationNotice && <p className="project-help"><b>{compensationNotice}</b></p>}

      <div className="card-title"><i className="fa-solid fa-plug-circle-bolt"></i> Compensación mensual/bimestral por SED–llave</div>
      <p className="project-help">Compensación de llave: tiene prioridad en el análisis económico. Si falta, se usa la compensación SED como referencia, sin repartirla.</p>
      <textarea className="input-control monthly-json-input" value={circuitCompensationText} onChange={event => { setCircuitCompensationText(event.target.value); setCircuitCompensationPreview(null); }} placeholder='Pega JSON con SED, llave, inicio, fin y monto (inicio=fin para mensual)' />
      <button className="btn btn-cyan" onClick={previewCircuitCompensation} disabled={!circuitCompensationText.trim() || circuitCompensationBusy}>Validar compensación por llave</button>
      {circuitCompensationPreview && <div className="monthly-preview"><b>{circuitCompensationPreview.periodCount} periodo(s) · {circuitCompensationPreview.accepted} SED–llave/periodo</b><span>Total informativo: S/ {circuitCompensationPreview.totalCompensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}</span><span>Llaves abreviadas resueltas: {circuitCompensationPreview.aliasesResolved}</span><span>Coincidencias ambiguas: {circuitCompensationPreview.ambiguous}</span><span>Fuera del universo: {circuitCompensationPreview.outsideUniverse}</span><span>Duplicados: {circuitCompensationPreview.duplicates}</span><span>Inválidos: {circuitCompensationPreview.invalid}</span>{circuitCompensationPreview.periods.map(period => <div key={`${period.periodKey}:${period.periodEndKey}`}><strong>{period.periodLabel}{period.periodExists ? ` · periodo existente (${period.existingConflicts} coincidencias)` : ''}</strong><span> · {period.accepted} llaves · S/ {period.totalCompensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}</span></div>)}<button className="btn btn-green" onClick={confirmCircuitCompensationImport} disabled={!circuitCompensationPreview.valid || !circuitCompensationSupport || circuitCompensationBusy}>{circuitCompensationSupport ? 'Guardar compensación de llave' : 'Requiere migración de compensación por llave'}</button></div>}
      {circuitCompensationPeriods.length > 0 && <div className="work-project-list">{circuitCompensationPeriods.map(period => <div key={`${period.periodKey}:${period.periodEndKey}`}><div><b>{period.periodLabel}</b><span>{period.circuitCount} llaves · {period.sedCount} SED · S/ {period.totalCompensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}</span></div><button onClick={() => removeCircuitCompensationPeriod(period)} disabled={circuitCompensationBusy} title="Eliminar solo compensación de llave"><i className="fa-solid fa-trash-can"></i></button></div>)}</div>}
      {circuitCompensationError && <div className="project-validation-errors"><p>{circuitCompensationError}</p></div>}

      <div className="card-title"><i className="fa-solid fa-layer-group"></i> Proyectos ligeros</div>
      <input className="input-control" value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="Nombre del proyecto" />
      <textarea className="input-control" value={projectDescription} onChange={event => setProjectDescription(event.target.value)} placeholder="Descripción" />
      <div className="project-sed-selector">{ranking.map(item => <label key={item.sedId}><input type="checkbox" checked={projectSedIds.includes(item.sedId)} onChange={() => setProjectSedIds(current => current.includes(item.sedId) ? current.filter(id => id !== item.sedId) : [...current, item.sedId])} />{item.sedId}</label>)}</div>
      <button className="btn btn-green" onClick={saveProject}>Guardar selección como proyecto</button>
      {projectError && <div className="project-validation-errors"><p>{projectError}</p></div>}
      <div className="work-project-list">{workProjects.map(project => <div key={project.id}><div><b>{project.name}</b><span>{project.sed_ids.length} SED · {project.period_keys.length} meses</span></div><button onClick={async () => { try { await onOpenWorkProject(project); } catch (error) { setProjectError(error?.message || 'No se pudo abrir el proyecto.'); } }}>Abrir</button><button onClick={() => downloadConfig(project)}>Descargar</button><button onClick={() => onDeleteWorkProject(project.id)}><i className="fa-solid fa-trash-can"></i></button></div>)}</div>
      <textarea className="input-control" value={portableConfigText} onChange={event => setPortableConfigText(event.target.value)} placeholder="Pegar definición GEOPLUZ_PROJECT_CONFIG" />
      <button className="btn btn-cyan" onClick={openPortableConfig} disabled={!portableConfigText.trim()}>Abrir definición portable</button>
      <p className="project-help">Los proyectos ligeros guardan referencias a SED y meses, no duplican geometría, fallas ni resultados del analizador.</p>

      <div className="card-title"><i className="fa-solid fa-laptop"></i> Datos locales</div>
      <div className="work-project-list">{(localProjects || []).map(project => <div key={project.projectId}><div><b>💻 {project.projectName}</b><span>{project.counts?.seds || 0} SED · {project.counts?.fallas || 0} fallas · solo este navegador</span></div><button onClick={() => removeLocalDataset(project)}><i className="fa-solid fa-trash-can"></i></button></div>)}</div>
      {(localProjects || []).length === 0 && <p className="project-help">No hay datasets temporales guardados en este navegador. IndexedDB no sustituye un backup.</p>}
    </div>
  </details>;
}
