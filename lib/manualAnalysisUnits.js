import { coordinateDistanceMeters, createPhysicalSegmentKey, createTopologyEdgeId } from './circuitTopology.js';
import { getDrawableLineCoordinates } from './coordUtils.js';

function cloneCoords(coords) {
  return Array.isArray(coords) ? coords.map(coord => Array.isArray(coord) ? [...coord] : coord) : [];
}

export function createManualEdgeRefsForLine(line = {}, lineIndex = 0) {
  const normalizedCoords = getDrawableLineCoordinates(line?.coords);
  if (!normalizedCoords.length) return [];
  const segmentKey = createPhysicalSegmentKey(line);
  const lineId = String(line.id ?? lineIndex);
  const refs = [];
  for (let endVertexIndex = 1; endVertexIndex < normalizedCoords.length; endVertexIndex += 1) {
    const startVertexIndex = endVertexIndex - 1;
    const coords = cloneCoords([normalizedCoords[startVertexIndex], normalizedCoords[endVertexIndex]]);
    const lengthMeters = coordinateDistanceMeters(coords[0], coords[1]);
    if (!Number.isFinite(lengthMeters)) continue;
    refs.push({
      edgeId: createTopologyEdgeId(segmentKey, startVertexIndex, endVertexIndex),
      segmentKey,
      lineId,
      startVertexIndex,
      endVertexIndex,
      coords,
      lengthMeters
    });
  }
  return refs;
}

export function buildManualEdgeCatalog(lines = []) {
  return (Array.isArray(lines) ? lines : []).flatMap((line, index) => createManualEdgeRefsForLine(line, index));
}

function readEdgeRefs(group) {
  const refs = Array.isArray(group?.edgeRefs) ? group.edgeRefs : Array.isArray(group?.edge_refs) ? group.edge_refs : [];
  return refs.map(ref => ({
    edgeId: ref?.edgeId ?? ref?.edge_id,
    segmentKey: ref?.segmentKey ?? ref?.segment_key,
    lineId: ref?.lineId ?? ref?.line_id,
    startVertexIndex: ref?.startVertexIndex ?? ref?.start_vertex_index,
    endVertexIndex: ref?.endVertexIndex ?? ref?.end_vertex_index,
    coords: cloneCoords(ref?.coords),
    lengthMeters: Number(ref?.lengthMeters ?? ref?.length_meters)
  })).filter(ref => typeof ref.edgeId === 'string' && ref.edgeId && typeof ref.segmentKey === 'string' && ref.segmentKey);
}

export function resolveManualGroupEdgeRefs(group = {}, lines = []) {
  const catalog = buildManualEdgeCatalog(lines);
  const catalogByEdgeId = new Map(catalog.map(ref => [ref.edgeId, ref]));
  const persistedRefs = readEdgeRefs(group);
  if (persistedRefs.length) {
    const resolved = [];
    const missingEdgeIds = [];
    persistedRefs.forEach((ref) => {
      const current = catalogByEdgeId.get(ref.edgeId);
      if (current) resolved.push(current);
      else missingEdgeIds.push(ref.edgeId);
    });
    return { edgeRefs: resolved, source: 'edgeRefs', missingEdgeIds, ambiguousLineIds: [] };
  }

  const lineIds = new Set((Array.isArray(group?.lineIds) ? group.lineIds : Array.isArray(group?.line_ids) ? group.line_ids : []).map(String));
  const edgeRefs = catalog.filter(ref => lineIds.has(ref.lineId));
  const segmentsByLineId = new Map();
  edgeRefs.forEach((ref) => {
    if (!segmentsByLineId.has(ref.lineId)) segmentsByLineId.set(ref.lineId, new Set());
    segmentsByLineId.get(ref.lineId).add(ref.segmentKey);
  });
  return {
    edgeRefs,
    source: 'legacyLineIds',
    missingEdgeIds: [],
    ambiguousLineIds: [...segmentsByLineId.entries()].filter(([, keys]) => keys.size > 1).map(([lineId]) => lineId).sort()
  };
}

export function createManualAnalysisUnits(cableGroups = [], lines = [], topology = {}) {
  const eligibleEdges = new Map((topology?.edges || []).map(edge => [edge.edgeId, edge]));
  return (Array.isArray(cableGroups) ? cableGroups : [])
    .filter(group => group?.analysisUnit === true || group?.analysis_unit === true || readEdgeRefs(group).length > 0)
    .map((group) => {
    const resolution = resolveManualGroupEdgeRefs(group, lines);
    const edgeIds = [...new Set(resolution.edgeRefs.map(ref => ref.edgeId).filter(edgeId => eligibleEdges.has(edgeId)))].sort();
    return {
      analysisUnitId: `manual:${String(group?.id ?? '')}`,
      source: 'manual',
      manualGroupId: group?.id ?? null,
      name: group?.name || 'Tramo manual',
      note: group?.note || '',
      color: group?.color || null,
      calibre: group?.calibre || '',
      edgeIds,
      segmentKeys: [...new Set(edgeIds.map(edgeId => eligibleEdges.get(edgeId)?.segmentKey).filter(Boolean))].sort(),
      lengthMeters: edgeIds.reduce((total, edgeId) => total + (eligibleEdges.get(edgeId)?.lengthMeters || 0), 0),
      identitySource: resolution.source,
      missingEdgeIds: resolution.missingEdgeIds,
      ambiguousLineIds: resolution.ambiguousLineIds
    };
  }).filter(unit => unit.manualGroupId !== null && unit.edgeIds.length > 0)
    .sort((left, right) => left.analysisUnitId.localeCompare(right.analysisUnitId));
}

export function splitEdgeIdsIntoConnectedComponents(edgeIds = [], topology = {}) {
  const selected = new Set(edgeIds);
  const edgeById = new Map((topology?.edges || []).map(edge => [edge.edgeId, edge]));
  const edgesByNode = new Map();
  selected.forEach((edgeId) => {
    const edge = edgeById.get(edgeId);
    if (!edge) return;
    for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
      if (!edgesByNode.has(nodeId)) edgesByNode.set(nodeId, []);
      edgesByNode.get(nodeId).push(edgeId);
    }
  });
  const visited = new Set();
  const components = [];
  [...selected].sort().forEach((firstEdgeId) => {
    if (visited.has(firstEdgeId) || !edgeById.has(firstEdgeId)) return;
    const queue = [firstEdgeId];
    const component = [];
    visited.add(firstEdgeId);
    while (queue.length) {
      const edgeId = queue.shift();
      component.push(edgeId);
      const edge = edgeById.get(edgeId);
      for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
        for (const candidate of edgesByNode.get(nodeId) || []) {
          if (!visited.has(candidate)) {
            visited.add(candidate);
            queue.push(candidate);
          }
        }
      }
    }
    components.push(component.sort());
  });
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}
