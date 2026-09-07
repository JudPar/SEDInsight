import { calculateParetoPriority } from './branchIndicators.js';
import { createManualAnalysisUnits, splitEdgeIdsIntoConnectedComponents } from './manualAnalysisUnits.js';
import { getCauseCategory } from './constants.js';

function normalizeCalibre(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
    .replace(/\s*(?:X|×)\s*/g, 'X')
    .replace(/\s*-\s*/g, '-');
}

function coordinateKey(coordinate) {
  return JSON.stringify(coordinate);
}

function coordinatesEqual(left, right) {
  return coordinateKey(left) === coordinateKey(right);
}

function shortHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function faultIdentity(assignment, assignmentIndex) {
  if (Number.isInteger(assignment?.faultIndex)) return `index:${assignment.faultIndex}`;
  if (assignment?.faultId !== null && assignment?.faultId !== undefined) return `id:${String(assignment.faultId)}`;
  return `assignment:${assignmentIndex}`;
}

function summarizeCauses(items, faults) {
  const buckets = new Map();
  items.forEach((assignment) => {
    const fault = faults[assignment.faultIndex] || null;
    const category = getCauseCategory(fault?.causa ?? fault?.cause);
    if (!buckets.has(category.id)) buckets.set(category.id, { id: category.id, label: category.label, count: 0 });
    buckets.get(category.id).count += 1;
  });
  return Array.from(buckets.values())
    .map(cause => ({ ...cause, share: items.length ? cause.count / items.length * 100 : 0 }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function buildCalibreEvidence(physicalSegments, cableGroups, topology) {
  const edgeCalibre = new Map();
  [...(topology.edges || []), ...(topology.originalEdges || [])].forEach((edge) => {
    const calibre = normalizeCalibre(edge?.calibreLabel || edge?.calibre);
    if (calibre) edgeCalibre.set(edge.edgeId, calibre);
  });
  const calibreConflictSegmentKeys = new Set((Array.isArray(physicalSegments) ? physicalSegments : [])
    .filter(segment => segment?.calibreConflict)
    .map(segment => segment.segmentKey));

  return {
    edgeCalibre,
    ambiguousLineIds: new Set(),
    ambiguousSegmentKeys: new Set(),
    calibreConflictSegmentKeys
  };
}

function edgeEndpointCoordinate(edge, nodeId) {
  if (edge.startNodeId === nodeId) return edge.coords?.[0] || null;
  if (edge.endNodeId === nodeId) return edge.coords?.[1] || null;
  return null;
}

function findPhysicalConnector(topology, originalEdgeById, nodeId, fromCoordinate, toCoordinate) {
  if (coordinatesEqual(fromCoordinate, toCoordinate)) return { connected: true, connectorEdgeIds: [] };
  const candidates = (topology.excludedIntraNodeEdgeIds || [])
    .map(edgeId => originalEdgeById.get(edgeId))
    .filter(edge => edge?.startNodeId === nodeId && edge?.endNodeId === nodeId)
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const adjacency = new Map();
  candidates.forEach((edge) => {
    const [start, end] = edge.coords || [];
    const startKey = coordinateKey(start);
    const endKey = coordinateKey(end);
    if (!adjacency.has(startKey)) adjacency.set(startKey, []);
    if (!adjacency.has(endKey)) adjacency.set(endKey, []);
    adjacency.get(startKey).push({ edgeId: edge.edgeId, nextKey: endKey });
    adjacency.get(endKey).push({ edgeId: edge.edgeId, nextKey: startKey });
  });
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

function deterministicMaximum(items, readValue) {
  if (!items.length) return null;
  return items.reduce((selected, item) => {
    const delta = readValue(item) - readValue(selected);
    if (delta > 0) return item;
    if (delta === 0 && item.analysisSegmentId.localeCompare(selected.analysisSegmentId) < 0) return item;
    return selected;
  });
}

export function buildAnalysisSegments({
  topology = {},
  faultAssignment = {},
  faults = [],
  physicalSegments = [],
  cableGroups = [],
  lines = []
} = {}) {
  const branches = Array.isArray(topology.branches) ? topology.branches : [];
  const analyticalEdges = Array.isArray(topology.edges) ? topology.edges : [];
  const originalEdges = Array.isArray(topology.originalEdges) ? topology.originalEdges : analyticalEdges;
  const nodes = Array.isArray(topology.nodes) ? topology.nodes : [];
  const edgeById = new Map(analyticalEdges.map(edge => [edge.edgeId, edge]));
  const originalEdgeById = new Map(originalEdges.map(edge => [edge.edgeId, edge]));
  const branchesAtNode = new Map(nodes.map(node => [node.nodeId, []]));
  branches.forEach((branch) => {
    branchesAtNode.get(branch.startNodeId)?.push(branch);
    if (branch.endNodeId !== branch.startNodeId) branchesAtNode.get(branch.endNodeId)?.push(branch);
  });

  const calibreEvidence = buildCalibreEvidence(
    Array.isArray(physicalSegments) ? physicalSegments : [],
    Array.isArray(cableGroups) ? cableGroups : [],
    topology
  );

  function endpointEdge(branch, nodeId) {
    const edgeId = branch.startNodeId === nodeId ? branch.edgeIds?.[0] : branch.edgeIds?.at(-1);
    return edgeById.get(edgeId);
  }

  const continuityDiagnostics = [];
  const acceptedPairs = [];
  nodes.slice().sort((left, right) => left.nodeId.localeCompare(right.nodeId)).forEach((node) => {
    const incidentBranches = Array.from(new Map((branchesAtNode.get(node.nodeId) || [])
      .map(branch => [branch.branchId, branch])).values())
      .sort((left, right) => left.branchId.localeCompare(right.branchId));
    if (node.degree >= 3) {
      continuityDiagnostics.push({ nodeId: node.nodeId, degree: node.degree, status: 'stopped', reason: 'bifurcation' });
      return;
    }
    if (node.degree !== 2 || incidentBranches.length !== 2) return;
    const [left, right] = incidentBranches;
    const leftEdge = endpointEdge(left, node.nodeId);
    const rightEdge = endpointEdge(right, node.nodeId);
    const physicalConnection = findPhysicalConnector(
      topology,
      originalEdgeById,
      node.nodeId,
      edgeEndpointCoordinate(leftEdge, node.nodeId),
      edgeEndpointCoordinate(rightEdge, node.nodeId)
    );
    acceptedPairs.push({
      branchId: left.branchId,
      candidateBranchId: right.branchId,
      nodeId: node.nodeId,
      degree: node.degree,
      connectorEdgeIds: physicalConnection.connected ? physicalConnection.connectorEdgeIds : [],
      continuityReason: 'degree-2',
      pairKey: [left.branchId, right.branchId].sort().join('\u0000')
    });
    continuityDiagnostics.push({ nodeId: node.nodeId, degree: node.degree, status: 'continued', reason: 'degree-2' });
  });
  acceptedPairs.sort((left, right) => left.pairKey.localeCompare(right.pairKey));

  const parent = new Map(branches.map(branch => [branch.branchId, branch.branchId]));
  const find = branchId => {
    let current = branchId;
    while (parent.get(current) !== current) current = parent.get(current);
    let cursor = branchId;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, current);
      cursor = next;
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return false;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second, first);
    return true;
  };

  const usedPairs = acceptedPairs.filter(pair => union(pair.branchId, pair.candidateBranchId));
  const components = new Map();
  branches.forEach((branch) => {
    const root = find(branch.branchId);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(branch);
  });

  const automaticComponentRecords = Array.from(components.values()).map((componentBranches) => {
    const branchIds = componentBranches.map(branch => branch.branchId).sort();
    const edgeIds = componentBranches.flatMap(branch => branch.edgeIds || []);
    const edgeIdSet = new Set(edgeIds);
    const connectorEdgeIds = new Set();
    const gaps = [];

    componentBranches.forEach((branch) => {
      let currentNodeId = branch.startNodeId;
      let previousEdge = null;
      (branch.edgeIds || []).forEach((edgeId) => {
        const edge = edgeById.get(edgeId);
        if (!edge) return;
        if (previousEdge) {
          const connection = findPhysicalConnector(
            topology,
            originalEdgeById,
            currentNodeId,
            edgeEndpointCoordinate(previousEdge, currentNodeId),
            edgeEndpointCoordinate(edge, currentNodeId)
          );
          if (connection.connected) connection.connectorEdgeIds.forEach(edgeId => connectorEdgeIds.add(edgeId));
          else gaps.push({ nodeId: currentNodeId, fromEdgeId: previousEdge.edgeId, toEdgeId: edge.edgeId });
        }
        currentNodeId = edge.startNodeId === currentNodeId ? edge.endNodeId : edge.startNodeId;
        previousEdge = edge;
      });
    });
    usedPairs.filter(pair => branchIds.includes(pair.branchId) && branchIds.includes(pair.candidateBranchId))
      .forEach(pair => pair.connectorEdgeIds.forEach(edgeId => connectorEdgeIds.add(edgeId)));

    const orderedEdges = Array.from(edgeIdSet).sort();
    const analysisSegmentId = `analysis-segment-${shortHash(orderedEdges.join('\u0000'))}`;
    return { analysisSegmentId, branchIds, edgeIds: orderedEdges, connectorEdgeIds: Array.from(connectorEdgeIds).sort(), gaps };
  }).sort((left, right) => left.analysisSegmentId.localeCompare(right.analysisSegmentId));

  const manualUnits = createManualAnalysisUnits(cableGroups, lines, topology);
  const manualEdgeOwners = new Map();
  const manualOverlapEdgeIds = new Set();
  const manualRecords = manualUnits.map((unit) => {
    const edgeIds = unit.edgeIds.filter((edgeId) => {
      if (manualEdgeOwners.has(edgeId)) {
        manualOverlapEdgeIds.add(edgeId);
        return false;
      }
      manualEdgeOwners.set(edgeId, unit.analysisUnitId);
      return true;
    });
    return {
      analysisSegmentId: unit.analysisUnitId,
      source: 'manual',
      manualGroupId: unit.manualGroupId,
      name: unit.name,
      note: unit.note,
      color: unit.color,
      branchIds: [...new Set(branches.filter(branch => branch.edgeIds?.some(edgeId => edgeIds.includes(edgeId))).map(branch => branch.branchId))].sort(),
      edgeIds,
      connectorEdgeIds: [],
      gaps: [],
      identitySource: unit.identitySource,
      missingEdgeIds: unit.missingEdgeIds,
      ambiguousLineIds: unit.ambiguousLineIds
    };
  }).filter(record => record.edgeIds.length > 0);

  const componentRecords = [
    ...manualRecords,
    ...automaticComponentRecords.flatMap((record) => {
      const remaining = record.edgeIds.filter(edgeId => !manualEdgeOwners.has(edgeId));
      if (!remaining.length) return [];
      if (remaining.length === record.edgeIds.length) return [{ ...record, source: 'automatic' }];
      return splitEdgeIdsIntoConnectedComponents(remaining, topology).map((edgeIds) => ({
        analysisSegmentId: `analysis-segment-${shortHash(edgeIds.join('\u0000'))}`,
        source: 'automatic',
        branchIds: [...new Set(branches.filter(branch => branch.edgeIds?.some(edgeId => edgeIds.includes(edgeId))).map(branch => branch.branchId))].sort(),
        edgeIds,
        connectorEdgeIds: [],
        gaps: []
      }));
    })
  ].sort((left, right) => left.analysisSegmentId.localeCompare(right.analysisSegmentId));

  const connectorOwners = new Map();
  componentRecords.forEach((segment) => {
    segment.connectorEdgeIds = segment.connectorEdgeIds.filter((edgeId) => {
      if (connectorOwners.has(edgeId)) return false;
      connectorOwners.set(edgeId, segment.analysisSegmentId);
      return true;
    });
  });

  const edgeOwner = new Map();
  componentRecords.forEach(segment => segment.edgeIds.forEach(edgeId => edgeOwner.set(edgeId, segment.analysisSegmentId)));
  const assignments = Array.isArray(faultAssignment.assignments) ? faultAssignment.assignments : [];
  const assignmentsBySegment = new Map(componentRecords.map(segment => [segment.analysisSegmentId, []]));
  const seenFaults = new Set();
  const outsideAssignments = [];
  assignments.forEach((assignment, assignmentIndex) => {
    const identity = faultIdentity(assignment, assignmentIndex);
    if (seenFaults.has(identity)) return;
    seenFaults.add(identity);
    if (assignment?.junctionFault || assignment?.unassigned_reason) {
      outsideAssignments.push(assignment);
      return;
    }
    const owner = edgeOwner.get(assignment?.edgeId);
    if (!owner) outsideAssignments.push(assignment);
    else assignmentsBySegment.get(owner).push(assignment);
  });
  const faultsAssignedToAnalysisSegments = Array.from(assignmentsBySegment.values())
    .reduce((total, segmentAssignments) => total + segmentAssignments.length, 0);

  const sourceFaults = Array.isArray(faults) ? faults : [];
  const segmentMetrics = componentRecords.map((segment) => {
    const allEdgeIds = [...segment.edgeIds, ...segment.connectorEdgeIds];
    const lengthMeters = allEdgeIds.reduce((total, edgeId) => total + (originalEdgeById.get(edgeId)?.lengthMeters || 0), 0);
    const segmentAssignments = assignmentsBySegment.get(segment.analysisSegmentId) || [];
    const calibreLengths = new Map();
    let unknownCalibreLengthMeters = 0;
    const mountingLengths = { aerial: 0, underground: 0, unclassified: 0 };
    allEdgeIds.forEach((edgeId) => {
      const edge = originalEdgeById.get(edgeId);
      const length = edge?.lengthMeters || 0;
      const calibre = calibreEvidence.edgeCalibre.get(edgeId);
      if (!calibre) unknownCalibreLengthMeters += length;
      else calibreLengths.set(calibre, (calibreLengths.get(calibre) || 0) + length);
      const mounting = ['aerial', 'underground'].includes(edge?.mounting) ? edge.mounting : 'unclassified';
      mountingLengths[mounting] += length;
    });
    const calibres = Array.from(calibreLengths.entries())
      .map(([label, length]) => ({ label, lengthMeters: length }))
      .sort((left, right) => right.lengthMeters - left.lengthMeters || left.label.localeCompare(right.label));
    const calibreStatus = calibres.length === 0 ? 'unknown'
      : calibres.length === 1 && unknownCalibreLengthMeters === 0 ? 'known'
        : 'mixed';
    const causes = summarizeCauses(segmentAssignments, sourceFaults);
    const lengthKm = lengthMeters / 1000;
    const segmentEdges = allEdgeIds.map(edgeId => originalEdgeById.get(edgeId)).filter(Boolean);
    const geometryReliability = segmentEdges.some(edge => edge.geometryReliability === 'unverified_crs')
      ? 'unverified_crs'
      : segmentEdges.length && segmentEdges.every(edge => edge.geometryReliability === 'canonical_wgs84') ? 'canonical_wgs84' : 'unknown';
    return {
      ...segment,
      lengthMeters,
      lengthKm,
      faultIndexes: segmentAssignments.map(assignment => assignment.faultIndex),
      faultCount: segmentAssignments.length,
      faultsPerKm: lengthKm > 0 ? segmentAssignments.length / lengthKm : null,
      faultShare: faultsAssignedToAnalysisSegments ? segmentAssignments.length / faultsAssignedToAnalysisSegments * 100 : 0,
      confidence: {
        high: segmentAssignments.filter(assignment => assignment.confidence === 'high').length,
        review: segmentAssignments.filter(assignment => assignment.confidence === 'review').length,
        low: segmentAssignments.filter(assignment => assignment.confidence === 'low').length
      },
      highConfidenceFaults: segmentAssignments.filter(assignment => assignment.confidence === 'high').length,
      reviewConfidenceFaults: segmentAssignments.filter(assignment => assignment.confidence === 'review').length,
      lowConfidenceFaults: segmentAssignments.filter(assignment => assignment.confidence === 'low').length,
      causes,
      mainCause: causes[0] || null,
      calibreStatus,
      calibreLabel: calibreStatus === 'known' ? calibres[0].label : calibreStatus === 'mixed' ? 'Mixto' : 'No informado',
      calibres,
      unknownCalibreLengthMeters,
      mountingStatus: [mountingLengths.aerial, mountingLengths.underground, mountingLengths.unclassified].filter(length => length > 0).length > 1
        ? 'mixed'
        : mountingLengths.aerial > 0 ? 'aerial' : mountingLengths.underground > 0 ? 'underground' : 'unclassified',
      aerialLengthMeters: mountingLengths.aerial,
      undergroundLengthMeters: mountingLengths.underground,
      unclassifiedLengthMeters: mountingLengths.unclassified,
      geometryReliability
    };
  });

  const priority = calculateParetoPriority(segmentMetrics);
  const segmentsWithFaults = segmentMetrics.filter(segment => segment.faultCount > 0);
  const densitySegments = segmentsWithFaults.filter(segment => segment.faultsPerKm !== null);
  return {
    totalAnalysisSegments: segmentMetrics.length,
    faultsAssignedToAnalysisSegments,
    faultsOutsideAnalysisSegments: outsideAssignments.length,
    outsideAssignments,
    analysisSegmentWithMostFaults: deterministicMaximum(segmentsWithFaults, segment => segment.faultCount)?.analysisSegmentId || null,
    analysisSegmentWithHighestFaultsPerKm: deterministicMaximum(densitySegments, segment => segment.faultsPerKm)?.analysisSegmentId || null,
    ...priority,
    analysisSegments: segmentMetrics.sort((left, right) => {
      if (left.faultsPerKm === null && right.faultsPerKm !== null) return 1;
      if (left.faultsPerKm !== null && right.faultsPerKm === null) return -1;
      return (right.faultsPerKm ?? 0) - (left.faultsPerKm ?? 0) || right.faultCount - left.faultCount || left.analysisSegmentId.localeCompare(right.analysisSegmentId);
    }),
    diagnostics: {
      continuity: continuityDiagnostics,
      acceptedContinuities: usedPairs,
      segmentationRule: 'ANALYTICAL_NODE_DEGREE',
      calibreCuts: 0,
      angularContinuities: 0,
      ambiguousCalibreLineIds: Array.from(calibreEvidence.ambiguousLineIds).sort(),
      ambiguousCalibreSegmentKeys: Array.from(calibreEvidence.ambiguousSegmentKeys).sort(),
      calibreConflictSegmentKeys: Array.from(calibreEvidence.calibreConflictSegmentKeys).sort(),
      gaps: componentRecords.flatMap(segment => segment.gaps.map(gap => ({ analysisSegmentId: segment.analysisSegmentId, ...gap }))),
      manualPriorityApplied: manualRecords.length > 0,
      manualAnalysisUnits: manualRecords.length,
      manualOverlapEdgeIds: [...manualOverlapEdgeIds].sort(),
      manualIdentityWarnings: manualRecords.filter(record => record.missingEdgeIds.length || record.ambiguousLineIds.length).map(record => ({
        analysisSegmentId: record.analysisSegmentId,
        missingEdgeIds: record.missingEdgeIds,
        ambiguousLineIds: record.ambiguousLineIds
      }))
    }
  };
}

export function resolveAnalysisSegment(analysisSegmentIndicators, analysisSegmentId) {
  if (!analysisSegmentId || !Array.isArray(analysisSegmentIndicators?.analysisSegments)) return null;
  return analysisSegmentIndicators.analysisSegments
    .find(segment => segment.analysisSegmentId === analysisSegmentId) || null;
}

export function buildAnalysisSegmentFaultView(faults = [], faultAssignment = {}, analysisSegment = null, filterEnabled = false) {
  const sourceFaults = Array.isArray(faults) ? faults : [];
  const assignments = Array.isArray(faultAssignment?.assignments) ? faultAssignment.assignments : [];
  if (!filterEnabled || !analysisSegment) return { faults: sourceFaults, assignments };
  const includedIndexes = new Set(analysisSegment.faultIndexes || []);
  const filteredFaults = [];
  const filteredAssignments = [];
  sourceFaults.forEach((fault, faultIndex) => {
    if (!includedIndexes.has(faultIndex)) return;
    filteredFaults.push(fault);
    const assignment = assignments.find(item => item?.faultIndex === faultIndex && !item?.junctionFault);
    if (assignment) filteredAssignments.push(assignment);
  });
  return { faults: filteredFaults, assignments: filteredAssignments };
}
