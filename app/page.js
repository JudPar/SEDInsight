'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import * as XLSX from 'xlsx';
import Sidebar from '@/components/Sidebar';
import FaultForm from '@/components/FaultForm';
import PresentationHUD from '@/components/PresentationHUD';
import PresentationTablePanel from '@/components/PresentationTablePanel';
import TicketConflictModal from '@/components/TicketConflictModal';
import DataSourceBadge from '@/components/DataSourceBadge';
import { sortSedIds } from '@/components/SearchableSedSelect';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { exportExcelBySed } from '@/lib/excelUtils';
import { exportPdfReport } from '@/lib/pdfUtils';
import { clearActiveLocalProject, clearExpectedLocalProject, getActiveLocalProject, getActiveLocalProjectState, getCachedSeds, getExpectedLocalProject, getLocalProject, invalidateSedsCache, listLocalProjects, markLocalProjectExpected, removeLocalProject, setActiveLocalProject, setCachedSeds } from '@/lib/dbCache';
import { buildSedOverviewLlaves, filterFaultsForCircuitView } from '@/lib/sedOverview';
import { analyzeCircuit, CIRCUIT_STATUSES, hydrateLlave, serializeLlaveLines } from '@/lib/circuitAnalysis';
import { buildAnalysisSegmentFaultView, resolveAnalysisSegment } from '@/lib/analysisSegments';
import { GEOPLUZ_PROJECT_FORMAT, parseProjectJson } from '@/lib/projectFormat';
import { createProjectDocument, projectToInternalModel } from '@/lib/projectMappers';
import { validateProject } from '@/lib/projectValidation';
import { createSupabaseProjectRepository, getMainDatabaseState } from '@/lib/projectImport';
import { createSupabaseLifecycleRepository, deleteCurrentProject, discardStaging, finalizeStagedProject, stageProject } from '@/lib/projectStaging';
import {
  COORD_SOURCE,
  coordinatePairsEqual,
  formatGeoreferenceSummary,
  georeferenceFaultBatch,
  getCoordinatePair,
  isValidCoordinatePair,
  markCoordinatesManual,
  normalizeSuministro
} from '@/lib/faultGeolocation';

// MapViewer importado dinámicamente para evitar SSR
const MapViewer = dynamic(() => import('@/components/MapViewer'), { ssr: false });

function mapSupabaseRowsToProjectState(sedsData = [], llavesData = [], fallasData = []) {
  const database = {};
  sedsData.forEach(sed => {
    database[sed.id] = {
      id: sed.id,
      name: sed.name,
      sedCoord: sed.sed_coord,
      createdAt: sed.created_at || null,
      llaves: {}
    };
  });
  llavesData.forEach(llave => {
    if (database[llave.sed_id]) database[llave.sed_id].llaves[llave.llave_code] = hydrateLlave(llave);
  });
  const faults = fallasData.map((falla, index) => ({
    id: falla.id,
    number: index + 1,
    coords: isValidCoordinatePair(falla) ? [falla.latitud, falla.longitud] : null,
    ticket: falla.ticket || '',
    horaInicio: falla.hora_inicio || '',
    zona: falla.zona || '',
    set: falla.set_alimentador ? falla.set_alimentador.split('/')[0]?.trim() : '',
    alimentador: falla.set_alimentador ? falla.set_alimentador.split('/')[1]?.trim() : '',
    setAlimentador: falla.set_alimentador || '',
    nota: falla.nota || '',
    odm: falla.odm || '',
    suministro: falla.suministro || '',
    sedLlave: falla.sed_llave || '',
    sed: falla.sed_id || '',
    llaveSistema: falla.llave_code || '',
    llaveCampo: `${falla.llave_code || ''} (Campo)`,
    falla: falla.falla_real || '',
    causa: falla.causa || '',
    linkCroquis: falla.link_croquis || '',
    fotos: falla.fotos || [],
    coordSource: falla.coord_source || null,
    coordLookupSuministro: falla.coord_lookup_suministro || null,
    createdAt: falla.created_at || null
  }));
  return { database, faults };
}

function downloadProjectFile(project) {
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeName = String(project.project.name || 'geopluz-proyecto').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  link.href = url;
  link.download = `${safeName || 'geopluz-proyecto'}.geopluz.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function Page() {
  // Estado de Datos
  const [localDatabase, setLocalDatabase] = useState({});
  const [numberedPointsList, setNumberedPointsList] = useState([]);

  // Estado de Conflictos de JSON (Centro de Control)
  const [conflictsList, setConflictsList] = useState([]);
  const [isConflictModalOpen, setIsConflictModalOpen] = useState(false);
  const [currentSourceName, setCurrentSourceName] = useState('');

  // Estado de Navegación
  const [currentSedId, setCurrentSedId] = useState('');
  const [currentLlaveId, setCurrentLlaveId] = useState('');
  const [showFullSedView, setShowFullSedView] = useState(false);

  // Estado UI
  const [currentTheme, setCurrentTheme] = useState('light');
  const [currentMapStyle, setCurrentMapStyle] = useState('clean');
  const [isAddPointMode, setIsAddPointMode] = useState(false);
  const [isPresentationMode, setIsPresentationMode] = useState(true);
  const [relocatingPointIndex, setRelocatingPointIndex] = useState(null);
  const [isSegmentSelectionMode, setIsSegmentSelectionMode] = useState(false);
  const [selectedLineIds, setSelectedLineIds] = useState([]);
  const [circuitPhase1Analysis, setCircuitPhase1Analysis] = useState(null);
  const [selectedAnalysisSegmentId, setSelectedAnalysisSegmentId] = useState(null);
  const [filterByAnalysisSegment, setFilterByAnalysisSegment] = useState(false);
  const [deletingPointId, setDeletingPointId] = useState(null);
  const [activeMajorOverlays, setActiveMajorOverlays] = useState(() => new Set());
  const [dataSource, setDataSource] = useState({ kind: 'SUPABASE', readOnly: false, projectId: 'geopluz-main', projectName: 'Base Principal GEOPLUZ' });
  const [localProjectCatalog, setLocalProjectCatalog] = useState([]);

  // Estado del Formulario
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPointIndex, setEditingPointIndex] = useState(null);

  // La copia local editable nunca sincroniza escrituras con Supabase.
  const isSupabaseSource = dataSource.kind === 'SUPABASE';
  const isLocalWorkspace = dataSource.kind === 'LOCAL_WORKSPACE';
  const isEditable = isSupabaseSource || isLocalWorkspace;
  
  const mapRef = useRef(null);

  const setMajorOverlayOpen = useCallback((overlayId, isOpen) => {
    setActiveMajorOverlays(current => {
      const alreadyOpen = current.has(overlayId);
      if (alreadyOpen === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(overlayId);
      else next.delete(overlayId);
      return next;
    });
  }, []);

  const isMajorOverlayOpen = activeMajorOverlays.size > 0;

  useEffect(() => {
    setMajorOverlayOpen('fault-form', isFormOpen);
  }, [isFormOpen, setMajorOverlayOpen]);

  useEffect(() => {
    setMajorOverlayOpen('ticket-conflicts', isConflictModalOpen);
  }, [isConflictModalOpen, setMajorOverlayOpen]);

  useEffect(() => {
    initializeData();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('dark-theme', currentTheme === 'dark');
  }, [currentTheme]);

  async function initializeData() {
    const expectedLocalProject = getExpectedLocalProject();
    const [activeLocalProject, catalog] = await Promise.all([getActiveLocalProjectState(), listLocalProjects()]);
    setLocalProjectCatalog(catalog);
    if (activeLocalProject?.project) {
      const validation = await validateProject(activeLocalProject.project);
      if (validation.valid) {
        const editable = activeLocalProject.editable || Boolean(expectedLocalProject?.editable);
        await setActiveLocalProject(activeLocalProject.project, { editable });
        setLocalProjectCatalog(await listLocalProjects());
        applyLocalProject(activeLocalProject.project, { editable });
        return;
      }
      await clearActiveLocalProject();
    }
    if (expectedLocalProject) {
      setDataSource({ kind: 'LOCAL_PROJECT', readOnly: true, projectId: expectedLocalProject.projectId, projectName: `${expectedLocalProject.projectName} (no disponible)` });
      return;
    }
    await loadSupabaseData();
  }

  // Carga de Datos desde IndexedDB Caché / Supabase
  async function loadSupabaseData({ skipCache = false } = {}) {
    // 1. Intentar cargar SEDS & Llaves desde caché IndexedDB primero para respuesta instantánea
    if (!skipCache) {
      try {
        const cachedDb = await getCachedSeds();
        if (cachedDb && Object.keys(cachedDb).length > 0) {
          setLocalDatabase(cachedDb);
        }
      } catch (cErr) {
        console.warn('Error leyendo caché IndexedDB:', cErr);
      }
    }

    if (!isSupabaseConfigured || !supabase) return;
    try {
      const { data: sedsData, error: sedsError } = await supabase.from('seds').select('*').range(0, 99999);
      const { data: llavesData } = await supabase.from('llaves').select('*').range(0, 99999);
      const { data: fallasData } = await supabase.from('fallas').select('*').range(0, 99999);
      
      if (!sedsError && sedsData) {
        const db = {};
        sedsData.forEach(sed => {
          db[sed.id] = {
            id: sed.id,
            name: sed.name,
            sedCoord: sed.sed_coord,
            createdAt: sed.created_at || null,
            llaves: {}
          };
        });
        
        if (llavesData) {
          llavesData.forEach(llave => {
            if (db[llave.sed_id]) {
              db[llave.sed_id].llaves[llave.llave_code] = hydrateLlave(llave);
            }
          });
        }
        setLocalDatabase(db);
        // Guardar la versión actualizada en IndexedDB
        setCachedSeds(db);
        
        if (fallasData) {
          const points = fallasData.map((f, i) => ({
            id: f.id,
            number: i + 1,
            coords: isValidCoordinatePair(f) ? [f.latitud, f.longitud] : null,
            ticket: f.ticket || '',
            horaInicio: f.hora_inicio || '',
            zona: f.zona || '',
            set: f.set_alimentador ? f.set_alimentador.split('/')[0]?.trim() : '',
            alimentador: f.set_alimentador ? f.set_alimentador.split('/')[1]?.trim() : '',
            setAlimentador: f.set_alimentador || '',
            nota: f.nota || '',
            odm: f.odm || '',
            suministro: f.suministro || '',
            sedLlave: f.sed_llave || '',
            sed: f.sed_id || '',
            llaveSistema: f.llave_code || '',
            llaveCampo: `${f.llave_code || ''} (Campo)`,
            falla: f.falla_real || '',
            causa: f.causa || '',
            linkCroquis: f.link_croquis || '',
            fotos: f.fotos || [],
            coordSource: f.coord_source || null,
            coordLookupSuministro: f.coord_lookup_suministro || null,
            createdAt: f.created_at || null
          }));
          setNumberedPointsList(points);
        }
        setDataSource({ kind: 'SUPABASE', readOnly: false, projectId: 'geopluz-main', projectName: 'Base Principal GEOPLUZ' });
      }
    } catch (err) {
      console.log('Supabase no disponible, usando caché local:', err.message);
    }
  }

  function applyLocalProject(project, { editable = false } = {}) {
    const model = projectToInternalModel(project);
    setLocalDatabase(model.localDatabase);
    setNumberedPointsList(model.numberedPointsList);
    setDataSource({
      kind: editable ? 'LOCAL_WORKSPACE' : 'LOCAL_PROJECT',
      readOnly: !editable,
      projectId: project.project.id,
      projectName: project.project.name,
      sourceKind: project.project.source_kind
    });
    setIsAddPointMode(false);
    setRelocatingPointIndex(null);
    setIsSegmentSelectionMode(false);
    setSelectedLineIds([]);
    setEditingPointIndex(null);
    setIsFormOpen(false);
    markLocalProjectExpected(project, { editable });
    const firstSed = Object.keys(model.localDatabase)[0] || '';
    setCurrentSedId(firstSed);
    setCurrentLlaveId(firstSed ? Object.keys(model.localDatabase[firstSed]?.llaves || {})[0] || '' : '');
  }

  async function handleOpenLocalProject(project, _validationResult, { editable = false } = {}) {
    const validation = await validateProject(project);
    if (!validation.valid) throw new Error('El proyecto dejó de ser válido antes de abrirse.');
    if (isLocalWorkspace) await persistCurrentLocalWorkspace();
    const cached = await setActiveLocalProject(project, { editable });
    applyLocalProject(project, { editable });
    setLocalProjectCatalog(await listLocalProjects());
    if (!cached) {
      alert('El proyecto se abrió localmente, pero el navegador no permitió guardarlo para futuras recargas.');
    }
  }

  async function handleGetActiveLocalProject() {
    const cached = await getActiveLocalProject();
    if (cached) return cached;
    return createProjectDocument(localDatabase, numberedPointsList, {
      projectId: dataSource.projectId,
      projectName: dataSource.projectName,
      sourceKind: dataSource.sourceKind || 'LOCAL_PROJECT'
    });
  }

  async function persistCurrentLocalWorkspace() {
    if (!isLocalWorkspace) return null;
    const project = await createProjectDocument(localDatabase, numberedPointsList, {
      projectId: dataSource.projectId,
      projectName: dataSource.projectName,
      sourceKind: dataSource.sourceKind || 'LOCAL_PROJECT'
    });
    const saved = await setActiveLocalProject(project, { editable: true });
    if (saved) {
      markLocalProjectExpected(project, { editable: true });
      setLocalProjectCatalog(await listLocalProjects());
    }
    return project;
  }

  async function handleSwitchLocalProject(projectId, { editable = true } = {}) {
    if (!projectId || (projectId === dataSource.projectId && editable === isLocalWorkspace)) return;
    if (isLocalWorkspace) await persistCurrentLocalWorkspace();
    const project = await getLocalProject(projectId);
    if (!project) throw new Error('La copia local seleccionada ya no está disponible en este navegador.');
    const validation = await validateProject(project);
    if (!validation.valid) throw new Error('La copia local seleccionada no supera la validación del proyecto.');
    const saved = await setActiveLocalProject(project, { editable });
    if (!saved) throw new Error('El navegador no pudo activar la copia local seleccionada.');
    applyLocalProject(project, { editable });
    setLocalProjectCatalog(await listLocalProjects());
  }

  async function handleRemoveLocalProject(projectId) {
    const wasActive = dataSource.projectId === projectId && !isSupabaseSource;
    if (wasActive && isLocalWorkspace) await persistCurrentLocalWorkspace();
    const removed = await removeLocalProject(projectId);
    if (!removed) throw new Error('No se pudo eliminar la copia local del navegador.');
    setLocalProjectCatalog(await listLocalProjects());
    if (wasActive) await handleCloseLocalProject({ skipPersist: true });
  }

  useEffect(() => {
    if (!isLocalWorkspace) return undefined;
    const timeoutId = window.setTimeout(async () => {
      try {
        await persistCurrentLocalWorkspace();
      } catch (error) {
        console.warn('No se pudo guardar la copia editable local:', error?.message || 'Error desconocido');
      }
    }, 350);
    return () => window.clearTimeout(timeoutId);
  }, [dataSource.projectId, dataSource.projectName, dataSource.sourceKind, isLocalWorkspace, localDatabase, numberedPointsList]);

  async function handleCheckMainDatabase() {
    if (!isSupabaseConfigured || !supabase) throw new Error('Supabase no está configurado para comprobar la Base Principal.');
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session) throw new Error('Tu sesión de Supabase no está disponible. Inicia sesión nuevamente.');
    return getMainDatabaseState(createSupabaseProjectRepository(supabase));
  }

  async function handleCloseLocalProject({ skipPersist = false } = {}) {
    if (dataSource.kind !== 'LOCAL_PROJECT' && dataSource.kind !== 'LOCAL_WORKSPACE') return;
    if (isLocalWorkspace && !skipPersist) await persistCurrentLocalWorkspace();
    await clearActiveLocalProject();
    clearExpectedLocalProject();
    setLocalDatabase({});
    setNumberedPointsList([]);
    setCurrentSedId('');
    setCurrentLlaveId('');
    setDataSource({ kind: 'SUPABASE', readOnly: false, projectId: 'geopluz-main', projectName: 'Base Principal GEOPLUZ' });
    await loadSupabaseData();
  }

  async function handleDownloadProject() {
    try {
      const project = await createProjectDocument(localDatabase, numberedPointsList, {
        projectId: dataSource.projectId,
        projectName: dataSource.projectName,
        sourceKind: dataSource.sourceKind || dataSource.kind
      });
      downloadProjectFile(project);
    } catch (error) {
      alert(`No se pudo generar el proyecto: ${error.message}`);
    }
  }

  async function requireLifecycleSession() {
    if (!isSupabaseConfigured || !supabase) throw new Error('Supabase no está configurado.');
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session?.user?.id) throw new Error('Tu sesión de Supabase expiró. Inicia sesión nuevamente.');
    return { session, repository: createSupabaseLifecycleRepository(supabase) };
  }

  async function handleDownloadMainProject() {
    const { session } = await requireLifecycleSession();
    if (!session) return;
    const [sedsResult, llavesResult, fallasResult] = await Promise.all([
      supabase.from('seds').select('*').range(0, 99999),
      supabase.from('llaves').select('*').range(0, 99999),
      supabase.from('fallas').select('*').range(0, 99999)
    ]);
    const error = sedsResult.error || llavesResult.error || fallasResult.error;
    if (error) throw new Error('No se pudo obtener un snapshot completo de la Base Principal.');
    const state = mapSupabaseRowsToProjectState(sedsResult.data, llavesResult.data, fallasResult.data);
    const project = await createProjectDocument(state.database, state.faults, {
      projectId: 'geopluz-main', projectName: 'Base Principal GEOPLUZ', sourceKind: 'SUPABASE'
    });
    downloadProjectFile(project);
  }

  async function handleStageProject(project, onProgress) {
    const validation = await validateProject(project);
    if (!validation.valid) throw new Error('El proyecto dejó de ser válido antes de cargar staging.');
    const { session, repository } = await requireLifecycleSession();
    return stageProject(repository, project, session.user.id, { onProgress });
  }

  async function handleDiscardStaging(importId) {
    const { repository } = await requireLifecycleSession();
    return discardStaging(repository, importId);
  }

  function countsAreEqual(left, right) {
    return ['seds', 'llaves', 'fallas'].every(table => left?.[table] === right?.[table]);
  }

  async function getSupplyMasterCount() {
    const { count, error } = await supabase.from('suministros_coordenadas').select('*', { count: 'exact', head: true });
    if (error || !Number.isInteger(count)) throw new Error('No se pudo verificar el maestro de suministros.');
    return count;
  }

  async function finishProjectLifecycle(result, successMessage) {
    await clearActiveLocalProject();
    clearExpectedLocalProject();
    await invalidateSedsCache();
    setLocalDatabase({});
    setNumberedPointsList([]);
    setCurrentSedId('');
    setCurrentLlaveId('');
    setDataSource({ kind: 'SUPABASE', readOnly: false, projectId: 'geopluz-main', projectName: 'Base Principal GEOPLUZ' });
    await loadSupabaseData({ skipCache: true });
    alert(`${successMessage}\n\nSED: ${result.seds}\nCircuitos: ${result.llaves}\nFallas: ${result.fallas}`);
  }

  async function handleFinalizeProject(importId, displayedCurrentCounts, replacementCounts) {
    const { repository } = await requireLifecycleSession();
    const [freshCounts, supplyBefore] = await Promise.all([
      getMainDatabaseState(createSupabaseProjectRepository(supabase)),
      getSupplyMasterCount()
    ]);
    if (!countsAreEqual(freshCounts, displayedCurrentCounts)) {
      const error = new Error('Los conteos de la Base Principal cambiaron. Revisa y confirma nuevamente.');
      error.code = 'CURRENT_COUNTS_CHANGED';
      error.counts = freshCounts;
      throw error;
    }
    const result = await finalizeStagedProject(repository, importId, freshCounts);
    const [verified, supplyAfter] = await Promise.all([
      getMainDatabaseState(createSupabaseProjectRepository(supabase)),
      getSupplyMasterCount()
    ]);
    if (!countsAreEqual(verified, replacementCounts) || supplyAfter !== supplyBefore) {
      const error = new Error('La RPC finalizó, pero la verificación remota posterior no coincide. No reintentes sin revisar la Base Principal.');
      error.code = 'POST_FINALIZATION_VERIFICATION_FAILED';
      error.finalized = true;
      error.counts = verified;
      throw error;
    }
    const wasImport = freshCounts.isEmpty || result.operation === 'import';
    await finishProjectLifecycle(result, wasImport ? 'Proyecto importado correctamente.' : 'Proyecto reemplazado correctamente.');
    return result;
  }

  async function handleDeleteMainProject(displayedCurrentCounts) {
    const { repository } = await requireLifecycleSession();
    const freshCounts = await getMainDatabaseState(createSupabaseProjectRepository(supabase));
    if (!countsAreEqual(freshCounts, displayedCurrentCounts)) {
      const error = new Error('Los conteos de la Base Principal cambiaron. Revisa y confirma nuevamente.');
      error.code = 'CURRENT_COUNTS_CHANGED';
      error.counts = freshCounts;
      throw error;
    }
    const result = await deleteCurrentProject(repository, freshCounts);
    const verified = await getMainDatabaseState(createSupabaseProjectRepository(supabase));
    if (!verified.isEmpty) throw new Error('La verificación remota indica que la Base Principal no quedó vacía.');
    await finishProjectLifecycle(result, 'Proyecto actual borrado correctamente.');
    return result;
  }

  // El matching sigue centralizado en sedUtils. La vista completa omite solo el filtro de llave.
  const selectedLlavePoints = filterFaultsForCircuitView(numberedPointsList, {
    sedId: currentSedId,
    llaveId: currentLlaveId,
    showFullSed: false
  });
  const fullSedPoints = filterFaultsForCircuitView(numberedPointsList, {
    sedId: currentSedId,
    llaveId: currentLlaveId,
    showFullSed: true
  });
  const filteredPoints = showFullSedView ? fullSedPoints : selectedLlavePoints;

  // Seleccionar SED y auto-seleccionar su primera llave
  const handleSedSelect = (sedId) => {
    setCurrentSedId(sedId);
    if (sedId && localDatabase[sedId] && localDatabase[sedId].llaves) {
      const llaves = Object.keys(localDatabase[sedId].llaves);
      if (llaves.length > 0) {
        setCurrentLlaveId(llaves[0]);
      } else {
        setCurrentLlaveId('');
      }
    } else {
      setCurrentLlaveId('');
    }
  };

  // Importación JSON
  function handleImportJson(files) {
    if (!isEditable) {
      alert('El proyecto local está en modo solo lectura. Cierra el proyecto local para cargar registros en la Base Principal.');
      return;
    }
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const rawData = parseProjectJson(evt.target.result);
          await mergeJsonData(rawData, file.name);
        } catch(err) {
          alert(`❌ Error al leer el archivo JSON "${file.name}":\n` + err.message);
        }
      };
      reader.onerror = () => {
        alert(`❌ Error de lectura en "${file.name}". Es posible que el archivo esté bloqueado por el antivirus o por otra aplicación.`);
      };
      reader.readAsText(file);
    });
  }

  async function handleImportJsonText(jsonText) {
    if (!isEditable) {
      alert('El proyecto local está en modo solo lectura. Cierra el proyecto local para cargar registros en la Base Principal.');
      return;
    }
    if (!jsonText || !jsonText.trim()) return;
    try {
      const rawData = parseProjectJson(jsonText.trim());
      await mergeJsonData(rawData, 'Texto Pegado');
    } catch(err) {
      alert('❌ Error al procesar el código JSON pegado. Verifique que el formato esté completo y sea un JSON válido.\nDetalle: ' + err.message);
    }
  }

  // Funciones auxiliares para extracción flexible de columnas/propiedades
  function getFlexibleValue(obj, possibleKeys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const k of possibleKeys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
        return obj[k];
      }
    }
    const normalizedObj = {};
    for (const key in obj) {
      const normKey = key.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
      normalizedObj[normKey] = obj[key];
    }
    for (const k of possibleKeys) {
      const normSearchKey = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedObj[normSearchKey] !== undefined && normalizedObj[normSearchKey] !== null && normalizedObj[normSearchKey] !== '') {
        return normalizedObj[normSearchKey];
      }
    }
    return '';
  }

  function extractCoordsFromRow(row) {
    let lat = parseFloat(getFlexibleValue(row, ['latitud', 'lat', 'y', 'latitud1']));
    let lng = parseFloat(getFlexibleValue(row, ['longitud', 'lng', 'long', 'x', 'longitud1']));

    if (isNaN(lat) || isNaN(lng)) {
      const rawCoords = getFlexibleValue(row, ['coords', 'coordenadas', 'gps', 'location', 'coordenada']);
      if (typeof rawCoords === 'string' && rawCoords.includes(',')) {
        const parts = rawCoords.split(',');
        if (parts.length >= 2) {
          const pLat = parseFloat(parts[0].trim());
          const pLng = parseFloat(parts[1].trim());
          if (!isNaN(pLat) && !isNaN(pLng)) {
            lat = pLat;
            lng = pLng;
          }
        }
      } else if (Array.isArray(rawCoords) && rawCoords.length >= 2 && typeof rawCoords[0] === 'number') {
        lat = rawCoords[0];
        lng = rawCoords[1];
      }
    }

    if (!isNaN(lat) && !isNaN(lng)) {
      return [lat, lng];
    }
    return null;
  }

  function prepareImportedFault(pt, fallbackTicket, fallbackSedLlave = '00007S-3SP') {
    const ticketVal = String(getFlexibleValue(pt, ['ticket', 'nro', 'incidencia', 'id', 'nroticket'])).trim();
    const sedLlaveVal = String(getFlexibleValue(pt, ['sedllave', 'sed_llave', 'circuito']) || fallbackSedLlave);
    const partes = sedLlaveVal.split('-');
    const sedVal = String(pt.sed || partes[0] || 'SED');
    const llaveSysVal = String(pt.llaveSistema || partes[1] || 'LLAVE');

    return {
      coords: pt.coords || extractCoordsFromRow(pt),
      ticket: ticketVal || fallbackTicket,
      horaInicio: String(getFlexibleValue(pt, ['horainicio', 'hora', 'fecha', 'inicio']) || new Date().toLocaleString()),
      zona: String(getFlexibleValue(pt, ['zona', 'distrito', 'area']) || 'Zona Norte'),
      set: String(getFlexibleValue(pt, ['set', 'subestacion']) || 'SET'),
      alimentador: String(getFlexibleValue(pt, ['alimentador', 'alim', 'circuito']) || 'Alim'),
      nota: String(getFlexibleValue(pt, ['nota', 'comentario', 'observacion']) || 'Falla atendida'),
      odm: String(getFlexibleValue(pt, ['odm', 'orden']) || 'ODM-000'),
      suministro: normalizeSuministro(getFlexibleValue(pt, ['suministro', 'nis'])) || '',
      sedLlave: sedLlaveVal,
      sed: sedVal,
      llaveSistema: llaveSysVal,
      llaveCampo: String(pt.llaveCampo || `${llaveSysVal} (Campo)`),
      falla: String(getFlexibleValue(pt, ['falla', 'fallareal', 'averia', 'descripcion']) || 'Averia reparada'),
      causa: String(getFlexibleValue(pt, ['causa', 'diagnostico']) || 'Deterioro'),
      linkCroquis: String(getFlexibleValue(pt, ['linkcroquis', 'croquis', 'link', 'mapa', 'url']) || ''),
      fotos: pt.fotos || [],
      coordSource: pt.coordSource || pt.coord_source || null,
      coordLookupSuministro: pt.coordLookupSuministro || pt.coord_lookup_suministro || null
    };
  }

  async function mergeJsonData(rawData, sourceName = 'Archivo') {
    if (!rawData) {
      alert(`⚠️ El contenido de ${sourceName} está vacío.`);
      return;
    }

    if (rawData.format === GEOPLUZ_PROJECT_FORMAT) {
      alert('Este archivo corresponde a un proyecto GEOPLUZ. Ábrelo desde la sección Proyecto para validarlo y visualizarlo de forma segura.');
      return;
    }

    if (!isEditable) {
      alert('El proyecto local está en modo solo lectura. No se mezclaron registros.');
      return;
    }

    let processedAny = false;

    // 1. Estructura de red (SEDs y Llaves)
    let incoming = {};
    const rootSedsObj = rawData.seds || rawData.subestaciones || rawData.red || rawData.database;

    if (rootSedsObj && typeof rootSedsObj === 'object' && !Array.isArray(rootSedsObj)) {
      incoming = rootSedsObj;
    } else if (Array.isArray(rawData)) {
      // Si es un Array, comprobar si los elementos parecen SEDs (tienen 'llaves' o 'lines' o 'sedCoord')
      const looksLikeSeds = rawData.length > 0 && (rawData[0].llaves || rawData[0].sedCoord || (rawData[0].id && !rawData[0].ticket && !rawData[0].falla));
      if (looksLikeSeds) {
        rawData.forEach(item => { if (item && item.id) incoming[item.id] = item; });
      }
    } else if (rawData.id && (rawData.llaves || rawData.sedCoord)) {
      incoming[rawData.id] = rawData;
    } else if (typeof rawData === 'object' && !Array.isArray(rawData)) {
      for (const k in rawData) {
        if (rawData[k] && typeof rawData[k] === 'object' && (rawData[k].llaves || rawData[k].sedCoord || k.endsWith('S') || k.startsWith('SED'))) {
          incoming[k] = rawData[k];
        }
      }
    }

    if (Object.keys(incoming).length > 0) {
      processedAny = true;
      setLocalDatabase(prev => {
        const updated = { ...prev };
        for (const sedId in incoming) {
          if (!updated[sedId]) {
            updated[sedId] = incoming[sedId];
          } else {
            const existingLlaves = { ...(updated[sedId].llaves || {}) };
            const newLlaves = incoming[sedId].llaves || {};
            for (const llaveId in newLlaves) {
              const existingAnalysis = existingLlaves[llaveId]?.analysis;
              existingLlaves[llaveId] = { ...newLlaves[llaveId], ...(existingAnalysis ? { analysis: existingAnalysis } : {}) };
            }
            updated[sedId] = { ...updated[sedId], llaves: existingLlaves };
          }
        }

        const sedKeys = Object.keys(updated);
        const realSedKey = sedKeys.find(k => k !== 'SED_ACTIVA' && Object.keys(updated[k]?.llaves || {}).length > 0) || sedKeys[0];

        if (realSedKey) {
          setCurrentSedId(realSedKey);
          const llaveKeys = Object.keys(updated[realSedKey]?.llaves || {});
          const realLlaveKey = llaveKeys.find(k => k !== 'CIRCUITO_ACTIVO') || llaveKeys[0];
          if (realLlaveKey) {
            setCurrentLlaveId(realLlaveKey);
          }
        }

        const realCount = sedKeys.filter(k => k !== 'SED_ACTIVA').length || sedKeys.length;

        setTimeout(() => {
          alert(`✅ ¡RED ELÉCTRICA CARGADA DESDE ${sourceName.toUpperCase()}!\n\nSe detectaron ${realCount} Subestación(es) (SEDs) con sus llaves.`);
        }, 100);

        return updated;
      });
    }

    // 2. Detección flexible de fallas/puntos en el JSON
    let incomingFallas = [];
    if (rawData.fallas && Array.isArray(rawData.fallas)) {
      incomingFallas = rawData.fallas;
    } else if (rawData.points && Array.isArray(rawData.points)) {
      incomingFallas = rawData.points;
    } else if (rawData.incidencias && Array.isArray(rawData.incidencias)) {
      incomingFallas = rawData.incidencias;
    } else if (rawData.averias && Array.isArray(rawData.averias)) {
      incomingFallas = rawData.averias;
    } else if (rawData.records && Array.isArray(rawData.records)) {
      incomingFallas = rawData.records;
    } else if (rawData.data && Array.isArray(rawData.data)) {
      incomingFallas = rawData.data;
    } else if (rawData.type === 'FeatureCollection' && Array.isArray(rawData.features)) {
      incomingFallas = rawData.features.map(f => ({
        ...(f.properties || {}),
        coords: f.geometry && f.geometry.coordinates ? [f.geometry.coordinates[1], f.geometry.coordinates[0]] : null
      }));
    } else if (Array.isArray(rawData)) {
      const first = rawData[0];
      if (first && (first.ticket || first.falla || first.falla_real || first.coords || first.latitud || first.incidencia || first.suministro)) {
        incomingFallas = rawData;
      }
    }

    let loadedFirstSed = null;

    if (incomingFallas.length > 0) {
      processedAny = true;
      let addedCount = 0;
      const detectedConflicts = [];
      const lookupCandidates = incomingFallas.map((pt, index) =>
        prepareImportedFault(pt, `TK-${Date.now()}-${index + 1}`)
      );
      const { faults: georeferencedPoints, summary } = await georeferenceFaultBatch(supabase, lookupCandidates);

      setNumberedPointsList(prev => {
        const existing = [...prev];
        const existingMap = new Map();
        existing.forEach(p => {
          if (p.ticket) {
            existingMap.set(String(p.ticket).trim().toLowerCase(), p);
          }
        });

        georeferencedPoints.forEach(pt => {
          const ticketVal = String(getFlexibleValue(pt, ['ticket', 'nro', 'incidencia', 'id', 'nroticket'])).trim();
          const ticketKey = ticketVal ? ticketVal.toLowerCase() : '';

          const coords = pt.coords || extractCoordsFromRow(pt);
          const sedLlaveVal = String(getFlexibleValue(pt, ['sedllave', 'sed_llave', 'circuito']) || '00007S-3SP');
          const partes = sedLlaveVal.split('-');
          const sedVal = String(pt.sed || (partes[0] ? partes[0] : 'SED'));
          const llaveSysVal = String(pt.llaveSistema || (partes[1] ? partes[1] : 'LLAVE'));

          if (!loadedFirstSed && sedVal) {
            loadedFirstSed = sedVal;
          }

          const preparedPoint = {
            coords: coords,
            ticket: ticketVal || `TK-${existing.length + 1}`,
            horaInicio: String(getFlexibleValue(pt, ['horainicio', 'hora', 'fecha', 'inicio']) || new Date().toLocaleString()),
            zona: String(getFlexibleValue(pt, ['zona', 'distrito', 'area']) || 'Zona Norte'),
            set: String(getFlexibleValue(pt, ['set', 'subestacion']) || 'SET'),
            alimentador: String(getFlexibleValue(pt, ['alimentador', 'alim', 'circuito']) || 'Alim'),
            nota: String(getFlexibleValue(pt, ['nota', 'comentario', 'observacion']) || 'Falla atendida'),
            odm: String(getFlexibleValue(pt, ['odm', 'orden']) || 'ODM-000'),
            suministro: String(getFlexibleValue(pt, ['suministro', 'nis']) || 'N/A'),
            sedLlave: sedLlaveVal,
            sed: sedVal,
            llaveSistema: llaveSysVal,
            llaveCampo: String(pt.llaveCampo || `${llaveSysVal} (Campo)`),
            falla: String(getFlexibleValue(pt, ['falla', 'fallareal', 'averia', 'descripcion']) || 'Avería reparada'),
            causa: String(getFlexibleValue(pt, ['causa', 'diagnostico']) || 'Deterioro'),
            linkCroquis: String(getFlexibleValue(pt, ['linkcroquis', 'croquis', 'link', 'mapa', 'url']) || ''),
            fotos: pt.fotos || [],
            coordSource: pt.coordSource || null,
            coordLookupSuministro: pt.coordLookupSuministro || null
          };

          if (ticketKey && existingMap.has(ticketKey)) {
            // Detectado duplicado para el Centro de Control
            detectedConflicts.push({
              ticketKey: ticketKey,
              existing: existingMap.get(ticketKey),
              incoming: preparedPoint
            });
          } else {
            // Nuevo registro sin conflicto
            const pointNum = existing.length + 1;
            const newPoint = { ...preparedPoint, number: pointNum };
            existing.push(newPoint);
            if (ticketKey) existingMap.set(ticketKey, newPoint);
            addedCount++;
          }
        });

        return existing;
      });

      if (loadedFirstSed) {
        setCurrentSedId(loadedFirstSed);
      }

      if (detectedConflicts.length > 0) {
        setConflictsList(detectedConflicts);
        setCurrentSourceName(sourceName);
        setIsConflictModalOpen(true);
        setTimeout(() => alert(formatGeoreferenceSummary(summary)), 100);
      } else {
        setTimeout(() => {
          alert(`✅ ¡FALLAS CARGADAS DESDE ${sourceName.toUpperCase()}!\n\n• Agregados: ${addedCount} registro(s) nuevo(s).\n\n${formatGeoreferenceSummary(summary)}`);
        }, 100);
      }
    }

    if (!processedAny) {
      const topKeys = typeof rawData === 'object' && rawData !== null ? Object.keys(rawData).slice(0, 8).join(', ') : 'Ninguna';
      alert(`⚠️ El archivo "${sourceName}" fue leído correctamente, pero su estructura no fue reconocida como Red de SEDs ni Registro de Fallas.\n\n• Claves encontradas en la raíz del JSON: [${topKeys}]\n\nSi el explorador bloquea el archivo, puede usar el botón 'Pegar JSON'.`);
    }
  }

  // Manejo de Selección de Datos (A vs B)
  const handleResolveConflicts = (decisions) => {
    let replacedCount = 0;
    let keptCount = 0;

    setNumberedPointsList(prev => {
      const updated = prev.map(pt => {
        const tKey = String(pt.ticket).trim().toLowerCase();
        const decision = decisions[tKey];
        if (!decision) return pt;

        const conflict = conflictsList.find(c => c.ticketKey === tKey);
        if (!conflict) return pt;

        if (decision === 'B') {
          replacedCount++;
          return {
            ...pt,
            ...conflict.incoming,
            number: pt.number // Preservar posición
          };
        } else {
          keptCount++;
          return pt;
        }
      });
      return updated;
    });

    setIsConflictModalOpen(false);
    setConflictsList([]);

    setTimeout(() => {
      alert(`✅ ¡SELECCIÓN APLICADA CON ÉXITO!\n\n• Conservados con el Registro Existente (Dato A): ${keptCount}\n• Reemplazados por el Nuevo del JSON (Dato B): ${replacedCount}`);
    }, 100);
  };

  // Importación Excel
  function handleImportExcel(file) {
    if (!isEditable) {
      alert('El proyecto local está en modo solo lectura. Cierra el proyecto local para importar registros.');
      return;
    }
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        let skippedPoints = 0;
        const importedBatch = [];
        const existingTickets = new Set(numberedPointsList.map(p => String(p.ticket).trim().toLowerCase()).filter(Boolean));
        let firstImportedSed = null;

        workbook.SheetNames.forEach(sheetName => {
          const worksheet = workbook.Sheets[sheetName];
          const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

          jsonRows.forEach(row => {
            const ticket = String(getFlexibleValue(row, ['ticket', 'nro', 'incidencia', 'id', 'nroticket'])).trim();
            const coords = extractCoordsFromRow(row);

            if (ticket || coords) {
              const ticketKey = ticket.toLowerCase();
              if (ticketKey && existingTickets.has(ticketKey)) {
                skippedPoints++;
                return;
              }
              if (ticketKey) existingTickets.add(ticketKey);

              const pointData = prepareImportedFault(
                row,
                `TK-${Date.now()}-${importedBatch.length + 1}`,
                sheetName || '00007S-5SP'
              );

              if (!firstImportedSed && pointData.sed) {
                firstImportedSed = pointData.sed;
              }
              importedBatch.push(pointData);
            }
          });
        });

        const { faults: georeferencedPoints, summary } = await georeferenceFaultBatch(supabase, importedBatch);
        const savedPoints = await saveFallasBatchToSupabase(georeferencedPoints);
        setNumberedPointsList(prev => [
          ...prev,
          ...savedPoints.map((point, index) => ({ ...point, number: prev.length + index + 1 }))
        ]);

        if (firstImportedSed) {
          setCurrentSedId(firstImportedSed);
        }

        let msg = `✅ EXCEL IMPORTADO:\n\n• Agregados: ${savedPoints.length} registros.\n\n${formatGeoreferenceSummary(summary)}`;
        if (skippedPoints > 0) {
          msg += `\n• Omitidos por Ticket duplicado: ${skippedPoints} registros.`;
        }
        alert(msg);
      } catch(err) {
        alert('Error al procesar Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleExportExcel() {
    const dataToExport = filteredPoints.length > 0 ? filteredPoints : numberedPointsList;
    await mapRef.current?.prepareForExport?.();
    await exportExcelBySed(dataToExport, currentSedId, currentLlaveId);
  }

  async function handleExportPdf() {
    const dataToExport = filteredPoints.length > 0 ? filteredPoints : numberedPointsList;
    await mapRef.current?.prepareForExport?.();
    await exportPdfReport(dataToExport, currentSedId, currentLlaveId, {
      status: currentAnalysis.status,
      note: currentAnalysis.note
    });
  }

  async function checkEditPermission() {
    if (!isEditable) {
      alert('Este proyecto local está en modo solo lectura. Cierra el proyecto local para volver a editar la Base Principal.');
      return false;
    }
    return true;
  }

  // Acciones en el mapa
  // Usando useCallback para que la referencia se actualice cuando cambie relocatingPointIndex,
  // lo que permite que la ref en MapViewer siempre tenga el callback más reciente.
  const handleMapClick = useCallback(async (latlng) => {
    if (!isEditable) return;
    if (relocatingPointIndex !== null) {
      const allowed = await checkEditPermission();
      if (!allowed) {
        setRelocatingPointIndex(null);
        return;
      }
      setNumberedPointsList(prev => {
        const updated = [...prev];
        const targetPoint = updated[relocatingPointIndex];
        if (targetPoint) {
          updated[relocatingPointIndex] = markCoordinatesManual(targetPoint, [latlng.lat, latlng.lng]);
          saveFallaToSupabase(updated[relocatingPointIndex]);
          alert(`✅ Punto de Falla #${targetPoint.localNumber || targetPoint.number || ''} reubicado con éxito en: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`);
        }
        return updated;
      });
      setRelocatingPointIndex(null);
      return;
    }
    
    if (!isAddPointMode || isPresentationMode) return;
    const allowed = await checkEditPermission();
    if (!allowed) return;
    
    const pointNum = numberedPointsList.length + 1;
    const newPoint = {
      number: pointNum,
      coords: [latlng.lat, latlng.lng],
      ticket: `TK-${Math.floor(Math.random()*90000+10000)}`,
      horaInicio: new Date().toLocaleString(),
      zona: 'Zona Lima Norte',
      set: 'SET San Juan',
      alimentador: 'Alim 1',
      nota: 'Empalme sustituido',
      odm: `ODM-${Math.floor(Math.random()*9000+1000)}`,
      suministro: 'Suministro',
      sedLlave: `${currentSedId}-${currentLlaveId}`,
      sed: currentSedId,
      llaveSistema: currentLlaveId,
      llaveCampo: `${currentLlaveId} (Campo)`,
      falla: 'Cable subterráneo cortado',
      causa: 'Excavación externa',
      coordSource: COORD_SOURCE.MANUAL,
      coordLookupSuministro: null
    };
    
    const updated = [...numberedPointsList, newPoint];
    setNumberedPointsList(updated);
    setEditingPointIndex(updated.length - 1);
    setIsFormOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relocatingPointIndex, isAddPointMode, isPresentationMode, numberedPointsList, currentSedId, currentLlaveId, isEditable]);

  // Guardado de Falla
  function handleSavePoint(pointData) {
    if (!isEditable) {
      setIsFormOpen(false);
      setEditingPointIndex(null);
      return;
    }
    const updated = [...numberedPointsList];
    const existingPoint = editingPointIndex !== null ? updated[editingPointIndex] : null;
    let savedPoint = {
      ...(existingPoint || {}),
      ...pointData,
      suministro: normalizeSuministro(pointData.suministro) || '',
      coordLookupSuministro: existingPoint?.coordLookupSuministro || pointData.coordLookupSuministro || null
    };
    if (!existingPoint || !coordinatePairsEqual(existingPoint, savedPoint)) {
      savedPoint = markCoordinatesManual(savedPoint, savedPoint.coords);
    }
    if (editingPointIndex !== null && updated[editingPointIndex]) {
      updated[editingPointIndex] = savedPoint;
    } else {
       // if we are inserting without editing index... but normally editingPointIndex is set
       updated.push(savedPoint);
    }
    setNumberedPointsList(updated);
    setIsFormOpen(false);
    
    saveFallaToSupabase(updated[editingPointIndex !== null ? editingPointIndex : updated.length - 1]);
    setEditingPointIndex(null);
  }

  function buildFallaRecord(point) {
    const pair = isValidCoordinatePair(point) ? getCoordinatePair(point) : [null, null];
    return {
      sed_id: point.sed,
      llave_code: point.llaveSistema,
      sed_llave: point.sedLlave,
      ticket: point.ticket,
      suministro: normalizeSuministro(point.suministro),
      falla_real: point.falla,
      causa: point.causa,
      nota: point.nota,
      odm: point.odm,
      zona: point.zona,
      set_alimentador: `${point.set || ''} / ${point.alimentador || ''}`,
      hora_inicio: point.horaInicio,
      latitud: pair[0],
      longitud: pair[1],
      link_croquis: point.linkCroquis || null,
      fotos: point.fotos || [],
      coord_source: pair[0] !== null ? (point.coordSource || null) : null,
      coord_lookup_suministro: point.coordLookupSuministro || null
    };
  }

  async function saveFallasBatchToSupabase(points) {
    if (isLocalWorkspace) return points;
    if (!isSupabaseSource) throw new Error('El proyecto local está en modo solo lectura.');
    if (!isSupabaseConfigured || !supabase) {
      throw new Error('Supabase no esta configurado. No se importaron las fallas.');
    }
    if (points.length === 0) return [];

    const savedByTicket = new Map();
    const chunkSize = 300;
    for (let index = 0; index < points.length; index += chunkSize) {
      const chunk = points.slice(index, index + chunkSize);
      const { data, error } = await supabase.from('fallas').insert(chunk.map(buildFallaRecord)).select('id, ticket');
      if (error) throw error;
      (data || []).forEach((row) => savedByTicket.set(String(row.ticket || '').trim().toLowerCase(), row.id));
    }

    return points.map((point) => ({
      ...point,
      id: savedByTicket.get(String(point.ticket || '').trim().toLowerCase()) || point.id
    }));
  }

  async function saveFallaToSupabase(point) {
    if (!isSupabaseSource) return;
    if (!isSupabaseConfigured || !supabase) return;
    try {
      const record = buildFallaRecord(point);
      
      if (point.id) {
        await supabase.from('fallas').update(record).eq('id', point.id);
      } else {
        let { data, error } = await supabase.from('fallas').upsert(record, { onConflict: 'ticket' }).select();
        if (error) {
          const res = await supabase.from('fallas').insert(record).select();
          data = res.data;
        }
        if (data && data.length > 0) {
            // Update the id of the point in state so future edits use update instead of insert
            setNumberedPointsList(prev => prev.map(p => (p.ticket && p.ticket === point.ticket) || p.number === point.number ? { ...p, id: data[0].id } : p));
        }
      }
    } catch(err) {
      console.warn('Error guardando falla en Supabase:', err.message);
    }
  }

  // Eliminar Falla
  async function handleDeletePoint(index) {
    if (!isEditable) {
      alert('El proyecto local está en modo solo lectura.');
      return;
    }
    const point = numberedPointsList[index];
    if (!point || deletingPointId !== null) return;
    if (isLocalWorkspace) {
      const label = point.ticket ? ` ${point.ticket}` : ` #${point.localNumber || point.number || ''}`;
      if (!confirm(`¿Eliminar la falla${label} de esta copia local? Supabase no se modificará.`)) return;
      setNumberedPointsList(prev => prev
        .filter((_, itemIndex) => itemIndex !== index)
        .map((item, itemIndex) => ({ ...item, number: itemIndex + 1 }))
      );
      setEditingPointIndex(null);
      setIsFormOpen(false);
      setRelocatingPointIndex(null);
      return;
    }
    if (!point.id) {
      alert('Esta falla todavía no tiene un ID persistido. Guárdala en la base principal antes de eliminarla.');
      return;
    }
    if (!isSupabaseConfigured || !supabase) {
      alert('Supabase no está configurado. La falla no fue eliminada.');
      return;
    }

    const label = point.ticket ? ` ${point.ticket}` : ` #${point.localNumber || point.number || ''}`;
    const confirmed = confirm(`¿Eliminar la falla${label}? Esta acción eliminará el registro de la base de datos.`);
    if (!confirmed) return;

    setDeletingPointId(point.id);
    try {
      const { data, error } = await supabase
        .from('fallas')
        .delete()
        .eq('id', point.id)
        .select('id');

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('Supabase no confirmó la eliminación del registro.');
      }

      setNumberedPointsList(prev => prev
        .filter(item => item.id !== point.id)
        .map((item, itemIndex) => ({ ...item, number: itemIndex + 1 }))
      );
      if (editingPointIndex === index) {
        setEditingPointIndex(null);
        setIsFormOpen(false);
      } else if (editingPointIndex !== null && editingPointIndex > index) {
        setEditingPointIndex(editingPointIndex - 1);
      }
      if (relocatingPointIndex === index) {
        setRelocatingPointIndex(null);
      } else if (relocatingPointIndex !== null && relocatingPointIndex > index) {
        setRelocatingPointIndex(relocatingPointIndex - 1);
      }
      alert('Falla eliminada correctamente.');
    } catch (error) {
      console.error('Error eliminando falla en Supabase:', {
        message: error?.message || 'Error desconocido',
        code: error?.code || null
      });
      alert('No se pudo eliminar la falla. El registro permanece visible.');
    } finally {
      setDeletingPointId(null);
    }
  }

  // Eliminar SED y Llave
  async function handleDeleteSed(sedId) {
    if (!isEditable || !sedId) return;
    if (isLocalWorkspace) {
      if (!confirm(`¿Eliminar la SED ${sedId} de esta copia local? Supabase no se modificará.`)) return;
      setLocalDatabase(prev => {
        const updated = { ...prev };
        delete updated[sedId];
        return updated;
      });
      setCurrentSedId('');
      setCurrentLlaveId('');
      return;
    }
    if (!supabase) return;
    const allowed = await checkEditPermission();
    if (!allowed) return;
    const { count, error: countError } = await supabase.from('fallas').select('*', { count: 'exact', head: true }).eq('sed_id', sedId);
    if (countError) return alert('No se pudo comprobar si existen fallas relacionadas. No se eliminó la SED.');
    const confirmed = confirm(`¿Eliminar la SED ${sedId}?\n\nSus llaves se eliminarán por la relación de base de datos.\n${count || 0} fallas tienen sed_id exacto igual a esta SED y NO serán eliminadas.\n\nNo se aplicarán heurísticas sobre sed_llave.`);
    if (!confirmed) return;
    const { data, error } = await supabase.from('seds').delete().eq('id', sedId).select('id');
    if (error || !data?.length) return alert('No se pudo eliminar la SED. No se realizaron limpiezas adicionales.');
    await invalidateSedsCache();
    setCurrentSedId('');
    setCurrentLlaveId('');
    await loadSupabaseData({ skipCache: true });
    alert('SED eliminada. Las fallas existentes se conservaron sin modificar.');
  }

  async function handleDeleteLlave(sedId, llaveCode) {
    if (!isEditable || !sedId || !llaveCode) return;
    if (isLocalWorkspace) {
      if (!confirm(`¿Eliminar el circuito ${llaveCode} de esta copia local? Supabase no se modificará.`)) return;
      setLocalDatabase(prev => {
        const sed = prev[sedId];
        if (!sed?.llaves?.[llaveCode]) return prev;
        const llaves = { ...sed.llaves };
        delete llaves[llaveCode];
        return { ...prev, [sedId]: { ...sed, llaves } };
      });
      setCurrentLlaveId('');
      return;
    }
    if (!supabase) return;
    const allowed = await checkEditPermission();
    if (!allowed) return;
    const { count, error: countError } = await supabase.from('fallas').select('*', { count: 'exact', head: true }).eq('sed_id', sedId).eq('llave_code', llaveCode);
    if (countError) return alert('No se pudo comprobar si existen fallas relacionadas. No se eliminó el circuito.');
    const confirmed = confirm(`¿Eliminar el circuito ${llaveCode} de la SED ${sedId}?\n\n${count || 0} fallas coinciden exactamente en sed_id y llave_code y NO serán eliminadas.`);
    if (!confirmed) return;
    const { data, error } = await supabase.from('llaves').delete().eq('sed_id', sedId).eq('llave_code', llaveCode).select('id');
    if (error || !data?.length) return alert('No se pudo eliminar el circuito. Las fallas permanecen intactas.');
    await invalidateSedsCache();
    setCurrentLlaveId('');
    await loadSupabaseData({ skipCache: true });
    alert('Circuito eliminado. Las fallas existentes se conservaron sin modificar.');
  }

  // Reubicación
  async function handleRelocatePoint(index) {
    const allowed = await checkEditPermission();
    if (!allowed) return;
    setRelocatingPointIndex(index);
    alert('Haz clic en el mapa en la nueva ubicación.');
  }

  async function saveSedsToSupabase(sedsToSave) {
    if (!isSupabaseSource) return;
    // Guardar en la caché local IndexedDB
    setCachedSeds(sedsToSave);

    if (!isSupabaseConfigured || !supabase) {
      console.warn('Supabase no está configurado. No se sincronizaron cambios.');
      return;
    }
    try {
      const sedsBatch = [];
      const llavesBatch = [];

      for (const sedId in sedsToSave) {
        const sed = sedsToSave[sedId];
        sedsBatch.push({
          id: sedId,
          name: sed.name || `SED ${sedId}`,
          sed_coord: sed.sedCoord || null
        });

        if (sed.llaves) {
          for (const llaveCode in sed.llaves) {
            const llave = sed.llaves[llaveCode];
            llavesBatch.push({
              sed_id: sedId,
              llave_code: llaveCode,
              name: llave.name || llaveCode,
              lines_data: serializeLlaveLines(llave)
            });
          }
        }
      }

      const CHUNK_SIZE = 500;
      for (let i = 0; i < sedsBatch.length; i += CHUNK_SIZE) {
        await supabase.from('seds').upsert(sedsBatch.slice(i, i + CHUNK_SIZE));
      }
      for (let i = 0; i < llavesBatch.length; i += CHUNK_SIZE) {
        await supabase.from('llaves').upsert(llavesBatch.slice(i, i + CHUNK_SIZE), { onConflict: 'sed_id,llave_code' });
      }
    } catch (err) {
      console.warn('Error guardando SEDs en Supabase:', err.message);
    }
  }

  async function handleSaveToMainDatabase() {
    if (!isSupabaseSource) {
      alert('La copia editable se guarda solo en este navegador. Usa "Descargar proyecto" para compartirla; Supabase no se modificará.');
      return;
    }
    const allowed = await checkEditPermission();
    if (!allowed) return;

    try {
      // 1. Guardar SEDs y Llaves en lote masivo
      await saveSedsToSupabase(localDatabase);

      // 2. Guardar Fallas en lote masivo (Bulk Upsert)
      if (numberedPointsList.length > 0) {
        if (isSupabaseConfigured && supabase) {
          // 1. Consultar a Supabase qué tickets ya existen en la BD para vincular sus IDs
          const ticketsList = numberedPointsList.map(p => p.ticket).filter(Boolean);
          let existingTicketsMap = new Map();

          if (ticketsList.length > 0) {
            const CHUNK_SIZE = 300;
            for (let i = 0; i < ticketsList.length; i += CHUNK_SIZE) {
              const chunk = ticketsList.slice(i, i + CHUNK_SIZE);
              const { data: existingRows } = await supabase
                .from('fallas')
                .select('id, ticket')
                .in('ticket', chunk);

              if (existingRows) {
                existingRows.forEach(row => {
                  if (row.ticket) {
                    existingTicketsMap.set(String(row.ticket).trim().toLowerCase(), row.id);
                  }
                });
              }
            }
          }

          // 2. Construir el lote de fallas asignando el ID de Supabase si el ticket ya existía
          const fallasBatch = numberedPointsList.map(point => {
            const tKey = point.ticket ? String(point.ticket).trim().toLowerCase() : '';
            const existingId = point.id || existingTicketsMap.get(tKey);

            const record = buildFallaRecord(point);
            if (existingId) {
              record.id = existingId;
            }
            return record;
          });

          // 3. Separar registros con ID (para UPDATE/UPSERT) y verdaderamente nuevos (para INSERT)
          const withId = fallasBatch.filter(f => f.id);
          const withoutId = fallasBatch.filter(f => !f.id);

          let allSavedData = [];

          // Actualizar existentes en Supabase
          if (withId.length > 0) {
            const { data: updatedData, error: errUpdate } = await supabase
              .from('fallas')
              .upsert(withId)
              .select();
            if (errUpdate) throw errUpdate;
            if (updatedData) allSavedData = allSavedData.concat(updatedData);
          }

          // Insertar verdaderamente nuevos en Supabase
          if (withoutId.length > 0) {
            const { data: insertedData, error: errInsert } = await supabase
              .from('fallas')
              .insert(withoutId)
              .select();
            if (errInsert) throw errInsert;
            if (insertedData) allSavedData = allSavedData.concat(insertedData);
          }

          // 4. Mapear los IDs asignados por Supabase de vuelta a numberedPointsList
          if (allSavedData.length > 0) {
            const idMap = new Map(allSavedData.map(d => [String(d.ticket).trim().toLowerCase(), d.id]));
            setNumberedPointsList(prev => prev.map(p => {
              const key = String(p.ticket).trim().toLowerCase();
              return idMap.has(key) ? { ...p, id: idMap.get(key) } : p;
            }));
          }
        } else {
          throw new Error('Supabase no está configurado. No se sincronizaron fallas.');
        }
      }
      alert('✅ ¡Datos sincronizados exitosamente con la Base de Datos Principal en la Nube!');
    } catch (err) {
      alert('❌ Error al guardar en la Base Principal: ' + err.message);
    }
  }

  async function handleSedDragEnd(sedId, latlng) {
    const allowed = await checkEditPermission();
    if (!allowed) return;
    const updated = { ...localDatabase };
    if (updated[sedId]) {
      updated[sedId].sedCoord = [latlng.lat, latlng.lng];
      setLocalDatabase(updated);
      saveSedsToSupabase({ [sedId]: updated[sedId] });
    }
  }

  function handleFlyToPoint(point) {
    if (mapRef.current && point.coords) {
      mapRef.current.focusFailure(point);
    }
  }

  // Navegación
  const sedsList = sortSedIds(Object.keys(localDatabase));
  function navigateSed(dir) {
    if (sedsList.length === 0) return;
    const currentIndex = sedsList.indexOf(currentSedId);
    let newIndex = currentIndex + dir;
    if (newIndex < 0) newIndex = sedsList.length - 1;
    if (newIndex >= sedsList.length) newIndex = 0;
    setCurrentSedId(sedsList[newIndex]);
    
    // Select first llave of the new SED
    const llaves = Object.keys(localDatabase[sedsList[newIndex]].llaves || {});
    if (llaves.length > 0) {
      setCurrentLlaveId(llaves[0]);
    } else {
      setCurrentLlaveId('');
    }
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (isPresentationMode) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') navigateSed(1);
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') navigateSed(-1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPresentationMode, currentSedId, localDatabase]);

  useEffect(() => {
    setIsSegmentSelectionMode(false);
    setSelectedLineIds([]);
    setCircuitPhase1Analysis(null);
    setSelectedAnalysisSegmentId(null);
    setFilterByAnalysisSegment(false);
  }, [currentSedId, currentLlaveId]);

  const currentLlaveData = currentSedId && currentLlaveId && localDatabase[currentSedId]?.llaves?.[currentLlaveId]
    ? localDatabase[currentSedId].llaves[currentLlaveId]
    : null;

  const currentSedCoord = localDatabase[currentSedId]?.sedCoord || null;

  const currentAnalysis = currentLlaveData?.analysis || { note: '', cableGroups: [], status: 'cargado' };
  const selectedAnalysisSegment = resolveAnalysisSegment(circuitPhase1Analysis?.analysisSegmentIndicators, selectedAnalysisSegmentId);
  const analysisSegmentFaultView = buildAnalysisSegmentFaultView(
    selectedLlavePoints,
    circuitPhase1Analysis?.faultAssignment,
    selectedAnalysisSegment,
    filterByAnalysisSegment
  );
  const visibleFaultPoints = showFullSedView ? fullSedPoints : analysisSegmentFaultView.faults;
  const sedOverviewLlaves = buildSedOverviewLlaves(localDatabase[currentSedId], currentLlaveId);
  const selectedAnalysisSegmentEdges = selectedAnalysisSegment
    ? [...selectedAnalysisSegment.edgeIds, ...selectedAnalysisSegment.connectorEdgeIds]
      .map(edgeId => circuitPhase1Analysis?.topology?.originalEdges?.find(edge => edge.edgeId === edgeId))
      .filter(Boolean)
    : [];
  const circuitEntries = Object.entries(localDatabase).flatMap(([sedId, sed]) => Object.entries(sed.llaves || {}).map(([llaveId, llave]) => ({
    sedId, llaveId, sedName: sed.name || sedId, status: llave.analysis?.status || 'cargado'
  })));
  const selectedDistance = (currentLlaveData?.lines || [])
    .filter((line, index) => selectedLineIds.includes(String(line.id ?? index)))
    .reduce((total, line) => total + (Number(line.length) || 0), 0);

  function handleAnalyzeCurrentCircuit() {
    if (!currentLlaveData) return;
    const linesData = Array.isArray(currentLlaveData.linesData)
      ? currentLlaveData.linesData
      : serializeLlaveLines(currentLlaveData);
    const nextAnalysis = analyzeCircuit(linesData, selectedLlavePoints, { rootCoordinate: currentSedCoord });
    const nextSelectedSegment = resolveAnalysisSegment(nextAnalysis.analysisSegmentIndicators, selectedAnalysisSegmentId);
    setCircuitPhase1Analysis(nextAnalysis);
    setSelectedAnalysisSegmentId(nextSelectedSegment?.analysisSegmentId || null);
    if (!nextSelectedSegment) setFilterByAnalysisSegment(false);
  }

  function handleSelectAnalysisSegment(analysisSegmentId) {
    if (analysisSegmentId === selectedAnalysisSegmentId) {
      setSelectedAnalysisSegmentId(null);
      setFilterByAnalysisSegment(false);
      return;
    }
    setSelectedAnalysisSegmentId(analysisSegmentId);
  }

  function updateCurrentLlaveAnalysis(updater) {
    if (!isEditable) return;
    if (!currentSedId || !currentLlaveId) return;
    setCircuitPhase1Analysis(null);
    setLocalDatabase(prev => {
      const llave = prev[currentSedId]?.llaves?.[currentLlaveId];
      if (!llave) return prev;
      const analysis = updater(llave.analysis || { note: '', cableGroups: [] });
      const updatedLlave = { ...llave, analysis, linesData: null };
      updatedLlave.linesData = serializeLlaveLines(updatedLlave);
      const updated = { ...prev, [currentSedId]: { ...prev[currentSedId], llaves: { ...prev[currentSedId].llaves, [currentLlaveId]: updatedLlave } } };
      if (isSupabaseSource) setCachedSeds(updated);
      saveSedsToSupabase({ [currentSedId]: updated[currentSedId] });
      return updated;
    });
  }

  async function handleSaveCircuitNote(note) {
    const allowed = await checkEditPermission();
    if (!allowed) return;
    updateCurrentLlaveAnalysis(analysis => ({ ...analysis, note }));
  }

  async function handleSaveCircuitStatus(status) {
    const allowed = await checkEditPermission();
    if (!allowed) return;
    if (!CIRCUIT_STATUSES[status]) return;
    updateCurrentLlaveAnalysis(analysis => ({ ...analysis, status }));
  }

  function handleLineClick(lineId) {
    if (!isSegmentSelectionMode) return;
    setSelectedLineIds(prev => prev.includes(String(lineId)) ? prev.filter(id => id !== String(lineId)) : [...prev, String(lineId)]);
  }

  async function handleToggleSegmentSelection() {
    if (!isSegmentSelectionMode) {
      const allowed = await checkEditPermission();
      if (!allowed) return;
      setIsSegmentSelectionMode(true);
      setSelectedLineIds([]);
    } else {
      setIsSegmentSelectionMode(false);
      setSelectedLineIds([]);
    }
  }

  async function handleStartEditCableGroup(group) {
    const allowed = await checkEditPermission();
    if (!allowed) return false;
    setSelectedLineIds(group.lineIds ? group.lineIds.map(String) : []);
    setIsSegmentSelectionMode(true);
    return true;
  }

  function handleCancelEditCableGroup() {
    setSelectedLineIds([]);
    setIsSegmentSelectionMode(false);
  }

  async function handleSaveCableGroup({ id, name, calibre, color, note }) {
    const allowed = await checkEditPermission();
    if (!allowed) return;
    if (!selectedLineIds.length) return;

    const groupId = id || `cable-${Date.now()}`;
    const group = {
      id: groupId,
      name: name || 'Tramo sin nombre',
      calibre,
      color,
      note: note || '',
      lineIds: selectedLineIds,
      distance: selectedDistance
    };

    updateCurrentLlaveAnalysis(analysis => {
      const existingGroups = analysis.cableGroups || [];
      const cleanedGroups = existingGroups
        .filter(item => item.id !== groupId)
        .map(item => ({
          ...item,
          lineIds: item.lineIds ? item.lineIds.filter(lid => !selectedLineIds.includes(String(lid))) : []
        }))
        .filter(item => item.lineIds && item.lineIds.length > 0);

      return {
        ...analysis,
        cableGroups: [...cleanedGroups, group]
      };
    });

    setSelectedLineIds([]);
    setIsSegmentSelectionMode(false);
  }

  async function handleDeleteCableGroup(groupId) {
    const allowed = await checkEditPermission();
    if (!allowed) return;
    if (!confirm('¿Eliminar esta clasificación de calibre?')) return;
    updateCurrentLlaveAnalysis(analysis => ({
      ...analysis,
      cableGroups: (analysis.cableGroups || []).filter(group => group.id !== groupId)
    }));
  }

  async function handleEnterEditMode() {
    const allowed = await checkEditPermission();
    if (allowed) {
      setIsPresentationMode(false);
    }
  }

  return (
    <>
      <DataSourceBadge dataSource={dataSource} onCloseLocalProject={handleCloseLocalProject} />
      {!isPresentationMode && (
        <Sidebar
          seds={localDatabase}
          faultPoints={numberedPointsList}
          filteredFaultPoints={visibleFaultPoints}
          analysisFaultAssignments={analysisSegmentFaultView.assignments}
          analysisCircuitFaultTotal={selectedLlavePoints.length}
          currentSedId={currentSedId}
          setCurrentSedId={handleSedSelect}
          currentLlaveId={currentLlaveId}
          setCurrentLlaveId={setCurrentLlaveId}
          showFullSedView={showFullSedView}
          onToggleFullSedView={() => setShowFullSedView(value => !value)}
          currentTheme={currentTheme}
          setCurrentTheme={setCurrentTheme}
          currentMapStyle={currentMapStyle}
          setCurrentMapStyle={setCurrentMapStyle}
          isAddPointMode={isAddPointMode}
          setIsAddPointMode={setIsAddPointMode}
          isPresentationMode={isPresentationMode}
          isEditable={isEditable}
          canSyncToMainDatabase={isSupabaseSource}
          circuitNote={currentAnalysis.note}
          cableGroups={currentAnalysis.cableGroups || []}
          circuitStatus={currentAnalysis.status}
          circuitPhase1Analysis={circuitPhase1Analysis}
          selectedAnalysisSegmentId={selectedAnalysisSegmentId}
          filterByAnalysisSegment={filterByAnalysisSegment}
          isSegmentSelectionMode={isSegmentSelectionMode}
          selectedLineCount={selectedLineIds.length}
          selectedDistance={selectedDistance}
          onSaveCircuitNote={handleSaveCircuitNote}
          onSaveCircuitStatus={handleSaveCircuitStatus}
          onAnalyzeCircuit={handleAnalyzeCurrentCircuit}
          onSelectAnalysisSegment={handleSelectAnalysisSegment}
          onFilterSelectedAnalysisSegment={() => { if (selectedAnalysisSegment) setFilterByAnalysisSegment(true); }}
          onShowAllAnalysisFaults={() => setFilterByAnalysisSegment(false)}
          onToggleSegmentSelection={handleToggleSegmentSelection}
          onStartEditCableGroup={handleStartEditCableGroup}
          onCancelEditCableGroup={handleCancelEditCableGroup}
          onSaveCableGroup={handleSaveCableGroup}
          onDeleteCableGroup={handleDeleteCableGroup}
          onTogglePresentationMode={() => setIsPresentationMode(true)}
          onImportJson={handleImportJson}
          onImportJsonText={handleImportJsonText}
          onImportExcel={handleImportExcel}
          onExportExcel={handleExportExcel}
          onExportPdf={handleExportPdf}
          onSaveToMainDatabase={handleSaveToMainDatabase}
          onDeleteSed={handleDeleteSed}
          onDeleteLlave={handleDeleteLlave}
          onEditPoint={(idx) => { if (isEditable) { setEditingPointIndex(idx); setIsFormOpen(true); } }}
          onDeletePoint={handleDeletePoint}
          deletingPointId={deletingPointId}
          onRelocatePoint={handleRelocatePoint}
          onFlyToPoint={(point) => mapRef.current?.focusFailure?.(point)}
          onMajorOverlayChange={setMajorOverlayOpen}
          dataSource={dataSource}
          localProjects={localProjectCatalog}
          onDownloadProject={handleDownloadProject}
          onOpenLocalProject={handleOpenLocalProject}
          onSwitchLocalProject={handleSwitchLocalProject}
          onRemoveLocalProject={handleRemoveLocalProject}
          onGetActiveLocalProject={handleGetActiveLocalProject}
          onCheckMainDatabase={handleCheckMainDatabase}
          onDownloadMainProject={handleDownloadMainProject}
          onStageProject={handleStageProject}
          onDiscardStaging={handleDiscardStaging}
          onFinalizeProject={handleFinalizeProject}
          onDeleteMainProject={handleDeleteMainProject}
          onCloseLocalProject={handleCloseLocalProject}
        />
      )}
      
      <div className="map-container">
        <MapViewer
          ref={mapRef}
          currentTheme={currentTheme}
          currentMapStyle={currentMapStyle}
          circuitId={`${currentSedId}:${showFullSedView ? 'SED_COMPLETA' : currentLlaveId}`}
          llaveData={currentLlaveData}
          sedOverviewLlaves={sedOverviewLlaves}
          showFullSedView={showFullSedView}
          selectedLlaveId={currentLlaveId}
          sedId={currentSedId}
          sedCoord={currentSedCoord}
          faultPoints={visibleFaultPoints}
          isAddPointMode={isAddPointMode}
          isRelocating={relocatingPointIndex !== null}
          isPresentationMode={isPresentationMode}
          isEditable={isEditable}
          circuitNote={currentAnalysis.note}
          cableGroups={currentAnalysis.cableGroups || []}
          isSegmentSelectionMode={isSegmentSelectionMode}
          selectedLineIds={selectedLineIds}
          selectedAnalysisSegmentId={selectedAnalysisSegmentId}
          selectedAnalysisSegmentEdges={selectedAnalysisSegmentEdges}
          hasSelectedAnalysisSegment={Boolean(selectedAnalysisSegment)}
          onLineClick={handleLineClick}
          onMapClick={handleMapClick}
          onSedDragEnd={handleSedDragEnd}
          onPointClick={(idx) => { setEditingPointIndex(idx); setIsFormOpen(true); }}
          hideOverlays={isMajorOverlayOpen}
        />
      </div>
      
      {isPresentationMode && (
        <>
          <PresentationHUD
            sedId={currentSedId}
            sedName={localDatabase[currentSedId]?.name || currentSedId || 'Sin SED'}
            llaveName={currentLlaveId || ''}
            sedsList={sedsList}
            localDatabase={localDatabase}
            circuitEntries={circuitEntries}
            circuitStatus={currentAnalysis.status}
            onSelectSed={handleSedSelect}
            onSelectLlave={(llaveId) => setCurrentLlaveId(llaveId)}
            onSelectCircuit={(sedId, llaveId) => { setCurrentSedId(sedId); setCurrentLlaveId(llaveId); }}
            currentMapStyle={currentMapStyle}
            currentTheme={currentTheme}
            onPrevSed={() => navigateSed(-1)}
            onNextSed={() => navigateSed(1)}
            onToggleMapStyle={() => setCurrentMapStyle(s => s === 'clean' ? 'detailed' : 'clean')}
            onToggleTheme={() => setCurrentTheme(theme => theme === 'light' ? 'dark' : 'light')}
            onEnterEditMode={handleEnterEditMode}
          />
          <PresentationTablePanel
            points={analysisSegmentFaultView.faults}
            onRowClick={handleFlyToPoint}
            onExportExcel={handleExportExcel}
            onExportPdf={handleExportPdf}
            onMajorOverlayChange={setMajorOverlayOpen}
          />
        </>
      )}
      
      <FaultForm
        isOpen={isEditable && isFormOpen}
        onClose={() => { setIsFormOpen(false); setEditingPointIndex(null); }}
        onSave={handleSavePoint}
        editingPoint={editingPointIndex !== null ? numberedPointsList[editingPointIndex] : null}
        defaultSedLlave={`${currentSedId}-${currentLlaveId}`}
      />

      <TicketConflictModal
        isOpen={isConflictModalOpen}
        conflicts={conflictsList}
        onResolveAll={handleResolveConflicts}
      />
    </>
  );
}
