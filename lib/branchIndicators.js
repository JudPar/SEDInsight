import { getCauseCategory } from './constants.js';

function faultIdentity(assignment, assignmentIndex) {
  if (Number.isInteger(assignment?.faultIndex)) return `index:${assignment.faultIndex}`;
  if (assignment?.faultId !== null && assignment?.faultId !== undefined) {
    return `id:${typeof assignment.faultId}:${String(assignment.faultId)}`;
  }
  return `assignment:${assignmentIndex}`;
}

function summarizeCauses(causeCounts, faultCount) {
  return Array.from(causeCounts.values())
    .map(cause => ({
      ...cause,
      share: faultCount > 0 ? cause.count / faultCount * 100 : 0
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function selectMaximum(items, readValue) {
  if (!items.length) return null;
  return items.reduce((selected, item) => {
    const selectedValue = readValue(selected);
    const itemValue = readValue(item);
    if (itemValue > selectedValue) return item;
    if (itemValue === selectedValue && item.branchId.localeCompare(selected.branchId) < 0) return item;
    return selected;
  });
}

function metricIdentity(item) {
  return item?.analysisSegmentId ?? item?.branchId ?? '';
}

export function calculateParetoPriority(branches = []) {
  const branchMetrics = Array.isArray(branches) ? branches : [];
  const eligible = branchMetrics.filter(branch =>
    branch?.faultCount > 0 &&
    typeof branch.faultsPerKm === 'number' &&
    Number.isFinite(branch.faultsPerKm));
  const validLengthBranches = branchMetrics.filter(branch =>
    typeof branch?.lengthKm === 'number' &&
    Number.isFinite(branch.lengthKm) &&
    branch.lengthKm > 0);
  const circuitLengthKm = validLengthBranches.reduce((total, branch) => total + branch.lengthKm, 0);
  const circuitFaultCount = validLengthBranches.reduce((total, branch) => total + (Number(branch.faultCount) || 0), 0);
  const circuitAverageFaultsPerKm = circuitLengthKm > 0 ? circuitFaultCount / circuitLengthKm : null;

  const priorityCandidates = eligible
    .filter(candidate => !eligible.some(other =>
      metricIdentity(other) !== metricIdentity(candidate) &&
      other.faultCount >= candidate.faultCount &&
      other.faultsPerKm >= candidate.faultsPerKm &&
      (other.faultCount > candidate.faultCount || other.faultsPerKm > candidate.faultsPerKm)))
    .map(branch => ({
      ...branch,
      faultsPerKmToCircuitAverage: circuitAverageFaultsPerKm > 0
        ? branch.faultsPerKm / circuitAverageFaultsPerKm
        : null
    }));

  return {
    priorityStatus: priorityCandidates.length === 0
      ? 'insufficient_data'
      : priorityCandidates.length === 1 ? 'single' : 'multiple',
    priorityCandidates,
    circuitAverageFaultsPerKm
  };
}

export function describeParetoCandidates(priorityCandidates = []) {
  const candidates = Array.isArray(priorityCandidates) ? priorityCandidates : [];
  if (!candidates.length) return [];
  const maximumFaultCount = Math.max(...candidates.map(candidate => candidate.faultCount));
  const maximumFaultsPerKm = Math.max(...candidates.map(candidate => candidate.faultsPerKm));

  return candidates.map(candidate => {
    const reasons = [];
    if (candidate.faultCount === maximumFaultCount) reasons.push('Mayor concentración de fallas');
    if (candidate.faultsPerKm === maximumFaultsPerKm) reasons.push('Mayor densidad de fallas');
    const recurrentCause = candidate.faultCount >= 2 &&
      Array.isArray(candidate.causes) && candidate.causes.length === 1 &&
      candidate.causes[0]?.count === candidate.faultCount
      ? `Causa recurrente: ${candidate.causes[0].label}`
      : null;
    return { branchId: metricIdentity(candidate), reasons, recurrentCause };
  });
}

export function calculateBranchIndicators(topology = {}, faultAssignment = {}, faults = []) {
  const branches = Array.isArray(topology.branches) ? topology.branches : [];
  const assignments = Array.isArray(faultAssignment.assignments) ? faultAssignment.assignments : [];
  const sourceFaults = Array.isArray(faults) ? faults : [];
  const edgeToBranch = new Map();
  const ambiguousEdgeIds = new Set();

  branches.forEach((branch) => {
    (Array.isArray(branch.edgeIds) ? branch.edgeIds : []).forEach((edgeId) => {
      if (edgeToBranch.has(edgeId) && edgeToBranch.get(edgeId) !== branch.branchId) ambiguousEdgeIds.add(edgeId);
      else edgeToBranch.set(edgeId, branch.branchId);
    });
  });

  const unbranchedEdgeIds = new Set(Array.isArray(topology.unbranchedEdgeIds) ? topology.unbranchedEdgeIds : []);
  const branchFaults = new Map(branches.map(branch => [branch.branchId, []]));
  const seenFaults = new Set();
  const missingCoordinateAssignments = [];
  const junctionFaultAssignments = [];
  const unbranchedFaultAssignments = [];
  const unclassifiedFaultAssignments = [];

  assignments.forEach((assignment, assignmentIndex) => {
    const identity = faultIdentity(assignment, assignmentIndex);
    if (seenFaults.has(identity)) return;
    seenFaults.add(identity);

    if (assignment?.unassigned_reason === 'missing_coordinates') {
      missingCoordinateAssignments.push(assignment);
      return;
    }
    if (assignment?.junctionFault === true) {
      junctionFaultAssignments.push(assignment);
      return;
    }
    if (unbranchedEdgeIds.has(assignment?.edgeId)) {
      unbranchedFaultAssignments.push(assignment);
      return;
    }
    const branchId = edgeToBranch.get(assignment?.edgeId);
    if (!branchId || ambiguousEdgeIds.has(assignment.edgeId)) {
      unclassifiedFaultAssignments.push(assignment);
      return;
    }
    branchFaults.get(branchId).push({ assignment, fault: sourceFaults[assignment.faultIndex] || null });
  });

  const faultsAssignedToBranches = Array.from(branchFaults.values()).reduce((total, items) => total + items.length, 0);
  const warnings = [];
  if (ambiguousEdgeIds.size) warnings.push({
    code: 'AMBIGUOUS_EDGE_BRANCH',
    count: ambiguousEdgeIds.size,
    message: `${ambiguousEdgeIds.size} bordes aparecen en más de una rama y no se usaron para indicadores.`
  });

  const branchMetrics = branches.map((branch) => {
    const items = branchFaults.get(branch.branchId) || [];
    const validLength = typeof branch.lengthMeters === 'number' && Number.isFinite(branch.lengthMeters) && branch.lengthMeters >= 0;
    const lengthMeters = validLength ? branch.lengthMeters : null;
    const lengthKm = validLength ? branch.lengthMeters / 1000 : null;
    const causeCounts = new Map();
    items.forEach(({ fault }) => {
      const category = getCauseCategory(fault?.causa ?? fault?.cause);
      if (!causeCounts.has(category.id)) causeCounts.set(category.id, { id: category.id, label: category.label, count: 0 });
      causeCounts.get(category.id).count += 1;
    });
    const causes = summarizeCauses(causeCounts, items.length);
    if (!lengthKm) warnings.push({
      code: 'INVALID_BRANCH_LENGTH',
      branchId: branch.branchId,
      message: `La rama ${branch.branchId} tiene longitud cero o inválida; fallas/km no fue calculado.`
    });
    return {
      branchId: branch.branchId,
      edgeIds: branch.edgeIds,
      segmentKeys: branch.segmentKeys,
      lengthMeters,
      lengthKm,
      faultCount: items.length,
      faultsPerKm: lengthKm > 0 ? items.length / lengthKm : null,
      faultShare: faultsAssignedToBranches > 0 ? items.length / faultsAssignedToBranches * 100 : 0,
      highConfidenceFaults: items.filter(item => item.assignment.confidence === 'high').length,
      reviewConfidenceFaults: items.filter(item => item.assignment.confidence === 'review').length,
      lowConfidenceFaults: items.filter(item => item.assignment.confidence === 'low').length,
      causes,
      mainCause: causes[0] || null
    };
  }).sort((left, right) => {
    if (left.faultsPerKm === null && right.faultsPerKm !== null) return 1;
    if (left.faultsPerKm !== null && right.faultsPerKm === null) return -1;
    return (right.faultsPerKm ?? 0) - (left.faultsPerKm ?? 0) || right.faultCount - left.faultCount || left.branchId.localeCompare(right.branchId);
  });

  const branchesWithFaults = branchMetrics.filter(branch => branch.faultCount > 0);
  const branchWithMostFaults = selectMaximum(branchesWithFaults, branch => branch.faultCount);
  const densityCandidates = branchesWithFaults.filter(branch => branch.faultsPerKm !== null);
  const branchWithHighestFaultsPerKm = selectMaximum(densityCandidates, branch => branch.faultsPerKm);
  const priority = calculateParetoPriority(branchMetrics);

  return {
    totalBranches: branches.length,
    faultsAssignedToBranches,
    unbranchedFaults: unbranchedFaultAssignments.length,
    unbranchedFaultAssignments,
    unclassifiedFaults: unclassifiedFaultAssignments.length,
    unclassifiedFaultAssignments,
    missingCoordinates: missingCoordinateAssignments.length,
    junctionFaults: junctionFaultAssignments.length,
    junctionFaultAssignments,
    faultsOutsideBranches: junctionFaultAssignments.length + unbranchedFaultAssignments.length + unclassifiedFaultAssignments.length,
    branchWithMostFaults: branchWithMostFaults?.branchId || null,
    branchWithHighestFaultsPerKm: branchWithHighestFaultsPerKm?.branchId || null,
    ...priority,
    branches: branchMetrics,
    warnings
  };
}

export function resolveAnalysisBranch(branchIndicators, branchId) {
  if (!branchId || !Array.isArray(branchIndicators?.branches)) return null;
  return branchIndicators.branches.find(branch => branch.branchId === branchId) || null;
}

export function buildAnalysisBranchFaultView(faults = [], faultAssignment = {}, branch = null, filterEnabled = false) {
  const sourceFaults = Array.isArray(faults) ? faults : [];
  const assignments = Array.isArray(faultAssignment?.assignments) ? faultAssignment.assignments : [];
  if (!filterEnabled || !branch) return { faults: sourceFaults, assignments };

  const branchEdgeIds = new Set(Array.isArray(branch.edgeIds) ? branch.edgeIds : []);
  const includedFaultIndexes = new Set();
  assignments.forEach((assignment) => {
    if (assignment?.junctionFault === true || !Number.isInteger(assignment?.faultIndex) || !branchEdgeIds.has(assignment.edgeId)) return;
    includedFaultIndexes.add(assignment.faultIndex);
  });

  const filteredFaults = [];
  const filteredAssignments = [];
  sourceFaults.forEach((fault, faultIndex) => {
    if (!includedFaultIndexes.has(faultIndex)) return;
    filteredFaults.push(fault);
    const assignment = assignments.find(item => item?.junctionFault !== true && item?.faultIndex === faultIndex && branchEdgeIds.has(item.edgeId));
    if (assignment) filteredAssignments.push(assignment);
  });
  return { faults: filteredFaults, assignments: filteredAssignments };
}
