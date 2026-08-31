export const COORD_SOURCE = Object.freeze({
  ORIGINAL: 'ORIGINAL',
  LOOKUP: 'SUMINISTRO_LOOKUP',
  MANUAL: 'MANUAL'
});

const INVALID_SUPPLIES = new Set([
  '',
  '-',
  'N/A',
  'NA',
  'N/D',
  'ND',
  'NULL',
  'UNDEFINED',
  'S/N',
  'SIN SUMINISTRO'
]);

export function normalizeSuministro(value) {
  if (value === null || value === undefined) return null;

  const trimmed = String(value).trim();
  if (INVALID_SUPPLIES.has(trimmed.toUpperCase())) return null;

  const excelInteger = trimmed.match(/^(\d+)\.0+$/);
  return excelInteger ? excelInteger[1] : trimmed;
}

export function nullableFiniteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function getCoordinatePair(fault) {
  if (!fault) return null;

  if (Array.isArray(fault.coords)) {
    const candidate = Array.isArray(fault.coords[0]) ? fault.coords[0] : fault.coords;
    if (candidate.length >= 2) return [nullableFiniteNumber(candidate[0]), nullableFiniteNumber(candidate[1])];
  }

  return [nullableFiniteNumber(fault.latitud), nullableFiniteNumber(fault.longitud)];
}

export function isValidCoordinatePair(value) {
  const pair = Array.isArray(value) ? getCoordinatePair({ coords: value }) : getCoordinatePair(value);
  if (!pair) return false;
  const [latitud, longitud] = pair;
  return latitud !== null && longitud !== null && latitud >= -90 && latitud <= 90 && longitud >= -180 && longitud <= 180;
}

export function coordinatePairsEqual(left, right) {
  const leftPair = getCoordinatePair(left);
  const rightPair = getCoordinatePair(right);
  if (!leftPair || !rightPair) return leftPair === rightPair;
  return leftPair[0] === rightPair[0] && leftPair[1] === rightPair[1];
}

export function markCoordinatesManual(fault, coords) {
  return {
    ...fault,
    coords,
    coordSource: isValidCoordinatePair(coords) ? COORD_SOURCE.MANUAL : null,
    coordLookupSuministro: fault?.coordLookupSuministro || null
  };
}

export function getCoordinateSourceLabel(source) {
  if (source === COORD_SOURCE.ORIGINAL) return 'Original';
  if (source === COORD_SOURCE.LOOKUP) return 'Automática';
  if (source === COORD_SOURCE.MANUAL) return 'Manual';
  return '';
}

function normalizeFaultSupply(fault) {
  const suministro = normalizeSuministro(fault.suministro);
  return { ...fault, suministro: suministro || '' };
}

export function applyCoordinateLookup(faults, coordinateMap = new Map(), { lookupFailed = false, lookupQueries = 0 } = {}) {
  const summary = {
    processed: faults.length,
    original: 0,
    automatic: 0,
    withoutReference: 0,
    invalidSupply: 0,
    lookupQueries,
    lookupFailed
  };

  const enriched = faults.map((inputFault) => {
    const fault = normalizeFaultSupply(inputFault);
    const suministro = normalizeSuministro(fault.suministro);

    if (isValidCoordinatePair(fault)) {
      summary.original += 1;
      return {
        ...fault,
        coordSource: fault.coordSource || COORD_SOURCE.ORIGINAL,
        coordLookupSuministro: fault.coordLookupSuministro || null
      };
    }

    const reference = suministro ? coordinateMap.get(suministro) : null;
    if (reference && isValidCoordinatePair(reference)) {
      summary.automatic += 1;
      const [latitud, longitud] = getCoordinatePair(reference);
      return {
        ...fault,
        coords: [latitud, longitud],
        coordSource: COORD_SOURCE.LOOKUP,
        coordLookupSuministro: suministro
      };
    }

    if (!suministro) summary.invalidSupply += 1;
    summary.withoutReference += 1;
    return {
      ...fault,
      coords: null,
      coordSource: null,
      coordLookupSuministro: fault.coordLookupSuministro || null
    };
  });

  return { faults: enriched, summary };
}

export async function georeferenceFaultBatch(supabase, faults, { chunkSize = 300 } = {}) {
  const supplies = [...new Set(
    faults
      .filter((fault) => !isValidCoordinatePair(fault))
      .map((fault) => normalizeSuministro(fault.suministro))
      .filter(Boolean)
  )];

  if (!supabase || supplies.length === 0) return applyCoordinateLookup(faults);

  const coordinateMap = new Map();
  let lookupQueries = 0;

  try {
    for (let index = 0; index < supplies.length; index += chunkSize) {
      lookupQueries += 1;
      const chunk = supplies.slice(index, index + chunkSize);
      const { data, error } = await supabase
        .from('suministros_coordenadas')
        .select('suministro, latitud, longitud')
        .in('suministro', chunk);

      if (error) throw error;
      (data || []).forEach((row) => {
        const suministro = normalizeSuministro(row.suministro);
        if (suministro && isValidCoordinatePair(row)) coordinateMap.set(suministro, row);
      });
    }

    return applyCoordinateLookup(faults, coordinateMap, { lookupQueries });
  } catch {
    // Discard partial lookup results: either the whole lookup succeeds or no
    // inferred coordinate is assigned to the batch.
    return applyCoordinateLookup(faults, new Map(), { lookupFailed: true, lookupQueries });
  }
}

export function formatGeoreferenceSummary(summary) {
  const lines = [
    `Fallas procesadas: ${summary.processed}`,
    `Con coordenada original: ${summary.original}`,
    `Ubicadas automáticamente: ${summary.automatic}`,
    `Sin referencia: ${summary.withoutReference}`
  ];
  if (summary.invalidSupply > 0) lines.push(`Suministros inválidos: ${summary.invalidSupply}`);
  if (summary.lookupFailed) lines.push('El lookup de suministros falló; no se asignaron coordenadas automáticas.');
  return lines.join('\n');
}
