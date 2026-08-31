import { calculateParetoPriority } from './branchIndicators.js';
import { getCauseCategory } from './constants.js';

export const ANALYSIS_MAX_DEFLECTION_DEG = 10;
export const ANALYSIS_MIN_ANGLE_MARGIN_DEG = 10;

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

function localVector(from, to) {
  const referenceLatitude = (from[0] + to[0]) / 2 * Math.PI / 180;
  return [
    (to[1] - from[1]) * Math.cos(referenceLatitude),
    to[0] - from[0]
  ];
}

function deflectionDegrees(left, right) {
  const denominator = Math.hypot(...left) * Math.hypot(...right);
  if (!denominator) return null;
  const cosine = Math.max(-1, Math.min(1, (left[0] * right[0] + left[1] * right[1]) / denominator));
  return 180 - Math.acos(cosine) * 180 / Math.PI;
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
  const segmentsByLineId = new Map();
  physicalSegments.forEach((segment) => {
    if (segment?.lineId === null || segment?.lineId === undefined) return;
    const lineId = String(segment.lineId);
    if (!segmentsByLineId.has(lineId)) segmentsByLineId.set(lineId, []);
    segmentsByLineId.get(lineId).push(segment);
  });

  const labelsBySegmentKey = new Map();
  const ambiguousLineIds = new Set();
  cableGroups.forEach((group) => {
    const calibre = normalizeCalibre(group?.calibre);
    if (!calibre) return;
    const lineIds = Array.isArray(group?.lineIds) ? group.lineIds : Array.isArray(group?.line_ids) ? group.line_ids : [];
    new Set(lineIds.map(String)).forEach((lineId) => {
      const matches = segmentsByLineId.get(lineId) || [];
      if (matches.length !== 1) {
        if (matches.length > 1) ambiguousLineIds.add(lineId);
        return;
      }
      const segmentKey = matches[0].segmentKey;
      if (!labelsBySegmentKey.has(segmentKey)) labelsBySegmentKey.set(segmentKey, new Set());
      labelsBySegmentKey.get(segmentKey).add(calibre);
    });
  });

  const ambiguousSegmentKeys = new Set(Array.from(labelsBySegmentKey.entries())
    .filter(([, labels]) => labels.size > 1)
    .map(([segmentKey]) => segmentKey));
  const edgeCalibre = new Map();
  [...(topology.edges || []), ...(topology.originalEdges || [])].forEach((edge) => {
    const labels = labelsBySegmentKey.get(edge.segmentKey);
    if (!labels || labels.size !== 1 || ambiguousSegmentKeys.has(edge.segmentKey)) return;
    edgeCalibre.set(edge.edgeId, Array.from(labels)[0]);
  });

  return { edgeCalibre, ambiguousLineIds, ambiguousSegmentKeys };
}

function branchCalibre(branch, edgeCalibre) {
  const edgeIds = branch.edgeIds || [];
  const labels = new Set(edgeIds.map(edgeId => edgeCalibre.get(edgeId)).filter(Boolean));
  const hasUnknownEdges = edgeIds.some(edgeId => !edgeCalibre.has(edgeId));
  return labels.size === 1 ? { status: 'known', label: Array.from(labels)[0], hasUnknownEdges }
    : labels.size > 1 ? { status: 'mixed', label: null, hasUnknownEdges }
      : { status: 'unknown', label: null, hasUnknownEdges };
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

function calibreAllowsPair(left, right) {
  if (left.status === 'known' && right.status === 'known' && left.label !== right.label) return false;
  return true;
}

function selectUnambiguousCalibreContinuation(currentCalibre, alternatives, maxDeflectionDeg) {
  if (currentCalibre?.status !== 'known' || currentCalibre.hasUnknownEdges) return null;
  if (alternatives.some(candidate => candidate.calibre?.status === 'mixed')) return null;

  const sameCalibre = alternatives.filter(candidate =>
    candidate.calibre?.status === 'known' && !candidate.calibre.hasUnknownEdges &&
    candidate.calibre.label === currentCalibre.label);
  if (sameCalibre.length !== 1) return null;

  const [selected] = sameCalibre;
  const hasPlausibleBlocker = alternatives.some(candidate => {
    if (candidate === selected || candidate.deflection > maxDeflectionDeg) return false;
    return candidate.calibre?.status !== 'known' || candidate.calibre.hasUnknownEdges ||
      candidate.calibre.label === currentCalibre.label;
  });
  return hasPlausibleBlocker ? null : selected;
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
  maxDeflectionDeg = ANALYSIS_MAX_DEFLECTION_DEG,
  minAngleMarginDeg = ANALYSIS_MIN_ANGLE_MARGIN_DEG
} = {}) {
  const branches = Array.isArray(topology.branches) ? topology.branches : [];
  const analyticalEdges = Array.isArray(topology.edges) ? topology.edges : [];
  const originalEdges = Array.isArray(topology.originalEdges) ? topology.originalEdges : analyticalEdges;
  const nodes = Array.isArray(topology.nodes) ? topology.nodes : [];
  const edgeById = new Map(analyticalEdges.map(edge => [edge.edgeId, edge]));
  const originalEdgeById = new Map(originalEdges.map(edge => [edge.edgeId, edge]));
  const nodeById = new Map(nodes.map(node => [node.nodeId, node]));
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
  const calibreByBranch = new Map(branches.map(branch => [branch.branchId, branchCalibre(branch, calibreEvidence.edgeCalibre)]));

  function endpointEdge(branch, nodeId) {
    const edgeId = branch.startNodeId === nodeId ? branch.edgeIds?.[0] : branch.edgeIds?.at(-1);
    return edgeById.get(edgeId);
  }

  function endpointVector(branch, nodeId) {
    const edge = endpointEdge(branch, nodeId);
    const node = nodeById.get(nodeId);
    if (!edge || !node) return null;
    const otherNodeId = edge.startNodeId === nodeId ? edge.endNodeId : edge.startNodeId;
    const otherNode = nodeById.get(otherNodeId);
    return otherNode ? localVector(node.coordinate, otherNode.coordinate) : null;
  }

  const proposals = new Map();
  const continuityDiagnostics = [];
  branches.forEach((branch) => {
    [branch.startNodeId, branch.endNodeId].forEach((nodeId) => {
      const vector = endpointVector(branch, nodeId);
      if (!vector) return;
      const alternatives = (branchesAtNode.get(nodeId) || [])
        .filter(candidate => candidate.branchId !== branch.branchId)
        .map(candidate => ({
          branch: candidate,
          deflection: deflectionDegrees(vector, endpointVector(candidate, nodeId)),
          calibre: calibreByBranch.get(candidate.branchId)
        }))
        .filter(candidate => candidate.deflection !== null)
        .sort((left, right) => left.deflection - right.deflection || left.branch.branchId.localeCompare(right.branch.branchId));
      if (!alternatives.length) return;

      const currentCalibre = calibreByBranch.get(branch.branchId);
      const angularBest = alternatives[0];
      const secondDeflection = alternatives[1]?.deflection ?? Infinity;
      const angularMargin = secondDeflection - angularBest.deflection;
      const isUniqueAnalyticalContinuation = nodeById.get(nodeId)?.degree === 2 && alternatives.length === 1;
      let selected = isUniqueAnalyticalContinuation && calibreAllowsPair(currentCalibre, angularBest.calibre)
        ? angularBest
        : angularBest.deflection <= maxDeflectionDeg && angularMargin >= minAngleMarginDeg &&
          calibreAllowsPair(currentCalibre, angularBest.calibre) ? angularBest : null;
      let continuityReason = selected ? 'geometry' : null;

      if (!selected) {
        selected = selectUnambiguousCalibreContinuation(currentCalibre, alternatives, maxDeflectionDeg);
        if (selected) continuityReason = 'calibre';
      }

      if (!selected) {
        continuityDiagnostics.push({ branchId: branch.branchId, nodeId, status: 'stopped', bestDeflection: angularBest.deflection, angleMargin: angularMargin });
        return;
      }

      const leftEdge = endpointEdge(branch, nodeId);
      const rightEdge = endpointEdge(selected.branch, nodeId);
      const physicalConnection = findPhysicalConnector(
        topology,
        originalEdgeById,
        nodeId,
        edgeEndpointCoordinate(leftEdge, nodeId),
        edgeEndpointCoordinate(rightEdge, nodeId)
      );
      if (!physicalConnection.connected) {
        continuityDiagnostics.push({ branchId: branch.branchId, nodeId, status: 'gap_without_connector', candidateBranchId: selected.branch.branchId });
        return;
      }

      proposals.set(`${branch.branchId}\u0000${nodeId}`, {
        branchId: branch.branchId,
        candidateBranchId: selected.branch.branchId,
        nodeId,
        deflection: selected.deflection,
        angleMargin: angularMargin,
        connectorEdgeIds: physicalConnection.connectorEdgeIds,
        continuityReason,
        resolvedByCalibre: continuityReason === 'calibre'
      });
    });
  });

  const acceptedPairs = [];
  const pairKeys = new Set();
  Array.from(proposals.values())
    .sort((left, right) => left.branchId.localeCompare(right.branchId) || left.nodeId.localeCompare(right.nodeId))
    .forEach((proposal) => {
    const reverse = proposals.get(`${proposal.candidateBranchId}\u0000${proposal.nodeId}`);
    if (proposal.continuityReason !== 'calibre' && reverse?.candidateBranchId !== proposal.branchId) return;
    const pairKey = [proposal.branchId, proposal.candidateBranchId].sort().join('\u0000');
    if (pairKeys.has(pairKey)) return;
    pairKeys.add(pairKey);
    const continuityReason = proposal.continuityReason === 'calibre' || reverse?.continuityReason === 'calibre'
      ? 'calibre'
      : 'geometry';
    acceptedPairs.push({ ...proposal, continuityReason, resolvedByCalibre: continuityReason === 'calibre', pairKey });
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

  const componentRecords = Array.from(components.values()).map((componentBranches) => {
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
    allEdgeIds.forEach((edgeId) => {
      const length = originalEdgeById.get(edgeId)?.lengthMeters || 0;
      const calibre = calibreEvidence.edgeCalibre.get(edgeId);
      if (!calibre) unknownCalibreLengthMeters += length;
      else calibreLengths.set(calibre, (calibreLengths.get(calibre) || 0) + length);
    });
    const calibres = Array.from(calibreLengths.entries())
      .map(([label, length]) => ({ label, lengthMeters: length }))
      .sort((left, right) => right.lengthMeters - left.lengthMeters || left.label.localeCompare(right.label));
    const calibreStatus = calibres.length === 0 ? 'unknown'
      : calibres.length === 1 && unknownCalibreLengthMeters === 0 ? 'known'
        : 'mixed';
    const causes = summarizeCauses(segmentAssignments, sourceFaults);
    const lengthKm = lengthMeters / 1000;
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
      unknownCalibreLengthMeters
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
      ambiguousCalibreLineIds: Array.from(calibreEvidence.ambiguousLineIds).sort(),
      ambiguousCalibreSegmentKeys: Array.from(calibreEvidence.ambiguousSegmentKeys).sort(),
      gaps: componentRecords.flatMap(segment => segment.gaps.map(gap => ({ analysisSegmentId: segment.analysisSegmentId, ...gap })))
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
