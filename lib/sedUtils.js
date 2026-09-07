/**
 * Utilities for flexible SED matching, cleaning, and searching across GEOPLUZ.
 */

/**
 * Canonical identifier used for joins and metrics. It intentionally preserves
 * leading zeroes and does not try to extract a SED from a SED-Llave value.
 */
export function normalizeSedId(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .toUpperCase();
}

export function normalizeLlaveCode(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .toUpperCase();
}

export function canonicalCircuitKey(sedId, llaveCode) {
  const normalizedSedId = normalizeSedId(sedId);
  const normalizedLlaveCode = normalizeLlaveCode(llaveCode);
  return normalizedSedId && normalizedLlaveCode ? `${normalizedSedId}\u0000${normalizedLlaveCode}` : '';
}

/**
 * Normalizes a SED code by stripping "SED", "SUBESTACIÓN", "SUBESTACION", hyphens, and whitespace.
 * e.g., "SED 04487A" -> "04487A", "Subestación-04487A" -> "04487A"
 */
export function cleanSedCode(sedId) {
  if (!sedId) return '';
  return String(sedId)
    .trim()
    .toUpperCase()
    .replace(/^(SUBESTACI[ÓO]N|SUBESTACION|SED)[\s\-_]*/i, '')
    .trim();
}

/**
 * Normalizes a SED code and strips leading zeros.
 * e.g., "04487A" -> "4487A", "004487" -> "4487"
 */
export function cleanSedCodeNoZero(sedId) {
  const cleaned = cleanSedCode(sedId);
  // Keep at least one digit if all zeros
  const stripped = cleaned.replace(/^0+/, '');
  return stripped || cleaned;
}

/**
 * Checks flexibly if a falla record (its sed_id or sed_llave) matches a target SED ID.
 * Resolves discrepancies in "SED" prefixes, leading zeros, case sensitivity, and extra spaces.
 * 
 * @param {string} fallaSed - e.g., "04487A" or "SED 04487A"
 * @param {string} fallaSedLlave - e.g., "04487A-2SP" or "SED 04487A-2SP"
 * @param {string} targetSedId - e.g., "04487A"
 * @returns {boolean}
 */
export function isSedMatch(fallaSed, fallaSedLlave, targetSedId) {
  if (!targetSedId) return true;

  const targetClean = cleanSedCode(targetSedId);
  const targetNoZero = cleanSedCodeNoZero(targetSedId);
  const rawTarget = String(targetSedId).trim().toLowerCase();

  // 1. Direct match with fallaSed
  if (fallaSed) {
    const rawSed = String(fallaSed).trim().toLowerCase();
    const cleanSed = cleanSedCode(fallaSed);
    const cleanNoZero = cleanSedCodeNoZero(fallaSed);

    if (rawSed === rawTarget) return true;
    if (cleanSed && targetClean && cleanSed === targetClean) return true;
    if (cleanNoZero && targetNoZero && cleanNoZero === targetNoZero) return true;
    if (rawSed.includes(rawTarget) || rawTarget.includes(rawSed)) return true;
  }

  // 2. Direct or prefix match with fallaSedLlave (e.g. "04487A-2SP")
  if (fallaSedLlave) {
    const rawLlave = String(fallaSedLlave).trim().toLowerCase();
    const cleanLlave = cleanSedCode(fallaSedLlave);
    const cleanLlaveNoZero = cleanSedCodeNoZero(fallaSedLlave);

    if (rawLlave.includes(rawTarget)) return true;
    if (targetClean && cleanLlave.includes(targetClean)) return true;
    if (targetNoZero && cleanLlaveNoZero.includes(targetNoZero)) return true;

    // Check segment before '-' in sedLlave
    const sedPart = fallaSedLlave.split('-')[0];
    if (sedPart) {
      const cleanPart = cleanSedCode(sedPart);
      const cleanPartNoZero = cleanSedCodeNoZero(sedPart);
      if (cleanPart === targetClean || cleanPartNoZero === targetNoZero) return true;
    }
  }

  return false;
}

/**
 * Flexibly filters the sedsList according to a search query text.
 * Matches against raw sedId, cleaned sedId (with/without leading zeros, with/without "SED"),
 * and sed.name description.
 * 
 * @param {Array<string>} sedsList - Array of SED IDs
 * @param {Object} localDatabase - Database map of SED objects { [sedId]: { name, ... } }
 * @param {string} searchText - Query typed by the user
 * @returns {Array<string>} - Filtered list of SED IDs
 */
export function filterSedsList(sedsList = [], localDatabase = {}, searchText = '') {
  if (!searchText || !searchText.trim()) return sedsList;

  const query = searchText.trim().toLowerCase();
  const queryClean = cleanSedCode(searchText).toLowerCase();
  const queryNoZero = cleanSedCodeNoZero(searchText).toLowerCase();

  return sedsList.filter(sedId => {
    const rawId = String(sedId).toLowerCase();
    const cleanId = cleanSedCode(sedId).toLowerCase();
    const cleanIdNoZero = cleanSedCodeNoZero(sedId).toLowerCase();
    
    const sedObj = localDatabase[sedId] || {};
    const sedName = String(sedObj.name || '').toLowerCase();

    return (
      rawId.includes(query) ||
      cleanId.includes(query) ||
      cleanId.includes(queryClean) ||
      (queryNoZero && cleanIdNoZero.includes(queryNoZero)) ||
      (queryNoZero && rawId.includes(queryNoZero)) ||
      sedName.includes(query) ||
      `sed ${cleanId}`.includes(query) ||
      `subestacion ${cleanId}`.includes(query) ||
      `subestación ${cleanId}`.includes(query)
    );
  });
}

/**
 * Checks flexibly if a falla record matches a target Llave Code.
 * 
 * @param {string} fallaLlaveCode - e.g. "2SP" or "MI-07/04487A/2SP"
 * @param {string} fallaSedLlave - e.g. "04487A-2SP" or "SED 04487A-2SP"
 * @param {string} targetLlaveId - e.g. "2SP"
 * @returns {boolean}
 */
export function isLlaveMatch(fallaLlaveCode, fallaSedLlave, targetLlaveId) {
  if (!targetLlaveId || !targetLlaveId.trim()) return true;

  const rawTarget = String(targetLlaveId).trim().toLowerCase();
  const cleanTarget = rawTarget.includes('/')
    ? rawTarget.split('/').pop().trim()
    : rawTarget;

  // 1. Direct match on fallaLlaveCode
  if (fallaLlaveCode) {
    const rawLlave = String(fallaLlaveCode).trim().toLowerCase();
    const cleanLlave = rawLlave.includes('/')
      ? rawLlave.split('/').pop().trim()
      : rawLlave;

    if (rawLlave === rawTarget || cleanLlave === cleanTarget) return true;
    if (rawLlave.endsWith(cleanTarget) || rawTarget.endsWith(cleanLlave)) return true;
  }

  // 2. Direct or suffix match on fallaSedLlave (e.g. "04487A-2SP")
  if (fallaSedLlave) {
    const rawSedLlave = String(fallaSedLlave).trim().toLowerCase();
    const parts = rawSedLlave.split('-');
    if (parts.length > 1) {
      const llavePart = parts.slice(1).join('-').trim();
      const cleanPart = llavePart.includes('/')
        ? llavePart.split('/').pop().trim()
        : llavePart;
      if (llavePart === rawTarget || cleanPart === cleanTarget) return true;
      if (llavePart.endsWith(cleanTarget)) return true;
    }
  }

  return false;
}

