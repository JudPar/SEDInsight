export const NODE_SNAP_TOLERANCE_METERS = 2;
export const TERMINAL_SPUR_MAX_METERS = 15;

const EARTH_RADIUS_METERS = 6371008.8;

export function createTopologyEdgeId(segmentKey, startVertexIndex, endVertexIndex) {
  return `edge:${JSON.stringify([segmentKey, startVertexIndex, endVertexIndex])}`;
}

function isValidCoordinate(coordinate) {
  return Array.isArray(coordinate) && coordinate.length >= 2 &&
    typeof coordinate[0] === 'number' && Number.isFinite(coordinate[0]) && coordinate[0] >= -90 && coordinate[0] <= 90 &&
    typeof coordinate[1] === 'number' && Number.isFinite(coordinate[1]) && coordinate[1] >= -180 && coordinate[1] <= 180;
}

function coordinateDistanceMeters(from, to) {
  const toRadians = value => value * Math.PI / 180;
  const lat1 = toRadians(from[0]);
  const lat2 = toRadians(to[0]);
  const deltaLat = lat2 - lat1;
  const deltaLng = toRadians(to[1] - from[1]);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  const boundedA = Math.min(1, Math.max(0, a));
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
}

function snapOccurrences(occurrences, toleranceMeters) {
  if (!occurrences.length) return [];

  if (toleranceMeters === 0) {
    const exactClusters = new Map();
    occurrences.forEach((occurrence, index) => {
      const key = JSON.stringify(occurrence.coordinate);
      if (!exactClusters.has(key)) exactClusters.set(key, []);
      exactClusters.get(key).push(index);
    });
    return Array.from(exactClusters.values());
  }

  const referenceLatitude = occurrences.reduce((total, occurrence) => total + occurrence.coordinate[0], 0) / occurrences.length;
  const cosine = Math.max(Math.cos(referenceLatitude * Math.PI / 180), 1e-12);
  const buckets = new Map();
  const projected = occurrences.map((occurrence) => ({
    x: EARTH_RADIUS_METERS * occurrence.coordinate[1] * Math.PI / 180 * cosine,
    y: EARTH_RADIUS_METERS * occurrence.coordinate[0] * Math.PI / 180
  }));

  const clusters = [];
  const clusterIdByOccurrence = new Map();
  projected.forEach((point, index) => {
    const bucketX = Math.floor(point.x / toleranceMeters);
    const bucketY = Math.floor(point.y / toleranceMeters);
    const candidateClusterIds = new Set();
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        const nearby = buckets.get(`${bucketX + xOffset}:${bucketY + yOffset}`) || [];
        nearby.forEach(candidateIndex => candidateClusterIds.add(clusterIdByOccurrence.get(candidateIndex)));
      }
    }

    let selectedClusterId = null;
    let selectedMaximumDistance = null;
    Array.from(candidateClusterIds).sort((left, right) => left - right).forEach((clusterId) => {
      const distances = clusters[clusterId].map(memberIndex =>
        coordinateDistanceMeters(occurrences[index].coordinate, occurrences[memberIndex].coordinate));
      const maximumDistance = Math.max(...distances);
      if (maximumDistance > toleranceMeters) return;
      if (selectedMaximumDistance === null || maximumDistance < selectedMaximumDistance) {
        selectedClusterId = clusterId;
        selectedMaximumDistance = maximumDistance;
      }
    });

    if (selectedClusterId === null) {
      selectedClusterId = clusters.length;
      clusters.push([]);
    }
    clusters[selectedClusterId].push(index);
    clusterIdByOccurrence.set(index, selectedClusterId);

    const bucketKey = `${bucketX}:${bucketY}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(index);
  });

  // Complete-link: every pair of original coordinates in a snapped node remains within tolerance.
  return clusters;
}

function collectComponents(nodes, edges) {
  const edgeById = new Map(edges.map(edge => [edge.edgeId, edge]));
  const nodeById = new Map(nodes.map(node => [node.nodeId, node]));
  const visited = new Set();
  const components = [];

  nodes.forEach((startNode) => {
    if (visited.has(startNode.nodeId)) return;
    const queue = [startNode.nodeId];
    const nodeIds = [];
    const edgeIds = new Set();
    visited.add(startNode.nodeId);
    while (queue.length) {
      const nodeId = queue.shift();
      nodeIds.push(nodeId);
      const node = nodeById.get(nodeId);
      node.edgeIds.forEach((edgeId) => {
        edgeIds.add(edgeId);
        const edge = edgeById.get(edgeId);
        const otherNodeId = edge.startNodeId === nodeId ? edge.endNodeId : edge.startNodeId;
        if (!visited.has(otherNodeId)) {
          visited.add(otherNodeId);
          queue.push(otherNodeId);
        }
      });
    }
    components.push({
      componentId: `component-${components.length + 1}`,
      nodeIds,
      edgeIds: Array.from(edgeIds)
    });
  });
  return components;
}

function classifyNode(node) {
  if (node.degree === 1) return 'terminal';
  if (node.degree === 2) return 'passage';
  if (node.degree >= 3) return 'bifurcation';
  return 'isolated';
}

function buildAnalyticalNodes(originalNodes, analyticalEdges) {
  const analyticalEdgeIds = new Set(analyticalEdges.map(edge => edge.edgeId));
  return originalNodes.map((node) => {
    const edgeIds = node.edgeIds.filter(edgeId => analyticalEdgeIds.has(edgeId));
    const degree = edgeIds.length;
    return { ...node, edgeIds, degree, kind: classifyNode({ degree }) };
  }).filter(node => node.degree > 0);
}

function classifyTerminalSpurs(nodes, edges, rootNodeId, maximumLengthMeters) {
  const nodeById = new Map(nodes.map(node => [node.nodeId, node]));
  const edgeById = new Map(edges.map(edge => [edge.edgeId, edge]));
  const terminalSpurs = [];

  // Each walk uses only the original degrees. Exclusions never feed back into classification.
  nodes.filter(node => node.degree === 1 && node.nodeId !== rootNodeId).forEach((terminalNode) => {
    const edgeIds = [];
    let lengthMeters = 0;
    let currentNodeId = terminalNode.nodeId;
    let previousEdgeId = null;
    let anchorNodeId = null;

    while (true) {
      const currentNode = nodeById.get(currentNodeId);
      const nextEdgeIds = Array.from(new Set(currentNode?.edgeIds || []))
        .filter(edgeId => edgeId !== previousEdgeId);
      if (nextEdgeIds.length !== 1) break;

      const edge = edgeById.get(nextEdgeIds[0]);
      if (!edge) break;
      edgeIds.push(edge.edgeId);
      lengthMeters += edge.lengthMeters;
      const nextNodeId = edge.startNodeId === currentNodeId ? edge.endNodeId : edge.startNodeId;
      const nextNode = nodeById.get(nextNodeId);

      if (nextNodeId === rootNodeId || nextNode?.degree >= 3) {
        anchorNodeId = nextNodeId;
        break;
      }
      if (nextNode?.degree !== 2) break;

      previousEdgeId = edge.edgeId;
      currentNodeId = nextNodeId;
    }

    if (anchorNodeId && lengthMeters <= maximumLengthMeters) {
      terminalSpurs.push({
        spurId: `terminal-spur-${terminalSpurs.length + 1}`,
        terminalNodeId: terminalNode.nodeId,
        anchorNodeId,
        edgeIds,
        lengthMeters
      });
    }
  });

  return terminalSpurs;
}

function buildBranches(nodes, edges, rootNodeId) {
  const nodeById = new Map(nodes.map(node => [node.nodeId, node]));
  const edgeById = new Map(edges.map(edge => [edge.edgeId, edge]));
  const significantNodes = new Set(nodes
    .filter(node => node.degree === 1 || node.degree >= 3 || node.nodeId === rootNodeId)
    .map(node => node.nodeId));
  const visitedEdges = new Set();
  const branches = [];

  nodes.filter(node => significantNodes.has(node.nodeId)).forEach((startNode) => {
    Array.from(new Set(startNode.edgeIds)).forEach((firstEdgeId) => {
      if (visitedEdges.has(firstEdgeId)) return;
      const edgeIds = [];
      const segmentKeys = [];
      let lengthMeters = 0;
      let currentNodeId = startNode.nodeId;
      let currentEdgeId = firstEdgeId;
      let endNodeId = currentNodeId;

      while (currentEdgeId && !visitedEdges.has(currentEdgeId)) {
        visitedEdges.add(currentEdgeId);
        const edge = edgeById.get(currentEdgeId);
        edgeIds.push(currentEdgeId);
        if (!segmentKeys.includes(edge.segmentKey)) segmentKeys.push(edge.segmentKey);
        lengthMeters += edge.lengthMeters;
        endNodeId = edge.startNodeId === currentNodeId ? edge.endNodeId : edge.startNodeId;
        if (significantNodes.has(endNodeId)) break;
        const nextEdges = Array.from(new Set(nodeById.get(endNodeId).edgeIds)).filter(edgeId => !visitedEdges.has(edgeId));
        if (nextEdges.length !== 1) break;
        currentNodeId = endNodeId;
        [currentEdgeId] = nextEdges;
      }

      const branchEdges = edgeIds.map(edgeId => edgeById.get(edgeId)).filter(Boolean);
      const calibreLabels = Array.from(new Set(branchEdges.map(edge => edge.calibreLabel).filter(Boolean))).sort();
      const hasUnknownCalibre = branchEdges.some(edge => !edge.calibreLabel);
      const calibreStatus = calibreLabels.length === 0 ? 'unknown'
        : calibreLabels.length === 1 && !hasUnknownCalibre ? 'known'
          : 'mixed';

      branches.push({
        branchId: `branch-${branches.length + 1}`,
        startNodeId: startNode.nodeId,
        endNodeId,
        segmentKeys,
        edgeIds,
        lengthMeters,
        calibreStatus,
        calibreLabel: calibreStatus === 'known' ? calibreLabels[0] : calibreStatus === 'mixed' ? 'Mixto' : 'No informado',
        calibres: calibreLabels,
        hasUnknownCalibre
      });
    });
  });

  return {
    branches,
    unbranchedEdgeIds: edges.filter(edge => !visitedEdges.has(edge.edgeId)).map(edge => edge.edgeId)
  };
}

export function buildCircuitTopology(physicalSegments = [], options = {}) {
  const toleranceCandidate = options.snapToleranceMeters ?? NODE_SNAP_TOLERANCE_METERS;
  const snapToleranceMeters = typeof toleranceCandidate === 'number' && Number.isFinite(toleranceCandidate) && toleranceCandidate >= 0
    ? toleranceCandidate
    : NODE_SNAP_TOLERANCE_METERS;
  const spurLengthCandidate = options.terminalSpurMaxMeters ?? TERMINAL_SPUR_MAX_METERS;
  const terminalSpurMaxMeters = typeof spurLengthCandidate === 'number' && Number.isFinite(spurLengthCandidate) && spurLengthCandidate >= 0
    ? spurLengthCandidate
    : TERMINAL_SPUR_MAX_METERS;
  const segments = Array.isArray(physicalSegments) ? physicalSegments : [];
  const occurrences = [];
  const occurrenceByVertex = new Map();

  segments.forEach((segment, segmentIndex) => {
    if (!Array.isArray(segment?.coords)) return;
    segment.coords.forEach((coordinate, vertexIndex) => {
      if (!isValidCoordinate(coordinate)) return;
      const occurrenceIndex = occurrences.length;
      occurrences.push({ coordinate, segmentIndex, vertexIndex });
      occurrenceByVertex.set(`${segmentIndex}:${vertexIndex}`, occurrenceIndex);
    });
  });

  const orderedGroups = snapOccurrences(occurrences, snapToleranceMeters);
  const nodeIdByOccurrence = new Map();
  const nodes = orderedGroups.map((indices, index) => {
    const coordinate = indices.reduce((total, occurrenceIndex) => {
      const value = occurrences[occurrenceIndex].coordinate;
      return [total[0] + value[0], total[1] + value[1]];
    }, [0, 0]).map(value => value / indices.length);
    const nodeId = `node-${index + 1}`;
    indices.forEach(occurrenceIndex => nodeIdByOccurrence.set(occurrenceIndex, nodeId));
    return { nodeId, coordinate, degree: 0, kind: 'isolated', edgeIds: [] };
  });
  const nodeById = new Map(nodes.map(node => [node.nodeId, node]));

  const edges = [];
  segments.forEach((segment, segmentIndex) => {
    if (!Array.isArray(segment?.coords)) return;
    for (let vertexIndex = 1; vertexIndex < segment.coords.length; vertexIndex += 1) {
      const startOccurrence = occurrenceByVertex.get(`${segmentIndex}:${vertexIndex - 1}`);
      const endOccurrence = occurrenceByVertex.get(`${segmentIndex}:${vertexIndex}`);
      if (startOccurrence === undefined || endOccurrence === undefined) continue;
      const edge = {
        edgeId: createTopologyEdgeId(segment.segmentKey, vertexIndex - 1, vertexIndex),
        startNodeId: nodeIdByOccurrence.get(startOccurrence),
        endNodeId: nodeIdByOccurrence.get(endOccurrence),
        segmentKey: segment.segmentKey,
        coords: [segment.coords[vertexIndex - 1], segment.coords[vertexIndex]],
        lengthMeters: coordinateDistanceMeters(segment.coords[vertexIndex - 1], segment.coords[vertexIndex]),
        calibre: segment.calibre || null,
        calibreLabel: segment.calibreLabel || segment.calibre || null,
        calibreDisplayLabel: segment.calibreDisplayLabel || segment.calibreLabel || segment.calibre || 'No informado',
        calibreSource: segment.calibreSource || 'unknown',
        calibreConflict: Boolean(segment.calibreConflict)
      };
      edges.push(edge);
      nodeById.get(edge.startNodeId).edgeIds.push(edge.edgeId);
      nodeById.get(edge.endNodeId).edgeIds.push(edge.edgeId);
    }
  });

  nodes.forEach((node) => {
    node.degree = node.edgeIds.length;
    node.kind = classifyNode(node);
  });

  const rootCoordinate = isValidCoordinate(options.rootCoordinate) ? options.rootCoordinate : null;
  let rootNodeId = null;
  let rootDistanceMeters = null;
  if (rootCoordinate && nodes.length) {
    nodes.forEach((node) => {
      const distanceMeters = coordinateDistanceMeters(rootCoordinate, node.coordinate);
      if (rootDistanceMeters === null || distanceMeters < rootDistanceMeters) {
        rootNodeId = node.nodeId;
        rootDistanceMeters = distanceMeters;
      }
    });
  }

  const originalComponents = collectComponents(nodes, edges);
  const originalBranches = buildBranches(nodes, edges, rootNodeId);
  const excludedIntraNodeEdgeIds = edges
    .filter(edge => edge.startNodeId === edge.endNodeId)
    .map(edge => edge.edgeId);
  const excludedIntraNodeEdgeIdSet = new Set(excludedIntraNodeEdgeIds);
  const topologyBaseEdges = edges.filter(edge => !excludedIntraNodeEdgeIdSet.has(edge.edgeId));
  const topologyBaseNodes = buildAnalyticalNodes(nodes, topologyBaseEdges);
  const terminalSpurs = classifyTerminalSpurs(topologyBaseNodes, topologyBaseEdges, rootNodeId, terminalSpurMaxMeters);
  const excludedSpurEdgeIds = Array.from(new Set(terminalSpurs.flatMap(spur => spur.edgeIds)));
  const excludedSpurEdgeIdSet = new Set(excludedSpurEdgeIds);
  const analyticalEdges = topologyBaseEdges.filter(edge => !excludedSpurEdgeIdSet.has(edge.edgeId));
  const analyticalNodes = buildAnalyticalNodes(nodes, analyticalEdges);
  const components = collectComponents(analyticalNodes, analyticalEdges);
  const { branches, unbranchedEdgeIds } = buildBranches(analyticalNodes, analyticalEdges, rootNodeId);
  return {
    snapToleranceMeters,
    terminalSpurMaxMeters,
    rootStatus: rootNodeId ? 'detected' : 'unknown',
    rootNodeId,
    rootDistanceMeters,
    nodeCount: analyticalNodes.length,
    edgeCount: analyticalEdges.length,
    bifurcationCount: analyticalNodes.filter(node => node.kind === 'bifurcation').length,
    terminalCount: analyticalNodes.filter(node => node.kind === 'terminal').length,
    branchCount: branches.length,
    componentCount: components.length,
    disconnectedComponents: Math.max(0, components.length - 1),
    originalNodeCount: nodes.length,
    originalEdgeCount: edges.length,
    originalBranchCount: originalBranches.branches.length,
    originalComponentCount: originalComponents.length,
    terminalSpurCount: terminalSpurs.length,
    excludedSpurLengthMeters: terminalSpurs.reduce((total, spur) => total + spur.lengthMeters, 0),
    excludedSpurEdgeIds,
    terminalSpurs,
    intraNodeEdgeCount: excludedIntraNodeEdgeIds.length,
    excludedIntraNodeLengthMeters: edges
      .filter(edge => excludedIntraNodeEdgeIdSet.has(edge.edgeId))
      .reduce((total, edge) => total + edge.lengthMeters, 0),
    excludedIntraNodeEdgeIds,
    nodes: analyticalNodes,
    edges: analyticalEdges,
    originalNodes: nodes,
    originalEdges: edges,
    branches,
    components,
    unbranchedEdgeIds
  };
}
