'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import FaultTable from './FaultTable';
import ProjectPanel from './ProjectPanel';
import DataManagementPanel from './DataManagementPanel';
import SearchableSedSelect from './SearchableSedSelect';
import EconomicAnalysisPanel from './EconomicAnalysisPanel';
import { CIRCUIT_STATUSES } from '@/lib/circuitAnalysis';
import { describeParetoCandidates } from '@/lib/branchIndicators';
import { sortLlaveIds, sortSedIds } from '@/lib/navigationSort';

const CABLE_COLORS = ['#e53935', '#d81b60', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#546e7a'];

function formatKilometers(meters) {
  return `${(Number(meters || 0) / 1000).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

function formatBranchMeters(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return '-';
  const fractionDigits = Math.abs(value) < 10 ? 2 : 1;
  return `${value.toLocaleString('es-PE', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })} m`;
}

export default function Sidebar({
  seds,
  faultPoints,
  filteredFaultPoints,
  analysisFaultAssignments,
  analysisCircuitFaultTotal,
  currentSedId,
  setCurrentSedId,
  currentLlaveId,
  setCurrentLlaveId,
  showFullSedView,
  onToggleFullSedView,
  currentTheme,
  setCurrentTheme,
  currentMapStyle,
  setCurrentMapStyle,
  isAddPointMode,
  setIsAddPointMode,
  isPresentationMode,
  isEditable,
  canSyncToMainDatabase,
  circuitNote,
  cableGroups,
  circuitStatus,
  circuitPhase1Analysis,
  selectedAnalysisSegmentId,
  filterByAnalysisSegment,
  isSegmentSelectionMode,
  selectedLineCount,
  selectedDistance,
  economicAnalysisInput,
  economicSimulations,
  onSaveCircuitNote,
  onSaveCircuitStatus,
  onAnalyzeCircuit,
  onSelectAnalysisSegment,
  onFilterSelectedAnalysisSegment,
  onShowAllAnalysisFaults,
  onSaveEconomicSimulation,
  onToggleSegmentSelection,
  onStartEditCableGroup,
  onCancelEditCableGroup,
  onSaveCableGroup,
  onDeleteCableGroup,
  onTogglePresentationMode,
  onImportJson,
  onImportJsonText,
  onImportExcel,
  onExportExcel,
  onExportPdf,
  onSaveToMainDatabase,
  onDeleteSed,
  onDeleteLlave,
  onEditPoint,
  onDeletePoint,
  deletingPointId,
  onRelocatePoint,
  onFlyToPoint,
  onMajorOverlayChange,
  dataSource,
  localProjects,
  onDownloadProject,
  onOpenLocalProject,
  onSwitchLocalProject,
  onRemoveLocalProject,
  onGetActiveLocalProject,
  onCheckMainDatabase,
  onDownloadMainProject,
  onStageProject,
  onDiscardStaging,
  onFinalizeProject,
  onDeleteMainProject,
  onCloseLocalProject,
  faultPeriods,
  selectedPeriodKeys,
  onChangeSelectedPeriods,
  sedFaultRanking,
  periodSupport,
  onImportMonthly,
  onDeletePeriod,
  compensationRows,
  onImportCompensation,
  onDeleteCompensationPeriod,
  workProjects,
  onSaveWorkProject,
  onOpenWorkProject,
  onDeleteWorkProject,
  onCopySedLink,
  sedLinkFeedback
}) {
  const jsonInputRef = useRef(null);
  const excelInputRef = useRef(null);
  const [showJsonPasteModal, setShowJsonPasteModal] = useState(false);
  const [pastedJsonText, setPastedJsonText] = useState('');
  const [sedsMasterDB, setSedsMasterDB] = useState({});
  const [noteDraft, setNoteDraft] = useState('');
  const [cableName, setCableName] = useState('');
  const [cableCalibre, setCableCalibre] = useState('');
  const [cableColor, setCableColor] = useState(CABLE_COLORS[1]);
  const [cableNote, setCableNote] = useState('');
  const [statusDraft, setStatusDraft] = useState('cargado');
  const [editingCableGroupId, setEditingCableGroupId] = useState(null);
  const [showEconomicAnalysis, setShowEconomicAnalysis] = useState(false);
  const [openSection, setOpenSection] = useState(null);
  const sidebarContentRef = useRef(null);
  const sectionRefs = useRef(new Map());

  const registerSection = useCallback((sectionId, node) => {
    if (node) sectionRefs.current.set(sectionId, node);
    else sectionRefs.current.delete(sectionId);
  }, []);

  const toggleSection = useCallback((sectionId) => {
    setOpenSection(current => current === sectionId ? null : sectionId);
  }, []);

  useEffect(() => {
    if (!openSection) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      const container = sidebarContentRef.current;
      const section = sectionRefs.current.get(openSection);
      if (!container || !section) return;
      const containerTop = container.getBoundingClientRect().top;
      const sectionTop = section.getBoundingClientRect().top;
      container.scrollTo({
        top: Math.max(0, container.scrollTop + sectionTop - containerTop),
        behavior: 'smooth'
      });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [openSection]);

  useEffect(() => setNoteDraft(circuitNote || ''), [circuitNote, currentSedId, currentLlaveId]);
  useEffect(() => setStatusDraft(circuitStatus || 'cargado'), [circuitStatus, currentSedId, currentLlaveId]);

  useEffect(() => {
    onMajorOverlayChange?.('paste-json', showJsonPasteModal);
    return () => onMajorOverlayChange?.('paste-json', false);
  }, [showJsonPasteModal, onMajorOverlayChange]);

  const reportFaultTableOverlay = useCallback((isOpen) => {
    onMajorOverlayChange?.('fault-table', isOpen);
  }, [onMajorOverlayChange]);

  useEffect(() => {
    setEditingCableGroupId(null);
    setCableName('');
    setCableCalibre('');
    setCableColor(CABLE_COLORS[1]);
    setCableNote('');
    setShowEconomicAnalysis(false);
  }, [currentSedId, currentLlaveId]);

  useEffect(() => {
    if (!selectedAnalysisSegmentId) setShowEconomicAnalysis(false);
  }, [selectedAnalysisSegmentId]);

  useEffect(() => {
    fetch('/seds_master_db.min.json')
      .then(res => res.ok ? res.json() : {})
      .then(data => setSedsMasterDB(data))
      .catch(err => console.warn('No se pudo cargar seds_master_db.min.json:', err));
  }, []);

  const getMasterSedInfo = (sedId) => {
    if (!sedId || !sedsMasterDB || Object.keys(sedsMasterDB).length === 0) return null;
    let master = sedsMasterDB[sedId] || 
                 sedsMasterDB[sedId.replace(/^0+/, '')] || 
                 sedsMasterDB[sedId + 'S'] || 
                 sedsMasterDB[sedId.padStart(6, '0')];
    if (!master) {
      const keys = Object.keys(sedsMasterDB);
      const foundKey = keys.find(k => k.includes(sedId) || sedId.includes(k));
      if (foundKey) master = sedsMasterDB[foundKey];
    }
    return master;
  };

  const currentMasterSed = getMasterSedInfo(currentSedId);
  const selectedAnalysisSegment = circuitPhase1Analysis?.analysisSegmentIndicators?.analysisSegments
    ?.find(segment => segment.analysisSegmentId === selectedAnalysisSegmentId) || null;
  const priorityStatus = circuitPhase1Analysis?.analysisSegmentIndicators?.priorityStatus;
  const priorityCandidates = circuitPhase1Analysis?.analysisSegmentIndicators?.priorityCandidates || [];
  const priorityCandidateIds = new Set(priorityCandidates.map(segment => segment.analysisSegmentId));
  const priorityDescriptions = new Map(describeParetoCandidates(priorityCandidates)
    .map(description => [description.branchId, description]));
  const selectedPriorityDescription = priorityDescriptions.get(selectedAnalysisSegmentId) || null;

  const handleProcessPastedJson = () => {
    if (!pastedJsonText.trim()) {
      alert('⚠️ Por favor pega el código JSON en el recuadro antes de procesar.');
      return;
    }
    onImportJsonText(pastedJsonText);
    setPastedJsonText('');
    setShowJsonPasteModal(false);
  };

  // Toggle tema oscuro
  const toggleTheme = () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setCurrentTheme(newTheme);
    if (newTheme === 'dark') {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
  };

  const handleJsonChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportJson(e.target.files);
      e.target.value = '';
    }
  };

  const handleExcelChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportExcel(e.target.files[0]);
      e.target.value = '';
    }
  };

  const sedsList = sortSedIds(Object.keys(seds || {}));
  const hasData = sedsList.length > 0;
  
  const currentLlaves = currentSedId && seds[currentSedId] && seds[currentSedId].llaves 
    ? sortLlaveIds(Object.keys(seds[currentSedId].llaves))
    : [];

  return (
    <div id="sidebar" className={`sidebar ${isPresentationMode ? 'hidden' : ''}`}>
      {/* Encabezado de Marca PLUZ */}
      <div className="header-brand">
        <div className="brand-info">
          <img src="/PLUZ.png" alt="PLUZ" style={{ height: '28px', objectFit: 'contain' }} />
          <div>
            <h1>GEOPLUZ EMERGENCIAS</h1>
            <span>Análisis Histórico de Reparaciones de SEDs</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button 
            className="theme-toggle-btn" 
            onClick={() => setCurrentMapStyle(prev => prev === 'clean' ? 'detailed' : 'clean')}
            title="Cambiar a mapa limpio sin comercios ni mercados para mayor rapidez"
          >
            <i className={`fa-solid ${currentMapStyle === 'clean' ? 'fa-layer-group' : 'fa-map-location-dot'}`}></i>
            <span>{currentMapStyle === 'clean' ? 'Mapa Limpio' : 'Mapa Detallado'}</span>
          </button>
          <button className="theme-toggle-btn" onClick={toggleTheme}>
            <i className={`fa-solid ${currentTheme === 'dark' ? 'fa-sun' : 'fa-moon'}`}></i>
            <span>{currentTheme === 'dark' ? 'Modo Claro' : 'Modo Oscuro'}</span>
          </button>
          <button className="theme-toggle-btn mode-switch-btn" onClick={onTogglePresentationMode} title="Cambiar a modo presentación">
            <i className="fa-solid fa-desktop"></i>
            <span>Presentación</span>
          </button>
        </div>
      </div>

      <div className="sidebar-content" ref={sidebarContentRef}>
        <ProjectPanel
          expanded={openSection === 'projects'}
          onSectionToggle={() => toggleSection('projects')}
          sectionRef={node => registerSection('projects', node)}
          dataSource={dataSource}
          localProjects={localProjects}
          hasData={hasData || faultPoints.length > 0}
          onDownloadProject={onDownloadProject}
          onOpenLocalProject={onOpenLocalProject}
          onSwitchLocalProject={onSwitchLocalProject}
          onRemoveLocalProject={onRemoveLocalProject}
          onGetActiveLocalProject={onGetActiveLocalProject}
          onCheckMainDatabase={onCheckMainDatabase}
          onDownloadMainProject={onDownloadMainProject}
          onStageProject={onStageProject}
          onDiscardStaging={onDiscardStaging}
          onFinalizeProject={onFinalizeProject}
          onDeleteMainProject={onDeleteMainProject}
          onCloseLocalProject={onCloseLocalProject}
          onMajorOverlayChange={onMajorOverlayChange}
        />

        <DataManagementPanel
          expanded={openSection === 'data-management'}
          onSectionToggle={() => toggleSection('data-management')}
          sectionRef={node => registerSection('data-management', node)}
          seds={seds}
          faultPoints={faultPoints}
          periods={faultPeriods}
          selectedPeriodKeys={selectedPeriodKeys}
          onChangeSelectedPeriods={onChangeSelectedPeriods}
          ranking={sedFaultRanking}
          onSelectSed={setCurrentSedId}
          periodSupport={periodSupport}
          onImportMonthly={onImportMonthly}
          onDeletePeriod={onDeletePeriod}
          compensationRows={compensationRows}
          onImportCompensation={onImportCompensation}
          onDeleteCompensationPeriod={onDeleteCompensationPeriod}
          workProjects={workProjects}
          onSaveWorkProject={onSaveWorkProject}
          onOpenWorkProject={onOpenWorkProject}
          onDeleteWorkProject={onDeleteWorkProject}
          localProjects={localProjects}
          onRemoveLocalProject={onRemoveLocalProject}
        />

        {/* Ocultos */}
        <input 
          type="file" 
          ref={jsonInputRef}
          onChange={handleJsonChange}
          accept=".json,.geojson"
          multiple
          style={{ display: 'none' }}
        />
        <input 
          type="file" 
          ref={excelInputRef}
          onChange={handleExcelChange}
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
        />

        <details ref={node => registerSection('temporary-data', node)} className="sidebar-section" open={openSection === 'temporary-data'}>
          <summary onClick={(event) => { event.preventDefault(); toggleSection('temporary-data'); }}><span><i className="fa-solid fa-file-arrow-up"></i> Datos temporales locales</span><i className="fa-solid fa-chevron-down section-chevron"></i></summary>
        <div className="section-block">
          <div className="card-title">
            <i className="fa-solid fa-layer-group"></i> Importar datos temporales
          </div>
          <div className="form-group">
            <label>Estado de Base Local Acumulada:</label>
            <div className="status-badge">
              <i className="fa-solid fa-circle-info"></i> 
              <span>{hasData ? `${sedsList.length} SED(s) acumuladas` : 'Esperando archivos JSON...'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
            <button 
              className="btn btn-green" 
              style={{ flex: 1, padding: '7px 8px', fontSize: '11px' }}
              onClick={() => jsonInputRef.current && jsonInputRef.current.click()}
              disabled={!isEditable}
              title="Subir archivo JSON desde tu explorador de archivos"
            >
              <i className="fa-solid fa-file-circle-plus"></i> Cargar JSON
            </button>
            <button 
              className="btn btn-orange" 
              style={{ flex: 1, padding: '7px 8px', fontSize: '11px' }}
              onClick={() => setShowJsonPasteModal(true)}
              disabled={!isEditable}
              title="Pegar el texto/código del JSON directamente (si los archivos están bloqueados)"
            >
              <i className="fa-solid fa-paste"></i> Pegar JSON local
            </button>
          </div>
          {hasData && (
            <button 
              className="btn btn-cyan" 
              style={{ marginTop: '8px' }}
              onClick={onSaveToMainDatabase}
              disabled={!canSyncToMainDatabase}
              title={canSyncToMainDatabase ? 'Sincroniza los cambios con la Base de Datos Principal en Supabase' : 'La copia editable local no escribe en Supabase; descárgala desde Proyectos'}
            >
              <i className={`fa-solid ${canSyncToMainDatabase ? 'fa-cloud-arrow-up' : 'fa-download'}`}></i> {canSyncToMainDatabase ? '☁️ Guardar en Base Principal (Nube)' : 'Guardar copia desde Proyectos'}
            </button>
          )}

          {/* Modal para Pegar Código JSON */}
          {showJsonPasteModal && (
            <div className="modal-backdrop active" style={{ zIndex: 10000 }}>
              <div className="point-form-modal" style={{ width: '580px' }}>
                <h3 style={{ color: 'var(--accent-cyan)', fontSize: '14px', marginBottom: '10px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>📋 Pegar Código / Texto JSON</span>
                  <span onClick={() => setShowJsonPasteModal(false)} style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>&times;</span>
                </h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                  Abre tu archivo JSON en el <b>Bloc de Notas</b> (Notepad), selecciona todo (<b>Ctrl + A</b>), copia (<b>Ctrl + C</b>) y pégalo (<b>Ctrl + V</b>) aquí:
                </p>
                <textarea
                  className="input-control"
                  style={{ width: '100%', height: '200px', fontFamily: 'monospace', fontSize: '11px', resize: 'vertical', padding: '8px' }}
                  placeholder="Pega aquí el código JSON { ... }"
                  value={pastedJsonText}
                  onChange={(e) => setPastedJsonText(e.target.value)}
                />
                <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                  <button className="btn btn-green" style={{ flex: 1 }} onClick={handleProcessPastedJson}>
                    <i className="fa-solid fa-bolt"></i> ⚡ Cargar Red desde Texto Pegado
                  </button>
                  <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setShowJsonPasteModal(false)}>
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="section-block">
          <div className="card-title">
            <i className="fa-solid fa-file-excel" style={{ color: '#2e7d32' }}></i> Cargar Excel con registros
          </div>
          <p style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Importa Excel con columnas de Ticket, Falla Real, Coordenadas y pestañas por SED-Llave.
          </p>
          <button 
            className="btn btn-orange" 
            onClick={() => excelInputRef.current && excelInputRef.current.click()}
            disabled={!isEditable}
          >
            <i className="fa-solid fa-upload"></i> Cargar Histórico Excel (.xlsx)
          </button>
        </div>
        </details>

        <details ref={node => registerSection('navigation', node)} className="sidebar-section" open={openSection === 'navigation'}>
          <summary onClick={(event) => { event.preventDefault(); toggleSection('navigation'); }}><span><i className="fa-solid fa-sitemap"></i> 2. Navegación y gestión de SEDs</span><i className="fa-solid fa-chevron-down section-chevron"></i></summary>
        <div className="section-block">
          <div className="card-title">
            <i className="fa-solid fa-location-crosshairs"></i> Selección de circuito
          </div>
          <div className="form-group">
            <label>Subestación de Distribución (SED):</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <SearchableSedSelect seds={seds} value={currentSedId || ''} onChange={setCurrentSedId} disabled={!hasData} />
              {isEditable && currentSedId && (
                <button 
                  className="btn btn-outline" 
                  title="Eliminar SED Seleccionada"
                  style={{ width: 'auto', padding: '6px 10px', color: '#ff1744', borderColor: '#ff1744' }}
                  onClick={() => onDeleteSed(currentSedId)}
                >
                  <i className="fa-solid fa-trash"></i>
                </button>
              )}
            </div>
          </div>
          <div className="form-group">
            <label>Llave de Salida (Circuito):</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select 
                className="input-control"
                style={{ flex: 1 }}
                value={currentLlaveId || ''} 
                onChange={(e) => setCurrentLlaveId(e.target.value)}
                disabled={!currentSedId}
              >
                <option value="">{currentSedId ? '-- Seleccione una Llave --' : '-- Seleccione una SED primero --'}</option>
                {currentLlaves.map(llave => (
                  <option key={llave} value={llave}>{llave}</option>
                ))}
              </select>
              {isEditable && currentSedId && currentLlaveId && (
                <button 
                  className="btn btn-outline" 
                  title="Eliminar Llave Seleccionada"
                  style={{ width: 'auto', padding: '6px 10px', color: '#ff9800', borderColor: '#ff9800' }}
                  onClick={() => onDeleteLlave(currentSedId, currentLlaveId)}
                >
                  <i className="fa-solid fa-trash-can"></i>
                </button>
              )}
            </div>
          </div>
          <button
            className="btn btn-outline"
            style={{ marginTop: '-2px', marginBottom: '8px' }}
            disabled={!currentSedId || currentLlaves.length === 0}
            onClick={onToggleFullSedView}
          >
            <i className={`fa-solid ${showFullSedView ? 'fa-map-location-dot' : 'fa-layer-group'}`}></i>{' '}
            {showFullSedView ? 'Ver solo llave' : 'Ver SED completa'}
          </button>
          {currentSedId && <button className="btn btn-outline" style={{ marginBottom: '8px' }} onClick={onCopySedLink}>
            <i className="fa-solid fa-link"></i>{' '}{sedLinkFeedback || 'Copiar enlace de SED'}
          </button>}

          {currentMasterSed && (
            <div style={{ marginTop: '10px', padding: '8px 10px', background: 'rgba(0,119,194,0.08)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11px' }}>
              <div style={{ fontWeight: 700, color: 'var(--accent-cyan)', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                <span>📋 Ficha Técnica SED Master</span>
                <span style={{ fontWeight: 600, fontSize: '10px', background: 'var(--accent-cyan)', color: '#fff', padding: '1px 6px', borderRadius: '10px' }}>
                  {currentMasterSed.sheet || 'SP'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', color: 'var(--text-main)' }}>
                <div>👥 <b>Clientes BT:</b> {currentMasterSed.cli !== undefined ? currentMasterSed.cli.toLocaleString() : 'N/A'}</div>
                <div>⚡ <b>Potencia:</b> {currentMasterSed.kva !== undefined ? `${currentMasterSed.kva} KVA` : 'N/A'} ({currentMasterSed.kv || 10} kV)</div>
                <div>🏗️ <b>Tipo:</b> {currentMasterSed.tipo_const || currentMasterSed.tipo_sed || 'Superficie'}</div>
                <div>🔌 <b>Alim.:</b> {currentMasterSed.alim || 'N/A'}</div>
                <div style={{ gridColumn: 'span 2' }}>📍 <b>Dirección:</b> {currentMasterSed.dir || 'Sin registro'} ({currentMasterSed.dist || ''})</div>
                <div style={{ gridColumn: 'span 2' }}>🏢 <b>UO:</b> {currentMasterSed.uo || 'UO COLONIAL'} {currentMasterSed.contratista ? `| ${currentMasterSed.contratista}` : ''}</div>
              </div>
            </div>
          )}
        </div>
        </details>

        <details ref={node => registerSection('circuit-analysis', node)} className="sidebar-section" open={openSection === 'circuit-analysis'}>
          <summary onClick={(event) => { event.preventDefault(); toggleSection('circuit-analysis'); }}><span><i className="fa-solid fa-chart-line"></i> 3. Análisis del circuito</span><i className="fa-solid fa-chevron-down section-chevron"></i></summary>
        <div className="section-block">
          <div className="form-group" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
            <label>Análisis automático</label>
            <button className="btn btn-cyan" disabled={!currentLlaveId} onClick={onAnalyzeCircuit}>
              <i className="fa-solid fa-chart-column"></i> Analizar circuito
            </button>
            {showFullSedView && currentLlaveId && (
              <div style={{ marginTop: '6px', fontSize: '10.5px', color: 'var(--text-muted)' }}>
                Análisis: {currentLlaveId}
              </div>
            )}
            {circuitPhase1Analysis && (
              <div style={{ marginTop: '8px', padding: '8px 9px', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '10.5px', lineHeight: 1.45 }}>
                <div style={{ fontWeight: 700, color: 'var(--accent-cyan)', marginBottom: '5px' }}>Resultado del circuito seleccionado</div>
                <div><b>Longitud total registrada:</b> {formatKilometers(circuitPhase1Analysis.registeredStoredLengthMeters ?? circuitPhase1Analysis.storedLengthMeters)}</div>
                <div><b>Longitud analizable:</b> {formatKilometers(circuitPhase1Analysis.analyzableStoredLengthMeters ?? circuitPhase1Analysis.storedLengthMeters)}</div>
                <div><b>Longitud geográfica analizable:</b> {formatKilometers(circuitPhase1Analysis.analyzableGeographicLengthMeters ?? circuitPhase1Analysis.geographicLengthMeters)}</div>
                <div><b>Segmentos físicos analíticos:</b> {circuitPhase1Analysis.physicalSegments}</div>
                <div><b>Duplicados ignorados:</b> {circuitPhase1Analysis.duplicatesIgnored}</div>
                <div><b>Calibres detectados:</b> {circuitPhase1Analysis.detectedCalibres}</div>
                <div><b>Sin calibre:</b> {circuitPhase1Analysis.segmentsWithoutCalibre}</div>

                {circuitPhase1Analysis.usageSummary && (
                  <div style={{ marginTop: '7px', paddingTop: '6px', borderTop: '1px dashed var(--border-color)' }}>
                    <div style={{ fontWeight: 700, marginBottom: '3px' }}>Uso de red</div>
                    <div>Servicio Particular: {circuitPhase1Analysis.usageSummary.serviceParticular.segmentCount} tramos / {formatBranchMeters(circuitPhase1Analysis.usageSummary.serviceParticular.storedLengthMeters)}</div>
                    <div>Cliente: {circuitPhase1Analysis.usageSummary.client.segmentCount} tramos / {formatBranchMeters(circuitPhase1Analysis.usageSummary.client.storedLengthMeters)}</div>
                    <div>Secundario: {circuitPhase1Analysis.usageSummary.secondary.segmentCount} tramos / {formatBranchMeters(circuitPhase1Analysis.usageSummary.secondary.storedLengthMeters)}</div>
                    <div>Otros/sin dato: {circuitPhase1Analysis.usageSummary.otherOrUnknown.segmentCount} tramos / {formatBranchMeters(circuitPhase1Analysis.usageSummary.otherOrUnknown.storedLengthMeters)}</div>
                    <div style={{ marginTop: '3px' }}><b>Análisis:</b> Cliente excluidos: {circuitPhase1Analysis.analysisExcludedClientSegments} · {formatBranchMeters(circuitPhase1Analysis.excludedClientStoredLengthMeters)}</div>
                  </div>
                )}

                {circuitPhase1Analysis.faultAssignment && (
                  <div style={{ marginTop: '7px', paddingTop: '6px', borderTop: '1px dashed var(--border-color)' }}>
                    <div style={{ fontWeight: 700, marginBottom: '3px' }}>Asignación de fallas</div>
                    <div>Fallas del circuito: {circuitPhase1Analysis.faultAssignment.totalFaults}</div>
                    <div>Asignadas a la red analítica: {circuitPhase1Analysis.faultAssignment.assigned}</div>
                    <div>Asignadas a tramos: {circuitPhase1Analysis.analysisSegmentIndicators?.faultsAssignedToAnalysisSegments ?? 0}</div>
                    <div>Reubicadas vía Cliente: {circuitPhase1Analysis.faultAssignment.analyticallyRelocated ?? 0}</div>
                    <div>Sin asignar por distancia: {circuitPhase1Analysis.faultAssignment.tooFarFromNetwork ?? 0}</div>
                    {(circuitPhase1Analysis.faultAssignment.ambiguousClientConnections ?? 0) > 0 && <div>Conexión Cliente ambigua: {circuitPhase1Analysis.faultAssignment.ambiguousClientConnections}</div>}
                    <div>Fallas en nodos/bifurcaciones: {circuitPhase1Analysis.faultAssignment.junctionFaults}</div>
                    <div>Sin coordenadas: {circuitPhase1Analysis.faultAssignment.missingCoordinates}</div>
                    <div>Alta confianza: {circuitPhase1Analysis.faultAssignment.highConfidence}</div>
                    <div>Requieren revisión: {circuitPhase1Analysis.faultAssignment.reviewConfidence}</div>
                    <div>Baja confianza: {circuitPhase1Analysis.faultAssignment.lowConfidence}</div>
                  </div>
                )}

                {circuitPhase1Analysis.topology && (
                  <div style={{ marginTop: '7px', paddingTop: '6px', borderTop: '1px dashed var(--border-color)' }}>
                    <div style={{ fontWeight: 700, marginBottom: '3px' }}>Topología</div>
                    <div>Nodos: {circuitPhase1Analysis.topology.nodeCount}</div>
                    <div>Bifurcaciones: {circuitPhase1Analysis.topology.bifurcationCount}</div>
                    <div>Ramas: {circuitPhase1Analysis.topology.branchCount}</div>
                    <div>Componentes: {circuitPhase1Analysis.topology.componentCount}</div>
                    <div>Edges intranodo ignorados: {circuitPhase1Analysis.topology.intraNodeEdgeCount}</div>
                    <div>Derivaciones de servicio ignoradas: {circuitPhase1Analysis.topology.terminalSpurCount} · {circuitPhase1Analysis.topology.excludedSpurLengthMeters.toLocaleString('es-PE', { maximumFractionDigits: 1 })} m</div>
                    <div>Raíz: {circuitPhase1Analysis.topology.rootStatus === 'detected' ? 'detectada' : 'no determinada'}</div>
                  </div>
                )}

                {circuitPhase1Analysis.analysisSegmentIndicators && (
                  <div style={{ marginTop: '7px', paddingTop: '6px', borderTop: '1px dashed var(--border-color)' }}>
                    <div style={{ fontWeight: 700, marginBottom: '3px' }}>Tramos de análisis</div>
                    <div>Tramos: {circuitPhase1Analysis.analysisSegmentIndicators.totalAnalysisSegments}</div>
                    <div>Tramo con más fallas: {circuitPhase1Analysis.analysisSegmentIndicators.analysisSegmentWithMostFaults || 'Sin datos'}</div>
                    <div>Mayor fallas/km: {circuitPhase1Analysis.analysisSegmentIndicators.analysisSegmentWithHighestFaultsPerKm || 'Sin datos'}</div>
                    <div>Fallas fuera de tramos: {circuitPhase1Analysis.analysisSegmentIndicators.faultsOutsideAnalysisSegments}</div>
                    <div style={{ marginTop: '5px', padding: '5px', borderRadius: '4px', background: 'rgba(249, 168, 37, 0.09)' }}>
                      <b>
                        {priorityStatus === 'single'
                          ? 'Tramo prioritario'
                          : priorityStatus === 'multiple' ? 'Tramos candidatos prioritarios' : 'Priorización no disponible'}
                      </b>
                      {priorityStatus === 'multiple' && (
                        <div style={{ marginTop: '2px', color: 'var(--text-muted)' }}>
                          Ningún tramo supera simultáneamente a los demás en número de fallas y fallas/km.
                        </div>
                      )}
                      {priorityStatus === 'insufficient_data' && (
                        <div style={{ marginTop: '2px', color: 'var(--text-muted)' }}>No hay datos suficientes para comparar tramos.</div>
                      )}
                      {priorityCandidates.map(candidate => {
                        const description = priorityDescriptions.get(candidate.analysisSegmentId);
                        return (
                        <button
                          key={candidate.analysisSegmentId}
                          type="button"
                          onClick={() => onSelectAnalysisSegment?.(candidate.analysisSegmentId)}
                          style={{
                            display: 'block',
                            width: '100%',
                            marginTop: '4px',
                            padding: '5px',
                            textAlign: 'left',
                            borderRadius: '4px',
                            border: candidate.analysisSegmentId === selectedAnalysisSegmentId ? '1px solid #d81b60' : '1px solid var(--border-color)',
                            background: candidate.analysisSegmentId === selectedAnalysisSegmentId ? 'rgba(216, 27, 96, 0.12)' : 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            fontSize: '9.5px'
                          }}
                        >
                          <b>{candidate.analysisSegmentId}</b> · {formatBranchMeters(candidate.lengthMeters)} · {candidate.faultCount} fallas · {candidate.faultsPerKm?.toFixed(2) ?? '-'} fallas/km
                          <br />
                          {candidate.faultShare.toFixed(1)}% · {candidate.calibreLabel} · high/review/low {candidate.highConfidenceFaults}/{candidate.reviewConfidenceFaults}/{candidate.lowConfidenceFaults} · {candidate.mainCause?.label || 'Sin causa'}
                          {candidate.faultsPerKmToCircuitAverage !== null && (
                            <> · {candidate.faultsPerKmToCircuitAverage.toFixed(2)}× promedio</>
                          )}
                          {description?.reasons?.length > 0 && (
                            <><br /><span style={{ fontWeight: 700, color: 'var(--accent-cyan)' }}>{description.reasons.join(' · ')}</span></>
                          )}
                          {description?.recurrentCause && (
                            <><br /><span>{description.recurrentCause}</span></>
                          )}
                        </button>
                      );})}
                    </div>
                    <div style={{ overflowX: 'auto', marginTop: '5px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9.5px' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left' }}>Tramo</th>
                            <th>Long.</th>
                            <th>Fallas</th>
                            <th>F/km</th>
                            <th>%</th>
                            <th style={{ textAlign: 'left' }}>Calibre</th>
                            <th style={{ textAlign: 'left' }}>Causa principal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {circuitPhase1Analysis.analysisSegmentIndicators.analysisSegments.map(segment => {
                            const isSelectedSegment = segment.analysisSegmentId === selectedAnalysisSegmentId;
                            return (
                            <tr
                              key={segment.analysisSegmentId}
                              onClick={() => onSelectAnalysisSegment?.(segment.analysisSegmentId)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') onSelectAnalysisSegment?.(segment.analysisSegmentId);
                              }}
                              tabIndex={0}
                              aria-selected={isSelectedSegment}
                              style={{
                                cursor: 'pointer',
                                background: isSelectedSegment ? 'rgba(216, 27, 96, 0.16)' : 'transparent',
                                outline: isSelectedSegment ? '1px solid #d81b60' : 'none'
                              }}
                            >
                              <td>
                                {segment.analysisSegmentId}
                                {priorityCandidateIds.has(segment.analysisSegmentId) && (
                                  <span style={{ marginLeft: '3px', padding: '1px 3px', borderRadius: '3px', background: '#f9a825', color: '#212121', fontSize: '8px', fontWeight: 700 }}>
                                    {priorityStatus === 'single' ? 'Prioritaria' : 'Candidata'}
                                  </span>
                                )}
                              </td>
                              <td style={{ textAlign: 'center' }}>{formatBranchMeters(segment.lengthMeters)}</td>
                              <td style={{ textAlign: 'center' }}>{segment.faultCount}</td>
                              <td style={{ textAlign: 'center' }}>{segment.faultsPerKm === null ? '-' : segment.faultsPerKm.toFixed(2)}</td>
                              <td style={{ textAlign: 'center' }}>{segment.faultShare.toFixed(1)}%</td>
                              <td>{segment.calibreLabel}</td>
                              <td>{segment.mainCause?.label || '-'}</td>
                            </tr>
                          );})}
                        </tbody>
                      </table>
                    </div>
                    {selectedAnalysisSegment && (
                      <div style={{ marginTop: '6px', padding: '6px', borderRadius: '4px', background: 'rgba(216, 27, 96, 0.08)' }}>
                        <div><b>{selectedAnalysisSegment.analysisSegmentId}</b> · {formatBranchMeters(selectedAnalysisSegment.lengthMeters)}</div>
                        <div>{selectedAnalysisSegment.faultCount} fallas · {selectedAnalysisSegment.faultsPerKm?.toFixed(2) ?? '-'} fallas/km · {selectedAnalysisSegment.faultShare.toFixed(1)}%</div>
                        <div>Calibre: {selectedAnalysisSegment.calibreLabel}</div>
                        {selectedAnalysisSegment.calibreStatus === 'mixed' && (
                          <div>
                            Desglose: {selectedAnalysisSegment.calibres
                              .map(calibre => `${calibre.label} ${formatBranchMeters(calibre.lengthMeters)}`).join(' · ')}
                          </div>
                        )}
                        <div>Confianza: {selectedAnalysisSegment.highConfidenceFaults} alta / {selectedAnalysisSegment.reviewConfidenceFaults} revisión / {selectedAnalysisSegment.lowConfidenceFaults} baja</div>
                        <div>Causa principal: {selectedAnalysisSegment.mainCause?.label || 'Sin datos'}</div>
                        {selectedPriorityDescription?.reasons?.length > 0 && (
                          <div><b>Motivo Pareto:</b> {selectedPriorityDescription.reasons.join(' · ')}</div>
                        )}
                        {selectedPriorityDescription?.recurrentCause && <div>{selectedPriorityDescription.recurrentCause}</div>}
                        <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                          <button className="btn btn-outline" style={{ padding: '4px 6px', fontSize: '9.5px' }} onClick={onFilterSelectedAnalysisSegment}>
                            Ver fallas de este tramo
                          </button>
                          <button className="btn btn-outline" style={{ padding: '4px 6px', fontSize: '9.5px' }} onClick={onShowAllAnalysisFaults}>
                            Mostrar todas
                          </button>
                        </div>
                        <button
                          className="btn btn-green"
                          type="button"
                          style={{ width: '100%', marginTop: '6px' }}
                          onClick={() => setShowEconomicAnalysis(value => !value)}
                        >
                          {showEconomicAnalysis ? 'Cerrar análisis económico' : 'Analizar económicamente'}
                        </button>
                        {showEconomicAnalysis && selectedAnalysisSegment && (
                          <EconomicAnalysisPanel
                            key={selectedAnalysisSegment.analysisSegmentId}
                            input={economicAnalysisInput}
                            canSave={isEditable}
                            storedSimulations={economicSimulations || []}
                            onSaveSnapshot={onSaveEconomicSimulation}
                          />
                        )}
                        <div style={{ marginTop: '3px', color: 'var(--text-muted)' }}>
                          Mostrando {filteredFaultPoints.length} de {analysisCircuitFaultTotal} fallas{filterByAnalysisSegment ? ' · filtro activo' : ''}.
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {circuitPhase1Analysis.lengthByCalibre.length > 0 && (
                  <div style={{ marginTop: '7px', paddingTop: '6px', borderTop: '1px dashed var(--border-color)' }}>
                    {circuitPhase1Analysis.lengthByCalibre.map(item => (
                      <div key={item.normalizedLabel} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '3px' }}>
                        <span title={`Agrupado como ${item.normalizedLabel}`}>{item.originalLabels.map(label => label.trim()).join(' / ')}</span>
                        <b style={{ whiteSpace: 'nowrap' }}>{formatKilometers(item.storedLengthMeters)}</b>
                      </div>
                    ))}
                  </div>
                )}

                <details style={{ marginTop: '7px' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Detalles y advertencias</summary>
                  <div style={{ marginTop: '5px', color: 'var(--text-muted)' }}>
                    <div>Registros originales: {circuitPhase1Analysis.originalRecords}</div>
                    <div>Segmentos físicos registrados: {circuitPhase1Analysis.registeredPhysicalSegments ?? circuitPhase1Analysis.physicalSegments}</div>
                    <div>Longitud original antes de deduplicar: {formatKilometers(circuitPhase1Analysis.originalStoredLengthMeters)}</div>
                    <div>Longitud cero o inválida: {circuitPhase1Analysis.zeroStoredLengthSegments + circuitPhase1Analysis.invalidStoredLengthSegments}</div>
                    <div>Candidatos no eléctricos: {circuitPhase1Analysis.nonElectricalCandidates}</div>
                    {circuitPhase1Analysis.warnings.length > 0 ? (
                      <ul style={{ margin: '5px 0 0', paddingLeft: '17px' }}>
                        {circuitPhase1Analysis.warnings.map(warning => <li key={warning.code}>{warning.message}</li>)}
                      </ul>
                    ) : <div style={{ marginTop: '4px' }}>Sin advertencias de calidad.</div>}
                  </div>
                </details>
              </div>
            )}
          </div>
          <div className="card-title"><i className="fa-solid fa-pen-to-square"></i> Estado y conclusiones</div>
          <div className="form-group">
            <label>Estado del circuito:</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select className="input-control" value={statusDraft} disabled={!isEditable || !currentLlaveId} onChange={(e) => setStatusDraft(e.target.value)}>
                {Object.entries(CIRCUIT_STATUSES).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
              </select>
              <button className="btn btn-cyan" style={{ width: 'auto', whiteSpace: 'nowrap' }} disabled={!isEditable || !currentLlaveId} onClick={() => onSaveCircuitStatus(statusDraft)}>Guardar estado</button>
            </div>
          </div>
          <div className="form-group">
            <label>Conclusión del análisis:</label>
            <textarea className="input-control" rows="3" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} disabled={!isEditable || !currentLlaveId} placeholder="Conclusión del análisis visible en el mapa..." />
            <button className="btn btn-cyan" style={{ marginTop: '6px' }} disabled={!isEditable || !currentLlaveId} onClick={() => onSaveCircuitNote(noteDraft.trim())}>
              <i className="fa-solid fa-floppy-disk"></i> Guardar nota del circuito
            </button>
          </div>
          <div className="form-group" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
            <label>Clasificación de cable por tramos:</label>
            <button 
              className={`btn ${isSegmentSelectionMode ? 'btn-active-mode' : 'btn-orange'}`} 
              disabled={!isEditable || !currentLlaveId}
              onClick={() => {
                if (editingCableGroupId) {
                  setEditingCableGroupId(null);
                  setCableName('');
                  setCableCalibre('');
                  setCableColor(CABLE_COLORS[1]);
                  setCableNote('');
                  onCancelEditCableGroup?.();
                } else {
                  onToggleSegmentSelection?.();
                }
              }}
            >
              <i className={`fa-solid ${editingCableGroupId ? 'fa-xmark' : 'fa-object-group'}`}></i> {isSegmentSelectionMode ? (editingCableGroupId ? 'Cancelar edición' : 'Finalizar selección') : 'Seleccionar tramos en el mapa'}
            </button>
            
            {isSegmentSelectionMode && (
              <div style={{
                marginTop: '7px',
                padding: '6px 8px',
                borderRadius: '4px',
                background: editingCableGroupId ? 'rgba(255, 171, 0, 0.12)' : 'rgba(0, 229, 255, 0.1)',
                border: `1px solid ${editingCableGroupId ? '#ffab00' : 'rgba(0, 229, 255, 0.3)'}`,
                fontSize: '11px'
              }}>
                <div style={{ fontWeight: 'bold', color: editingCableGroupId ? '#ffab00' : 'var(--accent-cyan)', marginBottom: '3px' }}>
                  <i className={editingCableGroupId ? 'fa-solid fa-pen-to-square' : 'fa-solid fa-object-group'}></i> {editingCableGroupId ? 'Editando tramo y calibre' : 'Modo Selección de Tramos'}
                </div>
                <div style={{ color: 'var(--text-muted)' }}>
                  Seleccionados: <b style={{ color: 'var(--text-primary)' }}>{selectedLineCount}</b> · Longitud: <b style={{ color: 'var(--text-primary)' }}>{selectedDistance.toFixed(0)} m</b>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  💡 Haz clic en los tramos del mapa para sumarlos o quitarlos.
                </div>
              </div>
            )}

            {(selectedLineCount > 0 || editingCableGroupId) && (
              <div style={{ display: 'grid', gap: '6px', marginTop: '8px' }}>
                <input 
                  className="input-control" 
                  value={cableCalibre} 
                  disabled={!isEditable}
                  onChange={(e) => setCableCalibre(e.target.value)} 
                  placeholder="Calibre (ej. 70 mm²)" 
                />
                <input 
                  className="input-control" 
                  value={cableName} 
                  disabled={!isEditable}
                  onChange={(e) => setCableName(e.target.value)} 
                  placeholder="Nombre opcional del grupo (ej. Troncal principal)" 
                />
                <input className="input-control" value={cableNote} disabled={!isEditable} onChange={(e) => setCableNote(e.target.value)} placeholder="Nota o anotación (ej. Rama 1)" />
                <div className="cable-color-picker" aria-label="Color de la rama">
                  {CABLE_COLORS.map(color => <button key={color} type="button" disabled={!isEditable} className={cableColor === color ? 'active' : ''} style={{ backgroundColor: color }} onClick={() => setCableColor(color)} title={`Usar color ${color}`}><i className="fa-solid fa-check"></i></button>)}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button 
                    className={`btn ${editingCableGroupId ? 'btn-orange' : 'btn-green'}`} 
                    style={{ flex: 1 }} 
                    disabled={!isEditable || selectedLineCount === 0}
                    onClick={() => {
                      onSaveCableGroup({
                        id: editingCableGroupId,
                        name: cableName.trim(),
                        calibre: cableCalibre.trim(),
                        color: cableColor,
                        note: cableNote.trim()
                      });
                      setEditingCableGroupId(null);
                      setCableName('');
                      setCableCalibre('');
                      setCableColor(CABLE_COLORS[1]);
                      setCableNote('');
                    }}
                  >
                    <i className={editingCableGroupId ? 'fa-solid fa-check' : 'fa-solid fa-floppy-disk'}></i> {editingCableGroupId ? 'Actualizar tramo' : 'Guardar tramo'}
                  </button>
                  {editingCableGroupId && (
                    <button 
                      className="btn btn-outline" 
                      style={{ width: 'auto', padding: '0 10px' }} 
                      onClick={() => {
                        setEditingCableGroupId(null);
                        setCableName('');
                        setCableCalibre('');
                        setCableColor(CABLE_COLORS[1]);
                        setCableNote('');
                        onCancelEditCableGroup?.();
                      }} 
                      title="Cancelar edición"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </div>
            )}

            {(cableGroups || []).map(group => {
              const isCurrentlyEditing = editingCableGroupId === group.id;
              return (
                <div 
                  key={group.id} 
                  style={{ 
                    display: 'flex', 
                    gap: '6px', 
                    alignItems: 'center', 
                    marginTop: '7px', 
                    fontSize: '10.5px',
                    padding: '4px 6px',
                    borderRadius: '4px',
                    background: isCurrentlyEditing ? 'rgba(255, 171, 0, 0.15)' : 'transparent',
                    border: isCurrentlyEditing ? '1px solid #ffab00' : '1px solid transparent'
                  }}
                >
                  <span style={{ width: 12, height: 12, borderRadius: 2, background: group.color, flexShrink: 0 }}></span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <b>{group.calibre || 'No informado'}</b>{group.name ? ` · ${group.name}` : ''}{group.note ? ` · ${group.note}` : ''} · {Number(group.distance || 0).toFixed(0)} m
                  </span>
                  <button 
                    className="btn btn-outline" 
                    disabled={!isEditable}
                    style={{ width: 'auto', padding: '3px 6px', color: 'var(--accent-cyan)' }} 
                    onClick={async () => {
                      if (onStartEditCableGroup) {
                        const allowed = await onStartEditCableGroup(group);
                        if (allowed) {
                          setEditingCableGroupId(group.id);
                          setCableCalibre(group.calibre || '');
                          setCableName(group.name || '');
                          setCableColor(group.color || CABLE_COLORS[1]);
                          setCableNote(group.note || '');
                        }
                      }
                    }} 
                    title="Editar este calibre y sus tramos"
                  >
                    <i className="fa-solid fa-pen-to-square"></i>
                  </button>
                  <button 
                    className="btn btn-outline" 
                    disabled={!isEditable}
                    style={{ width: 'auto', padding: '3px 6px', color: '#ff1744' }} 
                    onClick={() => {
                      if (editingCableGroupId === group.id) {
                        setEditingCableGroupId(null);
                        setCableName('');
                        setCableCalibre('');
                        setCableColor(CABLE_COLORS[1]);
                        setCableNote('');
                      }
                      onDeleteCableGroup(group.id);
                    }} 
                    title="Eliminar clasificación"
                  >
                    <i className="fa-solid fa-trash"></i>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="section-block">
          <div className="card-title">
            <i className="fa-solid fa-location-dot" style={{ color: 'var(--accent-danger)' }}></i> Registro de fallas ({filteredFaultPoints.length})
          </div>
          <button 
            className={`btn ${isAddPointMode ? 'btn-active-mode' : 'btn-cyan'}`} 
            style={{ marginBottom: '8px' }}
            onClick={() => setIsAddPointMode(!isAddPointMode)}
            disabled={!isEditable}
          >
            <i className={`fa-solid ${isAddPointMode ? 'fa-crosshairs' : 'fa-plus-node'}`}></i> 
            {isAddPointMode ? ' 📍 Haz Clic en el Mapa para Marcar Punto' : ' 📍 Marcar Punto de Falla Reparada'}
          </button>
          
          <div className="points-table-container">
            <FaultTable 
              points={filteredFaultPoints} 
              faultAssignments={analysisFaultAssignments}
              showActions={isEditable}
              onEdit={onEditPoint}
              onDelete={onDeletePoint}
              deletingPointId={deletingPointId}
              onRelocate={onRelocatePoint}
              onRowClick={onFlyToPoint}
              onOverlayChange={reportFaultTableOverlay}
            />
          </div>
        </div>
        </details>

        <details ref={node => registerSection('report-export', node)} className="sidebar-section" open={openSection === 'report-export'}>
          <summary onClick={(event) => { event.preventDefault(); toggleSection('report-export'); }}><span><i className="fa-solid fa-file-export"></i> 4. Exportar reportes</span><i className="fa-solid fa-chevron-down section-chevron"></i></summary>
        <div className="section-block">
          <div className="card-title">
            <i className="fa-solid fa-file-export" style={{ color: '#2e7d32' }}></i> Exportar reportes
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button 
              className="btn btn-green" 
              onClick={onExportExcel}
              disabled={faultPoints.length === 0}
              title="Exporta archivo .xlsx con captura del plano de circuito y tabla estructurada"
            >
              <i className="fa-solid fa-file-excel"></i> Exportar a Excel (.xlsx)
            </button>
            <button 
              className="btn" 
              onClick={onExportPdf}
              disabled={faultPoints.length === 0}
              style={{
                background: 'linear-gradient(135deg, #c0392b, #962d22)',
                color: '#ffffff',
                border: '1px solid #e74c3c',
                cursor: faultPoints.length === 0 ? 'not-allowed' : 'pointer',
                opacity: faultPoints.length === 0 ? 0.6 : 1
              }}
              title="Genera reporte formal en PDF con imagen del circuito y tabla de fallas"
            >
              <i className="fa-solid fa-file-pdf"></i> Descargar Reporte Técnico (PDF)
            </button>
          </div>
        </div>
        </details>
      </div>
    </div>
  );
}
