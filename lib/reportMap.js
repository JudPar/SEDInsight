import { groupExactReportCoordinates, REPORT_MAP_SIZE } from './reportModel.js';
import { TILE_LAYERS } from './constants.js';

const MARKER_RADIUS = 17;
const MARKER_SPACING = 38;

function leadersCross(a, b) {
  if (a.anchor === b.anchor) return false;
  const turn = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const a1 = turn(a.anchor, { x: a.x, y: a.y }, b.anchor);
  const a2 = turn(a.anchor, { x: a.x, y: a.y }, { x: b.x, y: b.y });
  const b1 = turn(b.anchor, { x: b.x, y: b.y }, a.anchor);
  const b2 = turn(b.anchor, { x: b.x, y: b.y }, { x: a.x, y: a.y });
  return a1 * a2 < 0 && b1 * b2 < 0;
}

// Screen-space layout only. Geographic coordinates and report rows are untouched.
export function layoutReportFaultMarkers(groups, project, width, usableHeight) {
  const markers = groups.flatMap(group => group.members.map(member => ({
    ...member, anchor: project(group.coordinate)
  })));
  const top = 40 + MARKER_RADIUS + 3;
  const bottom = 40 + usableHeight - MARKER_RADIUS - 3;
  const components = [];
  const visited = new Set();
  for (let start = 0; start < markers.length; start += 1) {
    if (visited.has(start)) continue;
    const pending = [start], component = [];
    visited.add(start);
    while (pending.length) {
      const index = pending.pop();
      component.push(markers[index]);
      for (let other = 0; other < markers.length; other += 1) {
        if (visited.has(other)) continue;
        if (Math.hypot(markers[index].anchor.x - markers[other].anchor.x, markers[index].anchor.y - markers[other].anchor.y) < MARKER_SPACING) {
          visited.add(other);
          pending.push(other);
        }
      }
    }
    component.sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x || a.number - b.number);
    components.push(component);
  }
  components.sort((a, b) => b.length - a.length || a[0].anchor.y - b[0].anchor.y || a[0].anchor.x - b[0].anchor.x);
  const placed = [];
  for (const component of components) {
    const anchorX = component.map(item => item.anchor.x);
    const anchorY = component.map(item => item.anchor.y);
    const averageY = anchorY.reduce((sum, y) => sum + y, 0) / component.length;
    const maxRows = Math.floor((bottom - top) / MARKER_SPACING) + 1;
    if (component.length > maxRows * 2) throw new Error('Hay demasiadas fallas próximas para un mapa legible. Reduce el periodo o selecciona un tramo.');
    const columns = component.length > maxRows ? 2 : 1;
    const candidates = [];
    if (component.length === 1) candidates.push([{ ...component[0], x: component[0].anchor.x, y: component[0].anchor.y }]);
    for (let shift = 0; shift < 6; shift += 1) {
      for (const primarySide of [1, -1]) {
        const batches = columns === 1 ? [component] : [component.slice(0, Math.ceil(component.length / 2)), component.slice(Math.ceil(component.length / 2))];
        const candidate = batches.flatMap((batch, batchIndex) => {
          const side = batchIndex ? -primarySide : primarySide;
          const x = side > 0 ? Math.max(...anchorX) + 54 + shift * MARKER_SPACING : Math.min(...anchorX) - 54 - shift * MARKER_SPACING;
          const span = MARKER_SPACING * (batch.length - 1);
          const startY = Math.max(top, Math.min(bottom - span, averageY - span / 2));
          return batch.map((item, index) => ({ ...item, x, y: startY + index * MARKER_SPACING }));
        });
        if (candidate.some(item => item.x < MARKER_RADIUS + 3 || item.x > width - MARKER_RADIUS - 3)) continue;
        candidates.push(candidate);
      }
    }
    let best = null, bestPenalty = Infinity;
    for (const candidate of candidates) {
      let penalty = 0;
      for (const item of candidate) {
        if (item.y < top || item.y > bottom) penalty += 1000;
        for (const previous of placed) {
          if (Math.hypot(item.x - previous.x, item.y - previous.y) < MARKER_SPACING) penalty += 100;
          if (leadersCross(item, previous)) penalty += 100;
        }
        // Avoid putting a label over another fault's real location.
        for (const anchor of markers) {
          if (anchor.anchor === item.anchor && anchor.number === item.number) continue;
          if (Math.hypot(item.x - anchor.anchor.x, item.y - anchor.anchor.y) < MARKER_RADIUS * 2 + 3) penalty += 10;
        }
      }
      for (let i = 0; i < candidate.length; i += 1) {
        for (let j = 0; j < i; j += 1) if (leadersCross(candidate[i], candidate[j])) penalty += 100;
      }
      if (penalty < bestPenalty) { best = candidate; bestPenalty = penalty; }
      if (penalty === 0) break;
    }
    if (!best || bestPenalty >= 100) throw new Error('No hay espacio para separar los marcadores del reporte. Reduce el periodo o selecciona un tramo.');
    placed.push(...best);
  }
  return placed;
}

function mercator([lat, lon]) {
  const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  return { x: (lon + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}

export function buildReportMapLayout(model, { analysis = false } = {}) {
  const { width, height } = REPORT_MAP_SIZE;
  const faults = analysis && model.analysis ? model.faults.filter(f => model.analysis.faultNumbers.includes(f.number)) : model.faults;
  const groups = groupExactReportCoordinates(faults);
  const highlighted = analysis ? model.analysis?.edges || [] : [];
  const focus = highlighted.length ? highlighted.flatMap(edge => edge.coords) : model.network.flatMap(line => line.coords);
  // Include every report fault, even if outside the network. No silent clipping.
  const coordinates = [...focus, ...faults.flatMap(f => f.displayCoordinates)];
  if (!highlighted.length && model.sedCoordinate) coordinates.push(model.sedCoordinate);
  const projected = (coordinates.length ? coordinates : [[-12.0464, -77.0428]]).map(mercator);
  const minX = Math.min(...projected.map(p => p.x)), maxX = Math.max(...projected.map(p => p.x));
  const minY = Math.min(...projected.map(p => p.y)), maxY = Math.max(...projected.map(p => p.y));
  const legend = [...new Map(faults.map(f => [f.causeLabel, { label: f.causeLabel, color: f.color }])).values()];
  const footerHeight = 65 + Math.ceil(legend.length / 4) * 28;
  const padding = 80;
  const usableHeight = height - footerHeight - 40;
  const scale = Math.min((width - padding * 2) / Math.max(maxX - minX, 1e-12), (usableHeight - padding * 2) / Math.max(maxY - minY, 1e-12), 256 * 2 ** 19);
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const project = coordinate => {
    const p = mercator(coordinate);
    return { x: width / 2 + (p.x - center.x) * scale, y: 40 + usableHeight / 2 + (p.y - center.y) * scale };
  };
  const markers = layoutReportFaultMarkers(groups, project, width, usableHeight);
  return { width, height, footerHeight, usableHeight, scale, center, project, groups, markers, faults, legend, highlighted };
}

function tileImage(url) {
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { image.onload = null; image.onerror = null; resolve(null); }, 8000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); resolve(null); };
    image.src = url;
  });
}

// Dedicated fixed-size canvas; never captures, pans or resizes the interactive UI.
export async function renderReportMap(model, { analysis = false, tiles = true } = {}) {
  const layout = buildReportMapLayout(model, { analysis });
  const { width, height, project, scale, center, footerHeight, usableHeight } = layout;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('El navegador no pudo crear el mapa del reporte.');
  ctx.fillStyle = '#eef2f5'; ctx.fillRect(0, 0, width, height);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 40, width, usableHeight); ctx.clip();
  let tilesComplete = false;
  if (tiles) {
    const zoom = Math.max(0, Math.min(19, Math.floor(Math.log2(scale / 256))));
    const n = 2 ** zoom, size = scale / n;
    const left = center.x * n - width / (2 * size), top = center.y * n - usableHeight / (2 * size);
    const requests = [];
    for (let x = Math.floor(left); x <= Math.floor(left + width / size); x += 1) {
      for (let y = Math.floor(top); y <= Math.floor(top + usableHeight / size); y += 1) {
        if (y < 0 || y >= n) continue;
        const url = TILE_LAYERS.detailed.url.replace('{s}', 'a').replace('{z}', zoom).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
        requests.push({ x, y, url });
      }
    }
    const images = await Promise.all(requests.map(async tile => ({ ...tile, image: await tileImage(tile.url) })));
    tilesComplete = images.length > 0 && images.every(tile => tile.image);
    images.forEach(tile => { if (tile.image) ctx.drawImage(tile.image, (tile.x - left) * size, 40 + (tile.y - top) * size, size + 0.5, size + 0.5); });
  }
  function line(coords, color, weight, opacity = 1) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.globalAlpha = opacity;
    coords.forEach((coord, i) => { const p = project(coord); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  model.network.forEach(item => line(item.coords, item.color, 3.5, analysis ? 0.25 : 0.85));
  layout.highlighted.forEach(edge => line(edge.coords, '#b51760', 6));
  if (model.sedCoordinate) {
    const p = project(model.sedCoordinate);
    ctx.fillStyle = '#12344c'; ctx.fillRect(p.x - 8, p.y - 8, 16, 16);
    ctx.font = 'bold 17px Arial'; ctx.fillText(`SED ${model.sedId}`, p.x + 14, p.y - 12);
  }
  layout.markers.forEach(marker => {
    if (Math.hypot(marker.x - marker.anchor.x, marker.y - marker.anchor.y) < MARKER_RADIUS) return;
    ctx.beginPath(); ctx.moveTo(marker.anchor.x, marker.anchor.y); ctx.lineTo(marker.x, marker.y);
    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.beginPath(); ctx.arc(marker.anchor.x, marker.anchor.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#111827'; ctx.fill();
  });
  layout.markers.forEach(marker => {
    ctx.beginPath(); ctx.arc(marker.x, marker.y, MARKER_RADIUS, 0, 2 * Math.PI); ctx.fillStyle = marker.color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = 'bold 16px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = '#263238'; ctx.strokeText(String(marker.number), marker.x, marker.y);
    ctx.fillStyle = '#fff'; ctx.fillText(String(marker.number), marker.x, marker.y);
  });
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#12344c'; ctx.fillRect(0, 0, width, 40);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 20px Arial';
  ctx.fillText(analysis ? `Análisis - ${model.analysis?.name || model.llaveId}` : `SED ${model.sedId || 'General'} - ${model.llaveId || 'Todas las llaves'}`, 20, 27, width - 40);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, height - footerHeight, width, footerHeight);
  ctx.font = '16px Arial';
  layout.legend.forEach((item, i) => {
    const x = 20 + (i % 4) * 395, y = height - footerHeight + 27 + Math.floor(i / 4) * 28;
    ctx.fillStyle = item.color; ctx.fillRect(x, y - 13, 12, 12); ctx.fillStyle = '#263238'; ctx.fillText(item.label, x + 20, y, 365);
  });
  ctx.font = '14px Arial'; ctx.fillStyle = '#455a64';
  ctx.fillText('N° de marcador = N° de tabla. Las líneas unen etiquetas separadas con la ubicación real de cada falla.', 20, height - 28);
  ctx.fillText(tilesComplete ? '© OpenStreetMap contributors' : '© OpenStreetMap contributors · Fondo incompleto/no disponible; geometrías y fallas conservan su posición.', 20, height - 8);
  return { dataUrl: canvas.toDataURL('image/png'), width, height, tilesComplete };
}

export async function renderReportMaps(model, options = {}) {
  return { overview: await renderReportMap(model, options), analysis: model.analysis ? await renderReportMap(model, { ...options, analysis: true }) : null };
}
