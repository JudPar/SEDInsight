import { groupExactReportCoordinates, reportSpiderOffsets, REPORT_MAP_SIZE } from './reportModel.js';
import { TILE_LAYERS } from './constants.js';

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
  const largestOffset = Math.max(0, ...groups.map(g => Math.max(...reportSpiderOffsets(g.members.length).map(p => Math.hypot(p.x, p.y)))));
  const padding = Math.max(75, largestOffset + 30);
  if (padding * 2 >= height - footerHeight - 40) throw new Error('Hay demasiadas fallas coincidentes para un mapa legible. Reduce el periodo o selecciona un tramo.');
  const usableHeight = height - footerHeight - 40;
  const scale = Math.min((width - padding * 2) / Math.max(maxX - minX, 1e-12), (usableHeight - padding * 2) / Math.max(maxY - minY, 1e-12), 256 * 2 ** 19);
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const project = coordinate => {
    const p = mercator(coordinate);
    return { x: width / 2 + (p.x - center.x) * scale, y: 40 + usableHeight / 2 + (p.y - center.y) * scale };
  };
  return { width, height, footerHeight, usableHeight, scale, center, project, groups, faults, legend, highlighted };
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
  layout.groups.forEach(group => {
    const anchor = project(group.coordinate), offsets = reportSpiderOffsets(group.members.length);
    if (group.members.length > 1) {
      ctx.strokeStyle = '#455a64'; ctx.lineWidth = 1.5;
      offsets.forEach(offset => { ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(anchor.x + offset.x, anchor.y + offset.y); ctx.stroke(); });
      ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 5, 0, Math.PI * 2); ctx.fillStyle = '#111827'; ctx.fill();
    }
    group.members.forEach((member, i) => {
      const x = anchor.x + offsets[i].x, y = anchor.y + offsets[i].y;
      ctx.beginPath(); ctx.arc(x, y, 17, 0, 2 * Math.PI); ctx.fillStyle = member.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = 'bold 16px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = '#263238'; ctx.strokeText(String(member.number), x, y); ctx.fillStyle = '#fff'; ctx.fillText(String(member.number), x, y);
    });
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
  ctx.fillText('N° de marcador = N° de tabla. Flor solo en coordenadas idénticas; ancla = ubicación real.', 20, height - 28);
  ctx.fillText(tilesComplete ? '© OpenStreetMap contributors' : '© OpenStreetMap contributors · Fondo incompleto/no disponible; geometrías y fallas conservan su posición.', 20, height - 8);
  return { dataUrl: canvas.toDataURL('image/png'), width, height, tilesComplete };
}

export async function renderReportMaps(model, options = {}) {
  return { overview: await renderReportMap(model, options), analysis: model.analysis ? await renderReportMap(model, { ...options, analysis: true }) : null };
}
