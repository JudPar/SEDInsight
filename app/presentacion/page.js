'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import PresentationHUD from '@/components/PresentationHUD';
import PresentationTablePanel from '@/components/PresentationTablePanel';
import DataSourceBadge from '@/components/DataSourceBadge';
import { sortSedIds } from '@/components/SearchableSedSelect';
import { supabase } from '@/lib/supabase';
import { exportExcelBySed } from '@/lib/excelUtils';
import { exportPdfReport } from '@/lib/pdfUtils';
import { clearActiveLocalProject, clearExpectedLocalProject, getActiveLocalProject, getCachedSeds, getExpectedLocalProject, setCachedSeds } from '@/lib/dbCache';
import { isSedMatch, isLlaveMatch } from '@/lib/sedUtils';
import { hydrateLlave } from '@/lib/circuitAnalysis';
import { projectToInternalModel } from '@/lib/projectMappers';
import { validateProject } from '@/lib/projectValidation';
import { isValidCoordinatePair } from '@/lib/faultGeolocation';

// MapViewer importado dinámicamente para evitar SSR
const MapViewer = dynamic(() => import('@/components/MapViewer'), { ssr: false });

export default function PresentacionPage() {
  // Estado de Datos
  const [localDatabase, setLocalDatabase] = useState({});
  const [numberedPointsList, setNumberedPointsList] = useState([]);

  // Estado de Navegación
  const [currentSedId, setCurrentSedId] = useState('');
  const [currentLlaveId, setCurrentLlaveId] = useState('');

  // Estado UI
  const [currentTheme, setCurrentTheme] = useState('light');
  const [currentMapStyle, setCurrentMapStyle] = useState('clean');
  const [activeMajorOverlays, setActiveMajorOverlays] = useState(() => new Set());
  const [dataSource, setDataSource] = useState({ kind: 'SUPABASE', readOnly: false, projectId: 'geopluz-main', projectName: 'Base Principal GEOPLUZ' });
  
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
    loadData();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('dark-theme', currentTheme === 'dark');
  }, [currentTheme]);

  // Carga de Datos desde Supabase
  async function loadData() {
    const expectedLocalProject = getExpectedLocalProject();
    const localProject = await getActiveLocalProject();
    if (localProject) {
      const validation = await validateProject(localProject);
      if (validation.valid) {
        const model = projectToInternalModel(localProject);
        setLocalDatabase(model.localDatabase);
        setNumberedPointsList(model.numberedPointsList);
        setDataSource({ kind: 'LOCAL_PROJECT', readOnly: true, projectId: localProject.project.id, projectName: localProject.project.name });
        const firstSed = Object.keys(model.localDatabase)[0];
        if (firstSed) {
          setCurrentSedId(firstSed);
          setCurrentLlaveId(Object.keys(model.localDatabase[firstSed]?.llaves || {})[0] || '');
        }
        return;
      }
      await clearActiveLocalProject();
    }

    if (expectedLocalProject) {
      setDataSource({ kind: 'LOCAL_PROJECT', readOnly: true, projectId: expectedLocalProject.projectId, projectName: `${expectedLocalProject.projectName} (no disponible)` });
      return;
    }

    try {
      const cachedDb = await getCachedSeds();
      if (cachedDb && Object.keys(cachedDb).length > 0) {
        setLocalDatabase(cachedDb);
      }
    } catch (cErr) {
      console.warn('Error leyendo caché IndexedDB:', cErr);
    }

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

        // Initialize with first SED
        const firstSed = Object.keys(db)[0];
        if (firstSed) {
           setCurrentSedId(firstSed);
           const llaves = Object.keys(db[firstSed].llaves);
           if (llaves.length > 0) setCurrentLlaveId(llaves[0]);
        }
      }
    } catch (err) {
      console.log('Error al cargar datos:', err.message);
    }
  }

  // Filtrado flexible de Puntos de Falla por SED y Llave
  const getFilteredPoints = useCallback(() => {
    let list = numberedPointsList;
    if (currentSedId) {
      list = list.filter(pt => 
        isSedMatch(pt.sed, pt.sedLlave, currentSedId) && 
        isLlaveMatch(pt.llaveSistema, pt.sedLlave, currentLlaveId)
      );
    }
    return list.map((pt, i) => ({ ...pt, localNumber: i + 1 }));
  }, [numberedPointsList, currentSedId, currentLlaveId]);

  const filteredPoints = getFilteredPoints();

  function handleFlyToPoint(point) {
    if (mapRef.current && point.coords) {
      mapRef.current.focusFailure(point);
    }
  }

  async function handleExportExcel() {
    const dataToExport = filteredPoints.length > 0 ? filteredPoints : numberedPointsList;
    await exportExcelBySed(dataToExport, currentSedId, currentLlaveId);
  }

  async function handleExportPdf() {
    const dataToExport = filteredPoints.length > 0 ? filteredPoints : numberedPointsList;
    await exportPdfReport(dataToExport, currentSedId, currentLlaveId, {
      status: currentLlaveData?.analysis?.status || 'cargado',
      note: currentLlaveData?.analysis?.note || ''
    });
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
    
    const llaves = Object.keys(localDatabase[sedsList[newIndex]].llaves || {});
    if (llaves.length > 0) {
      setCurrentLlaveId(llaves[0]);
    } else {
      setCurrentLlaveId('');
    }
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') navigateSed(1);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') navigateSed(-1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentSedId, localDatabase]);

  const currentLlaveData = currentSedId && currentLlaveId && localDatabase[currentSedId]?.llaves?.[currentLlaveId]
    ? localDatabase[currentSedId].llaves[currentLlaveId]
    : null;

  const currentSedCoord = localDatabase[currentSedId]?.sedCoord || null;
  const circuitEntries = Object.entries(localDatabase).flatMap(([sedId, sed]) => Object.entries(sed.llaves || {}).map(([llaveId, llave]) => ({
    sedId, llaveId, sedName: sed.name || sedId, status: llave.analysis?.status || 'cargado'
  })));

  return (
    <>
      <DataSourceBadge
        dataSource={dataSource}
        onCloseLocalProject={dataSource.kind === 'LOCAL_PROJECT' ? async () => {
          await clearActiveLocalProject();
          clearExpectedLocalProject();
          window.location.href = '/';
        } : null}
      />
      <div className="map-container">
        <MapViewer
          ref={mapRef}
          currentTheme={currentTheme}
          currentMapStyle={currentMapStyle}
          circuitId={`${currentSedId}:${currentLlaveId}`}
          llaveData={currentLlaveData}
          sedId={currentSedId}
          sedCoord={currentSedCoord}
          faultPoints={filteredPoints}
          isAddPointMode={false}
          isPresentationMode={true}
          circuitNote={currentLlaveData?.analysis?.note || ''}
          cableGroups={currentLlaveData?.analysis?.cableGroups || []}
          isSegmentSelectionMode={false}
          selectedLineIds={[]}
          onMapClick={() => {}}
          onSedDragEnd={() => {}}
          onPointClick={(idx) => handleFlyToPoint(filteredPoints.find(p => p.localNumber - 1 === idx))}
          hideOverlays={isMajorOverlayOpen}
        />
      </div>
      
      <PresentationHUD
        sedId={currentSedId}
        sedName={localDatabase[currentSedId]?.name || currentSedId || 'Sin SED'}
        llaveName={currentLlaveId || ''}
        sedsList={sedsList}
        localDatabase={localDatabase}
        circuitEntries={circuitEntries}
        circuitStatus={currentLlaveData?.analysis?.status || 'cargado'}
        onSelectSed={(sedId) => {
          setCurrentSedId(sedId);
          const llaves = Object.keys(localDatabase[sedId]?.llaves || {});
          if (llaves.length > 0) setCurrentLlaveId(llaves[0]);
          else setCurrentLlaveId('');
        }}
        onSelectLlave={(llaveId) => setCurrentLlaveId(llaveId)}
        onSelectCircuit={(sedId, llaveId) => { setCurrentSedId(sedId); setCurrentLlaveId(llaveId); }}
        currentMapStyle={currentMapStyle}
        currentTheme={currentTheme}
        onPrevSed={() => navigateSed(-1)}
        onNextSed={() => navigateSed(1)}
        onToggleMapStyle={() => setCurrentMapStyle(s => s === 'clean' ? 'detailed' : 'clean')}
        onToggleTheme={() => setCurrentTheme(theme => theme === 'light' ? 'dark' : 'light')}
        onEnterEditMode={() => { window.location.href = '/'; }}
      />
      <PresentationTablePanel
        points={filteredPoints}
        onRowClick={handleFlyToPoint}
        onExportExcel={handleExportExcel}
        onExportPdf={handleExportPdf}
        onMajorOverlayChange={setMajorOverlayOpen}
      />
    </>
  );
}
