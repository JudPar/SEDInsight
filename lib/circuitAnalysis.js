import { buildCircuitTopology, createTopologyEdgeId } from './circuitTopology.js';
import { calculateBranchIndicators } from './branchIndicators.js';
import { buildAnalysisSegments } from './analysisSegments.js';

const ANALYSIS_MARKER = '__geopluz_circuit_analysis__';
const EARTH_RADIUS_METERS = 6371008.8;
const ELECTRICAL_PROPERTY_KEYS = ['ID Circuito', 'Tipo de Red', 'Faseo Existente', 'Voltaje Nominal', 'Neutro Existente'];
export const CIRCUIT_STATUSES = {
  en_proceso: { label: 'En proceso', color: '#f9a825' },
  cargado: { label: 'Cargado', color: '#0288d1' },
  analizado: { label: 'Analizado', color: '#2e7d32' },
  requiere_revision: { label: 'Requiere revisión', color: '#e65100' }
};

export function normalizeCircuitAnalysis(analysis = {}) {
  const status = CIRCUIT_STATUSES[analysis.status] ? analysis.status : 'cargado';
  return { note: '', cableGroups: [], ...analysis, status };
}

export function readStoredCircuitAnalysis(lines = []) {
  const marker = Array.isArray(lines)
    ? lines.find(line => line && Object.prototype.hasOwnProperty.call(line, ANALYSIS_MARKER))
    : null;
  const stored = marker?.[ANALYSIS_MARKER];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  return typeof structuredClone === 'function' ? structuredClone(stored) : JSON.parse(JSON.stringify(stored));
}

export function readCircuitAnalysis(lines = []) {
  return normalizeCircuitAnalysis(readStoredCircuitAnalysis(lines) || {});
}

export function readNetworkLines(lines = []) {
  return Array.isArray(lines)
    ? lines.filter(line => line && !Object.prototype.hasOwnProperty.call(line, ANALYSIS_MARKER))
    : [];
}

function isValidLatLonPair(pair) {
  return Array.isArray(pair) && pair.length >= 2 &&
    typeof pair[0] === 'number' && Number.isFinite(pair[0]) && pair[0] >= -90 && pair[0] <= 90 &&
    typeof pair[1] === 'number' && Number.isFinite(pair[1]) && pair[1] >= -180 && pair[1] <= 180;
}

function haversineDistanceMeters(from, to) {
  const toRadians = value => value * Math.PI / 180;
  const lat1 = toRadians(from[0]);
  const lat2 = toRadians(to[0]);
  const deltaLat = lat2 - lat1;
  const deltaLng = toRadians(to[1] - from[1]);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  const boundedA = Math.min(1, Math.max(0, a));
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
}

export function calculateGeographicLineLength(coords) {
  if (!Array.isArray(coords) || coords.length < 2 || coords.some(pair => !isValidLatLonPair(pair))) return null;
  let total = 0;
  for (let index = 1; index < coords.length; index += 1) {
    total += haversineDistanceMeters(coords[index - 1], coords[index]);
  }
  return total;
}

export function normalizeCalibreLabel(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .replace(/\s*(?:X|\u00D7)\s*/g, 'X')
    .replace(/\s*-\s*/g, '-');
}

function physicalSegmentKey(line) {
  const hasId = Object.prototype.hasOwnProperty.call(line, 'id');
  return JSON.stringify([hasId ? typeof line.id : 'missing', hasId ? line.id : null, line.coords]);
}

function hasElectricalMetadata(line) {
  const properties = line?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  return ELECTRICAL_PROPERTY_KEYS.some(key => {
    const value = properties[key];
    return value !== null && value !== undefined && String(value).trim() !== '';
  });
}

function storedCableGroups(linesData) {
  const stored = readStoredCircuitAnalysis(linesData) || {};
  if (Array.isArray(stored.cableGroups)) return stored.cableGroups;
  if (!Array.isArray(stored.cable_groups)) return [];
  return stored.cable_groups.map(group => ({ ...group, lineIds: group?.line_ids || [] }));
}

export function analyzeCircuitPhase1(linesData = []) {
  const originalSegments = readNetworkLines(linesData);
  const physicalByKey = new Map();
  let originalStoredLengthMeters = 0;

  originalSegments.forEach((line) => {
    const validStoredLength = typeof line.length === 'number' && Number.isFinite(line.length) && line.length >= 0;
    if (validStoredLength) originalStoredLengthMeters += line.length;
    const key = physicalSegmentKey(line);
    if (!physicalByKey.has(key)) physicalByKey.set(key, { key, line });
  });

  const physicalSegments = Array.from(physicalByKey.values()).map((item) => {
    const { line } = item;
    const validStoredLength = typeof line.length === 'number' && Number.isFinite(line.length) && line.length >= 0;
    return {
      ...item,
      storedLengthMeters: validStoredLength ? line.length : null,
      geographicLengthMeters: calculateGeographicLineLength(line.coords),
      electrical: hasElectricalMetadata(line)
    };
  });
  const physicalSegmentByKey = new Map(physicalSegments.map(segment => [segment.key, segment]));

  const physicalByLineId = new Map();
  physicalSegments.forEach((segment) => {
    if (segment.line.id === null || segment.line.id === undefined) return;
    const lineId = String(segment.line.id);
    if (!physicalByLineId.has(lineId)) physicalByLineId.set(lineId, []);
    physicalByLineId.get(lineId).push(segment);
  });

  const calibreBuckets = new Map();
  const segmentCalibres = new Map();
  const ambiguousCalibreLineIds = new Set();
  let unmatchedCalibreReferences = 0;
  let manualGroupsWithoutCalibre = 0;

  storedCableGroups(linesData).forEach((group) => {
    const originalLabel = typeof group?.calibre === 'string' ? group.calibre : '';
    const normalizedLabel = normalizeCalibreLabel(originalLabel);
    if (!normalizedLabel) {
      manualGroupsWithoutCalibre += 1;
      return;
    }
    if (!calibreBuckets.has(normalizedLabel)) {
      calibreBuckets.set(normalizedLabel, {
        normalizedLabel,
        originalLabels: new Set(),
        segmentKeys: new Set(),
        ambiguousLineIds: new Set()
      });
    }
    const bucket = calibreBuckets.get(normalizedLabel);
    bucket.originalLabels.add(originalLabel);
    const uniqueLineIds = new Set((Array.isArray(group.lineIds) ? group.lineIds : []).map(String));
    uniqueLineIds.forEach((lineId) => {
      const matches = physicalByLineId.get(lineId) || [];
      if (!matches.length) unmatchedCalibreReferences += 1;
      if (matches.length > 1) {
        ambiguousCalibreLineIds.add(lineId);
        bucket.ambiguousLineIds.add(lineId);
      }
      matches.forEach((segment) => {
        bucket.segmentKeys.add(segment.key);
        if (!segmentCalibres.has(segment.key)) segmentCalibres.set(segment.key, new Set());
        segmentCalibres.get(segment.key).add(normalizedLabel);
      });
    });
  });

  const lengthByCalibre = Array.from(calibreBuckets.values()).map((bucket) => {
    const segments = Array.from(bucket.segmentKeys).map(key => physicalSegmentByKey.get(key)).filter(Boolean);
    return {
      normalizedLabel: bucket.normalizedLabel,
      originalLabels: Array.from(bucket.originalLabels),
      segmentCount: segments.length,
      storedLengthMeters: segments.reduce((total, segment) => total + (segment.storedLengthMeters ?? 0), 0),
      geographicLengthMeters: segments.reduce((total, segment) => total + (segment.geographicLengthMeters ?? 0), 0),
      ambiguousLineIds: bucket.ambiguousLineIds.size
    };
  }).sort((left, right) => right.storedLengthMeters - left.storedLengthMeters || left.normalizedLabel.localeCompare(right.normalizedLabel));

  const duplicateSegments = originalSegments.length - physicalSegments.length;
  const invalidStoredLengthSegments = physicalSegments.filter(segment => segment.storedLengthMeters === null).length;
  const zeroStoredLengthSegments = physicalSegments.filter(segment => segment.storedLengthMeters === 0).length;
  const invalidGeometrySegments = physicalSegments.filter(segment => segment.geographicLengthMeters === null).length;
  const zeroGeographicLengthSegments = physicalSegments.filter(segment => segment.geographicLengthMeters === 0).length;
  const nonElectricalCandidates = physicalSegments.filter(segment => !segment.electrical).length;
  const segmentsWithMultipleCalibres = Array.from(segmentCalibres.values()).filter(labels => labels.size > 1).length;
  const warnings = [];

  if (duplicateSegments) warnings.push({ code: 'EXACT_DUPLICATES', count: duplicateSegments, message: `${duplicateSegments} registros duplicados exactos fueron ignorados.` });
  if (invalidStoredLengthSegments || zeroStoredLengthSegments) warnings.push({ code: 'INVALID_STORED_LENGTH', count: invalidStoredLengthSegments + zeroStoredLengthSegments, message: `${invalidStoredLengthSegments + zeroStoredLengthSegments} segmentos tienen longitud almacenada cero o inválida.` });
  if (invalidGeometrySegments || zeroGeographicLengthSegments) warnings.push({ code: 'INVALID_GEOMETRY_LENGTH', count: invalidGeometrySegments + zeroGeographicLengthSegments, message: `${invalidGeometrySegments + zeroGeographicLengthSegments} segmentos no producen una longitud geográfica positiva.` });
  if (nonElectricalCandidates) warnings.push({ code: 'POSSIBLY_NON_ELECTRICAL', count: nonElectricalCandidates, message: `${nonElectricalCandidates} segmentos carecen de metadatos eléctricos habituales.` });
  if (unmatchedCalibreReferences) warnings.push({ code: 'UNMATCHED_CALIBRE_REFERENCES', count: unmatchedCalibreReferences, message: `${unmatchedCalibreReferences} referencias de calibre no coinciden con un tramo físico.` });
  if (ambiguousCalibreLineIds.size) warnings.push({
    code: 'AMBIGUOUS_CALIBRE_REFERENCES',
    count: ambiguousCalibreLineIds.size,
    message: `${ambiguousCalibreLineIds.size} referencias de calibre usan un lineId asociado a varias geometrías; la longitud incluye todos esos segmentos porque lineIds no permite distinguirlos.`
  });
  if (manualGroupsWithoutCalibre) warnings.push({ code: 'GROUPS_WITHOUT_CALIBRE', count: manualGroupsWithoutCalibre, message: `${manualGroupsWithoutCalibre} grupos manuales no indican calibre.` });
  if (segmentsWithMultipleCalibres) warnings.push({ code: 'MULTIPLE_CALIBRES', count: segmentsWithMultipleCalibres, message: `${segmentsWithMultipleCalibres} segmentos aparecen en más de un calibre.` });

  return {
    originalRecords: originalSegments.length,
    physicalSegments: physicalSegments.length,
    duplicatesIgnored: duplicateSegments,
    originalStoredLengthMeters,
    storedLengthMeters: physicalSegments.reduce((total, segment) => total + (segment.storedLengthMeters ?? 0), 0),
    geographicLengthMeters: physicalSegments.reduce((total, segment) => total + (segment.geographicLengthMeters ?? 0), 0),
    invalidStoredLengthSegments,
    zeroStoredLengthSegments,
    invalidGeometrySegments,
    zeroGeographicLengthSegments,
    detectedCalibres: lengthByCalibre.length,
    lengthByCalibre,
    segmentsWithoutCalibre: physicalSegments.length - segmentCalibres.size,
    nonElectricalCandidates,
    unmatchedCalibreReferences,
    ambiguousCalibreLineIds: ambiguousCalibreLineIds.size,
    segmentsWithMultipleCalibres,
    warnings,
    physicalSegmentRecords: physicalSegments.map(segment => ({
      segmentKey: segment.key,
      lineId: segment.line?.id ?? null,
      coords: segment.line?.coords
    }))
  };
}

function projectCoordinateToLocalMeters(coordinate, origin) {
  const toRadians = value => value * Math.PI / 180;
  const referenceLatitude = toRadians(origin[0]);
  return {
    x: EARTH_RADIUS_METERS * toRadians(coordinate[1] - origin[1]) * Math.cos(referenceLatitude),
    y: EARTH_RADIUS_METERS * toRadians(coordinate[0] - origin[0])
  };
}

function localMetersToCoordinate(point, origin) {
  const toDegrees = value => value * 180 / Math.PI;
  const cosine = Math.max(Math.cos(origin[0] * Math.PI / 180), 1e-12);
  return [
    origin[0] + toDegrees(point.y / EARTH_RADIUS_METERS),
    origin[1] + toDegrees(point.x / (EARTH_RADIUS_METERS * cosine))
  ];
}

export function findNearestPointOnPolyline(point, coords) {
  if (!isValidLatLonPair(point) || !Array.isArray(coords) || coords.length < 2 ||
      coords.some(coordinate => !isValidLatLonPair(coordinate))) return null;

  let nearest = null;
  for (let index = 1; index < coords.length; index += 1) {
    const start = projectCoordinateToLocalMeters(coords[index - 1], point);
    const end = projectCoordinateToLocalMeters(coords[index], point);
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const squaredLength = deltaX ** 2 + deltaY ** 2;
    const projection = squaredLength > 0
      ? Math.min(1, Math.max(0, -(start.x * deltaX + start.y * deltaY) / squaredLength))
      : 0;
    const projected = {
      x: start.x + projection * deltaX,
      y: start.y + projection * deltaY
    };
    const distanceMeters = Math.hypot(projected.x, projected.y);
    if (!nearest || distanceMeters < nearest.distanceMeters) {
      nearest = {
        distanceMeters,
        nearestPoint: localMetersToCoordinate(projected, point),
        projectionParameter: projection,
        startVertexIndex: index - 1,
        endVertexIndex: index
      };
    }
  }
  return nearest;
}

export function classifyFaultAssignmentConfidence(distanceMeters) {
  if (distanceMeters <= 10) return 'high';
  if (distanceMeters <= 25) return 'review';
  return 'low';
}

function readFaultCoordinates(fault) {
  if (isValidLatLonPair(fault?.coords)) return fault.coords;
  const databaseCoordinates = [fault?.latitud, fault?.longitud];
  return isValidLatLonPair(databaseCoordinates) ? databaseCoordinates : null;
}

export function assignFaultsToPhysicalSegments(faults = [], physicalSegments = [], options = {}) {
  const candidates = Array.isArray(physicalSegments) ? physicalSegments : [];
  const eligibleEdgeIds = options.eligibleEdgeIds instanceof Set
    ? options.eligibleEdgeIds
    : Array.isArray(options.eligibleEdgeIds) ? new Set(options.eligibleEdgeIds) : null;
  const topologyEdges = new Map((Array.isArray(options.topology?.edges) ? options.topology.edges : [])
    .map(edge => [edge.edgeId, edge]));
  const topologyNodes = new Map((Array.isArray(options.topology?.nodes) ? options.topology.nodes : [])
    .map(node => [node.nodeId, node]));
  const branches = Array.isArray(options.topology?.branches) ? options.topology.branches : [];
  const branchEdgeIds = new Set(branches.flatMap(branch => Array.isArray(branch.edgeIds) ? branch.edgeIds : []));
  const assignments = (Array.isArray(faults) ? faults : []).map((fault, faultIndex) => {
    const faultId = fault?.id ?? fault?.ticket ?? null;
    const point = readFaultCoordinates(fault);
    if (!point) return { faultId, faultIndex, unassigned_reason: 'missing_coordinates' };

    let nearest = null;
    candidates.forEach((segment) => {
      if (!Array.isArray(segment?.coords)) return;
      for (let vertexIndex = 1; vertexIndex < segment.coords.length; vertexIndex += 1) {
        const edgeId = createTopologyEdgeId(segment.segmentKey, vertexIndex - 1, vertexIndex);
        if (eligibleEdgeIds && !eligibleEdgeIds.has(edgeId)) continue;
        const candidate = findNearestPointOnPolyline(point, [segment.coords[vertexIndex - 1], segment.coords[vertexIndex]]);
        if (!candidate || (nearest && candidate.distanceMeters >= nearest.distanceMeters)) continue;
        nearest = {
          faultId,
          faultIndex,
          segmentKey: segment.segmentKey,
          edgeId,
          lineId: segment.lineId,
          distanceMeters: candidate.distanceMeters,
          nearestPoint: candidate.nearestPoint,
          projectionParameter: candidate.projectionParameter,
          confidence: classifyFaultAssignmentConfidence(candidate.distanceMeters)
        };
      }
    });

    if (nearest) {
      const edge = topologyEdges.get(nearest.edgeId);
      const endpointNodeId = nearest.projectionParameter === 0
        ? edge?.startNodeId
        : nearest.projectionParameter === 1 ? edge?.endNodeId : null;
      const endpointNode = endpointNodeId ? topologyNodes.get(endpointNodeId) : null;
      if (endpointNode?.degree >= 3) {
        const candidateBranchIds = Array.from(new Set(branches
          .filter(branch => branch.startNodeId === endpointNodeId || branch.endNodeId === endpointNodeId)
          .map(branch => branch.branchId)))
          .sort((left, right) => left.localeCompare(right));
        return {
          ...nearest,
          junctionFault: true,
          nodeId: endpointNodeId,
          candidateBranchIds
        };
      }
    }
    return nearest || { faultId, faultIndex, unassigned_reason: 'no_valid_segments' };
  });

  const junctionFaultAssignments = assignments.filter(item => item.junctionFault === true);

  return {
    totalFaults: assignments.length,
    assigned: assignments.filter(item => item.segmentKey !== undefined).length,
    branchAssigned: assignments.filter(item => item.junctionFault !== true && branchEdgeIds.has(item.edgeId)).length,
    junctionFaults: junctionFaultAssignments.length,
    junctionFaultAssignments,
    missingCoordinates: assignments.filter(item => item.unassigned_reason === 'missing_coordinates').length,
    noValidSegments: assignments.filter(item => item.unassigned_reason === 'no_valid_segments').length,
    highConfidence: assignments.filter(item => item.confidence === 'high').length,
    reviewConfidence: assignments.filter(item => item.confidence === 'review').length,
    lowConfidence: assignments.filter(item => item.confidence === 'low').length,
    assignments
  };
}

export function analyzeCircuit(linesData = [], faults = [], options = {}) {
  const phase1 = analyzeCircuitPhase1(linesData);
  const topology = buildCircuitTopology(phase1.physicalSegmentRecords, {
    rootCoordinate: options.rootCoordinate,
    snapToleranceMeters: options.snapToleranceMeters,
    terminalSpurMaxMeters: options.terminalSpurMaxMeters
  });
  const faultAssignment = assignFaultsToPhysicalSegments(faults, phase1.physicalSegmentRecords, {
    eligibleEdgeIds: topology.edges.map(edge => edge.edgeId),
    topology
  });
  const branchIndicators = calculateBranchIndicators(topology, faultAssignment, faults);
  const analysisSegmentIndicators = buildAnalysisSegments({
    topology,
    faultAssignment,
    faults,
    physicalSegments: phase1.physicalSegmentRecords,
    cableGroups: storedCableGroups(linesData)
  });
  return {
    ...phase1,
    faultAssignment,
    topology,
    branchIndicators,
    analysisSegmentIndicators
  };
}

export function serializeLlaveLines(llave = {}) {
  if (Array.isArray(llave.linesData)) {
    return typeof structuredClone === 'function' ? structuredClone(llave.linesData) : JSON.parse(JSON.stringify(llave.linesData));
  }
  const lines = readNetworkLines(llave.lines);
  const analysis = llave.analysis || readCircuitAnalysis(llave.lines);
  return analysis.note || analysis.cableGroups?.length || analysis.status !== 'cargado' ? [...lines, { [ANALYSIS_MARKER]: analysis }] : lines;
}

export function hydrateLlave(llave = {}) {
  const lines = llave.lines_data || llave.lines || [];
  return {
    id: llave.id ?? null,
    name: llave.name,
    lines: readNetworkLines(lines),
    analysis: readCircuitAnalysis(lines),
    linesData: typeof structuredClone === 'function' ? structuredClone(lines) : JSON.parse(JSON.stringify(lines)),
    createdAt: llave.created_at || llave.createdAt || null
  };
}
