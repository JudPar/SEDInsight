'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getLifecycleTechnicalDetails } from '@/lib/projectStaging';
import { parseAndValidateProjectInputText, validateProject } from '@/lib/projectValidation';

const WORKER_THRESHOLD = 1024 * 1024;
const MAX_PROJECT_BYTES = 100 * 1024 * 1024;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function parseInWorker(text) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/projectParser.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(Object.assign(new Error(event.data.error.message), { code: event.data.error.code }));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('No se pudo iniciar el validador de proyectos.'));
    };
    worker.postMessage({ text });
  });
}

export default function ProjectPanel({
  expanded = false,
  onSectionToggle,
  sectionRef,
  dataSource,
  localProjects = [],
  hasData,
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
  onMajorOverlayChange
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputMode, setInputMode] = useState('file');
  const [selectedFile, setSelectedFile] = useState(null);
  const [pasteStats, setPasteStats] = useState({ chars: 0, bytes: 0 });
  const [phase, setPhase] = useState('idle');
  const [result, setResult] = useState(null);
  const [parseError, setParseError] = useState('');
  const [databaseState, setDatabaseState] = useState({ phase: 'idle', counts: null, error: '' });
  const [importProgress, setImportProgress] = useState(null);
  const [staging, setStaging] = useState(null);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [replacementText, setReplacementText] = useState('');
  const [lifecycleError, setLifecycleError] = useState('');
  const [catalogAction, setCatalogAction] = useState({ projectId: '', error: '' });
  const [deleteDialog, setDeleteDialog] = useState({ open: false, phase: 'idle', counts: null, backup: false, text: '', error: '', technicalDetails: null });
  const textareaRef = useRef(null);

  useEffect(() => {
    onMajorOverlayChange?.('project-open', isOpen || deleteDialog.open);
    return () => onMajorOverlayChange?.('project-open', false);
  }, [isOpen, deleteDialog.open, onMajorOverlayChange]);

  const resetValidation = useCallback(() => {
    setResult(null);
    setParseError('');
    setPhase('idle');
    setDatabaseState({ phase: 'idle', counts: null, error: '' });
    setImportProgress(null);
    setStaging(null);
    setReplacementConfirmed(false);
    setReplacementText('');
    setLifecycleError('');
  }, []);

  const closeModal = async ({ force = false, skipStagingDiscard = false } = {}) => {
    if (!force && ['staging', 'finalizing', 'cleanup'].includes(phase)) return;
    if (!skipStagingDiscard && staging?.importId) {
      try {
        await onDiscardStaging(staging.importId);
      } catch (error) {
        setLifecycleError(error?.message || 'No se pudo descartar el staging.');
        return;
      }
    }
    setIsOpen(false);
    setSelectedFile(null);
    setPasteStats({ chars: 0, bytes: 0 });
    if (textareaRef.current) textareaRef.current.value = '';
    resetValidation();
  };

  const checkMainDatabaseForProject = async () => {
    setDatabaseState({ phase: 'checking', counts: null, error: '' });
    try {
      const counts = await onCheckMainDatabase();
      setDatabaseState({ phase: counts.isEmpty ? 'empty' : 'blocked', counts, error: '' });
    } catch (error) {
      setDatabaseState({ phase: 'error', counts: null, error: error?.message || 'No se pudo comprobar la Base Principal.' });
    }
  };

  const processProjectText = async (text, sizeBytes, sourceName) => {
    resetValidation();
    if (sizeBytes > MAX_PROJECT_BYTES) {
      setPhase('error');
      setParseError('El proyecto supera el límite de seguridad de 100 MiB. Reduce las Data URLs embebidas o utiliza referencias externas.');
      return;
    }
    setPhase('parsing');
    try {
      const parsed = text.length >= WORKER_THRESHOLD && typeof Worker !== 'undefined'
        ? await parseInWorker(text)
        : await parseAndValidateProjectInputText(text);
      setPhase('validated');
      setResult({ ...parsed, sizeBytes, sourceName });
      if (parsed.valid && parsed.inputKind === 'GEOPLUZ_PROJECT' && !isLocalWorkspace) {
        await checkMainDatabaseForProject();
      } else if (parsed.valid && parsed.inputKind === 'GEOPLUZ_PROJECT') {
        setDatabaseState({ phase: 'local-only', counts: null, error: '' });
      } else if (parsed.valid) {
        setDatabaseState({ phase: 'legacy', counts: null, error: '' });
      }
    } catch (error) {
      setPhase('error');
      setParseError(error?.message || 'No se pudo leer el proyecto.');
    }
  };

  const handlePrepareActiveLocalProject = async () => {
    setIsOpen(true);
    resetValidation();
    setPhase('parsing');
    try {
      const project = await onGetActiveLocalProject();
      const validation = await validateProject(project);
      const sizeBytes = new Blob([JSON.stringify(project)]).size;
      setResult({ project, inputKind: 'GEOPLUZ_PROJECT', sizeBytes, sourceName: 'Proyecto local activo', ...validation });
      setPhase('validated');
      if (validation.valid) await checkMainDatabaseForProject();
    } catch (error) {
      setPhase('error');
      setParseError(error?.message || 'No se pudo recuperar el proyecto local activo.');
    }
  };

  const handleValidate = async () => {
    if (inputMode === 'file') {
      if (!selectedFile) return setParseError('Selecciona un archivo JSON.');
      if (selectedFile.size > MAX_PROJECT_BYTES) return setParseError('El archivo supera el límite de seguridad de 100 MiB.');
      setPhase('reading');
      try {
        const text = await selectedFile.text();
        await processProjectText(text, selectedFile.size, selectedFile.name);
      } catch {
        setPhase('error');
        setParseError('No se pudo leer el archivo seleccionado.');
      }
      return;
    }

    const text = textareaRef.current?.value || '';
    if (!text.trim()) return setParseError('Pega el contenido JSON completo antes de validar.');
    await processProjectText(text, new Blob([text]).size, 'Texto pegado');
  };

  const handleOpen = async ({ editable = false } = {}) => {
    if (!result?.valid) return;
    setPhase('loading');
    try {
      await onOpenLocalProject(result.project, result, { editable });
      await closeModal({ force: true });
    } catch (error) {
      setPhase('error');
      setParseError(error?.message || 'No se pudo abrir el proyecto local.');
    }
  };

  const handleSwitchCatalogProject = async (projectId, editable) => {
    setCatalogAction({ projectId, error: '' });
    try {
      await onSwitchLocalProject(projectId, { editable });
      setCatalogAction({ projectId: '', error: '' });
    } catch (error) {
      setCatalogAction({ projectId: '', error: error?.message || 'No se pudo abrir la copia local.' });
    }
  };

  const handleRemoveCatalogProject = async (project) => {
    if (!window.confirm(`¿Eliminar "${project.projectName}" de este navegador?\n\nSupabase y el archivo original no se modificarán.`)) return;
    setCatalogAction({ projectId: project.projectId, error: '' });
    try {
      await onRemoveLocalProject(project.projectId);
      setCatalogAction({ projectId: '', error: '' });
    } catch (error) {
      setCatalogAction({ projectId: '', error: error?.message || 'No se pudo eliminar la copia local.' });
    }
  };

  const finalizePreparedProject = async () => {
    if (!result?.valid || staging?.status !== 'ready' || !databaseState.counts) return;
    setPhase('finalizing');
    setLifecycleError('');
    try {
      await onFinalizeProject(staging.importId, databaseState.counts, result.preview.counts);
      setStaging(null);
      await closeModal({ force: true, skipStagingDiscard: true });
    } catch (error) {
      setPhase('validated');
      if (error?.finalized) {
        setStaging(null);
        setDatabaseState({ phase: 'error', counts: error?.counts || null, error: error.message });
      }
      setLifecycleError(error?.message || 'La finalización falló. PostgreSQL conservó el proyecto anterior mediante rollback.');
      if (error?.code === 'CURRENT_COUNTS_CHANGED' && error.counts) {
        setDatabaseState({ phase: error.counts.isEmpty ? 'empty' : 'blocked', counts: error.counts, error: '' });
        setReplacementConfirmed(false);
        setReplacementText('');
      }
    }
  };

  const handleImport = async () => {
    if (databaseState.phase !== 'empty' || staging?.status !== 'ready') return;
    const counts = result.preview.counts;
    const confirmed = window.confirm(`Se importarán a la Base Principal:\n\nSED: ${counts.seds}\nCircuitos: ${counts.llaves}\nFallas: ${counts.fallas}\n\n¿Continuar?`);
    if (!confirmed) {
      await handleDiscardPreparedStaging();
      return;
    }
    await finalizePreparedProject();
  };

  const handlePrepareStaging = async () => {
    if (!result?.valid || !['empty', 'blocked'].includes(databaseState.phase) || staging) return;
    setPhase('staging');
    setLifecycleError('');
    setImportProgress({ phase: 'seds', progress: { seds: 0, llaves: 0, fallas: 0 } });
    try {
      const staged = await onStageProject(result.project, setImportProgress);
      setStaging({ ...staged, status: 'ready' });
      setPhase('validated');
    } catch (error) {
      setPhase('validated');
      if (error?.importId) setStaging({ importId: error.importId, status: 'failed', progress: error.progress });
      setLifecycleError(`${error?.message || 'No se pudo preparar staging.'}${error?.cleanupSucceeded ? ' El staging parcial fue limpiado automáticamente.' : error?.importId ? ' La limpieza automática falló; descarta esta carga antes de continuar.' : ''}`);
    }
  };

  const handleDiscardPreparedStaging = async () => {
    if (!staging?.importId) return;
    setPhase('cleanup');
    setLifecycleError('');
    try {
      await onDiscardStaging(staging.importId);
      setStaging(null);
      setImportProgress(null);
      setReplacementConfirmed(false);
      setReplacementText('');
      setPhase('validated');
    } catch (error) {
      setPhase('validated');
      setLifecycleError(error?.message || 'No se pudo descartar staging.');
    }
  };

  const handleReplace = async () => {
    if (staging?.status !== 'ready' || !replacementConfirmed || replacementText !== 'REEMPLAZAR') return;
    await finalizePreparedProject();
  };

  const openDeleteDialog = async () => {
    setDeleteDialog({ open: true, phase: 'checking', counts: null, backup: false, text: '', error: '', technicalDetails: null });
    try {
      const counts = await onCheckMainDatabase();
      setDeleteDialog({ open: true, phase: 'ready', counts, backup: false, text: '', error: '', technicalDetails: null });
    } catch (error) {
      setDeleteDialog(current => ({ ...current, phase: 'error', error: error?.message || 'No se pudieron comprobar los conteos.' }));
    }
  };

  const handleDeleteCurrent = async () => {
    if (!deleteDialog.backup || deleteDialog.text !== 'BORRAR' || !deleteDialog.counts) return;
    setDeleteDialog(current => ({ ...current, phase: 'deleting', error: '', technicalDetails: null }));
    try {
      await onDeleteMainProject(deleteDialog.counts);
      setDeleteDialog({ open: false, phase: 'idle', counts: null, backup: false, text: '', error: '', technicalDetails: null });
    } catch (error) {
      setDeleteDialog(current => ({
        ...current,
        phase: 'ready',
        counts: error?.counts || current.counts,
        backup: false,
        text: '',
        error: error?.message || 'El borrado falló. PostgreSQL revirtió la transacción.',
        technicalDetails: getLifecycleTechnicalDetails(error)
      }));
    }
  };

  const isLocal = dataSource?.kind === 'LOCAL_PROJECT' || dataSource?.kind === 'LOCAL_WORKSPACE';
  const isLocalWorkspace = dataSource?.kind === 'LOCAL_WORKSPACE';
  const preview = result?.preview;

  return (
    <>
      <details ref={sectionRef} className="sidebar-section" open={expanded}>
        <summary onClick={(event) => { event.preventDefault(); onSectionToggle?.(); }}><span><i className="fa-solid fa-box-archive"></i> Proyectos</span><i className="fa-solid fa-chevron-down section-chevron"></i></summary>
        <div className="section-block project-actions">
          <div className="card-title"><i className="fa-solid fa-diagram-project"></i> Proyecto completo</div>
          {isLocal && <div className={`project-local-mode ${isLocalWorkspace ? 'is-editable' : ''}`}>
            <i className={`fa-solid ${isLocalWorkspace ? 'fa-file-pen' : 'fa-file-shield'}`}></i>
            <span>{isLocalWorkspace ? 'Copia editable local' : 'Proyecto local en consulta'}</span>
          </div>}
          <div className="project-catalog" aria-label="Proyectos disponibles en este navegador">
            <div className={`project-catalog-row is-main ${!isLocal ? 'is-active' : ''}`}>
              <div><strong>Base Principal</strong><span>Supabase</span></div>
              <button className="btn btn-outline" disabled={!isLocal || Boolean(catalogAction.projectId)} onClick={() => onCloseLocalProject()}>
                {!isLocal ? 'Actual' : 'Abrir'}
              </button>
            </div>
            {localProjects.map(project => {
              const isActive = isLocal && dataSource?.projectId === project.projectId;
              const isBusy = catalogAction.projectId === project.projectId;
              return <div key={project.projectId} className={`project-catalog-row ${isActive ? 'is-active' : ''}`}>
                <div className="project-catalog-info">
                  <strong title={project.projectName}>{project.projectName}</strong>
                  <span>SED {project.counts?.seds || 0} · Circuitos {project.counts?.llaves || 0} · Fallas {project.counts?.fallas || 0}</span>
                </div>
                <div className="project-catalog-actions">
                  <button className="btn btn-green" disabled={isBusy || (isActive && isLocalWorkspace)} onClick={() => handleSwitchCatalogProject(project.projectId, true)}>{isActive && isLocalWorkspace ? 'Editando' : 'Editar'}</button>
                  <button className="btn btn-outline" disabled={isBusy || (isActive && !isLocalWorkspace)} onClick={() => handleSwitchCatalogProject(project.projectId, false)}>{isActive && !isLocalWorkspace ? 'Consultando' : 'Consultar'}</button>
                  <button className="project-catalog-remove" disabled={isBusy} onClick={() => handleRemoveCatalogProject(project)} title="Eliminar solo de este navegador"><i className="fa-solid fa-trash-can"></i></button>
                </div>
              </div>;
            })}
            {localProjects.length === 0 && <p className="project-catalog-empty">Todavía no hay copias locales guardadas.</p>}
          </div>
          {catalogAction.error && <div className="project-validation-errors" role="alert"><strong>No se pudo cambiar de proyecto</strong><p>{catalogAction.error}</p></div>}
          <button className="btn btn-green" onClick={onDownloadProject} disabled={!hasData}>
            <i className="fa-solid fa-download"></i> Descargar proyecto
          </button>
          <button className="btn btn-cyan" onClick={() => setIsOpen(true)}>
            <i className="fa-solid fa-folder-open"></i> Abrir proyecto
          </button>
          {isLocal && (
            <>
              {!isLocalWorkspace && <button className="btn btn-orange" onClick={handlePrepareActiveLocalProject}>
                <i className="fa-solid fa-arrows-rotate"></i> Reemplazar Base Principal por este proyecto
              </button>}
              <button className="btn btn-outline" onClick={onCloseLocalProject}>
                <i className="fa-solid fa-cloud-arrow-left"></i> Cerrar proyecto local
              </button>
            </>
          )}
          {!isLocal && <button className="btn btn-outline project-delete-button" onClick={openDeleteDialog}>
            <i className="fa-solid fa-trash-can"></i> Borrar proyecto actual
          </button>}
          <p className="project-help">Puedes abrir un proyecto en consulta o como copia editable. La copia editable se guarda solo en este navegador y no modifica Supabase; descárgala para llevarla a otra computadora.</p>
        </div>
      </details>

      {isOpen && (
        <div className="modal-backdrop active project-open-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
          <div className="point-form-modal project-open-modal">
            <div className="modal-heading">
              <div><h3>Abrir proyecto GEOPLUZ</h3><span>Validación previa · importación solo con Base Principal vacía</span></div>
              <button className="icon-button" onClick={() => closeModal()} title="Cerrar"><i className="fa-solid fa-xmark"></i></button>
            </div>

            <div className="project-input-tabs">
              <button disabled={Boolean(staging)} className={inputMode === 'file' ? 'active' : ''} onClick={() => { setInputMode('file'); resetValidation(); }}><i className="fa-solid fa-file"></i> Seleccionar JSON</button>
              <button disabled={Boolean(staging)} className={inputMode === 'paste' ? 'active' : ''} onClick={() => { setInputMode('paste'); resetValidation(); }}><i className="fa-solid fa-paste"></i> Pegar JSON</button>
            </div>

            {inputMode === 'file' ? (
              <div className="project-input-area">
                <input disabled={Boolean(staging)} type="file" accept=".json,application/json" onChange={(event) => { setSelectedFile(event.target.files?.[0] || null); resetValidation(); }} />
                <span>{selectedFile ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}` : 'Ningún archivo seleccionado'}</span>
              </div>
            ) : (
              <div className="project-input-area">
                <textarea
                  ref={textareaRef}
                  disabled={Boolean(staging)}
                  className="input-control project-json-textarea"
                  placeholder="Pega aquí el proyecto JSON completo"
                  onInput={(event) => {
                    const value = event.currentTarget.value;
                    setPasteStats({ chars: value.length, bytes: new Blob([value]).size });
                    resetValidation();
                  }}
                />
                <span>{pasteStats.chars.toLocaleString()} caracteres · {formatBytes(pasteStats.bytes)}</span>
              </div>
            )}

            <button className="btn btn-cyan" onClick={handleValidate} disabled={Boolean(staging) || ['reading', 'parsing', 'loading', 'staging', 'finalizing', 'cleanup'].includes(phase)}>
              <i className={`fa-solid ${['reading', 'parsing'].includes(phase) ? 'fa-spinner fa-spin' : 'fa-shield-halved'}`}></i>
              {phase === 'reading' ? ' Leyendo…' : phase === 'parsing' ? ' Parseando y validando…' : ' Validar proyecto'}
            </button>

            {parseError && <div className="project-validation-errors" role="alert"><strong>No se pudo validar</strong><p>{parseError}</p></div>}

            {result && (
              <div className={`project-preview ${result.valid ? 'is-valid' : 'is-invalid'}`}>
                <h4>{result.valid ? 'Proyecto válido' : 'Proyecto con errores'}</h4>
                {preview && <div className="project-preview-grid">
                  <span>Proyecto</span><b>{preview.projectName}</b>
                  <span>Formato</span><b>{preview.format}</b>
                  <span>Versión</span><b>{preview.version}</b>
                  <span>SED</span><b>{preview.counts.seds}</b>
                  <span>Circuitos</span><b>{preview.counts.llaves}</b>
                  <span>Fallas</span><b>{preview.counts.fallas}</b>
                  <span>Referencias externas</span><b>{preview.externalReferences}</b>
                  <span>Relaciones no resueltas</span><b>{preview.unresolvedRelations}</b>
                  <span>Tamaño</span><b>{formatBytes(result.sizeBytes)}</b>
                </div>}
                {result.errors.length > 0 && <ul className="project-message-list errors">{result.errors.slice(0, 20).map((item, index) => <li key={`${item.code}-${index}`}><code>{item.path}</code> {item.message}</li>)}</ul>}
                {result.warnings.length > 0 && <ul className="project-message-list warnings">{result.warnings.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}</ul>}
                {result.valid && databaseState.phase === 'checking' && <div className="project-database-state"><i className="fa-solid fa-spinner fa-spin"></i> Comprobando conteos reales de Supabase…</div>}
                {result.valid && databaseState.phase === 'empty' && <div className="project-database-state is-empty"><strong>Base Principal vacía</strong><span>SED: 0 · Circuitos: 0 · Fallas: 0</span></div>}
                {result.valid && databaseState.phase === 'blocked' && <div className="project-database-state is-blocked">
                  <strong>La Base Principal ya contiene datos.</strong>
                  <span>SED: {databaseState.counts.seds} · Circuitos: {databaseState.counts.llaves} · Fallas: {databaseState.counts.fallas}</span>
                  <p>El proyecto nuevo debe prepararse en staging antes de reemplazar la Base Principal transaccionalmente.</p>
                </div>}
                {result.valid && databaseState.phase === 'error' && <div className="project-database-state is-blocked"><strong>No se pudo habilitar la importación</strong><p>{databaseState.error}</p></div>}
                {result.valid && databaseState.phase === 'legacy' && <div className="project-database-state is-blocked"><p>Una exportación legacy puede abrirse localmente, pero no importarse como proyecto completo.</p></div>}
                {result.valid && databaseState.phase === 'local-only' && <div className="project-database-state is-empty"><strong>Espacio de trabajo local</strong><p>Este proyecto se abrirá sin preparar staging ni modificar Supabase.</p></div>}
                {lifecycleError && <div className="project-validation-errors" role="alert"><strong>Operación de proyecto detenida</strong><p>{lifecycleError}</p></div>}
                {result.valid && ['empty', 'blocked'].includes(databaseState.phase) && !staging && <button className="btn btn-orange" onClick={handlePrepareStaging} disabled={phase === 'staging'}>
                  <i className="fa-solid fa-layer-group"></i> {databaseState.phase === 'empty' ? 'Preparar importación segura en staging' : 'Preparar reemplazo seguro en staging'}
                </button>}
                {importProgress && phase === 'staging' && <div className="project-import-progress"><i className="fa-solid fa-spinner fa-spin"></i> {importProgress.phase === 'validation' ? 'Validando staging' : `Cargando staging: ${importProgress.phase}`} · SED {importProgress.progress.seds}, circuitos {importProgress.progress.llaves}, fallas {importProgress.progress.fallas}</div>}
                {phase === 'finalizing' && <div className="project-import-progress"><i className="fa-solid fa-spinner fa-spin"></i> Finalizando proyecto mediante transacción PostgreSQL…</div>}
                {staging?.status === 'failed' && <div className="project-staging-confirmation">
                  <strong>La carga de staging no quedó válida.</strong>
                  <p>La Base Principal no fue modificada. Descarta únicamente esta carga antes de continuar.</p>
                  <button className="btn btn-outline" onClick={handleDiscardPreparedStaging} disabled={phase === 'cleanup'}>Descartar staging</button>
                </div>}
                {staging?.status === 'ready' && databaseState.phase === 'empty' && <div className="project-staging-confirmation">
                  <h4>Proyecto preparado y validado</h4>
                  <div className="project-database-state is-empty"><strong>Base Principal vacía</strong><span>Se importarán: SED {preview.counts.seds} · Circuitos {preview.counts.llaves} · Fallas {preview.counts.fallas}</span></div>
                  <p>La importación se finalizará mediante la misma RPC transaccional y los mismos locks usados para un reemplazo. El maestro de suministros no se modificará.</p>
                  <div className="project-final-actions">
                    <button className="btn btn-orange" onClick={handleImport} disabled={phase === 'finalizing'}>{phase === 'finalizing' ? 'Finalizando…' : 'Importar a Base Principal'}</button>
                    <button className="btn btn-outline" onClick={handleDiscardPreparedStaging} disabled={phase === 'finalizing'}>Cancelar y descartar staging</button>
                  </div>
                </div>}
                {staging?.status === 'ready' && databaseState.phase === 'blocked' && <div className="project-staging-confirmation">
                  <h4>Confirmación fuerte de reemplazo</h4>
                  <div className="project-replacement-comparison">
                    <div><strong>PROYECTO ACTUAL</strong><span>SED: {databaseState.counts.seds}</span><span>Circuitos: {databaseState.counts.llaves}</span><span>Fallas: {databaseState.counts.fallas}</span></div>
                    <div><strong>SERÁ REEMPLAZADO POR</strong><span>{preview.projectName}</span><span>SED: {preview.counts.seds}</span><span>Circuitos: {preview.counts.llaves}</span><span>Fallas: {preview.counts.fallas}</span></div>
                  </div>
                  <p><strong>El maestro de suministros no se modificará.</strong> Descarga primero un respaldo de la Base Principal.</p>
                  <button className="btn btn-green" onClick={() => onDownloadMainProject().catch(error => setLifecycleError(error?.message || 'No se pudo descargar el respaldo.'))}><i className="fa-solid fa-download"></i> Descargar proyecto actual</button>
                  <label className="project-strong-check"><input type="checkbox" checked={replacementConfirmed} onChange={event => setReplacementConfirmed(event.target.checked)} /> He guardado un respaldo del proyecto actual.</label>
                  <label>Escribe <b>REEMPLAZAR</b><input className="input-control" value={replacementText} onChange={event => setReplacementText(event.target.value)} autoComplete="off" /></label>
                  <div className="project-final-actions">
                    <button className="btn btn-orange" onClick={handleReplace} disabled={!replacementConfirmed || replacementText !== 'REEMPLAZAR' || phase === 'finalizing'}>{phase === 'finalizing' ? 'Finalizando…' : 'Reemplazar Base Principal'}</button>
                    <button className="btn btn-outline" onClick={handleDiscardPreparedStaging} disabled={phase === 'finalizing'}>Cancelar y descartar staging</button>
                  </div>
                </div>}
                {result.valid && <div className="project-final-actions project-open-mode-actions">
                  <button className="btn btn-outline" onClick={() => handleOpen({ editable: false })} disabled={Boolean(staging) || ['loading', 'staging', 'finalizing'].includes(phase)}><i className="fa-solid fa-eye"></i> {phase === 'loading' ? ' Abriendo…' : ' Abrir en consulta'}</button>
                  <button className="btn btn-green" onClick={() => handleOpen({ editable: true })} disabled={Boolean(staging) || ['loading', 'staging', 'finalizing'].includes(phase)}><i className="fa-solid fa-file-pen"></i> {phase === 'loading' ? ' Abriendo…' : ' Abrir copia editable'}</button>
                  <button className="btn btn-outline" onClick={() => closeModal()} disabled={['staging', 'finalizing', 'cleanup'].includes(phase)}>Cancelar</button>
                </div>}
              </div>
            )}
          </div>
        </div>
      )}
      {deleteDialog.open && (
        <div className="modal-backdrop active project-open-backdrop">
          <div className="point-form-modal project-delete-modal">
            <div className="modal-heading"><div><h3>Borrar proyecto actual</h3><span>Operación transaccional sobre la Base Principal</span></div></div>
            {deleteDialog.phase === 'checking' && <div className="project-database-state"><i className="fa-solid fa-spinner fa-spin"></i> Consultando conteos reales…</div>}
            {deleteDialog.error && <div className="project-validation-errors" role="alert"><strong>Operación detenida</strong><p>{deleteDialog.error}</p></div>}
            {deleteDialog.technicalDetails && <details className="project-technical-error">
              <summary>Detalle técnico</summary>
              <dl>
                {Object.entries(deleteDialog.technicalDetails).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}
              </dl>
            </details>}
            {deleteDialog.counts && <>
              <div className="project-database-state is-blocked"><strong>Se eliminarán únicamente los datos del proyecto</strong><span>SED: {deleteDialog.counts.seds} · Circuitos: {deleteDialog.counts.llaves} · Fallas: {deleteDialog.counts.fallas}</span><p>El maestro de suministros no será eliminado.</p></div>
              <button className="btn btn-green" onClick={() => onDownloadMainProject().catch(error => setDeleteDialog(current => ({ ...current, error: error?.message || 'No se pudo descargar el respaldo.' })))}><i className="fa-solid fa-download"></i> Descargar proyecto actual</button>
              <label className="project-strong-check"><input type="checkbox" checked={deleteDialog.backup} onChange={event => setDeleteDialog(current => ({ ...current, backup: event.target.checked }))} /> He guardado un respaldo del proyecto actual.</label>
              <label>Escribe <b>BORRAR</b><input className="input-control" value={deleteDialog.text} onChange={event => setDeleteDialog(current => ({ ...current, text: event.target.value }))} autoComplete="off" /></label>
            </>}
            <div className="project-final-actions">
              {deleteDialog.counts && <button className="btn btn-danger" onClick={handleDeleteCurrent} disabled={!deleteDialog.backup || deleteDialog.text !== 'BORRAR' || deleteDialog.phase === 'deleting'}>{deleteDialog.phase === 'deleting' ? 'Borrando…' : 'Borrar proyecto actual'}</button>}
              <button className="btn btn-outline" disabled={deleteDialog.phase === 'deleting'} onClick={() => setDeleteDialog({ open: false, phase: 'idle', counts: null, backup: false, text: '', error: '', technicalDetails: null })}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
