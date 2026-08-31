'use client';

export default function DataSourceBadge({ dataSource, onCloseLocalProject }) {
  const isLocal = dataSource?.kind === 'LOCAL_PROJECT';
  return (
    <div className={`data-source-badge ${isLocal ? 'is-local' : 'is-supabase'}`} role="status">
      <span><i className={`fa-solid ${isLocal ? 'fa-file-shield' : 'fa-cloud'}`}></i> {isLocal ? `Proyecto local — ${dataSource?.projectName || 'Sin nombre'} — Solo lectura` : 'Base Principal — Supabase'}</span>
      {isLocal && onCloseLocalProject && (
        <button type="button" onClick={onCloseLocalProject}>Cerrar proyecto local</button>
      )}
    </div>
  );
}
