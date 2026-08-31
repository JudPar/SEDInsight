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
export const getLocalProjectCacheKey = (projectId) => `local_project:${encodeURIComponent(projectId)}`;
export const LOCAL_PROJECT_SESSION_KEY = 'geopluz_local_project_expected';

export function markLocalProjectExpected(project) {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    sessionStorage.setItem(LOCAL_PROJECT_SESSION_KEY, JSON.stringify({
      projectId: project?.project?.id || 'local-project',
      projectName: project?.project?.name || 'Proyecto local'
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

export async function setActiveLocalProject(project) {
  const projectId = project?.project?.id;
  if (!projectId) return false;
  const previous = await getFromCache(ACTIVE_LOCAL_PROJECT_KEY);
  const previousProjectId = previous?.data?.projectId;
  if (previousProjectId && previousProjectId !== projectId) {
    await clearCache(getLocalProjectCacheKey(previousProjectId));
  }
  const saved = await saveToCache(getLocalProjectCacheKey(projectId), project);
  if (!saved) return false;
  return saveToCache(ACTIVE_LOCAL_PROJECT_KEY, { projectId });
}

export async function getActiveLocalProject() {
  const active = await getFromCache(ACTIVE_LOCAL_PROJECT_KEY);
  const projectId = active?.data?.projectId;
  if (!projectId) return null;
  const stored = await getFromCache(getLocalProjectCacheKey(projectId));
  return stored?.data || null;
}

export async function clearActiveLocalProject() {
  const active = await getFromCache(ACTIVE_LOCAL_PROJECT_KEY);
  const projectId = active?.data?.projectId;
  if (projectId) await clearCache(getLocalProjectCacheKey(projectId));
  await clearCache(ACTIVE_LOCAL_PROJECT_KEY);
  return true;
}
