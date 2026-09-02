'use client';

import { useMemo, useState } from 'react';
import { CIRCUIT_STATUSES } from '@/lib/circuitAnalysis';
import SearchableSedSelect from './SearchableSedSelect';
import { sortLlaveIds } from '@/lib/navigationSort';

export default function PresentationHUD({
  sedId,
  llaveName,
  sedsList = [],
  localDatabase = {},
  circuitEntries = [],
  showFullSedView = false,
  showAllLlavesOption = false,
  onSelectSed,
  onSelectLlave,
  currentMapStyle,
  currentTheme = 'light',
  onPrevSed,
  onNextSed,
  onToggleMapStyle,
  onToggleTheme,
  onEnterEditMode
}) {
  const [statusFilter, setStatusFilter] = useState('todos');
  const availableLlaves = useMemo(
    () => sortLlaveIds(Object.keys(localDatabase[sedId]?.llaves || {})),
    [localDatabase, sedId]
  );
  const searchableSeds = useMemo(() => {
    if (statusFilter === 'todos') return localDatabase;
    const matchingSedIds = new Set(
      circuitEntries
        .filter(circuit => circuit.status === statusFilter)
        .map(circuit => circuit.sedId)
    );
    return Object.fromEntries(
      Object.entries(localDatabase).filter(([candidateSedId]) => matchingSedIds.has(candidateSedId))
    );
  }, [circuitEntries, localDatabase, statusFilter]);
  const selectedLlaveValue = showAllLlavesOption && showFullSedView ? '' : (llaveName || '');

  return <div className="presentation-hud">
    <div className="hud-brand"><img src="/PLUZ.png" alt="PLUZ" /><div className="hud-badge"><i className="fa-solid fa-desktop"></i> PRESENTACIÓN</div></div>
    <div className="hud-context">
      {sedsList.length > 0 && <div className="hud-navigation">
        <SearchableSedSelect
          seds={searchableSeds}
          value={sedId || ''}
          onChange={onSelectSed}
          compact
        />
        <select
          className="hud-llave-select"
          value={selectedLlaveValue}
          onChange={event => onSelectLlave?.(event.target.value)}
          disabled={!sedId}
          aria-label="Seleccionar llave"
        >
          {showAllLlavesOption && <option value="">Todas las llaves</option>}
          {availableLlaves.map(llave => <option key={llave} value={llave}>{llave}</option>)}
        </select>
        <select
          className="hud-status-select"
          value={statusFilter}
          onChange={event => setStatusFilter(event.target.value)}
          aria-label="Filtrar por estado"
        >
          <option value="todos">Todos los estados</option>
          {Object.entries(CIRCUIT_STATUSES).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>
      </div>}
    </div>
    <div className="hud-actions">
      <button className="hud-btn" onClick={onPrevSed}><i className="fa-solid fa-chevron-left"></i> SED Ant.</button>
      <button className="hud-btn" onClick={onNextSed}>SED Sig. <i className="fa-solid fa-chevron-right"></i></button>
      <button className="hud-btn" onClick={onToggleMapStyle}><i className={`fa-solid ${currentMapStyle === 'clean' ? 'fa-layer-group' : 'fa-map-location-dot'}`}></i><span>{currentMapStyle === 'clean' ? 'Mapa Limpio' : 'Mapa Detallado'}</span></button>
      <button className="hud-btn" onClick={onToggleTheme} title={currentTheme === 'dark' ? 'Activar modo claro' : 'Activar modo oscuro'}><i className={`fa-solid ${currentTheme === 'dark' ? 'fa-sun' : 'fa-moon'}`}></i><span>{currentTheme === 'dark' ? 'Modo Claro' : 'Modo Oscuro'}</span></button>
      <button className="hud-btn hud-edit-btn" onClick={onEnterEditMode}><i className="fa-solid fa-pen-to-square"></i> Modo Edición</button>
    </div>
  </div>;
}
