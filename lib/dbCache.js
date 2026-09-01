// lib/dbCache.js
// Utilidad de Caché local con IndexedDB para evitar solicitudes excesivas a Supabase

const DB_NAME = 'GeoPluzCacheDB';
const DB_VERSION = 1;
const STORE_NAME = 'geopluz_store';

function openDB() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        } catch (err) {
          console.warn('IndexedDB upgrade error:', err);
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = () => resolve(null);
    } catch (err) {
      console.warn('IndexedDB open error:', err);
      resolve(null);
    }
  });
}

export async function getFromCache(key) {
  try {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  } catch (err) {
    return null;
  }
}

export async function saveToCache(key, data) {
  try {
    const db = await openDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put({ data, timestamp: Date.now() }, key);
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
      } catch (err) {
        resolve(false);
      }
    });
  } catch (err) {
    return false;
  }
}

export async function clearCache(key) {
  try {
    const db = await openDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        if (key) {
          store.delete(key);
        } else {
          store.clear();
        }
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
      } catch (err) {
        resolve(false);
      }
    });
  } catch (err) {
    return false;
  }
}

// Funciones helpers específicas para SEDS y Llaves
export const SEDS_CACHE_KEY = 'seds_database';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 12; // 12 Horas de Caché

export async function getCachedSeds(maxAgeMs = DEFAULT_TTL_MS) {
  const cached = await getFromCache(SEDS_CACHE_KEY);
  if (!cached || !cached.timestamp || !cached.data) return null;
  const isExpired = Date.now() - cached.timestamp > maxAgeMs;
  if (isExpired) return null;
  return cached.data;
}

export async function setCachedSeds(dbData) {
  await saveToCache(SEDS_CACHE_KEY, dbData);
}

export async function invalidateSedsCache() {
  await clearCache(SEDS_CACHE_KEY);
}

export const ACTIVE_LOCAL_PROJECT_KEY = 'active_local_project';
export const LOCAL_PROJECT_CATALOG_KEY = 'local_project_catalog';
export const getLocalProjectCacheKey = (projectId) => `local_project:${encodeURIComponent(projectId)}`;
export const LOCAL_PROJECT_SESSION_KEY = 'geopluz_local_project_expected';

export function markLocalProjectExpected(project, { editable = false } = {}) {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    sessionStorage.setItem(LOCAL_PROJECT_SESSION_KEY, JSON.stringify({
      projectId: project?.project?.id || 'local-project',
      projectName: project?.project?.name || 'Proyecto local',
      editable: Boolean(editable)
    }));
    return true;
  } catch {
    return false;
  }
}

export function getExpectedLocalProject() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const value = sessionStorage.getItem(LOCAL_PROJECT_SESSION_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function clearExpectedLocalProject() {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.removeItem(LOCAL_PROJECT_SESSION_KEY); } catch { /* sin acción */ }
}

function buildLocalProjectCatalogEntry(project, { editable = false, updatedAt = Date.now() } = {}) {
  return {
    projectId: project?.project?.id,
    projectName: project?.project?.name || 'Proyecto local',
    editable: Boolean(editable),
    updatedAt,
    counts: {
      seds: Number(project?.integrity?.counts?.seds || project?.seds?.length || 0),
      llaves: Number(project?.integrity?.counts?.llaves || project?.llaves?.length || 0),
      fallas: Number(project?.integrity?.counts?.fallas || project?.fallas?.length || 0)
    }
  };
}

export function upsertLocalProjectCatalog(entries, project, options = {}) {
  const entry = buildLocalProjectCatalogEntry(project, options);
  if (!entry.projectId) return Array.isArray(entries) ? entries : [];
  return [...(Array.isArray(entries) ? entries : []).filter(item => item?.projectId !== entry.projectId), entry]
    .sort((a, b) => (Number(b.updatedAt) - Number(a.updatedAt)) || String(a.projectName).localeCompare(String(b.projectName)));
}

export async function listLocalProjects() {
  const catalog = await getFromCache(LOCAL_PROJECT_CATALOG_KEY);
  return Array.isArray(catalog?.data) ? catalog.data : [];
}

export async function getLocalProject(projectId) {
  if (!projectId) return null;
  const stored = await getFromCache(getLocalProjectCacheKey(projectId));
  return stored?.data || null;
}

export async function setActiveLocalProject(project, { editable = false } = {}) {
  const projectId = project?.project?.id;
  if (!projectId) return false;
  const saved = await saveToCache(getLocalProjectCacheKey(projectId), project);
  if (!saved) return false;
  const catalog = upsertLocalProjectCatalog(await listLocalProjects(), project, { editable });
  const catalogSaved = await saveToCache(LOCAL_PROJECT_CATALOG_KEY, catalog);
  if (!catalogSaved) return false;
  return saveToCache(ACTIVE_LOCAL_PROJECT_KEY, { projectId, editable: Boolean(editable) });
}

export async function getActiveLocalProject() {
  const active = await getFromCache(ACTIVE_LOCAL_PROJECT_KEY);
  const projectId = active?.data?.projectId;
  if (!projectId) return null;
  return getLocalProject(projectId);
}

export async function getActiveLocalProjectState() {
  const active = await getFromCache(ACTIVE_LOCAL_PROJECT_KEY);
  const projectId = active?.data?.projectId;
  if (!projectId) return null;
  const project = await getLocalProject(projectId);
  return project ? { project, editable: Boolean(active?.data?.editable) } : null;
}

export async function clearActiveLocalProject() {
  await clearCache(ACTIVE_LOCAL_PROJECT_KEY);
  return true;
}

export async function removeLocalProject(projectId) {
  if (!projectId) return false;
  const active = await getFromCache(ACTIVE_LOCAL_PROJECT_KEY);
  if (active?.data?.projectId === projectId) await clearCache(ACTIVE_LOCAL_PROJECT_KEY);
  await clearCache(getLocalProjectCacheKey(projectId));
  const catalog = (await listLocalProjects()).filter(item => item?.projectId !== projectId);
  return saveToCache(LOCAL_PROJECT_CATALOG_KEY, catalog);
}
