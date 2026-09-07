import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { fitReportImage, formatReportCoordinates, reportFileName } from './reportModel.js';
import { renderReportMaps } from './reportMap.js';

const shown = value => value === null || value === undefined ? 'No disponible' : typeof value === 'number' ? value.toLocaleString('es-PE', { maximumFractionDigits: 3 }) : String(value);
export function buildReportPdf(model, maps = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const width = doc.internal.pageSize.getWidth(), height = doc.internal.pageSize.getHeight(), margin = 12;
  function header(title) {
    doc.setFillColor(18, 52, 76); doc.rect(margin, 10, width - 2 * margin, 19, 'F');
    doc.setTextColor(255); doc.setFontSize(13); doc.text(title, 17, 18, { maxWidth: width - 34 });
    doc.setFontSize(8); doc.text(`SED ${model.sedId || 'General'} / ${model.llaveId || 'Todas las llaves'} | Periodos: ${model.periodKeys.join(', ') || 'Sin selección'} | ${model.emittedAt}`, 17, 26);
    doc.setTextColor(30);
  }
  function table(headers, body, startY = 35) {
    autoTable(doc, { head: [headers], body, startY, margin: { left: margin, right: margin, top: 15, bottom: 15 },
      styles: { fontSize: 8, cellPadding: 2.2, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [18, 52, 76] }, alternateRowStyles: { fillColor: [243, 247, 250] }, rowPageBreak: 'avoid' });
  }
  function mapPage(title, snapshot) {
    header(title);
    if (snapshot) {
      const fit = fitReportImage(snapshot.width, snapshot.height, width - 2 * margin, height - 52);
      doc.addImage(snapshot.dataUrl, 'PNG', (width - fit.width) / 2, 34, fit.width, fit.height, undefined, 'FAST');
    } else { doc.setFontSize(11); doc.text('Mapa no disponible.', margin, 45); }
  }
  mapPage('GEOPLUZ - Reporte técnico de fallas', maps.overview);
  doc.addPage(); header(`Detalle de ${model.faults.length} fallas`);
  table(['N°', 'Ticket / inicio', 'SED / llave', 'Falla / causa', 'Suministro', 'Coordenadas mostradas / originales', 'Nota'],
    model.faults.map(f => [f.number, `${f.ticket}\n${f.startedAt}\n${f.periodKey}`, f.sedLlave, `${f.failure}\n${f.cause}`, f.supply,
      `${formatReportCoordinates(f.displayCoordinates)}${f.relocatedViaClient ? `\nAjustada desde suministro\nOriginal: ${formatReportCoordinates(f.originalCoordinates)}` : ''}`, f.note]));
  if (model.faults.some(f => f.croquis || f.photos.length)) {
    doc.addPage(); header('Referencias y evidencias');
    table(['N°', 'Croquis', 'Evidencias'], model.faults.filter(f => f.croquis || f.photos.length).map(f => [f.number, f.croquis, f.photos.map(p => p.url || p.name || '').join('\n')]));
  }
  if (!model.analysis && (model.conclusion || model.status)) {
    doc.addPage(); header('Estado y conclusión del circuito');
    table(['Concepto', 'Valor'], [['Estado', model.status || 'No disponible'], ['Conclusión del análisis', model.conclusion || 'Sin conclusión']]);
  }
  if (model.analysis) {
    doc.addPage(); mapPage('GEOPLUZ - Circuito / tramo analizado', maps.analysis);
    doc.addPage(); header('Indicadores del análisis');
    const m = model.analysis.metrics;
    table(['Concepto', 'Resultado'], [
      ['Unidad', model.analysis.name], ['Longitud (m)', shown(m.lengthMeters)], ['Fallas', shown(m.faultCount)], ['Fallas/km', shown(m.faultsPerKm)],
      ['Porcentaje de fallas', m.faultShare == null ? 'No disponible' : `${shown(m.faultShare)}%`], ['Calibre', m.calibreLabel || 'Ver desglose'],
      ...((m.calibres || []).map(c => [c.label || c.calibre, `${shown(c.lengthMeters ?? c.geographicLengthMeters)} m`])),
      ['Causa principal', m.mainCause?.label || 'No disponible'], ['High / review / low', `${shown(m.highConfidenceFaults)} / ${shown(m.reviewConfidenceFaults)} / ${shown(m.lowConfidenceFaults)}`],
      ['Pareto (sin scoring)', model.analysis.pareto.map(p => p.analysisSegmentId || p.branchId).join(', ') || 'Sin candidatos'],
      ['Llamadas conocidas de la unidad', model.analysis.calls?.recordsWithData ? model.analysis.calls.totalKnown : 'No disponible'],
      ['Compensación compatible del ámbito fuente (no asignada al tramo)', `${shown(model.analysis.compensation?.automatic?.totalKnown)} S/ - ámbito ${model.analysis.compensation?.automatic?.sourceScope || 'sin dato'}`],
      ['Conclusión del análisis', model.analysis.conclusion || 'Sin conclusión']
    ]);
  }
  if (model.economic) {
    const e = model.economic;
    doc.addPage(); header('Análisis económico preliminar');
    table(['Indicador', 'Valor', 'Criterio / unidad'], [
      ['Modelo GEOPLUZ', e.economicModelVersion, 'Simulación actual; supuestos reproducidos en Excel'],
      ['Lambda', shown(e.lambda.value), 'Fallas / exposición en años'],
      ['Compensación por falla', shown(e.compensationPerFault.value), `S/falla - ${e.compensationPerFault.source} - ámbito ${e.compensationPerFault.sourceScope || '-'}`],
      ['Inversión', shown(e.interventionCost.total), 'S/ - suma longitud (km) × costo unitario'],
      ['Beneficio anual evitable', shown(e.annualAvoidedBenefit), 'S/año - lambda × compensación × factor evitable'],
      ['VAN', shown(e.financial.npv), 'S/ - beneficios descontados menos inversión'],
      ['TIR', e.financial.irr === null ? 'No disponible' : `${(e.financial.irr * 100).toFixed(3)}%`, 'Tasa interna de retorno anual'],
      ['Retorno simple / descontado', `${shown(e.financial.simplePaybackYears)} / ${shown(e.financial.discountedPaybackYears)}`, 'años'],
      ['Beneficio / costo', shown(e.financial.benefitCostRatio), 'Valor presente de beneficios / inversión'],
      ...Object.entries(e.poisson).map(([months, value]) => [`Probabilidad >=1 falla / ${months} meses`, value ? `${(value.probabilityAtLeastOne * 100).toFixed(3)}%` : 'No disponible', '1 - exp(-lambda × meses/12)'])
    ]);
    doc.addPage(); header('Supuestos y trazabilidad económica');
    table(['Fuente / supuesto', 'Valor'], [
      ['Periodos', e.lambda.periodKeys.join(', ')], ['Exposición (años)', shown(e.lambda.exposureYears)],
      ['Fallas utilizadas', shown(e.lambda.faultCount)], ['Compensación compatible / fallas compatibles', `${shown(e.compensationPerFault.compatibleCompensation)} S/ / ${shown(e.compensationPerFault.faultsCompatible)}`],
      ['Periodos compatibles', e.compensationPerFault.compatiblePeriodKeys.join(', ')], ['Cobertura', e.compensationPerFault.coverageStatus],
      ...Object.entries(e.inputsUsed.assumptions).map(([key, value]) => {
        const labels = { aerialCostPerKm: 'Costo aéreo (S/km)', undergroundCostPerKm: 'Costo subterráneo (S/km)', unclassifiedCostPerKm: 'Costo sin clasificar (S/km)', compensationMode: 'Modo de compensación', manualCompensationPerFault: 'Compensación manual (S/falla)', avoidableFaultFactor: 'Factor evitable (proporción 0-1)', discountRate: 'Descuento anual (proporción 0-1)', horizonYears: 'Horizonte (años)', escalationRate: 'Escalamiento anual (proporción)' };
        return [labels[key] || key, shown(value)];
      }),
      ...Object.entries(e.traceability || {}).map(([key, value]) => [key, shown(value)]),
      ...(e.warnings || []).map(w => [w.code, w.message]), ['Nota', model.economicNote || '']
    ]);
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(90); doc.text(`GEOPLUZ | ${i} / ${pages}`, margin, height - 6); }
  return doc;
}
export async function exportPdfReport(model) {
  const maps = await renderReportMaps(model);
  buildReportPdf(model, maps).save(reportFileName(model, 'pdf'));
}
