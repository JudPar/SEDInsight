'use client';

import { useState, useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useMemo } from 'react';
import { fixCoord, getDrawableLineCoordinates, getWeightForZoom } from '@/lib/coordUtils';
import { TILE_LAYERS, MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, MAP_MAX_ZOOM, FAULT_CAUSES, DEFAULT_CAUSE_COLOR, getCauseCategory } from '@/lib/constants';
import { getSpiderfyPositions, groupOverlappingPoints } from '@/lib/overlappingMarkers';
import { safeExternalImageSource, safeExternalNavigationUrl } from '@/lib/externalAssetSafety';
import { getLineCalibreDisplay } from '@/lib/circuitAnalysis';
import { createManualEdgeRefsForLine } from '@/lib/manualAnalysisUnits';

const ANALYSIS_SELECTION_MAX_ZOOM = 19;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function safeMarkerColor(value, fallback) {
  return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? String(value) : fallback;
}

function getFaultIdentity(point, fallbackIndex = '') {
  if (point?.id !== null && point?.id !== undefined) return `id:${point.id}`;
  if (point?.originalIndex !== null && point?.originalIndex !== undefined) return `index:${point.originalIndex}`;
  return `ticket:${point?.ticket || ''}:number:${point?.number || fallbackIndex}`;
}

const MapViewer = forwardRef(({
  currentTheme,
  currentMapStyle,
  circuitId,
  llaveData,
  sedOverviewLlaves = [],
  showFullSedView = false,
  selectedLlaveId = '',
  sedId,
  sedCoord,
  faultPoints,
  isAddPointMode,
  isRelocating,
  isPresentationMode,
  isEditable = true,
  circuitNote,
  cableGroups = [],
  isSegmentSelectionMode,
  selectedLineIds = [],
  selectedManualEdgeIds = [],
  manualSelectionMessage = '',
  selectedAnalysisSegmentId = null,
  selectedAnalysisSegmentEdges = [],
  hasSelectedAnalysisSegment = false,
  onMapClick,
  onSedDragEnd,
  onPointClick,
  onLineClick,
  hideOverlays = false,
  sedPeriodSummary = null,
  selectedPeriodLabel = ''
}, ref) => {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const cleanTileLayerRef = useRef(null);
  const osmTileLayerRef = useRef(null);
  const darkTileLayerRef = useRef(null);
  const networkLayerGroupRef = useRef(null);
  const pointsLayerGroupRef = useRef(null);
  const spiderLayerGroupRef = useRef(null);
  const sedMarkerRef = useRef(null);
  const pointMarkersRef = useRef([]);
  const overlapGroupsRef = useRef(new Map());
  const activeSpiderGroupRef = useRef(null);
  const clearSpiderfyRef = useRef(() => {});
  const openSpiderfyRef = useRef(() => {});
  const focusRequestRef = useRef(0);
  const fittedCircuitRef = useRef(null);
  const fittedAnalysisSegmentRef = useRef(null);
  const visibleNetworkBoundsRef = useRef([]);
  const [sedsMasterDB, setSedsMasterDB] = useState({});
  const [mapViewport, setMapViewport] = useState({ bounds: null, zoom: MAP_DEFAULT_ZOOM });
  const [showLegend, setShowLegend] = useState(true);
  const [zoomControlBottom, setZoomControlBottom] = useState(10);
  const faultCauseCounts = useMemo(() => {
    const counts = Object.fromEntries(FAULT_CAUSES.map(cause => [cause.id, 0]));
    counts[DEFAULT_CAUSE_COLOR.id] = 0;
    (faultPoints || []).forEach(point => { const category = getCauseCategory(point.causa); counts[category.id] = (counts[category.id] || 0) + 1; });
    return counts;
  }, [faultPoints]);

  useEffect(() => {
    fetch('/seds_master_db.min.json')
      .then(res => res.ok ? res.json() : {})
      .then(data => setSedsMasterDB(data))
      .catch(err => console.warn('No se pudo cargar seds_master_db.min.json:', err));
  }, []);

  // Ref para mantener siempre la versión más reciente de onMapClick
  const onMapClickRef = useRef(onMapClick);

  // Actualizar la ref cada vez que cambie el prop
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);
  
  // Guardamos L en una ref para acceso posterior
  const LRef = useRef(null);

  const focusFailure = useCallback((pointOrCoords, preferredZoom = 19) => {
    const map = mapInstanceRef.current;
    if (!map || !pointOrCoords) return;

    const point = !Array.isArray(pointOrCoords) && pointOrCoords.coords ? pointOrCoords : null;
    const coords = point?.mapCoords || point?.coords || pointOrCoords;
    const target = Array.isArray(coords[0]) ? coords[0] : coords;
    const targetIdentity = point ? getFaultIdentity(point) : null;
    const targetZoom = Math.max(map.getZoom(), Math.min(preferredZoom, MAP_MAX_ZOOM));
    const mapRect = map.getContainer().getBoundingClientRect();
    const sidebar = document.querySelector('#sidebar.sidebar:not(.hidden)');
    const sidebarRect = sidebar?.getBoundingClientRect();
    const sidebarOverlap = sidebarRect
      ? Math.max(0, Math.min(mapRect.right, sidebarRect.right) - Math.max(mapRect.left, sidebarRect.left))
      : 0;

    const requestId = focusRequestRef.current + 1;
    focusRequestRef.current = requestId;
    let flyHandled = false;

    const revealMarker = () => {
      if (focusRequestRef.current !== requestId) return;
      const markerItem = pointMarkersRef.current.find(item => (
        targetIdentity
          ? item.pointIdentity === targetIdentity
          : item.coords[0] === target[0] && item.coords[1] === target[1]
      ));
      if (markerItem?.groupId) openSpiderfyRef.current(markerItem.groupId, markerItem.key);
      else markerItem?.marker?.openPopup();
    };

    const afterFly = () => {
      if (flyHandled || focusRequestRef.current !== requestId) return;
      flyHandled = true;
      if (sidebarOverlap > 0) {
        map.once('moveend', () => window.setTimeout(revealMarker, 50));
        map.panBy([-sidebarOverlap / 2, 0], { animate: true, duration: 0.35 });
      } else {
        window.setTimeout(revealMarker, 50);
      }
    };

    map.once('moveend', afterFly);
    map.flyTo(target, targetZoom, { duration: 1.1 });
    window.setTimeout(afterFly, 1400);
  }, []);

  const prepareForExport = useCallback(() => new Promise((resolve) => {
    const map = mapInstanceRef.current;
    const L = LRef.current;
    const coordinates = visibleNetworkBoundsRef.current;
    if (!map || !L || !Array.isArray(coordinates) || coordinates.length === 0) {
      resolve(false);
      return;
    }
    const bounds = L.latLngBounds(coordinates);
    if (!bounds.isValid()) {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off('moveend', finish);
      window.setTimeout(() => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(true)));
      }, 250);
    };

    map.invalidateSize({ pan: false });
    map.once('moveend', finish);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18, animate: false });
    window.setTimeout(finish, 450);
  }), []);

  useImperativeHandle(ref, () => ({
    flyTo: (coords, zoom) => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.flyTo(coords, zoom, { duration: 1.5 });
      }
    },
    focusFailure,
    flyToPoint: focusFailure,
    prepareForExport,
    invalidateSize: () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
      }
    },
    fitBounds: (bounds) => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50] });
      }
    }
  }), [focusFailure, prepareForExport]);

  useEffect(() => {
    if (!isPresentationMode || !mapRef.current) {
      setZoomControlBottom(10);
      return undefined;
    }

    const mapElement = mapRef.current;
    const panel = document.querySelector('.presentation-table-panel');
    if (!panel) return undefined;

    const updateZoomPosition = () => {
      const mapRect = mapElement.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const panelIsVisible = panelRect.width > 0 && panelRect.height > 0;
      setZoomControlBottom(panelIsVisible ? Math.max(10, mapRect.bottom - panelRect.top + 10) : 10);
    };

    const resizeObserver = new ResizeObserver(updateZoomPosition);
    resizeObserver.observe(mapElement);
    resizeObserver.observe(panel);
    window.addEventListener('resize', updateZoomPosition);
    requestAnimationFrame(updateZoomPosition);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateZoomPosition);
    };
  }, [isPresentationMode, faultPoints?.length]);

  // Inicializar mapa
  useEffect(() => {
    // Importación dinámica de Leaflet
    const L = require('leaflet');
    require('leaflet/dist/leaflet.css');
    LRef.current = L;

    if (!mapRef.current) return;
    if (mapInstanceRef.current) return; // Evitar reinicialización

    const map = L.map(mapRef.current, {
      center: MAP_DEFAULT_CENTER,
      zoom: MAP_DEFAULT_ZOOM,
      zoomControl: false,
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: false,
      preferCanvas: true
    });

    // Control de zoom
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Definir capas base
    cleanTileLayerRef.current = L.tileLayer(TILE_LAYERS.clean.url, TILE_LAYERS.clean.options);
    osmTileLayerRef.current = L.tileLayer(TILE_LAYERS.detailed.url, TILE_LAYERS.detailed.options);
    darkTileLayerRef.current = L.tileLayer(TILE_LAYERS.dark.url, TILE_LAYERS.dark.options);

    // Grupos de capas
    networkLayerGroupRef.current = L.layerGroup().addTo(map);
    pointsLayerGroupRef.current = L.layerGroup().addTo(map);
    spiderLayerGroupRef.current = L.layerGroup().addTo(map);

    // Eventos del mapa
    map.on('click', (e) => {
      clearSpiderfyRef.current();
      if (onMapClickRef.current) onMapClickRef.current(e.latlng);
    });

    map.on('zoomstart', () => clearSpiderfyRef.current());

    const updateViewport = () => {
      const zoom = map.getZoom();
      const bounds = map.getBounds();
      setMapViewport({ bounds, zoom });
      
      const weight = getWeightForZoom(zoom);
      networkLayerGroupRef.current.eachLayer((layer) => {
        if (layer instanceof L.Polyline) {
          layer.setStyle({ weight });
        }
      });
    };

    map.on('zoomend moveend', updateViewport);

    mapInstanceRef.current = map;

    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resizeObserver.observe(mapRef.current);

    return () => {
      resizeObserver.disconnect();
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Actualizar capa base según tema y estilo
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    // Remover todas primero
    map.removeLayer(cleanTileLayerRef.current);
    map.removeLayer(osmTileLayerRef.current);
    map.removeLayer(darkTileLayerRef.current);

    if (currentTheme === 'dark') {
      darkTileLayerRef.current.addTo(map);
    } else {
      if (currentMapStyle === 'clean') {
        cleanTileLayerRef.current.addTo(map);
      } else {
        osmTileLayerRef.current.addTo(map);
      }
    }
  }, [currentTheme, currentMapStyle]);

  // Dibujar red (llaveData y SED)
  useEffect(() => {
    const L = LRef.current;
    if (!L || !mapInstanceRef.current) return;
    
    const networkGroup = networkLayerGroupRef.current;
    networkGroup.clearLayers();

    const bounds = [];
    visibleNetworkBoundsRef.current = [];

    const networkLlaves = showFullSedView
      ? sedOverviewLlaves
      : llaveData ? [{
        llaveId: selectedLlaveId,
        name: llaveData.name || selectedLlaveId,
        lines: llaveData.lines || [],
        cableGroups,
        color: null,
        isSelected: true
      }] : [];

    if (networkLlaves.some(entry => Array.isArray(entry?.lines) && entry.lines.length > 0)) {
      const lineColor = currentTheme === 'dark' ? '#00e5ff' : '#0077c2';
      const zoom = mapInstanceRef.current.getZoom();
      const weight = getWeightForZoom(zoom);
      const analysisSegmentActive = hasSelectedAnalysisSegment && selectedAnalysisSegmentEdges.length > 0;
      const selectedManualEdgeIdSet = new Set(selectedManualEdgeIds);

      networkLlaves.forEach((entry) => {
        (Array.isArray(entry?.lines) ? entry.lines : []).forEach((line, index) => {
          const fixedCoords = getDrawableLineCoordinates(line?.coords);
          if (fixedCoords.length > 0) {
            const lineId = String(line.id ?? index);
            const entryCableGroups = entry.cableGroups || [];
            const cableGroup = entryCableGroups.find(group => group.lineIds?.map(String).includes(lineId));
            const calibreDisplay = getLineCalibreDisplay(line, entryCableGroups);
            const isSelected = entry.isSelected && selectedManualEdgeIds.length === 0 && selectedLineIds.includes(lineId);
            const baseColor = showFullSedView ? entry.color : (cableGroup?.color || lineColor);
            const baseWeight = showFullSedView && entry.isSelected ? weight + 1.5 : cableGroup && !showFullSedView ? weight + 1.5 : weight;

            const polyline = L.polyline(fixedCoords, {
              color: isSelected ? '#ffca28' : baseColor,
              weight: isSelected ? weight + 3 : baseWeight,
              opacity: isSelected ? 1 : (analysisSegmentActive ? 0.2 : (showFullSedView ? (entry.isSelected ? 0.95 : 0.72) : 0.9))
            }).addTo(networkGroup);

            if (isSegmentSelectionMode && entry.isSelected) {
              createManualEdgeRefsForLine(line, index).forEach((edgeRef) => {
                const start = fixedCoords[edgeRef.startVertexIndex];
                const end = fixedCoords[edgeRef.endVertexIndex];
                if (!start || !end) return;
                L.polyline([start, end], {
                  color: '#ffca28',
                  weight: weight + 10,
                  opacity: 0.01,
                  interactive: true
                }).on('click', (event) => {
                  L.DomEvent.stopPropagation(event);
                  onLineClick?.(line.id ?? index, edgeRef);
                }).addTo(networkGroup);
              });
            }

            if (line.id || line.length) {
              polyline.bindTooltip(`
                <div style="font-size:11px;">
                  <b>Circuito:</b> ${escapeHtml(entry.name || entry.llaveId || 'Llave')}<br>
                  <b>Longitud:</b> ${escapeHtml(line.length || 0)} m<br>
                  <b>ID Tramo:</b> ${escapeHtml(line.id || 'N/A')}<br>
                  <b>Calibre / Tipo de cable:</b> ${escapeHtml(calibreDisplay)}
                </div>
              `, { sticky: true });
            }

            fixedCoords.forEach(c => bounds.push(c));
          }
        });
      });

      if (analysisSegmentActive) {
        selectedAnalysisSegmentEdges.forEach((edge) => {
          const edgeCoords = getDrawableLineCoordinates(edge?.coords);
          if (!edgeCoords.length) return;
          L.polyline(edgeCoords, {
            color: '#d81b60',
            weight: weight + 3,
            opacity: 1,
            interactive: false
          }).addTo(networkGroup);
        });

      }

      if (selectedManualEdgeIdSet.size > 0) {
        (Array.isArray(llaveData?.lines) ? llaveData.lines : []).forEach((line, index) => {
          const lineCoords = getDrawableLineCoordinates(line?.coords);
          if (!lineCoords.length) return;
          createManualEdgeRefsForLine(line, index).forEach((edgeRef) => {
            if (!selectedManualEdgeIdSet.has(edgeRef.edgeId)) return;
            const start = lineCoords[edgeRef.startVertexIndex];
            const end = lineCoords[edgeRef.endVertexIndex];
            if (!start || !end) return;
            L.polyline([start, end], {
              color: '#ffca28',
              weight: weight + 5,
              opacity: 1,
              dashArray: '7, 5',
              interactive: false
            }).addTo(networkGroup);
          });
        });
      }
    }

    let masterSed = null;
    if (sedId && sedsMasterDB) {
      masterSed = sedsMasterDB[sedId] || 
                sedsMasterDB[sedId.replace(/^0+/, '')] || 
                sedsMasterDB[sedId + 'S'] || 
                sedsMasterDB[sedId.padStart(6, '0')];
      if (!masterSed) {
        const keys = Object.keys(sedsMasterDB);
        const foundKey = keys.find(k => k.includes(sedId) || sedId.includes(k));
        if (foundKey) masterSed = sedsMasterDB[foundKey];
      }
    }

    let fixedSedCoord = sedCoord ? fixCoord(sedCoord) : null;
    if (!fixedSedCoord && masterSed && masterSed.lat && masterSed.lng) {
      fixedSedCoord = [masterSed.lat, masterSed.lng];
    }

    if (fixedSedCoord && fixedSedCoord[0] !== 0 && fixedSedCoord[1] !== 0) {
      const sedIcon = L.divIcon({
        className: 'sed-substation-wrapper',
        html: `<div class="sed-substation-icon ${isPresentationMode || !isEditable ? 'is-readonly' : ''}" title="SED ${escapeHtml(sedId)}${isPresentationMode || !isEditable ? '' : ' (Arrastra para mover la SED)'}">⚡</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });

      sedMarkerRef.current = L.marker(fixedSedCoord, {
        icon: sedIcon,
        draggable: !isPresentationMode && isEditable,
        zIndexOffset: 2000
      }).addTo(networkGroup);

      if (sedId) {
        let tooltipContent = `<div style="font-size:11px; max-width:240px;">
          <b style="color:#ffab00;">⚡ SUBESTACIÓN (SED ${escapeHtml(sedId)})</b>`;

        if (masterSed) {
          tooltipContent += `<div style="margin-top:4px; border-top:1px dashed #bbb; padding-top:4px; font-size:10.5px; line-height:1.4;">
            ${masterSed.cli !== undefined ? `<div>👥 <b>Clientes BT:</b> ${escapeHtml(masterSed.cli.toLocaleString())}</div>` : ''}
            ${masterSed.kva !== undefined ? `<div>⚡ <b>Potencia:</b> ${escapeHtml(masterSed.kva)} KVA (${escapeHtml(masterSed.kv || 10)} kV)</div>` : ''}
            ${masterSed.tipo_const ? `<div>🏗️ <b>Construcción:</b> ${escapeHtml(masterSed.tipo_const)}</div>` : ''}
            ${masterSed.dir ? `<div>📍 <b>Dirección:</b> ${escapeHtml(masterSed.dir)} (${escapeHtml(masterSed.dist || '')})</div>` : ''}
            ${masterSed.uo ? `<div>🏢 <b>UO:</b> ${escapeHtml(masterSed.uo)}</div>` : ''}
          </div>`;
        }

        if (!isPresentationMode && isEditable) tooltipContent += `<div style="margin-top:4px; font-size:9.5px; color:#666;">Arrastra este marcador para ajustar su posición</div>`;
        tooltipContent += '</div>';

        sedMarkerRef.current.bindTooltip(tooltipContent, { sticky: true });
      }

      if (!isPresentationMode && isEditable) sedMarkerRef.current.on('dragend', (e) => {
        const marker = e.target;
        const position = marker.getLatLng();
        if (onSedDragEnd) {
          onSedDragEnd(sedId, { lat: position.lat, lng: position.lng });
        }
      });

      bounds.push(fixedSedCoord);
    }

    visibleNetworkBoundsRef.current = bounds.map(coordinate => [...coordinate]);

    // Centrar y enfocar automáticamente el mapa a los límites de la Llave seleccionada
    // No reencuadrar cuando cambia solo el resaltado de una selección: conserva el zoom del usuario.
    if (bounds.length > 0 && mapInstanceRef.current && fittedCircuitRef.current !== circuitId) {
      mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 18, animate: true });
      fittedCircuitRef.current = circuitId;
    }
  }, [llaveData, sedOverviewLlaves, showFullSedView, selectedLlaveId, sedCoord, sedId, currentTheme, sedsMasterDB, cableGroups, isSegmentSelectionMode, selectedLineIds, selectedManualEdgeIds, selectedAnalysisSegmentEdges, hasSelectedAnalysisSegment, onLineClick, isPresentationMode, isEditable, circuitId]);

  useEffect(() => {
    if (!selectedAnalysisSegmentId) {
      fittedAnalysisSegmentRef.current = null;
      return;
    }
    if (fittedAnalysisSegmentRef.current === selectedAnalysisSegmentId) return;

    const L = LRef.current;
    const map = mapInstanceRef.current;
    if (!L || !map) return;
    const coordinates = selectedAnalysisSegmentEdges.flatMap(edge => (
      Array.isArray(edge?.coords) ? edge.coords.map(coord => fixCoord(coord)) : []
    )).filter(coord => Array.isArray(coord) && coord.length >= 2 && coord.every(Number.isFinite));
    if (!coordinates.length) return;

    const bounds = L.latLngBounds(coordinates);
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [65, 65], maxZoom: ANALYSIS_SELECTION_MAX_ZOOM, animate: true });
    fittedAnalysisSegmentRef.current = selectedAnalysisSegmentId;
  }, [selectedAnalysisSegmentId, selectedAnalysisSegmentEdges]);

  // Dibujar puntos de falla y agrupar únicamente los que se pisan visualmente.
  useEffect(() => {
    const L = LRef.current;
    if (!L || !mapInstanceRef.current) return;

    const map = mapInstanceRef.current;
    const pointsGroup = pointsLayerGroupRef.current;
    const spiderGroup = spiderLayerGroupRef.current;
    clearSpiderfyRef.current();
    pointsGroup.clearLayers();
    spiderGroup.clearLayers();
    pointMarkersRef.current = [];
    overlapGroupsRef.current = new Map();
    activeSpiderGroupRef.current = null;

    const createPointIcon = (item) => L.divIcon({
      className: 'fault-point-wrapper',
      html: `<div class="fault-marker" style="background-color: ${safeMarkerColor(item.markerBg, '#d32f2f')}; color: ${safeMarkerColor(item.markerTextColor, '#ffffff')}; border-radius: 50%; width: 26px; height: 26px; display: flex; justify-content: center; align-items: center; font-weight: bold; font-size: 12px; border: 2px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.6);">${escapeHtml(item.displayNum)}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    const buildPopupContent = (item) => {
      const { pt, displayNum, subIdx, coordsCount, causeCat } = item;
      const subInfo = coordsCount > 1 ? ` (Punto ${subIdx + 1} de ${coordsCount})` : '';
      const linkCroquis = safeExternalNavigationUrl(pt.linkCroquis || pt.link_croquis || pt.croquis || '');
      const croquisHtml = linkCroquis
        ? `<div style="margin-top: 8px;">
            <a href="${escapeHtml(linkCroquis)}" target="_blank" rel="noopener noreferrer" style="display: block; width: 100%; text-align: center; padding: 6px 8px; background: #00897b; color: white; border-radius: 4px; font-weight: bold; text-decoration: none; box-sizing: border-box;">
              🗺️ Abrir Link del Croquis (PDF) ↗
            </a>
           </div>`
        : '<p style="margin: 4px 0; color: #888; font-style: italic;">Sin Link de Croquis</p>';
      const notaHtml = pt.nota ? `<p style="margin: 3px 0;"><b>📝 Nota Específica:</b> ${escapeHtml(pt.nota)}</p>` : '';
      const relocationHtml = pt.relocatedViaClient
        ? '<p style="margin: 4px 0; color: #00695c;"><b>Ubicación ajustada desde suministro</b></p>'
        : '';
      const horaHtml = pt.horaInicio ? `<p style="margin: 3px 0;"><b>🕒 Hora de Inicio:</b> ${escapeHtml(pt.horaInicio)}</p>` : '';
      const causaBadge = `<span style="display: inline-block; background-color: ${safeMarkerColor(causeCat.color, '#607d8b')}; color: ${safeMarkerColor(causeCat.textColor, '#ffffff')}; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 10px; margin-left: 4px;">${escapeHtml(causeCat.label)}</span>`;
      const causaHtml = `<p style="margin: 3px 0;"><b>💡 Causa:</b> ${escapeHtml(pt.causa || causeCat.label)} ${causaBadge}</p>`;
      const safePhotos = (pt.fotos || []).map(photo => ({
        name: escapeHtml(photo?.name || 'Foto'),
        source: safeExternalImageSource(photo?.url),
        href: safeExternalNavigationUrl(photo?.url)
      })).filter(photo => photo.source);
      const fotosHtml = safePhotos.length > 0
        ? `<div style="display:flex; gap:4px; margin-top:6px; overflow-x:auto;">
            ${safePhotos.map(photo => photo.href
              ? `<a href="${escapeHtml(photo.href)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(photo.source)}" style="width:45px; height:45px; object-fit:cover; border-radius:4px; border:1px solid #0077c2;" title="${photo.name}"></a>`
              : `<img src="${escapeHtml(photo.source)}" style="width:45px; height:45px; object-fit:cover; border-radius:4px; border:1px solid #0077c2;" title="${photo.name}">`).join('')}
           </div>`
        : '';

      return `
        <div style="min-width: 220px; max-width: 280px; font-size: 11px; line-height: 1.4;">
          <h4 style="margin: 0 0 6px 0; border-bottom: 1px solid #ccc; padding-bottom: 4px; color:#d32f2f;">📍 Falla #${escapeHtml(displayNum)}${escapeHtml(subInfo)}</h4>
          <p style="margin: 3px 0;"><b>Ticket:</b> ${escapeHtml(pt.ticket || '-')}</p>
          ${horaHtml}
          <p style="margin: 3px 0;"><b>Falla Real:</b> ${escapeHtml(pt.falla || pt.fallaReal || '-')}</p>
          ${causaHtml}
          <p style="margin: 3px 0;"><b>Suministro:</b> ${escapeHtml(pt.suministro || '-')}</p>
          ${relocationHtml}
          ${notaHtml}
          ${croquisHtml}
          ${fotosHtml}
          ${!isPresentationMode && isEditable ? `<button class="edit-btn-popup" data-id="${escapeHtml(pt.originalIndex)}" style="margin-top: 8px; width: 100%; padding: 5px; background: #0288d1; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight:bold;">📝 Editar Datos / Fotos</button>` : ''}
        </div>
      `;
    };

    const createIndividualMarker = (item, markerCoord, targetLayer) => {
      const marker = L.marker(markerCoord, { icon: createPointIcon(item) }).addTo(targetLayer);
      marker.bindPopup(buildPopupContent(item));
      marker.on('click', () => {
        if (!isPresentationMode && isEditable && onPointClick) onPointClick(item.pt.originalIndex);
      });
      return marker;
    };

    const clearSpiderfy = () => {
      spiderGroup.clearLayers();
      activeSpiderGroupRef.current = null;
    };

    const openSpiderfy = (groupId, preferredItemKey = null) => {
      const group = overlapGroupsRef.current.get(groupId);
      if (!group) return;
      if (activeSpiderGroupRef.current === groupId && !preferredItemKey) {
        clearSpiderfy();
        return;
      }

      clearSpiderfy();
      activeSpiderGroupRef.current = groupId;
      const centerPoint = map.latLngToLayerPoint(group.centerLatLng);
      const positions = getSpiderfyPositions(centerPoint, group.items.length);
      let preferredMarker = null;

      group.items.forEach((item, index) => {
        const visualLatLng = map.layerPointToLatLng(positions[index]);
        L.polyline([item.coords, visualLatLng], {
          color: currentTheme === 'dark' ? '#80deea' : '#546e7a',
          weight: 1.25,
          opacity: 0.8,
          interactive: false,
          className: 'fault-spider-leg'
        }).addTo(spiderGroup);
        const marker = createIndividualMarker(item, visualLatLng, spiderGroup);
        marker.setZIndexOffset(3000 + index);
        if (item.key === preferredItemKey) preferredMarker = marker;
      });

      if (preferredMarker) window.setTimeout(() => preferredMarker.openPopup(), 0);
    };

    clearSpiderfyRef.current = clearSpiderfy;
    openSpiderfyRef.current = openSpiderfy;

    if (faultPoints && faultPoints.length > 0) {
      const mapBounds = mapViewport.bounds || map.getBounds();
      const currentZoom = mapViewport.zoom || map.getZoom() || MAP_DEFAULT_ZOOM;

      if (!sedId && currentZoom < 8 && faultPoints.length > 10) return;

      const projectedItems = [];
      faultPoints.forEach((pt, pointIndex) => {
        const visibleCoords = pt.mapCoords || pt.coords;
        if (!visibleCoords) return;
        const displayNum = pt.localNumber || pt.number || '';
        let coordsList = [];
        if (Array.isArray(visibleCoords)) {
          coordsList = Array.isArray(visibleCoords[0]) ? visibleCoords.map(c => fixCoord(c)) : [fixCoord(visibleCoords)];
        }
        if (coordsList.length === 0) return;

        if (mapBounds && !sedId && faultPoints.length > 15) {
          const isVisible = coordsList.some(c => mapBounds.contains(L.latLng(c[0], c[1])));
          if (!isVisible) return;
        }

        if (coordsList.length > 1) {
          L.polyline(coordsList, {
            color: '#f44336',
            dashArray: '6, 6',
            weight: 2.5,
            opacity: 0.85
          }).addTo(pointsGroup);
        }

        coordsList.forEach((coord, subIdx) => {
          const causeCat = getCauseCategory(pt.causa);
          const pixel = map.latLngToLayerPoint(coord);
          const pointIdentity = getFaultIdentity(pt, pointIndex);
          projectedItems.push({
            key: `${pointIdentity}:point:${subIdx}`,
            pointIdentity,
            pt,
            coords: coord,
            subIdx,
            coordsCount: coordsList.length,
            displayNum,
            causeCat,
            markerBg: causeCat.color,
            markerTextColor: causeCat.textColor || '#ffffff',
            x: pixel.x,
            y: pixel.y
          });
        });
      });

      groupOverlappingPoints(projectedItems).forEach((group) => {
        const faultCount = new Set(group.items.map(item => item.pointIdentity)).size;
        if (group.items.length === 1 || faultCount === 1) {
          group.items.forEach((item) => {
            const marker = createIndividualMarker(item, item.coords, pointsGroup);
            pointMarkersRef.current.push({ ...item, marker, groupId: null });
          });
          return;
        }

        const groupId = group.items.map(item => item.key).sort().join('|');
        const centerLatLng = map.layerPointToLatLng(group.center);
        overlapGroupsRef.current.set(groupId, { ...group, centerLatLng });
        group.items.forEach(item => pointMarkersRef.current.push({ ...item, marker: null, groupId }));

        const groupIcon = L.divIcon({
          className: 'fault-overlap-wrapper',
          html: `<div class="fault-overlap-marker" title="${faultCount} fallas superpuestas">${faultCount}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        });
        const groupMarker = L.marker(centerLatLng, { icon: groupIcon, zIndexOffset: 2500 }).addTo(pointsGroup);
        groupMarker.on('click', () => openSpiderfy(groupId));
      });
    }

    return () => clearSpiderfy();
  }, [faultPoints, isPresentationMode, isEditable, onPointClick, mapViewport, sedId, currentTheme]);

  // Manejar modo de añadir punto / reubicar
  useEffect(() => {
    if (!mapRef.current) return;
    if (isAddPointMode || isRelocating) {
      mapRef.current.style.cursor = 'crosshair';
    } else {
      mapRef.current.style.cursor = '';
    }
  }, [isAddPointMode, isRelocating]);

  return (
    <div className={`map-viewer ${isPresentationMode ? 'is-presentation' : 'is-editing'}`} style={{ position: 'relative', width: '100%', height: '100%', '--zoom-control-bottom': `${zoomControlBottom}px` }}>
      <div id="map" ref={mapRef} style={{ width: '100%', height: '100%' }}></div>

      {!hideOverlays && sedId && sedPeriodSummary && (
        <div className="sed-period-summary-overlay" style={{
          position: 'absolute', right: '14px', bottom: '92px', zIndex: 1000,
          padding: '9px 11px', borderRadius: '8px', minWidth: '185px',
          background: currentTheme === 'dark' ? 'rgba(18,25,44,.94)' : 'rgba(255,255,255,.96)',
          color: currentTheme === 'dark' ? '#e0f7fa' : '#1a202c',
          border: `1px solid ${currentTheme === 'dark' ? 'rgba(0,229,255,.3)' : '#cbd5e0'}`,
          fontSize: '10.5px', lineHeight: 1.5
        }}>
          <b>SED {sedId}</b>
          <div>{selectedPeriodLabel}</div>
          <div>Fallas: <strong>{sedPeriodSummary.faultCount}</strong></div>
          <div>Llamadas: <strong>{sedPeriodSummary.callDataAvailable ? sedPeriodSummary.callCount : 'Sin dato'}</strong>{sedPeriodSummary.callDataAvailable && !sedPeriodSummary.callDataComplete ? ' · parcial' : ''}</div>
          <div>Compensación SED (referencia): <strong>{sedPeriodSummary.compensationDataAvailable ? `S/ ${sedPeriodSummary.compensation.toLocaleString('es-PE', { maximumFractionDigits: 2 })}` : 'Sin dato'}</strong>{sedPeriodSummary.compensationDataAvailable && !sedPeriodSummary.compensationDataComplete ? ' · parcial' : ''}</div>
        </div>
      )}

      {!hideOverlays && circuitNote && (
        <div style={{
          position: 'absolute',
          top: isPresentationMode ? '78px' : '14px',
          left: '14px',
          zIndex: 1000,
          maxWidth: '320px',
          padding: '10px 12px',
          borderRadius: '8px',
          background: currentTheme === 'dark' ? 'rgba(18,25,44,.94)' : 'rgba(255,255,255,.96)',
          color: currentTheme === 'dark' ? '#e0f7fa' : '#1a202c',
          border: `1px solid ${currentTheme === 'dark' ? 'rgba(0,229,255,.35)' : '#9fb3c8'}`,
          boxShadow: 'none',
          fontSize: '11px',
          lineHeight: 1.45,
          transition: 'top 0.3s ease'
        }}>
          <div style={{ fontWeight: 700, marginBottom: '4px', color: 'var(--accent-cyan)' }}><i className="fa-solid fa-clipboard-list"></i> Análisis del circuito</div>
          {circuitNote}
        </div>
      )}

      {!hideOverlays && isSegmentSelectionMode && (
        <div style={{
          position: 'absolute',
          top: isPresentationMode ? (circuitNote ? '180px' : '78px') : (circuitNote ? '120px' : '14px'),
          left: '14px',
          zIndex: 1000,
          padding: '8px 10px',
          borderRadius: '6px',
          background: '#fff8e1',
          border: '1px solid #ffca28',
          color: '#6d4c00',
          fontSize: '11px',
          fontWeight: 600,
          transition: 'top 0.3s ease'
        }}>
          {manualSelectionMessage || 'Haz clic en el tramo inicial y luego en el tramo final.'}
        </div>
      )}

      {!hideOverlays && showFullSedView && sedOverviewLlaves.length > 0 && (
        <div style={{
          position: 'absolute',
          top: isPresentationMode ? '78px' : (circuitNote ? '120px' : '14px'),
          right: '14px',
          zIndex: 1000,
          maxWidth: '280px',
          maxHeight: '38vh',
          overflowY: 'auto',
          padding: '9px 11px',
          borderRadius: '8px',
          background: currentTheme === 'dark' ? 'rgba(18,25,44,.94)' : 'rgba(255,255,255,.96)',
          color: currentTheme === 'dark' ? '#e0f7fa' : '#1a202c',
          border: `1px solid ${currentTheme === 'dark' ? 'rgba(0,229,255,.3)' : '#cbd5e0'}`,
          fontSize: '10.5px'
        }}>
          <div style={{ fontWeight: 700, marginBottom: '6px' }}>Llaves de la SED</div>
          {sedOverviewLlaves.map(entry => (
            <div key={entry.llaveId} style={{ display: 'flex', gap: '7px', alignItems: 'center', marginTop: '4px', fontWeight: entry.isSelected ? 700 : 400 }}>
              <span style={{ width: 14, height: entry.isSelected ? 5 : 4, background: entry.color, borderRadius: 2 }}></span>
              <span>{entry.llaveId}{entry.isSelected ? ' · seleccionada' : ''}</span>
            </div>
          ))}
        </div>
      )}

      {!hideOverlays && !showFullSedView && cableGroups.length > 0 && (
        <div style={{
          position: 'absolute',
          top: isPresentationMode ? '78px' : (circuitNote ? '120px' : '14px'),
          right: '14px',
          zIndex: 1000,
          maxWidth: '265px',
          padding: '9px 11px',
          borderRadius: '8px',
          background: currentTheme === 'dark' ? 'rgba(18,25,44,.94)' : 'rgba(255,255,255,.96)',
          color: currentTheme === 'dark' ? '#e0f7fa' : '#1a202c',
          border: `1px solid ${currentTheme === 'dark' ? 'rgba(0,229,255,.3)' : '#cbd5e0'}`,
          boxShadow: 'none',
          fontSize: '10.5px',
          transition: 'top 0.3s ease'
        }}>
          <div style={{ fontWeight: 700, marginBottom: '6px' }}><i className="fa-solid fa-cable-car"></i> Calibres del circuito</div>
          {cableGroups.map(group => <div key={group.id} style={{ display: 'flex', gap: '7px', alignItems: 'center', marginTop: '4px' }}><span style={{ width: 14, height: 4, background: group.color, borderRadius: 2 }}></span><span><b>{group.calibre}</b>{group.name ? ` · ${group.name}` : ''}{group.note ? ` · ${group.note}` : ''} ({Number(group.distance || 0).toFixed(0)} m)</span></div>)}
        </div>
      )}

      {/* Leyenda de Causas de Falla */}
      {!hideOverlays && <div className="map-legend-container" style={{
        position: 'absolute',
        bottom: '24px',
        left: '12px',
        zIndex: 1000,
        background: currentTheme === 'dark' ? 'rgba(18, 25, 44, 0.92)' : 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(8px)',
        border: `1px solid ${currentTheme === 'dark' ? 'rgba(0, 229, 255, 0.3)' : '#cbd5e0'}`,
        borderRadius: '8px',
        boxShadow: 'none',
        padding: showLegend ? '10px 12px' : '6px 10px',
        maxWidth: '250px',
        transition: 'all 0.2s ease',
        color: currentTheme === 'dark' ? '#e0f7fa' : '#1a202c',
        fontSize: '11px',
        userSelect: 'none'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justify: 'space-between',
          cursor: 'pointer',
          fontWeight: 'bold',
          fontSize: '11.5px',
          borderBottom: showLegend ? `1px solid ${currentTheme === 'dark' ? 'rgba(255,255,255,0.1)' : '#e2e8f0'}` : 'none',
          paddingBottom: showLegend ? '6px' : '0',
          marginBottom: showLegend ? '8px' : '0'
        }} onClick={() => setShowLegend(!showLegend)}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <i className="fa-solid fa-chart-simple" style={{ color: 'var(--accent-cyan)' }}></i> Causas · {faultPoints?.length || 0} fallas
          </span>
          <span style={{ fontSize: '10px', marginLeft: '8px', color: 'var(--accent-cyan)' }}>
            {showLegend ? '▼' : '▲'}
          </span>
        </div>

        {showLegend && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '220px', overflowY: 'auto' }}>
            {FAULT_CAUSES.map(cause => (
              <div key={cause.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  backgroundColor: cause.color,
                  border: '1px solid rgba(0,0,0,0.25)',
                  flexShrink: 0,
                  boxShadow: '0 0 3px rgba(0,0,0,0.3)'
                }}></span>
                <span style={{ fontSize: '10.5px', fontWeight: 500, flex: 1 }}>{cause.label}</span><b>{faultCauseCounts[cause.id] || 0}</b>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderTop: `1px dashed ${currentTheme === 'dark' ? 'rgba(255,255,255,0.15)' : '#e2e8f0'}`, paddingTop: '4px', marginTop: '2px' }}>
              <span style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: DEFAULT_CAUSE_COLOR.color,
                border: '1px solid rgba(0,0,0,0.25)',
                flexShrink: 0,
                boxShadow: '0 0 3px rgba(0,0,0,0.3)'
              }}></span>
              <span style={{ fontSize: '10.5px', fontStyle: 'italic', color: currentTheme === 'dark' ? '#90a4ae' : '#64748b' }}>
                {DEFAULT_CAUSE_COLOR.label}
              </span>
              <b>{faultCauseCounts[DEFAULT_CAUSE_COLOR.id] || 0}</b>
            </div>
          </div>
        )}
      </div>}
    </div>
  );

});

MapViewer.displayName = 'MapViewer';
export default MapViewer;
