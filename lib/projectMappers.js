import { GEOPLUZ_PROJECT_FORMAT, GEOPLUZ_PROJECT_VERSION, computeProjectChecksum } from './projectFormat.js';
import { normalizeCircuitAnalysis, readNetworkLines, readStoredCircuitAnalysis, serializeLlaveLines } from './circuitAnalysis.js';
import { nullableFiniteNumber } from './faultGeolocation.js';

function cloneValue(value) {
  if (value === undefined) return null;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function splitSetAlimentador(value = '') {
  const separator = String(value).indexOf('/');
  if (separator < 0) return [String(value).trim(), ''];
  return [String(value).slice(0, separator).trim(), String(value).slice(separator + 1).trim()];
}

function toCanonicalCableGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map((group) => {
    const result = cloneValue(group || {});
    if (Object.hasOwn(result, 'lineIds')) {
      result.line_ids = cloneValue(result.lineIds);
      delete result.lineIds;
    } else if (Object.hasOwn(result, 'line_ids')) {
      result.line_ids = cloneValue(result.line_ids);
    }
    return result;
  });
}

function toInternalCableGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map((group) => {
    const result = cloneValue(group || {});
    if (Object.hasOwn(result, 'line_ids')) {
      result.lineIds = cloneValue(result.line_ids);
      delete result.line_ids;
    } else if (Object.hasOwn(result, 'lineIds')) {
      result.lineIds = cloneValue(result.lineIds);
    }
    return result;
  });
}

function toCanonicalAnalysis(analysis) {
  const result = cloneValue(analysis || {});
  if (Object.hasOwn(result, 'cableGroups')) {
    result.cable_groups = toCanonicalCableGroups(result.cableGroups);
    delete result.cableGroups;
  } else if (Object.hasOwn(result, 'cable_groups')) {
    result.cable_groups = toCanonicalCableGroups(result.cable_groups);
  }
  return result;
}

function toInternalAnalysis(analysis) {
  const result = cloneValue(analysis || {});
  if (Object.hasOwn(result, 'cable_groups')) {
    result.cableGroups = toInternalCableGroups(result.cable_groups);
    delete result.cable_groups;
  } else if (Object.hasOwn(result, 'cableGroups')) {
    result.cableGroups = toInternalCableGroups(result.cableGroups);
  }
  return result;
}

function relationForFault(point, sedIds, llaveKeys) {
  const sedId = String(point.sed || '');
  const llaveCode = String(point.llaveSistema || '');
  const sedResolved = Boolean(sedId && sedIds.has(sedId));
  const llaveResolved = Boolean(sedResolved && llaveCode && llaveKeys.has(`${sedId}\u0000${llaveCode}`));
  return {
    status: llaveResolved ? 'resolved' : 'unresolved',
    sed_ref: sedResolved ? `sed:${sedId}` : null,
    llave_ref: llaveResolved ? `llave:${sedId}:${llaveCode}` : null
  };
}

export async function createProjectDocument(localDatabase, faultPoints, options = {}) {
  const seds = [];
  const llaves = [];
  const sedIds = new Set(Object.keys(localDatabase || {}));
  const llaveKeys = new Set();

  Object.entries(localDatabase || {}).forEach(([sedId, sed]) => {
    seds.push({
      id: sedId,
      name: sed?.name ?? null,
      sed_coord: cloneValue(sed?.sedCoord ?? null),
      created_at: sed?.createdAt ?? null
    });

    Object.entries(sed?.llaves || {}).forEach(([llaveCode, llave]) => {
      llaveKeys.add(`${sedId}\u0000${llaveCode}`);
      const storedLinesData = Array.isArray(llave?.linesData) ? cloneValue(llave.linesData) : null;
      const linesData = storedLinesData || serializeLlaveLines(llave);
      const storedAnalysis = storedLinesData ? readStoredCircuitAnalysis(storedLinesData) : null;
      llaves.push({
        source_id: Number.isInteger(llave?.id) ? llave.id : null,
        sed_id: sedId,
        llave_code: llaveCode,
        name: llave?.name ?? null,
        lines: cloneValue(storedLinesData ? readNetworkLines(storedLinesData) : (llave?.lines || [])),
        analysis: toCanonicalAnalysis(storedLinesData ? (storedAnalysis || {}) : (llave?.analysis || {})),
        lines_data: linesData,
        created_at: llave?.createdAt ?? null
      });
    });
  });

  let croquisLinks = 0;
  let photoReferences = 0;
  let dataUrls = 0;
  const fallas = (faultPoints || []).map((point, index) => {
    const rawPair = Array.isArray(point?.coords?.[0]) ? point.coords[0] : (point.coords || [null, null]);
    const parsedLatitud = nullableFiniteNumber(rawPair?.[0]);
    const parsedLongitud = nullableFiniteNumber(rawPair?.[1]);
    const hasCompletePair = parsedLatitud !== null && parsedLongitud !== null;
    const latitud = hasCompletePair ? parsedLatitud : null;
    const longitud = hasCompletePair ? parsedLongitud : null;
    const linkCroquis = point.linkCroquis || null;
    const fotos = cloneValue(point.fotos || []);
    if (linkCroquis) croquisLinks += 1;
    photoReferences += fotos.length;
    dataUrls += fotos.filter(photo => typeof photo?.url === 'string' && photo.url.startsWith('data:')).length;

    return {
      record_ref: `falla:${String(index + 1).padStart(6, '0')}`,
      source_id: Number.isInteger(point.id) ? point.id : null,
      relation: relationForFault(point, sedIds, llaveKeys),
      sed_id: point.sed || null,
      llave_code: point.llaveSistema || null,
      sed_llave: point.sedLlave || null,
      ticket: point.ticket || null,
      suministro: point.suministro || null,
      falla_real: point.falla || point.fallaReal || null,
      causa: point.causa || null,
      nota: point.nota || null,
      odm: point.odm || null,
      zona: point.zona || null,
      set_alimentador: point.setAlimentador || `${point.set || ''} / ${point.alimentador || ''}`,
      hora_inicio: point.horaInicio || null,
      latitud,
      longitud,
      link_croquis: linkCroquis,
      fotos,
      coord_source: point.coordSource || null,
      coord_lookup_suministro: point.coordLookupSuministro || null,
      created_at: point.createdAt || null
    };
  });

  const project = {
    format: GEOPLUZ_PROJECT_FORMAT,
    version: GEOPLUZ_PROJECT_VERSION,
    exported_at: new Date().toISOString(),
    project: {
      id: options.projectId || 'geopluz-main',
      name: options.projectName || 'Base Principal GEOPLUZ',
      source_kind: options.sourceKind || 'SUPABASE'
    },
    integrity: {
      counts: { seds: seds.length, llaves: llaves.length, fallas: fallas.length },
      checksum: null
    },
    seds,
    llaves,
    fallas,
    external_assets: {
      mode: 'REFERENCES_ONLY',
      croquis_links: croquisLinks,
      photo_references: photoReferences,
      embedded_data_urls: dataUrls
    }
  };
  project.integrity.checksum = await computeProjectChecksum(project);
  return project;
}

export async function createProjectFromLegacyNetwork(rawData) {
  const root = rawData?.seds && !Array.isArray(rawData.seds) ? rawData.seds : rawData;
  const localDatabase = {};
  Object.entries(root || {}).forEach(([sedId, sed]) => {
    if (!sed || typeof sed !== 'object' || Array.isArray(sed)) return;
    if (!sed.llaves && !sed.sedCoord && !sed.sed_coord) return;
    localDatabase[sedId] = {
      id: sed.id || sedId,
      name: sed.name || `SED ${sedId}`,
      sedCoord: cloneValue(sed.sedCoord ?? sed.sed_coord ?? null),
      createdAt: sed.createdAt || sed.created_at || null,
      llaves: {}
    };
    Object.entries(sed.llaves || {}).forEach(([llaveCode, llave]) => {
      localDatabase[sedId].llaves[llaveCode] = {
        id: llave?.id || null,
        name: llave?.name || llaveCode,
        lines: cloneValue(llave?.lines || llave?.lines_data || []),
        analysis: normalizeCircuitAnalysis(toInternalAnalysis(llave?.analysis || {})),
        linesData: cloneValue(llave?.lines_data || null),
        createdAt: llave?.createdAt || llave?.created_at || null
      };
    });
  });
  return createProjectDocument(localDatabase, [], {
    projectId: 'legacy-network',
    projectName: 'Exportación legacy de red',
    sourceKind: 'LOCAL_PROJECT'
  });
}

export function projectToInternalModel(project) {
  const localDatabase = {};
  project.seds.forEach((sed) => {
    localDatabase[sed.id] = {
      id: sed.id,
      name: sed.name,
      sedCoord: cloneValue(sed.sed_coord),
      createdAt: sed.created_at,
      llaves: {}
    };
  });

  project.llaves.forEach((llave) => {
    if (!localDatabase[llave.sed_id]) return;
    localDatabase[llave.sed_id].llaves[llave.llave_code] = {
      id: llave.source_id,
      name: llave.name,
      lines: cloneValue(llave.lines),
      analysis: normalizeCircuitAnalysis(toInternalAnalysis(llave.analysis)),
      linesData: cloneValue(llave.lines_data || null),
      createdAt: llave.created_at
    };
  });

  const numberedPointsList = project.fallas.map((falla, index) => {
    const [set, alimentador] = splitSetAlimentador(falla.set_alimentador || '');
    return {
      id: falla.source_id,
      number: index + 1,
      coords: falla.latitud !== null && falla.longitud !== null ? [falla.latitud, falla.longitud] : null,
      ticket: falla.ticket || '',
      horaInicio: falla.hora_inicio || '',
      zona: falla.zona || '',
      set,
      alimentador,
      setAlimentador: falla.set_alimentador || '',
      nota: falla.nota || '',
      odm: falla.odm || '',
      suministro: falla.suministro || '',
      sedLlave: falla.sed_llave || '',
      sed: falla.sed_id || '',
      llaveSistema: falla.llave_code || '',
      llaveCampo: `${falla.llave_code || ''} (Campo)`,
      falla: falla.falla_real || '',
      causa: falla.causa || '',
      linkCroquis: falla.link_croquis || '',
      fotos: cloneValue(falla.fotos || []),
      coordSource: falla.coord_source || null,
      coordLookupSuministro: falla.coord_lookup_suministro || null,
      createdAt: falla.created_at || null,
      projectRecordRef: falla.record_ref,
      relationStatus: falla.relation?.status || 'unresolved'
    };
  });

  return { localDatabase, numberedPointsList };
}
