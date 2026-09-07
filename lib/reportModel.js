import { getDrawableLineCoordinates } from './coordUtils.js';
import { getCauseCategory } from './constants.js';
import { applyAnalyticalFaultCoordinates } from './analysisSegments.js';
import { derivePeriodKeyFromStartTime } from './monthlyFaultImport.js';

export const REPORT_MAP_SIZE = Object.freeze({ width: 1600, height: 1000 });
const clone = value => JSON.parse(JSON.stringify(value));
const pair = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 90 && Math.abs(value[1]) <= 180;
export function reportCoordinates(value) {
  if (pair(value)) return [[...value]];
  return Array.isArray(value) ? value.filter(pair).map(coord => [...coord]) : [];
}
export function fitReportImage(width, height, maxWidth, maxHeight) {
  if (![width, height, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Dimensiones de imagen inválidas.');
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

// Equality uses the full canonical numbers, without rounding or a proximity radius.
export function groupExactReportCoordinates(faults) {
  const groups = new Map();
  for (const fault of faults) {
    const seen = new Set();
    for (const coordinate of fault.displayCoordinates) {
      const key = JSON.stringify(coordinate);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, { coordinate: [...coordinate], members: [] });
      groups.get(key).members.push({ number: fault.number, color: fault.color, faultKey: fault.key });
    }
  }
  return [...groups.values()];
}

// Pixel offsets only: the geographic anchor and source records remain untouched.
export function reportSpiderOffsets(count) {
  if (count <= 1) return [{ x: 0, y: 0 }];
  const positions = [];
  let ring = 1;
  while (positions.length < count) {
    const capacity = Math.min(8 * ring, count - positions.length);
    const radius = 48 * ring;
    for (let index = 0; index < capacity; index += 1) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / capacity;
      positions.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    ring += 1;
  }
  return positions;
}

export function buildReportModel({
  sedId = '', llaveId = '', selectedPeriodKeys = [], emittedAt = new Date().toISOString(),
  faults = [], network = [], sedCoordinate = null, analysis = null, selectedSegment = null,
  circuitFaults = [], conclusion = '', status = '', economic = null, economicNote = '',
  calls = null, compensation = null, analysisLlaveId = llaveId
} = {}) {
  const adjusted = applyAnalyticalFaultCoordinates(circuitFaults, analysis?.faultAssignment);
  const byIndex = new Map(adjusted.map((f, i) => [f.originalIndex, { fault: f, index: i }]).filter(([index]) => Number.isInteger(index)));
  const byReference = new Map(circuitFaults.map((f, i) => [f, { fault: adjusted[i], index: i }]));
  const records = faults.map((source, index) => {
    const match = byReference.get(source) || byIndex.get(source.originalIndex);
    const fault = match?.fault || source;
    const category = getCauseCategory(fault.causa);
    return {
      key: `report-${index}`, number: index + 1, circuitFaultIndex: match?.index ?? null,
      ticket: String(fault.ticket ?? ''), sed: fault.sed || sedId, llave: fault.llaveSistema || llaveId,
      sedLlave: fault.sedLlave || `${fault.sed || sedId} / ${fault.llaveSistema || llaveId}`,
      startedAt: fault.horaInicio || fault.hora_inicio || '', periodKey: fault.periodKey || fault.period_key || derivePeriodKeyFromStartTime(fault.horaInicio || fault.hora_inicio) || '',
      cause: fault.causa || category.label, color: category.color, causeLabel: category.label,
      supply: String(fault.suministro ?? ''), failure: fault.falla || fault.fallaReal || '', note: fault.nota || '',
      croquis: fault.linkCroquis || fault.link_croquis || fault.croquis || '', photos: clone(fault.fotos || []),
      calls: fault.callCount ?? fault.call_count ?? null,
      displayCoordinates: reportCoordinates(fault.mapCoords || fault.coords || [fault.latitud, fault.longitud]),
      originalCoordinates: reportCoordinates(fault.originalCoordinate || fault.coords || [fault.latitud, fault.longitud]),
      relocatedViaClient: fault.relocatedViaClient === true,
      assignment: match ? clone(analysis?.faultAssignment?.assignments?.find(a => a.faultIndex === match.index) || null) : null
    };
  });
  const geometry = network.flatMap(entry => (entry.lines || []).map(line => ({
    id: line.id ?? '', llaveId: entry.llaveId || llaveId, color: entry.color || '#2176ae',
    coords: getDrawableLineCoordinates(line.coords)
  }))).filter(line => line.coords.length >= 2);
  let analysisReport = null;
  if (analysis) {
    const allSegments = analysis.analysisSegmentIndicators?.analysisSegments || [];
    const edgeIds = new Set(selectedSegment
      ? [...selectedSegment.edgeIds, ...(selectedSegment.connectorEdgeIds || [])]
      : [...(analysis.topology?.edges || []).map(e => e.edgeId), ...allSegments.flatMap(s => s.connectorEdgeIds || [])]);
    const edges = (analysis.topology?.originalEdges || []).filter(edge => edgeIds.has(edge.edgeId));
    const indexes = selectedSegment ? new Set(selectedSegment.faultIndexes || []) : null;
    const analysisFaults = records.filter(f => f.circuitFaultIndex !== null && (!indexes || indexes.has(f.circuitFaultIndex)));
    analysisReport = {
      id: selectedSegment?.analysisSegmentId || 'circuito',
      name: `${selectedSegment?.name || selectedSegment?.analysisSegmentId || 'Circuito completo'}${analysisLlaveId ? ` · Llave ${analysisLlaveId}` : ''}`,
      edges: clone(edges), faultNumbers: analysisFaults.map(f => f.number),
      metrics: selectedSegment ? clone(selectedSegment) : {
        lengthMeters: edges.reduce((sum, edge) => sum + (edge.lengthMeters || 0), 0),
        faultCount: analysis.faultAssignment?.totalFaults ?? circuitFaults.length,
        calibres: (analysis.lengthByCalibre || []).map(c => ({ label: c.normalizedLabel, lengthMeters: c.geographicLengthMeters }))
      },
      pareto: clone(analysis.analysisSegmentIndicators?.priorityCandidates || []), conclusion,
      calls: calls ? clone(calls) : null, compensation: compensation ? clone(compensation) : null
    };
  }
  const compatibleEconomic = economic && selectedSegment && economic.inputsUsed?.identity?.analysisUnitId === selectedSegment.analysisSegmentId
    && economic.inputsUsed?.identity?.sedId === sedId && economic.inputsUsed?.identity?.circuitId === llaveId
    && JSON.stringify([...(economic.lambda?.periodKeys || [])].sort()) === JSON.stringify([...selectedPeriodKeys].sort());
  return {
    version: 1, sedId, llaveId, periodKeys: [...selectedPeriodKeys], emittedAt, status, conclusion,
    faults: records, network: geometry, sedCoordinate: pair(sedCoordinate) ? [...sedCoordinate] : null,
    analysis: analysisReport, economic: compatibleEconomic ? clone(economic) : null, economicNote,
    mapSize: { ...REPORT_MAP_SIZE }
  };
}

export function reportFileName(model, extension) {
  const identity = [model.sedId || 'GENERAL', model.llaveId].filter(Boolean).join('_').replace(/[^\w-]/g, '_');
  return `GEOPLUZ_${identity}_${model.emittedAt.slice(0, 10)}.${extension}`;
}
export const formatReportCoordinates = coords => coords.length ? coords.map(pair => pair.join(', ')).join(' / ') : 'Sin coordenadas';
