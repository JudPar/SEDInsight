import { coordinateDistanceMeters, createPhysicalSegmentKey, createTopologyEdgeId } from './circuitTopology.js';
import { getDrawableLineCoordinates } from './coordUtils.js';

function cloneCoords(coords) {
  return Array.isArray(coords) ? coords.map(coord => Array.isArray(coord) ? [...coord] : coord) : [];
}

function coordinateKey(coordinate) {
  return JSON.stringify(coordinate);
}

function coordinatesEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && coordinateKey(left) === coordinateKey(right);
}

function edgeEndpointCoordinate(edge, nodeId) {
  if (edge?.startNodeId === nodeId) return edge.coords?.[0] || null;
  if (edge?.endNodeId === nodeId) return edge.coords?.[1] || null;
  return null;
}

export function findUniqueIntraNodeConnectorPath(topology = {}, nodeId, fromCoordinate, toCoordinate) {
  if (coordinatesEqual(fromCoordinate, toCoordinate)) return { connected: true, connectorEdgeIds: [] };
  if (!nodeId || !Array.isArray(fromCoordinate) || !Array.isArray(toCoordinate)) {
    return { connected: false, connectorEdgeIds: [] };
  }

  const originalEdgeById = new Map((topology?.originalEdges || topology?.edges || [])
    .map(edge => [edge.edgeId, edge]));
  const candidates = (topology?.excludedIntraNodeEdgeIds || [])
    .map(edgeId => originalEdgeById.get(edgeId))
    .filter(edge => edge?.startNodeId === nodeId && edge?.endNodeId === nodeId)
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const adjacency = new Map();
  candidates.forEach((edge) => {
    const [start, end] = edge.coords || [];
    if (!Array.isArray(start) || !Array.isArray(end)) return;
    const startKey = coordinateKey(start);
    const endKey = coordinateKey(end);
    if (!adjacency.has(startKey)) adjacency.set(startKey, []);
    if (!adjacency.has(endKey)) adjacency.set(endKey, []);
    adjacency.get(startKey).push({ edgeId: edge.edgeId, nextKey: endKey });
    adjacency.get(endKey).push({ edgeId: edge.edgeId, nextKey: startKey });
  });
  adjacency.forEach(steps => steps.sort((left, right) => left.edgeId.localeCompare(right.edgeId)));

  const startKey = coordinateKey(fromCoordinate);
  const targetKey = coordinateKey(toCoordinate);
  const queue = [{ coordinate: startKey, edgeIds: [], visited: new Set([startKey]) }];
  const paths = [];
  let shortestLength = Infinity;
  while (queue.length) {
    const current = queue.shift();
    if (current.edgeIds.length > shortestLength) continue;
    if (current.coordinate === targetKey) {
      shortestLength = current.edgeIds.length;
      paths.push(current.edgeIds);
      continue;
    }
    (adjacency.get(current.coordinate) || []).forEach((step) => {
      if (current.visited.has(step.nextKey)) return;
      queue.push({
        coordinate: step.nextKey,
        edgeIds: [...current.edgeIds, step.edgeId],
        visited: new Set([...current.visited, step.nextKey])
      });
    });
  }
  const shortestPaths = paths.filter(path => path.length === shortestLength);
  return shortestPaths.length === 1
    ? { connected: true, connectorEdgeIds: shortestPaths[0] }
    : { connected: false, connectorEdgeIds: [] };
}

export function findUniqueAnalyticalEdgePath(topology = {}, startEdgeId, endEdgeId) {
  const edges = Array.isArray(topology?.edges) ? topology.edges : [];
  const edgeById = new Map(edges.map(edge => [edge.edgeId, edge]));
  const startEdge = edgeById.get(startEdgeId);
  const endEdge = edgeById.get(endEdgeId);
  if (!startEdge || !endEdge) return { status: 'not_found', edgeIds: [], pathCount: 0 };
  if (startEdgeId === endEdgeId) return { status: 'found', edgeIds: [startEdgeId], pathCount: 1 };

  const excludedEndpoints = new Set([startEdgeId, endEdgeId]);
  const edgesByNode = new Map();
  edges.forEach((edge) => {
    if (excludedEndpoints.has(edge.edgeId)) return;
    for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
      if (!edgesByNode.has(nodeId)) edgesByNode.set(nodeId, []);
      edgesByNode.get(nodeId).push(edge);
    }
  });
  edgesByNode.forEach(nodeEdges => nodeEdges.sort((left, right) => left.edgeId.localeCompare(right.edgeId)));

  const uniquePaths = new Map();
  const startNodes = [...new Set([startEdge.startNodeId, startEdge.endNodeId])].sort();
  const targetNodes = new Set([endEdge.startNodeId, endEdge.endNodeId]);
  startNodes.forEach((startNodeId) => {
    const queue = [{ nodeId: startNodeId, edgeIds: [], visitedNodes: new Set([startNodeId]) }];
    while (queue.length && uniquePaths.size < 2) {
      const current = queue.shift();
      if (targetNodes.has(current.nodeId)) {
        const edgeIds = [startEdgeId, ...current.edgeIds, endEdgeId];
        uniquePaths.set(edgeIds.join('\u0000'), edgeIds);
        continue;
      }
      for (const edge of edgesByNode.get(current.nodeId) || []) {
        const nextNodeId = edge.startNodeId === current.nodeId ? edge.endNodeId : edge.startNodeId;
        if (current.visitedNodes.has(nextNodeId)) continue;
        queue.push({
          nodeId: nextNodeId,
          edgeIds: [...current.edgeIds, edge.edgeId],
          visitedNodes: new Set([...current.visitedNodes, nextNodeId])
        });
      }
    }
  });

  const paths = [...uniquePaths.values()];
  if (paths.length === 1) return { status: 'found', edgeIds: paths[0], pathCount: 1 };
  if (paths.length > 1) return { status: 'ambiguous', edgeIds: [], pathCount: paths.length };
  return { status: 'not_found', edgeIds: [], pathCount: 0 };
}

function collectManualConnectorEdges(edgeIds, topology) {
  const edgeById = new Map((topology?.edges || []).map(edge => [edge.edgeId, edge]));
  const selectedEdgesByNode = new Map();
  edgeIds.forEach((edgeId) => {
    const edge = edgeById.get(edgeId);
    if (!edge) return;
    for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
      if (!selectedEdgesByNode.has(nodeId)) selectedEdgesByNode.set(nodeId, []);
      selectedEdgesByNode.get(nodeId).push(edge);
    }
  });

  const connectorEdgeIds = new Set();
  const gaps = [];
  [...selectedEdgesByNode.entries()].sort(([left], [right]) => left.localeCompare(right)).forEach(([nodeId, nodeEdges]) => {
    const uniqueEdges = [...new Map(nodeEdges.map(edge => [edge.edgeId, edge])).values()]
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
    for (let leftIndex = 0; leftIndex < uniqueEdges.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < uniqueEdges.length; rightIndex += 1) {
        const left = uniqueEdges[leftIndex];
        const right = uniqueEdges[rightIndex];
        const connection = findUniqueIntraNodeConnectorPath(
          topology,
          nodeId,
          edgeEndpointCoordinate(left, nodeId),
          edgeEndpointCoordinate(right, nodeId)
        );
        if (connection.connected) connection.connectorEdgeIds.forEach(edgeId => connectorEdgeIds.add(edgeId));
        else gaps.push({ nodeId, fromEdgeId: left.edgeId, toEdgeId: right.edgeId });
      }
    }
  });
  return { connectorEdgeIds: [...connectorEdgeIds].sort(), gaps };
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
    const physicalContinuity = collectManualConnectorEdges(edgeIds, topology);
    return {
      analysisUnitId: `manual:${String(group?.id ?? '')}`,
      source: 'manual',
      manualGroupId: group?.id ?? null,
      name: group?.name || 'Tramo manual',
      note: group?.note || '',
      color: group?.color || null,
      calibre: group?.calibre || '',
      edgeIds,
      connectorEdgeIds: physicalContinuity.connectorEdgeIds,
      gaps: physicalContinuity.gaps,
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
