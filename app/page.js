'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import * as XLSX from 'xlsx';
import Sidebar from '@/components/Sidebar';
import FaultForm from '@/components/FaultForm';
import PresentationHUD from '@/components/PresentationHUD';
import PresentationTablePanel from '@/components/PresentationTablePanel';
import TicketConflictModal from '@/components/TicketConflictModal';
import { sortSedIds } from '@/components/SearchableSedSelect';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { exportExcelBySed } from '@/lib/excelUtils';
import { exportPdfReport } from '@/lib/pdfUtils';
import { getCachedSeds, setCachedSeds } from '@/lib/dbCache';
import { isSedMatch, isLlaveMatch } from '@/lib/sedUtils';
import { CIRCUIT_STATUSES, hydrateLlave, serializeLlaveLines } from '@/lib/circuitAnalysis';

// MapViewer importado dinámicamente para evitar SSR
const MapViewer = dynamic(() => import('@/components/MapViewer'), { ssr: false });

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

  // Estado UI
  const [currentTheme, setCurrentTheme] = useState('light');
  const [currentMapStyle, setCurrentMapStyle] = useState('clean');
  const [isAddPointMode, setIsAddPointMode] = useState(false);
  const [isPresentationMode, setIsPresentationMode] = useState(true);
  const [relocatingPointIndex, setRelocatingPointIndex] = useState(null);
  const [isSegmentSelectionMode, setIsSegmentSelectionMode] = useState(false);
  const [selectedLineIds, setSelectedLineIds] = useState([]);
  const [isFaultTableExpanded, setIsFaultTableExpanded] = useState(false);

  // Estado del Formulario
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPointIndex, setEditingPointIndex] = useState(null);

  // El acceso a esta pantalla exige una sesión Supabase válida mediante AuthGate.
  const isEditable = true;
  
  const mapRef = useRef(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('dark-theme', currentTheme === 'dark');
  }, [currentTheme]);

  // Carga de Datos desde IndexedDB Caché / Supabase
  async function loadData() {
    // 1. Intentar cargar SEDS & Llaves desde caché IndexedDB primero para respuesta instantánea
    try {
      const cachedDb = await getCachedSeds();
      if (cachedDb && Object.keys(cachedDb).length > 0) {
        setLocalDatabase(cachedDb);
      }
    } catch (cErr) {
      console.warn('Error leyendo caché IndexedDB:', cErr);
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
          // Deduplicar registros de Supabase por Ticket (manteniendo el más reciente o con ID más alto)
          const uniqueMap = new Map();
          fallasData.forEach(f => {
            const key = f.ticket ? String(f.ticket).trim().toLowerCase() : null;
            if (key) {
              if (!uniqueMap.has(key)) {
                uniqueMap.set(key, f);
              } else {
                const existing = uniqueMap.get(key);
                // Conservar el registro con mayor información o ID más reciente
                if ((!existing.latitud && f.latitud) || (f.id && (!existing.id || f.id > existing.id))) {
                  uniqueMap.set(key, f);
                }
              }
            } else {
              uniqueMap.set(`id_${f.id}`, f);
            }
          });

          const deduplicatedFallas = Array.from(uniqueMap.values());
          const points = deduplicatedFallas.map((f, i) => ({
            id: f.id,
            number: i + 1,
            coords: (f.latitud && f.longitud) ? [f.latitud, f.longitud] : null,
            ticket: f.ticket || '',
            horaInicio: f.hora_inicio || '',
            zona: f.zona || '',
            set: f.set_alimentador ? f.set_alimentador.split('/')[0]?.trim() : '',
            alimentador: f.set_alimentador ? f.set_alimentador.split('/')[1]?.trim() : '',
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
            fotos: f.fotos || []
          }));
          setNumberedPointsList(points);
        }
      }
    } catch (err) {
      console.log('Supabase no disponible, usando caché local:', err.message);
    }
  }

  // Filtrado flexible de Puntos por SED y Llave
  const getFilteredPoints = useCallback(() => {
    return numberedPointsList
      .map((pt, i) => ({ ...pt, originalIndex: i }))
      .filter(pt => {
        if (!currentSedId) return true;
        return isSedMatch(pt.sed, pt.sedLlave, currentSedId) && isLlaveMatch(pt.llaveSistema, pt.sedLlave, currentLlaveId);
      })
      .map((pt, i) => ({ ...pt, localNumber: i + 1 }));
  }, [numberedPointsList, currentSedId, currentLlaveId]);

  const filteredPoints = getFilteredPoints();

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
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const rawData = JSON.parse(evt.target.result);
          mergeJsonData(rawData, file.name);
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

  function handleImportJsonText(jsonText) {
    if (!jsonText || !jsonText.trim()) return;
    try {
      const rawData = JSON.parse(jsonText.trim());
      mergeJsonData(rawData, 'Texto Pegado');
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

  function mergeJsonData(rawData, sourceName = 'Archivo') {
    if (!rawData) {
      alert(`⚠️ El contenido de ${sourceName} está vacío.`);
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

      setNumberedPointsList(prev => {
        const existing = [...prev];
        const existingMap = new Map();
        existing.forEach(p => {
          if (p.ticket) {
            existingMap.set(String(p.ticket).trim().toLowerCase(), p);
          }
        });

        incomingFallas.forEach(pt => {
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
            fotos: pt.fotos || []
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
      } else {
        setTimeout(() => {
          alert(`✅ ¡FALLAS CARGADAS DESDE ${sourceName.toUpperCase()}!\n\n• Agregados: ${addedCount} registro(s) nuevo(s).`);
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
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        let importedPoints = 0;
        let skippedPoints = 0;
        const newPoints = [...numberedPointsList];
        const existingTickets = new Set(newPoints.map(p => String(p.ticket).trim().toLowerCase()).filter(Boolean));
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

              const sedLlaveVal = String(getFlexibleValue(row, ['sedllave', 'sed_llave', 'circuito']) || sheetName || '00007S-5SP');
              const partes = sedLlaveVal.split('-');
              const sedVal = partes[0] || '00007S';
              const llaveVal = partes[1] || '5SP';

              if (!firstImportedSed && sedVal) {
                firstImportedSed = sedVal;
              }

              const pointNum = newPoints.length + 1;
              const pointData = {
                number: pointNum,
                coords: coords,
                ticket: ticket || `TK-${Math.floor(Math.random()*90000+10000)}`,
                horaInicio: String(getFlexibleValue(row, ['horainicio', 'hora', 'fecha', 'inicio']) || new Date().toLocaleString()),
                zona: String(getFlexibleValue(row, ['zona', 'distrito', 'area']) || 'Zona Centro'),
                set: String(getFlexibleValue(row, ['set', 'subestacion']) || 'SET'),
                alimentador: String(getFlexibleValue(row, ['alimentador', 'alim', 'circuito']) || 'Alim'),
                nota: String(getFlexibleValue(row, ['nota', 'comentario', 'observacion']) || 'Falla atendida'),
                odm: String(getFlexibleValue(row, ['odm', 'orden']) || 'ODM-000'),
                suministro: String(getFlexibleValue(row, ['suministro', 'nis']) || 'N/A'),
                sedLlave: sedLlaveVal,
                sed: sedVal,
                llaveSistema: llaveVal,
                llaveCampo: `${llaveVal} (Campo)`,
                falla: String(getFlexibleValue(row, ['falla', 'fallareal', 'averia', 'descripcion']) || 'Avería reparada'),
                causa: String(getFlexibleValue(row, ['causa', 'diagnostico']) || 'Deterioro'),
                linkCroquis: String(getFlexibleValue(row, ['linkcroquis', 'croquis', 'link', 'mapa', 'url']) || '')
              };
              newPoints.push(pointData);
              importedPoints++;
              saveFallaToSupabase(pointData);
            }
          });
        });

        setNumberedPointsList(newPoints);

        if (firstImportedSed) {
          setCurrentSedId(firstImportedSed);
        }

        let msg = `✅ EXCEL IMPORTADO:\n\n• Agregados: ${importedPoints} registros.`;
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

  function handleExportJson() {
    const dataStr = JSON.stringify(localDatabase, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "geopluz_datos.json";
    link.click();
  }

  async function handleExportExcel() {
    const dataToExport = filteredPoints.length > 0 ? filteredPoints : numberedPointsList;
    await exportExcelBySed(dataToExport, currentSedId, currentLlaveId);
  }

  async function handleExportPdf() {
    const dataToExport = filteredPoints.length > 0 ? filteredPoints : numberedPointsList;
    await exportPdfReport(dataToExport, currentSedId, currentLlaveId, {
      status: currentAnalysis.status,
      note: currentAnalysis.note
    });
  }

  async function checkEditPermission() {
    return true;
  }

  // Acciones en el mapa
  // Usando useCallback para que la referencia se actualice cuando cambie relocatingPointIndex,
  // lo que permite que la ref en MapViewer siempre tenga el callback más reciente.
  const handleMapClick = useCallback(async (latlng) => {
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
          updated[relocatingPointIndex] = {
            ...targetPoint,
            coords: [latlng.lat, latlng.lng]
          };
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
      causa: 'Excavación externa'
    };
    
    const updated = [...numberedPointsList, newPoint];
    setNumberedPointsList(updated);
    setEditingPointIndex(updated.length - 1);
    setIsFormOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relocatingPointIndex, isAddPointMode, isPresentationMode, numberedPointsList, currentSedId, currentLlaveId]);

  // Guardado de Falla
  function handleSavePoint(pointData) {
    const updated = [...numberedPointsList];
    if (editingPointIndex !== null && updated[editingPointIndex]) {
      updated[editingPointIndex] = { ...updated[editingPointIndex], ...pointData };
    } else {
       // if we are inserting without editing index... but normally editingPointIndex is set
       updated.push(pointData);
    }
    setNumberedPointsList(updated);
    setIsFormOpen(false);
    
    saveFallaToSupabase(updated[editingPointIndex !== null ? editingPointIndex : updated.length - 1]);
    setEditingPointIndex(null);
  }

  async function saveFallaToSupabase(point) {
    if (!isSupabaseConfigured || !supabase) return;
    try {
      const record = {
        sed_id: point.sed,
        llave_code: point.llaveSistema,
        sed_llave: point.sedLlave,
        ticket: point.ticket,
        suministro: point.suministro,
        falla_real: point.falla,
        causa: point.causa,
        nota: point.nota,
        odm: point.odm,
        zona: point.zona,
        set_alimentador: `${point.set} / ${point.alimentador}`,
        hora_inicio: point.horaInicio,
        latitud: point.coords ? point.coords[0] : null,
        longitud: point.coords ? point.coords[1] : null,
        link_croquis: point.linkCroquis || null,
        fotos: point.fotos || []
      };
      
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
  async function handleDeletePoint() {
    alert('Eliminar fallas está deshabilitado por la política de seguridad actual.');
  }

  // Eliminar SED y Llave
  async function handleDeleteSed() {
    alert('Eliminar SEDs está deshabilitado por la política de seguridad actual.');
  }

  async function handleDeleteLlave() {
    alert('Eliminar llaves está deshabilitado por la política de seguridad actual.');
  }

  // Reubicación
  async function handleRelocatePoint(index) {
    const allowed = await checkEditPermission();
    if (!allowed) return;
    setRelocatingPointIndex(index);
    alert('Haz clic en el mapa en la nueva ubicación.');
  }

  async function saveSedsToSupabase(sedsToSave) {
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
    const allowed = await checkEditPermission();
    if (!allowed) return;

    try {
      // 1. Guardar SEDs y Llaves en lote masivo
      await saveSedsToSupabase(localDatabase);

      // 2. Guardar Fallas en lote masivo (Bulk Upsert)
      if (numberedPointsList.length > 0) {
        const fallasBatch = numberedPointsList.map(point => {
          const record = {
            sed_id: point.sed,
            llave_code: point.llaveSistema,
            sed_llave: point.sedLlave,
            ticket: point.ticket,
            suministro: point.suministro,
            falla_real: point.falla,
            causa: point.causa,
            nota: point.nota,
            odm: point.odm,
            zona: point.zona,
            set_alimentador: `${point.set} / ${point.alimentador}`,
            hora_inicio: point.horaInicio,
            latitud: point.coords ? point.coords[0] : null,
            longitud: point.coords ? point.coords[1] : null,
            link_croquis: point.linkCroquis || null,
            fotos: point.fotos || []
          };
          if (point.id) {
            record.id = point.id;
          }
          return record;
        });

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

            const record = {
              sed_id: point.sed,
              llave_code: point.llaveSistema,
              sed_llave: point.sedLlave,
              ticket: point.ticket,
              suministro: point.suministro,
              falla_real: point.falla,
              causa: point.causa,
              nota: point.nota,
              odm: point.odm,
              zona: point.zona,
              set_alimentador: `${point.set} / ${point.alimentador}`,
              hora_inicio: point.horaInicio,
              latitud: point.coords ? point.coords[0] : null,
              longitud: point.coords ? point.coords[1] : null,
              link_croquis: point.linkCroquis || null,
              fotos: point.fotos || []
            };
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
      mapRef.current.focusFailure(point.coords);
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
  }, [currentSedId, currentLlaveId]);

  const currentLlaveData = currentSedId && currentLlaveId && localDatabase[currentSedId]?.llaves?.[currentLlaveId]
    ? localDatabase[currentSedId].llaves[currentLlaveId]
    : null;

  const currentSedCoord = localDatabase[currentSedId]?.sedCoord || null;

  const currentAnalysis = currentLlaveData?.analysis || { note: '', cableGroups: [], status: 'cargado' };
  const circuitEntries = Object.entries(localDatabase).flatMap(([sedId, sed]) => Object.entries(sed.llaves || {}).map(([llaveId, llave]) => ({
    sedId, llaveId, sedName: sed.name || sedId, status: llave.analysis?.status || 'cargado'
  })));
  const selectedDistance = (currentLlaveData?.lines || [])
    .filter((line, index) => selectedLineIds.includes(String(line.id ?? index)))
    .reduce((total, line) => total + (Number(line.length) || 0), 0);

  function updateCurrentLlaveAnalysis(updater) {
    if (!currentSedId || !currentLlaveId) return;
    setLocalDatabase(prev => {
      const llave = prev[currentSedId]?.llaves?.[currentLlaveId];
      if (!llave) return prev;
      const updatedLlave = { ...llave, analysis: updater(llave.analysis || { note: '', cableGroups: [] }) };
      const updated = { ...prev, [currentSedId]: { ...prev[currentSedId], llaves: { ...prev[currentSedId].llaves, [currentLlaveId]: updatedLlave } } };
      setCachedSeds(updated);
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
      {!isPresentationMode && (
        <Sidebar
          seds={localDatabase}
          faultPoints={numberedPointsList}
          filteredFaultPoints={filteredPoints}
          currentSedId={currentSedId}
          setCurrentSedId={handleSedSelect}
          currentLlaveId={currentLlaveId}
          setCurrentLlaveId={setCurrentLlaveId}
          currentTheme={currentTheme}
          setCurrentTheme={setCurrentTheme}
          currentMapStyle={currentMapStyle}
          setCurrentMapStyle={setCurrentMapStyle}
          isAddPointMode={isAddPointMode}
          setIsAddPointMode={setIsAddPointMode}
          isPresentationMode={isPresentationMode}
          isEditable={isEditable}
          circuitNote={currentAnalysis.note}
          cableGroups={currentAnalysis.cableGroups || []}
          circuitStatus={currentAnalysis.status}
          isSegmentSelectionMode={isSegmentSelectionMode}
          selectedLineCount={selectedLineIds.length}
          selectedDistance={selectedDistance}
          onSaveCircuitNote={handleSaveCircuitNote}
          onSaveCircuitStatus={handleSaveCircuitStatus}
          onToggleSegmentSelection={handleToggleSegmentSelection}
          onStartEditCableGroup={handleStartEditCableGroup}
          onCancelEditCableGroup={handleCancelEditCableGroup}
          onSaveCableGroup={handleSaveCableGroup}
          onDeleteCableGroup={handleDeleteCableGroup}
          onTogglePresentationMode={() => setIsPresentationMode(true)}
          onImportJson={handleImportJson}
          onImportJsonText={handleImportJsonText}
          onImportExcel={handleImportExcel}
          onExportJson={handleExportJson}
          onExportExcel={handleExportExcel}
          onExportPdf={handleExportPdf}
          onSaveToMainDatabase={handleSaveToMainDatabase}
          onDeleteSed={handleDeleteSed}
          onDeleteLlave={handleDeleteLlave}
          onEditPoint={(idx) => { setEditingPointIndex(idx); setIsFormOpen(true); }}
          onDeletePoint={handleDeletePoint}
          onRelocatePoint={handleRelocatePoint}
          onFlyToPoint={(point) => mapRef.current?.focusFailure?.(point.coords)}
          onFaultTableExpanded={setIsFaultTableExpanded}
        />
      )}
      
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
          isAddPointMode={isAddPointMode}
          isRelocating={relocatingPointIndex !== null}
          isPresentationMode={isPresentationMode}
          circuitNote={currentAnalysis.note}
          cableGroups={currentAnalysis.cableGroups || []}
          isSegmentSelectionMode={isSegmentSelectionMode}
          selectedLineIds={selectedLineIds}
          onLineClick={handleLineClick}
          onMapClick={handleMapClick}
          onSedDragEnd={handleSedDragEnd}
          onPointClick={(idx) => { setEditingPointIndex(idx); setIsFormOpen(true); }}
          hideOverlays={isFaultTableExpanded}
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
            points={filteredPoints}
            onRowClick={handleFlyToPoint}
            onExportExcel={handleExportExcel}
            onExportPdf={handleExportPdf}
            onFullViewChange={setIsFaultTableExpanded}
          />
        </>
      )}
      
      <FaultForm
        isOpen={isFormOpen}
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
