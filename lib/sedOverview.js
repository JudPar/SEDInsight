import { isLlaveMatch, isSedMatch } from './sedUtils.js';

const LLAVE_COLORS = Object.freeze([
  '#1565c0', '#7b1fa2', '#00897b', '#ef6c00', '#c62828',
  '#3949ab', '#6d4c41', '#2e7d32', '#ad1457', '#00838f',
  '#5e35b1', '#f9a825'
]);

function faultIdentity(point, index) {
  if (point?.id !== null && point?.id !== undefined) return `id:${point.id}`;
  return `index:${index}`;
}

export function getStableLlaveColor(llaveId) {
  const value = String(llaveId || '');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return LLAVE_COLORS[(hash >>> 0) % LLAVE_COLORS.length];
}

export function buildSedOverviewLlaves(sed = {}, selectedLlaveId = '') {
  return Object.entries(sed?.llaves || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([llaveId, llave]) => ({
      llaveId,
      name: llave?.name || llaveId,
      lines: Array.isArray(llave?.lines) ? llave.lines : [],
      cableGroups: Array.isArray(llave?.analysis?.cableGroups) ? llave.analysis.cableGroups : [],
      color: getStableLlaveColor(llaveId),
      isSelected: llaveId === selectedLlaveId
    }));
}

export function filterFaultsForCircuitView(points = [], {
  sedId = '',
  llaveId = '',
  showFullSed = false,
  knownLlaveIds = []
} = {}) {
  const seen = new Set();
  return (Array.isArray(points) ? points : [])
    .map((point, originalIndex) => ({ ...point, originalIndex }))
    .filter((point) => {
      if (sedId && !isSedMatch(point.sed, point.sedLlave, sedId)) return false;
      if (!showFullSed && !isLlaveMatch(point.llaveSistema, point.sedLlave, llaveId, knownLlaveIds)) return false;
      const identity = faultIdentity(point, point.originalIndex);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .map((point, localIndex) => ({ ...point, localNumber: localIndex + 1 }));
}
