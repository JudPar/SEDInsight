import ExcelJS from 'exceljs';
import { fitReportImage, formatReportCoordinates, reportFileName } from './reportModel.js';
import { renderReportMaps } from './reportMap.js';
import { addEconomicWorkbook } from './reportEconomicWorkbook.js';

function table(sheet, row, headers, records, widths) {
  sheet.columns = widths.map(width => ({ width }));
  sheet.getRow(row).values = headers;
  records.forEach((record, index) => { sheet.getRow(row + 1 + index).values = record.map(value => value ?? null); });
  sheet.autoFilter = { from: { row, column: 1 }, to: { row: row + records.length, column: headers.length } };
  sheet.views = [{ state: 'frozen', ySplit: row, xSplit: 1, showGridLines: false }];
  sheet.pageSetup.fitToPage = false;
  sheet.pageSetup.scale = 80;
  sheet.pageSetup.printTitlesColumn = 'A:A';
  sheet.pageSetup.printTitlesRow = `${row}:${row}`;
}
function image(workbook, sheet, snapshot, row) {
  if (!snapshot) return row;
  const extent = fitReportImage(snapshot.width, snapshot.height, 800, 500);
  const id = workbook.addImage({ base64: snapshot.dataUrl, extension: 'png' });
  sheet.addImage(id, { tl: { col: 0, row: row - 1 }, ext: extent, editAs: 'absolute' });
  const rows = Math.ceil(extent.height * 0.75 / 18);
  for (let i = row; i < row + rows; i += 1) sheet.getRow(i).height = 18;
  return row + rows + 1;
}
export function buildReportWorkbook(model, maps = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GEOPLUZ'; workbook.created = new Date(model.emittedAt);
  workbook.calcProperties = { fullCalcOnLoad: true };
  const names = ['01_Resumen', '02_Memoria_Calculo', '03_Fallas', '04_Tramo_Analizado', '05_Supuestos'];
  for (const name of names) {
    const sheet = workbook.addWorksheet(name, { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } } });
    sheet.getCell('A1').value = `GEOPLUZ - ${name.slice(3).replaceAll('_', ' ')}`;
    sheet.mergeCells('A1:D1'); sheet.getRow(1).height = 30;
    sheet.getCell('A2').value = `SED ${model.sedId || 'General'} / ${model.llaveId || 'Todas las llaves'} / ${model.periodKeys.join(', ') || 'Sin periodo seleccionado'}`;
    sheet.mergeCells('A2:D2'); sheet.getRow(2).height = 30;
    sheet.headerFooter.oddFooter = 'GEOPLUZ &L&P / &N';
    sheet.views = [{ showGridLines: false }];
  }
  const summary = workbook.getWorksheet(names[0]);
  summary.columns = Array.from({ length: 10 }, () => ({ width: 13 }));
  summary.unMergeCells('A1:D1'); summary.mergeCells('A1:J1'); summary.unMergeCells('A2:D2'); summary.mergeCells('A2:J2');
  summary.getCell('A3').value = `Emisión: ${model.emittedAt} · ${model.faults.length} fallas · ${model.status || ''}`;
  summary.mergeCells('A3:J3');
  let row = image(workbook, summary, maps.overview, 5);
  summary.getRow(row - 1).addPageBreak();
  if (model.analysis) {
    summary.getCell(`A${row}`).value = `Análisis: ${model.analysis.name}`; summary.mergeCells(`A${row}:J${row}`); row += 2;
    row = image(workbook, summary, maps.analysis, row);
    summary.getRow(row - 1).addPageBreak();
    const metrics = model.analysis.metrics;
    const values = [
      ['Longitud analizada (m)', metrics.lengthMeters], ['Fallas', metrics.faultCount], ['Fallas/km', metrics.faultsPerKm],
      ['Porcentaje de fallas', metrics.faultShare === undefined ? null : metrics.faultShare / 100], ['Calibre', metrics.calibreLabel],
      ['Causa principal', metrics.mainCause?.label], ['High / review / low', `${metrics.highConfidenceFaults ?? '-'} / ${metrics.reviewConfidenceFaults ?? '-'} / ${metrics.lowConfidenceFaults ?? '-'}`],
      ['Candidatos Pareto', model.analysis.pareto.map(item => item.analysisSegmentId || item.branchId).join(', ')],
      ['Llamadas conocidas de la unidad', model.analysis.calls?.recordsWithData ? model.analysis.calls.totalKnown : null],
      ['Compensación compatible (ámbito fuente)', model.analysis.compensation?.automatic?.totalKnown],
      ['Ámbito compensación (no distribuida al tramo)', model.analysis.compensation?.automatic?.sourceScope],
      ['Conclusión del análisis', model.analysis.conclusion]
    ];
    values.forEach(([label, value], i) => {
      summary.getCell(`A${row}`).value = label; summary.mergeCells(`A${row}:C${row}`);
      summary.getCell(`D${row}`).value = value ?? 'No disponible'; summary.mergeCells(`D${row}:J${row}`);
      summary.getCell(`D${row}`).numFmt = i === 3 ? '0.00%' : '#,##0.000';
      summary.getRow(row).height = Math.max(36, Math.ceil(String(value ?? '').length / 75) * 14 + 8); row++;
    });
    (metrics.calibres || []).forEach(calibre => { summary.getCell(`A${row}`).value = calibre.label || calibre.calibre; summary.mergeCells(`A${row}:C${row}`); summary.getCell(`D${row}`).value = calibre.lengthMeters ?? calibre.geographicLengthMeters; summary.getCell(`E${row}`).value = 'm'; row++; });
  }
  const faultsSheet = workbook.getWorksheet(names[2]);
  table(faultsSheet, 4, ['N°', 'Ticket', 'SED / llave', 'Periodo', 'Hora de inicio', 'Falla', 'Causa', 'Suministro', 'Coord. mostrada', 'Coord. original', 'Ajustada Cliente', 'Nota', 'Croquis', 'Fotos', 'Llamadas', 'En análisis', 'Edge asignado', 'Distancia (m)', 'Confianza / motivo'],
    model.faults.map(f => [f.number, f.ticket, f.sedLlave, f.periodKey, f.startedAt, f.failure, f.cause, f.supply, formatReportCoordinates(f.displayCoordinates), formatReportCoordinates(f.originalCoordinates), f.relocatedViaClient ? 'Sí' : 'No', f.note, f.croquis, f.photos.map(p => p.url || p.name || '').join('\n'), f.calls, model.analysis?.faultNumbers.includes(f.number) ? 'Sí' : 'No', f.assignment?.edgeId, f.assignment?.distanceMeters, f.assignment?.unassigned_reason || (f.assignment?.junctionFault ? 'Bifurcación' : f.assignment?.confidence)]),
    [8, 20, 25, 12, 22, 40, 24, 18, 40, 40, 18, 50, 40, 40, 14, 14, 40, 16, 24]);
  const edgesSheet = workbook.getWorksheet(names[3]);
  table(edgesSheet, 4, ['Edge ID', 'Segment key', 'Longitud (m)', 'Usage', 'Calibre', 'Montaje', 'Coords', 'N° fallas', 'Función'],
    (model.analysis?.edges || []).map(edge => [edge.edgeId, edge.segmentKey, edge.lengthMeters, edge.usage, edge.calibreDisplayLabel || edge.calibreLabel || edge.calibre, edge.mounting, formatReportCoordinates(edge.coords || []), model.faults.filter(f => model.analysis.faultNumbers.includes(f.number) && f.assignment?.edgeId === edge.edgeId).map(f => f.number).join(', '), edge.startNodeId === edge.endNodeId ? 'Conector físico' : 'Red analítica']),
    [45, 45, 18, 22, 26, 20, 45, 20, 24]);
  addEconomicWorkbook(workbook, model);
  if (model.economic) {
    row += 2;
    for (const [label, ref] of [['Inversión (S/)', 10], ['VAN (S/)', 14], ['TIR', 15], ['Retorno simple (años)', 16], ['Retorno descontado (años)', 17], ['Beneficio / costo', 18]]) {
      summary.getCell(`A${row}`).value = label; summary.mergeCells(`A${row}:C${row}`);
      summary.getCell(`D${row}`).value = { formula: `'02_Memoria_Calculo'!B${ref}`, result: workbook.getWorksheet(names[1]).getCell(`B${ref}`).result };
      summary.getCell(`D${row}`).numFmt = ref === 15 ? '0.00%' : '#,##0.00'; row++;
    }
  }
  workbook.eachSheet(sheet => {
    sheet.eachRow((r, index) => {
      if (!r.height) {
        let lines = 1;
        r.eachCell((cell, column) => {
          if (typeof cell.value === 'string') lines = Math.max(lines, ...cell.value.split('\n').map(text => Math.ceil(text.length / Math.max(8, (sheet.getColumn(column).width || 13) - 2))));
        });
        r.height = index <= 4 ? 30 : Math.min(409, Math.max(30, lines * 14 + 8));
      }
      r.eachCell(cell => {
        cell.alignment = { vertical: 'middle', wrapText: true, ...cell.alignment };
        if (!cell.font?.color) cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF233447' } };
        if (index === 1 || index === 4) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12344C' } };
          cell.font = { name: 'Calibri', size: index === 1 ? 15 : 11, bold: true, color: { argb: 'FFFFFFFF' } };
        }
      });
    });
  });
  summary.pageSetup.printArea = `A1:J${row + 1}`;
  return workbook;
}

export async function exportExcelBySed(model) {
  const maps = await renderReportMaps(model);
  const workbook = buildReportWorkbook(model, maps);
  const buffer = await workbook.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = reportFileName(model, 'xlsx');
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
