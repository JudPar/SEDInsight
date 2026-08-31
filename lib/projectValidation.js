import { CIRCUIT_STATUSES } from './circuitAnalysis.js';
import {
  DANGEROUS_JSON_KEYS,
  GEOPLUZ_PROJECT_FORMAT,
  GEOPLUZ_PROJECT_VERSION,
  computeProjectChecksum,
  isLegacyNetworkJson,
  parseProjectJson
} from './projectFormat.js';
import { createProjectFromLegacyNetwork } from './projectMappers.js';
import { classifyExternalReference } from './externalAssetSafety.js';

const COORD_SOURCES = new Set(['ORIGINAL', 'SUMINISTRO_LOOKUP', 'MANUAL']);

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validCoordinatePair(pair) {
  return Array.isArray(pair) && pair.length >= 2 &&
    typeof pair[0] === 'number' && Number.isFinite(pair[0]) &&
    typeof pair[1] === 'number' && Number.isFinite(pair[1]) &&
    pair[0] >= -90 && pair[0] <= 90 &&
    pair[1] >= -180 && pair[1] <= 180;
}

function validNetworkCoordinatePair(pair) {
  if (!Array.isArray(pair) || pair.length < 2 || typeof pair[0] !== 'number' || !Number.isFinite(pair[0]) || typeof pair[1] !== 'number' || !Number.isFinite(pair[1])) return false;
  if (validCoordinatePair(pair)) return true;
  const first = pair[0];
  const second = pair[1];
  const utm = (first >= 100000 && first <= 900000 && second > 8000000 && second < 10000000) ||
    (second >= 100000 && second <= 900000 && first > 8000000 && first < 10000000);
  const webMercator = Math.abs(first) <= 20037508.34 && Math.abs(second) <= 20037508.34 && Math.abs(first) > 1000000 && Math.abs(second) > 1000000;
  return utm || webMercator;
}

function isNullableString(value) {
  return value === null || value === undefined || typeof value === 'string';
}

function isNullableNumber(value) {
  return value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function findDangerousProperty(value, path = '$', seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) return `${path}.${key}`;
    const nested = findDangerousProperty(value[key], `${path}.${key}`, seen);
    if (nested) return nested;
  }
  return null;
}

export async function validateProject(project, options = {}) {
  const errors = [];
  const warnings = [];
  const error = (code, path, message) => errors.push({ code, path, message });
  const warning = (code, path, message) => warnings.push({ code, path, message });

  const dangerousPath = findDangerousProperty(project);
  if (dangerousPath) error('UNSAFE_PROPERTY', dangerousPath, 'El proyecto contiene una propiedad no permitida.');
  if (!isObject(project)) {
    error('INVALID_ROOT', '$', 'La raíz del proyecto debe ser un objeto.');
    return { valid: false, errors, warnings, preview: null };
  }
  if (project.format !== GEOPLUZ_PROJECT_FORMAT) error('INVALID_FORMAT', '$.format', 'El formato no corresponde a GEOPLUZ_PROJECT.');
  if (project.version !== GEOPLUZ_PROJECT_VERSION) error('UNSUPPORTED_VERSION', '$.version', `La versión ${project.version ?? 'ausente'} no está soportada.`);
  if (typeof project.exported_at !== 'string' || Number.isNaN(Date.parse(project.exported_at))) error('INVALID_EXPORTED_AT', '$.exported_at', 'exported_at debe ser una fecha ISO válida.');
  if (!isObject(project.project)) error('INVALID_PROJECT_METADATA', '$.project', 'Falta la metadata del proyecto.');
  else {
    if (typeof project.project.id !== 'string' || !project.project.id.trim()) error('INVALID_PROJECT_ID', '$.project.id', 'El proyecto debe tener un identificador.');
    if (typeof project.project.name !== 'string' || !project.project.name.trim()) error('INVALID_PROJECT_NAME', '$.project.name', 'El proyecto debe tener un nombre.');
    if (!['SUPABASE', 'LOCAL_PROJECT'].includes(project.project.source_kind)) error('INVALID_SOURCE_KIND', '$.project.source_kind', 'El origen del proyecto no es reconocido.');
  }

  ['seds', 'llaves', 'fallas'].forEach((field) => {
    if (!Array.isArray(project[field])) error('EXPECTED_ARRAY', `$.${field}`, `${field} debe ser un array.`);
  });
  if (errors.length) return { valid: false, errors, warnings, preview: null };

  const sedIds = new Set();
  project.seds.forEach((sed, index) => {
    const path = `$.seds[${index}]`;
    if (!isObject(sed)) return error('INVALID_SED', path, 'La SED debe ser un objeto.');
    if (typeof sed.id !== 'string' || !sed.id.trim()) error('INVALID_SED_ID', `${path}.id`, 'La SED debe tener un id de texto.');
    else if (sedIds.has(sed.id)) error('DUPLICATE_SED', `${path}.id`, `La SED ${sed.id} está duplicada.`);
    else sedIds.add(sed.id);
    if (!isNullableString(sed.name)) error('INVALID_TYPE', `${path}.name`, 'El nombre de SED debe ser texto o null.');
    if (sed.sed_coord !== null && sed.sed_coord !== undefined && !validNetworkCoordinatePair(sed.sed_coord)) error('INVALID_COORDINATE', `${path}.sed_coord`, 'La coordenada de SED no es válida.');
    if (!isNullableString(sed.created_at)) error('INVALID_TYPE', `${path}.created_at`, 'created_at debe ser texto o null.');
  });

  const llaveKeys = new Set();
  project.llaves.forEach((llave, index) => {
    const path = `$.llaves[${index}]`;
    if (!isObject(llave)) return error('INVALID_LLAVE', path, 'La llave debe ser un objeto.');
    if (typeof llave.sed_id !== 'string' || !llave.sed_id) error('INVALID_LLAVE_SED', `${path}.sed_id`, 'La llave debe indicar su SED.');
    else if (!sedIds.has(llave.sed_id)) error('ORPHAN_LLAVE', `${path}.sed_id`, 'La llave referencia una SED inexistente.');
    if (typeof llave.llave_code !== 'string' || !llave.llave_code) error('INVALID_LLAVE_CODE', `${path}.llave_code`, 'La llave debe tener código.');
    if (!isNullableNumber(llave.source_id)) error('INVALID_TYPE', `${path}.source_id`, 'source_id debe ser número o null.');
    if (!isNullableString(llave.name)) error('INVALID_TYPE', `${path}.name`, 'El nombre de llave debe ser texto o null.');
    if (!isNullableString(llave.created_at)) error('INVALID_TYPE', `${path}.created_at`, 'created_at debe ser texto o null.');
    const key = `${llave.sed_id}\u0000${llave.llave_code}`;
    if (llaveKeys.has(key)) error('DUPLICATE_LLAVE', path, 'La combinación SED/código de llave está duplicada.');
    else llaveKeys.add(key);
    if (!Array.isArray(llave.lines)) error('INVALID_LINES', `${path}.lines`, 'El trazado debe ser un array.');
    else llave.lines.forEach((line, lineIndex) => {
      const linePath = `${path}.lines[${lineIndex}]`;
      if (!isObject(line)) error('INVALID_LINE', linePath, 'Cada tramo debe ser un objeto.');
      else {
        if (!Array.isArray(line.coords) || line.coords.length === 0 || line.coords.some(pair => !validNetworkCoordinatePair(pair))) {
          error('INVALID_LINE_COORDINATES', `${linePath}.coords`, 'Las coordenadas del tramo no son válidas.');
        }
        if (line.id !== null && line.id !== undefined && !['string', 'number'].includes(typeof line.id)) error('INVALID_LINE_ID', `${linePath}.id`, 'El id del tramo debe ser texto, número o null.');
        if (line.length !== null && line.length !== undefined && (typeof line.length !== 'number' || !Number.isFinite(line.length) || line.length < 0)) error('INVALID_LINE_LENGTH', `${linePath}.length`, 'La longitud debe ser un número no negativo.');
      }
    });
    if (llave.lines_data !== undefined && !Array.isArray(llave.lines_data)) error('INVALID_LINES_DATA', `${path}.lines_data`, 'lines_data debe ser un array.');
    if (!isObject(llave.analysis)) error('INVALID_ANALYSIS', `${path}.analysis`, 'Falta el análisis del circuito.');
    else {
      if (llave.analysis.status !== undefined && !CIRCUIT_STATUSES[llave.analysis.status]) error('INVALID_CIRCUIT_STATUS', `${path}.analysis.status`, 'El estado del circuito no es válido.');
      if (!isNullableString(llave.analysis.note)) error('INVALID_TYPE', `${path}.analysis.note`, 'analysis.note debe ser texto, null o estar ausente.');
      if (llave.analysis.cable_groups !== undefined && !Array.isArray(llave.analysis.cable_groups)) error('INVALID_CABLE_GROUPS', `${path}.analysis.cable_groups`, 'Los calibres deben ser un array o estar ausentes.');
      else (llave.analysis.cable_groups || []).forEach((group, groupIndex) => {
        const groupPath = `${path}.analysis.cable_groups[${groupIndex}]`;
        if (!isObject(group)) return error('INVALID_CABLE_GROUP', groupPath, 'Cada grupo de cable debe ser un objeto.');
        if (group.id === null || !['string', 'number'].includes(typeof group.id)) error('INVALID_CABLE_GROUP_ID', `${groupPath}.id`, 'El grupo de cable debe tener un id de texto o número.');
        ['name', 'calibre', 'color', 'note'].forEach((field) => {
          if (!isNullableString(group[field])) error('INVALID_TYPE', `${groupPath}.${field}`, `${field} debe ser texto, null o estar ausente.`);
        });
        if (group.distance !== null && group.distance !== undefined && (typeof group.distance !== 'number' || !Number.isFinite(group.distance) || group.distance < 0)) error('INVALID_CABLE_DISTANCE', `${groupPath}.distance`, 'distance debe ser un número no negativo, null o estar ausente.');
        if (group.line_ids !== null && group.line_ids !== undefined && (!Array.isArray(group.line_ids) || group.line_ids.some(lineId => !['string', 'number'].includes(typeof lineId)))) {
          error('INVALID_CABLE_LINES', `${groupPath}.line_ids`, 'line_ids debe contener identificadores de tramo.');
        }
      });
    }
  });

  const recordRefs = new Set();
  const tickets = new Map();
  let unresolvedRelations = 0;
  let externalReferences = 0;
  let embeddedDataUrls = 0;
  let croquisLinks = 0;
  let photoReferences = 0;
  let legacyExternalReferences = 0;
  let navigableExternalReferences = 0;

  project.fallas.forEach((falla, index) => {
    const path = `$.fallas[${index}]`;
    if (!isObject(falla)) return error('INVALID_FALLA', path, 'La falla debe ser un objeto.');
    if (typeof falla.record_ref !== 'string' || !falla.record_ref) error('INVALID_RECORD_REF', `${path}.record_ref`, 'La falla debe tener record_ref.');
    else if (recordRefs.has(falla.record_ref)) error('DUPLICATE_RECORD_REF', `${path}.record_ref`, 'record_ref está duplicado.');
    else recordRefs.add(falla.record_ref);
    if (!isNullableNumber(falla.source_id)) error('INVALID_TYPE', `${path}.source_id`, 'source_id debe ser número o null.');

    ['sed_id', 'llave_code', 'sed_llave', 'ticket', 'suministro', 'falla_real', 'causa', 'nota', 'odm', 'zona', 'set_alimentador', 'hora_inicio', 'link_croquis', 'coord_lookup_suministro', 'created_at'].forEach((field) => {
      if (!isNullableString(falla[field])) error('INVALID_TYPE', `${path}.${field}`, `${field} debe ser texto o null.`);
    });
    if (!isNullableNumber(falla.latitud) || !isNullableNumber(falla.longitud) ||
      ((falla.latitud === null) !== (falla.longitud === null)) ||
      (falla.latitud !== null && !validCoordinatePair([falla.latitud, falla.longitud]))) {
      error('INVALID_COORDINATE', path, 'La coordenada de la falla debe ser una pareja completa y válida.');
    }
    if (falla.coord_source !== null && falla.coord_source !== undefined && !COORD_SOURCES.has(falla.coord_source)) error('INVALID_COORD_SOURCE', `${path}.coord_source`, 'La trazabilidad de coordenada no es reconocida.');
    if (!Array.isArray(falla.fotos)) error('INVALID_PHOTOS', `${path}.fotos`, 'fotos debe ser un array.');
    else falla.fotos.forEach((photo, photoIndex) => {
      if (!isObject(photo) || !isNullableString(photo.name) || typeof photo.url !== 'string') error('INVALID_PHOTO', `${path}.fotos[${photoIndex}]`, 'La referencia de foto no es válida.');
      else {
        const reference = classifyExternalReference(photo.url, { allowDataImage: true });
        externalReferences += 1;
        photoReferences += 1;
        if (reference.kind === 'data-image') embeddedDataUrls += 1;
        else if (reference.kind === 'web') navigableExternalReferences += 1;
        else if (reference.kind === 'legacy') {
          legacyExternalReferences += 1;
          warning('LEGACY_EXTERNAL_ASSET_REFERENCE', `${path}.fotos[${photoIndex}].url`, 'La referencia legacy se conservará, pero no se habilitará para navegación.');
        } else error('UNSAFE_URL', `${path}.fotos[${photoIndex}].url`, 'La referencia utiliza un esquema no permitido.');
      }
    });
    if (falla.link_croquis) {
      const reference = classifyExternalReference(falla.link_croquis);
      externalReferences += 1;
      croquisLinks += 1;
      if (reference.kind === 'web') navigableExternalReferences += 1;
      else if (reference.kind === 'legacy') {
        legacyExternalReferences += 1;
        warning('LEGACY_EXTERNAL_ASSET_REFERENCE', `${path}.link_croquis`, 'La referencia legacy se conservará, pero no se habilitará para navegación.');
      } else error('UNSAFE_URL', `${path}.link_croquis`, 'El enlace utiliza un esquema no permitido.');
    }

    if (!isObject(falla.relation) || !['resolved', 'unresolved'].includes(falla.relation.status)) {
      error('INVALID_RELATION', `${path}.relation`, 'La relación de la falla no está declarada correctamente.');
    } else if (falla.relation.status === 'resolved') {
      const expectedSedRef = `sed:${falla.sed_id}`;
      const expectedLlaveRef = `llave:${falla.sed_id}:${falla.llave_code}`;
      if (!sedIds.has(falla.sed_id) || !llaveKeys.has(`${falla.sed_id}\u0000${falla.llave_code}`) || falla.relation.sed_ref !== expectedSedRef || falla.relation.llave_ref !== expectedLlaveRef) {
        error('INVALID_RESOLVED_RELATION', `${path}.relation`, 'La relación marcada como resuelta no coincide con SED/llave.');
      }
    } else {
      unresolvedRelations += 1;
      const expectedSedRef = sedIds.has(falla.sed_id) ? `sed:${falla.sed_id}` : null;
      if (falla.relation.sed_ref !== expectedSedRef || falla.relation.llave_ref !== null) {
        error('INVALID_UNRESOLVED_RELATION', `${path}.relation`, 'La relación no resuelta no coincide con sus referencias literales disponibles.');
      }
    }

    const ticketKey = typeof falla.ticket === 'string' ? falla.ticket.trim().toLowerCase() : '';
    if (ticketKey) tickets.set(ticketKey, (tickets.get(ticketKey) || 0) + 1);
  });

  const duplicateTicketGroups = Array.from(tickets.values()).filter(count => count > 1).length;
  if (duplicateTicketGroups) warning('DUPLICATE_TICKETS', '$.fallas', `${duplicateTicketGroups} grupos de tickets repetidos; se conservarán como registros independientes.`);
  if (unresolvedRelations) warning('UNRESOLVED_RELATIONS', '$.fallas', `${unresolvedRelations} fallas tienen relaciones no resueltas; se conservarán literalmente.`);
  if (externalReferences) warning('EXTERNAL_REFERENCES', '$.external_assets', `${externalReferences} enlaces son referencias externas y no incluyen los archivos.`);
  if (embeddedDataUrls) warning('EMBEDDED_DATA_URLS', '$.external_assets', `${embeddedDataUrls} fotos están embebidas como Data URL y aumentan el tamaño.`);

  if (!isObject(project.external_assets)) error('INVALID_EXTERNAL_ASSETS', '$.external_assets', 'Falta la metadata de referencias externas.');
  else {
    if (project.external_assets.mode !== 'REFERENCES_ONLY') error('INVALID_EXTERNAL_ASSET_MODE', '$.external_assets.mode', 'El modo de recursos externos no está soportado.');
    ['croquis_links', 'photo_references', 'embedded_data_urls'].forEach((field) => {
      if (!Number.isInteger(project.external_assets[field]) || project.external_assets[field] < 0) error('INVALID_EXTERNAL_ASSET_COUNT', `$.external_assets.${field}`, `${field} debe ser un entero no negativo.`);
    });
    if (project.external_assets.croquis_links !== croquisLinks) error('EXTERNAL_ASSET_COUNT_MISMATCH', '$.external_assets.croquis_links', 'El conteo de enlaces de croquis no coincide.');
    if (project.external_assets.photo_references !== photoReferences) error('EXTERNAL_ASSET_COUNT_MISMATCH', '$.external_assets.photo_references', 'El conteo de fotos no coincide.');
    if (project.external_assets.embedded_data_urls !== embeddedDataUrls) error('EXTERNAL_ASSET_COUNT_MISMATCH', '$.external_assets.embedded_data_urls', 'El conteo de Data URLs no coincide.');
  }

  const counts = project.integrity?.counts;
  if (!isObject(counts)) error('MISSING_COUNTS', '$.integrity.counts', 'Faltan los conteos de integridad.');
  else {
    if (counts.seds !== project.seds.length) error('COUNT_MISMATCH', '$.integrity.counts.seds', 'El conteo de SED no coincide.');
    if (counts.llaves !== project.llaves.length) error('COUNT_MISMATCH', '$.integrity.counts.llaves', 'El conteo de llaves no coincide.');
    if (counts.fallas !== project.fallas.length) error('COUNT_MISMATCH', '$.integrity.counts.fallas', 'El conteo de fallas no coincide.');
  }

  if (options.verifyChecksum !== false && project.integrity?.checksum) {
    const checksum = await computeProjectChecksum(project);
    if (checksum && checksum !== project.integrity.checksum) error('CHECKSUM_MISMATCH', '$.integrity.checksum', 'El checksum no coincide; el proyecto pudo ser alterado o truncado.');
  } else if (!project.integrity?.checksum) {
    warning('CHECKSUM_MISSING', '$.integrity.checksum', 'El proyecto no incluye checksum; se validaron estructura y conteos.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    preview: {
      projectName: project.project?.name || 'Sin nombre',
      format: project.format,
      version: project.version,
      counts: { seds: project.seds.length, llaves: project.llaves.length, fallas: project.fallas.length },
      externalReferences,
      legacyExternalReferences,
      navigableExternalReferences,
      unresolvedRelations,
      duplicateTicketGroups,
      embeddedDataUrls
    }
  };
}

export async function parseAndValidateProjectText(text, options = {}) {
  const project = parseProjectJson(text);
  const validation = await validateProject(project, options);
  return { project, ...validation };
}

export async function parseAndValidateProjectInputText(text, options = {}) {
  const parsed = parseProjectJson(text);
  if (isLegacyNetworkJson(parsed)) {
    const project = await createProjectFromLegacyNetwork(parsed);
    const validation = await validateProject(project, options);
    validation.warnings.unshift({
      code: 'LEGACY_NETWORK',
      path: '$',
      message: 'Este JSON corresponde a una exportación legacy y no contiene el proyecto completo ni todas las fallas.'
    });
    return { project, inputKind: 'LEGACY_NETWORK', ...validation };
  }
  const validation = await validateProject(parsed, options);
  return { project: parsed, inputKind: 'GEOPLUZ_PROJECT', ...validation };
}
