'use client';

export default function DataSourceBadge({ dataSource, onCloseLocalProject }) {
  const isLocal = dataSource?.kind === 'LOCAL_PROJECT' || dataSource?.kind === 'LOCAL_WORKSPACE';
  const isLocalWorkspace = dataSource?.kind === 'LOCAL_WORKSPACE';
  const sourceLabel = isLocal
    ? `Proyecto local — ${dataSource?.projectName || 'Sin nombre'} — ${isLocalWorkspace ? 'Edición local (sin Supabase)' : 'Solo lectura'}`
    : 'Base Principal — Supabase';
  return (
    <div className={`data-source-badge ${isLocal ? 'is-local' : 'is-supabase'} ${isLocalWorkspace ? 'is-editable-local' : ''}`} role="status">
      <span><i className={`fa-solid ${isLocalWorkspace ? 'fa-file-pen' : isLocal ? 'fa-file-shield' : 'fa-cloud'}`}></i> {sourceLabel}</span>
      {isLocal && onCloseLocalProject && (
        <button type="button" onClick={onCloseLocalProject}>Cerrar proyecto local</button>
      )}
    </div>
  );
}
