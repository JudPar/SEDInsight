export function normalizeSedIdParam(value) {
  if (typeof value !== 'string') return null;
  const sedId = value.trim();
  if (!sedId || sedId.length > 120 || /[\u0000-\u001f\u007f]/.test(sedId)) return null;
  return sedId;
}

export function buildSedPath(sedId) {
  const normalized = normalizeSedIdParam(sedId);
  return normalized ? `/sed/${encodeURIComponent(normalized)}` : '/';
}

export function buildSedUrl(origin, sedId) {
  const normalizedOrigin = String(origin || '').replace(/\/$/, '');
  return `${normalizedOrigin}${buildSedPath(sedId)}`;
}

export function replaceBrowserPath(nextPath, browserWindow = globalThis.window) {
  if (!browserWindow?.history || !browserWindow?.location) return false;
  if (browserWindow.location.pathname === nextPath) return false;
  browserWindow.history.replaceState(browserWindow.history.state, '', nextPath);
  return true;
}

export function resolveSedDeepLink(seds, requestedSedId) {
  const sedId = normalizeSedIdParam(requestedSedId);
  const found = Boolean(sedId && Object.hasOwn(seds || {}, sedId));
  return {
    sedId: found ? sedId : null,
    found,
    notice: found ? '' : 'La SED solicitada no se encuentra en la Base Principal.'
  };
}
