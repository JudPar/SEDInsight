export const ECONOMIC_INPUT_ROWS = Object.freeze({ faultCount: 5, exposureYears: 6, aerialLength: 7, undergroundLength: 8, unknownLength: 9,
  aerialCost: 10, undergroundCost: 11, unknownCost: 12, compensation: 13, compatibleFaults: 14, mode: 15, manualCompensation: 16,
  avoidableFactor: 17, discount: 18, horizon: 19, escalation: 20, geometryVerified: 21 });
export const ECONOMIC_RESULT_ROWS = Object.freeze({ lambda: 5, compensationPerFault: 6, aerial: 7, underground: 8, unclassified: 9,
  capex: 10, exposure: 11, benefit: 12, pv: 13, npv: 14, irr: 15, payback: 16, discountedPayback: 17, ratio: 18 });
const NA = '"No disponible"';
const CURRENCY = '"S/ "#,##0.00;[Red]("S/ "#,##0.00)';

export function addEconomicWorkbook(workbook, model) {
  const build = workbook.getWorksheet('02_Memoria_Calculo');
  const inputs = workbook.getWorksheet('05_Supuestos');
  const sim = model.economic;
  if (!sim) {
    build.getCell('A4').value = 'Sin simulación económica vigente para esta selección. Abra Analizar económicamente y vuelva a exportar.';
    build.mergeCells('A4:F5'); build.getCell('A4').alignment = { wrapText: true };
    return;
  }
  const used = sim.inputsUsed, geometry = used.geometry || {}, assumptions = used.assumptions || {};
  const maxYears = Math.max(100, assumptions.horizonYears || 0);
  const sourceRows = [
    ['Fallas de la unidad', used.faults?.count, 'fallas', 'analysisUnit.faultIndexes'],
    ['Exposición observada', used.period?.exposureYears, 'años', 'Días de los periodos seleccionados / 365.2425'],
    ['Longitud aérea', geometry.aerialLengthMeters, 'm', 'Geometría analizada'],
    ['Longitud subterránea', geometry.undergroundLengthMeters, 'm', 'Geometría analizada'],
    ['Longitud sin clasificar', geometry.unclassifiedLengthMeters, 'm', 'Sin inferir montaje'],
    ['Costo aéreo', assumptions.aerialCostPerKm, 'S/km', 'Supuesto utilizado'],
    ['Costo subterráneo', assumptions.undergroundCostPerKm, 'S/km', 'Supuesto utilizado'],
    ['Costo sin clasificar', assumptions.unclassifiedCostPerKm, 'S/km', 'Supuesto manual, si existe'],
    ['Compensación observada compatible', sim.compensationPerFault.compatibleCompensation, 'S/', `Ámbito: ${sim.compensationPerFault.sourceScope || 'sin dato'}`],
    ['Fallas compatibles con compensación', sim.compensationPerFault.faultsCompatible, 'fallas', 'Denominador del ámbito/periodos compatibles, no del tramo'],
    ['Modo compensación', assumptions.compensationMode, 'automatic/manual', 'Cambiar a manual para utilizar el valor de la fila siguiente'],
    ['Compensación manual por falla', assumptions.manualCompensationPerFault, 'S/falla', 'Solo utilizada en modo manual'],
    ['Factor de fallas evitables', assumptions.avoidableFaultFactor, '%', 'Supuesto de la simulación'],
    ['Tasa de descuento', assumptions.discountRate, '% anual', 'Supuesto de la simulación'],
    ['Horizonte financiero', assumptions.horizonYears, 'años', `Editable entre 1 y ${maxYears}`],
    ['Escalamiento del beneficio', assumptions.escalationRate, '% anual', 'Supuesto de la simulación'],
    ['Geometría utilizable para costos', ['invalid', 'unverified_crs'].includes(geometry.geometryReliability) ? 0 : 1, '1/0', geometry.geometryReliability || 'unknown']
  ];
  inputs.getRow(4).values = ['Concepto', 'Valor', 'Unidad', 'Fuente / criterio'];
  sourceRows.forEach((row, i) => {
    inputs.getRow(i + 5).values = row.map(value => value ?? null);
    const cell = inputs.getCell(i + 5, 2);
    cell.numFmt = [17, 18, 20].includes(i + 5) ? '0.00%' : '#,##0.0000';
    cell.font = { name: 'Calibri', color: { argb: 'FF1565C0' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1FC' } };
  });
  inputs.getCell('B15').dataValidation = { type: 'list', allowBlank: false, formulae: ['"automatic,manual"'] };
  inputs.getCell('B19').dataValidation = { type: 'whole', operator: 'between', formulae: [1, maxYears], showErrorMessage: true, error: `Use un entero de 1 a ${maxYears}.` };
  inputs.getCell('B17').dataValidation = { type: 'decimal', operator: 'between', formulae: [0, 1], showErrorMessage: true };
  inputs.getRow(24).values = ['Modelo', sim.economicModelVersion, 'GEOPLUZ', 'Evaluación económica preliminar; sin recomendación automática'];
  inputs.getRow(25).values = ['Periodos técnicos', sim.lambda.periodKeys.join(', ')];
  inputs.getRow(26).values = ['Periodos compensación', sim.compensationPerFault.compatiblePeriodKeys.join(', ')];
  inputs.getRow(27).values = ['Cobertura compensación', sim.compensationPerFault.coverageStatus];
  inputs.getRow(28).values = ['Nota', model.economicNote || ''];
  Object.entries(sim.traceability || {}).forEach(([key, value], i) => { inputs.getRow(30 + i).values = [key, value]; });
  (sim.warnings || []).forEach((warning, i) => { inputs.getRow(40 + i).values = [warning.code, warning.message]; });

  const S = row => `'05_Supuestos'!B${row}`;
  const f = (row, label, formula, result, unit, criterion, format = '#,##0.0000') => {
    build.getRow(row).values = [label, { formula, result: Number.isFinite(result) ? result : 'No disponible' }, unit, criterion];
    build.getCell(row, 2).numFmt = format;
  };
  build.getRow(4).values = ['Concepto', 'Resultado', 'Unidad', 'Criterio'];
  f(5, 'Tasa de fallas (lambda)', `IF(AND(ISNUMBER(${S(5)}),${S(5)}>=0,ISNUMBER(${S(6)}),${S(6)}>0),${S(5)}/${S(6)},${NA})`, sim.lambda.value, 'fallas/año', 'Fallas / exposición en años');
  f(6, 'Compensación estimada por falla', `IF(${S(15)}="manual",IF(AND(ISNUMBER(${S(16)}),${S(16)}>=0),${S(16)},${NA}),IF(AND(ISNUMBER(${S(13)}),${S(13)}>=0,ISNUMBER(${S(14)}),${S(14)}>0),${S(13)}/${S(14)},${NA}))`, sim.compensationPerFault.value, 'S/falla', 'Modo manual o compensación / fallas compatibles', CURRENCY);
  for (const [row, lengthRow, costRow, key, label] of [[7, 7, 10, 'aerial', 'Costo aéreo'], [8, 8, 11, 'underground', 'Costo subterráneo'], [9, 9, 12, 'unclassified', 'Costo sin clasificar']]) {
    f(row, label, `IF(AND(ISNUMBER(${S(lengthRow)}),${S(lengthRow)}>=0),IF(${S(lengthRow)}=0,0,IF(AND(ISNUMBER(${S(costRow)}),${S(costRow)}>=0),${S(lengthRow)}/1000*${S(costRow)},${NA})),${NA})`, sim.interventionCost.components[key].cost, 'S/', 'Longitud en m / 1000 × costo por km', CURRENCY);
  }
  f(10, 'Inversión', `IF(AND(COUNT(B7:B9)=3,${S(21)}=1),SUM(B7:B9),${NA})`, sim.interventionCost.total, 'S/', 'Suma de costos; requiere geometría utilizable', CURRENCY);
  f(11, 'Exposición anual por compensación', `IF(COUNT(B5:B6)=2,B5*B6,${NA})`, sim.annualCompensationExposure, 'S/año', 'Lambda × compensación por falla', CURRENCY);
  f(12, 'Impacto económico atribuible estimado anual', `IF(AND(ISNUMBER(B11),ISNUMBER(${S(17)}),${S(17)}>=0,${S(17)}<=1),B11*${S(17)},${NA})`, sim.annualAvoidedBenefit, 'S/año', 'Exposición × factor evitable', CURRENCY);
  const first = 41, last = 40 + maxYears;
  const valid = `AND(ISNUMBER(B10),ISNUMBER(B12),ISNUMBER(${S(18)}),${S(18)}>-1,ISNUMBER(${S(20)}),${S(20)}>-1,ISNUMBER(${S(19)}),${S(19)}>=1,${S(19)}<=${maxYears},INT(${S(19)})=${S(19)})`;
  f(13, 'Valor presente de beneficios', `IF(${valid},SUM(F${first}:F${last}),${NA})`, sim.financial.pvBenefits, 'S/', 'Suma de beneficios descontados', CURRENCY);
  f(14, 'VAN', `IF(AND(ISNUMBER(B13),ISNUMBER(B10)),B13-B10,${NA})`, sim.financial.npv, 'S/', 'Beneficios presentes - inversión', CURRENCY);
  f(15, 'TIR', `IF(AND(ISNUMBER(B13),B10>0,B12>0),IFERROR(IRR(E40:E${last}),${NA}),${NA})`, sim.financial.irr, '% anual', 'TIR de flujos anuales; no disponible si no existe raíz', '0.00%');
  f(16, 'Retorno simple', `IF(ISNUMBER(B13),IF(B10=0,0,IF(B12>0,B10/B12,${NA})),${NA})`, sim.financial.simplePaybackYears, 'años', 'Inversión / beneficio anual');
  f(17, 'Retorno descontado', `IF(ISNUMBER(B13),IF(B10=0,0,IF(COUNT(H${first}:H${last})>0,MIN(H${first}:H${last}),${NA})),${NA})`, sim.financial.discountedPaybackYears, 'años', 'Primer cruce acumulado con interpolación anual');
  f(18, 'Relación beneficio/costo', `IF(AND(ISNUMBER(B13),ISNUMBER(B10),B10>0),B13/B10,${NA})`, sim.financial.benefitCostRatio, 'ratio', 'Valor presente de beneficios / inversión');
  [2, 6, 12].forEach((months, i) => f(20 + i, `Probabilidad >=1 falla en ${months} meses`, `IF(ISNUMBER(B5),1-EXP(-B5*${months}/12),${NA})`, sim.poisson[months]?.probabilityAtLeastOne, '%', 'Poisson: 1 - exp(-lambda × meses/12)', '0.00%'));
  build.getCell('A25').value = 'Azul = inputs editables en 05_Supuestos. Resultados con fórmulas. Excel recalcula al abrir.';
  build.mergeCells('A25:H26'); build.getCell('A25').alignment = { wrapText: true };
  build.getRow(39).values = ['Año', '', '', 'Beneficio', 'Flujo', 'Valor presente', 'Acumulado presente', 'Año de recuperación'];
  build.getCell('A40').value = 0;
  build.getCell('E40').value = { formula: `IF(ISNUMBER(B10),-B10,${NA})`, result: sim.interventionCost.total === null ? 'No disponible' : -sim.interventionCost.total };
  build.getCell('G40').value = 0;
  for (let year = 1; year <= maxYears; year += 1) {
    const row = 40 + year, cash = sim.financial.yearlyCashFlows[year - 1];
    build.getCell(`A${row}`).value = year;
    const enabled = `AND(ISNUMBER($B$10),ISNUMBER($B$12),ISNUMBER(${S(18)}),${S(18)}>-1,ISNUMBER(${S(20)}),${S(20)}>-1,ISNUMBER(${S(19)}),${S(19)}>=1,${S(19)}<=${maxYears},INT(${S(19)})=${S(19)})`;
    const cumulative = cash?.discountedCumulative ?? sim.financial.pvBenefits ?? 0;
    const recoveredHere = sim.financial.discountedPaybackYears > year - 1 && sim.financial.discountedPaybackYears <= year;
    const formulas = {
      D: [`IF(${enabled},IF(A${row}<=${S(19)},$B$12*(1+${S(20)})^(A${row}-1),0),${NA})`, cash?.benefit ?? (sim.financial.available ? 0 : 'No disponible')],
      E: [`D${row}`, cash?.benefit ?? (sim.financial.available ? 0 : 'No disponible')],
      F: [`IF(ISNUMBER(D${row}),D${row}/(1+${S(18)})^A${row},${NA})`, cash?.discountedBenefit ?? (sim.financial.available ? 0 : 'No disponible')],
      G: [`IF(AND(ISNUMBER(F${row}),ISNUMBER(G${row - 1})),G${row - 1}+F${row},${NA})`, sim.financial.available ? cumulative : 'No disponible'],
      H: [`IF(AND(ISNUMBER(F${row}),ISNUMBER($B$10),ISNUMBER(G${row}),G${row}>=$B$10,G${row - 1}<$B$10,F${row}>0),A${row}-1+($B$10-G${row - 1})/F${row},"")`, recoveredHere ? sim.financial.discountedPaybackYears : '']
    };
    Object.entries(formulas).forEach(([col, [formula, result]]) => { build.getCell(`${col}${row}`).value = { formula, result }; build.getCell(`${col}${row}`).numFmt = col === 'H' ? '0.0000' : CURRENCY; });
  }
  build.pageSetup.printArea = `A1:H${40 + (assumptions.horizonYears || 1)}`;
  inputs.columns = [{ width: 44 }, { width: 32 }, { width: 20 }, { width: 75 }];
  build.columns = [{ width: 43 }, { width: 23 }, { width: 16 }, { width: 50 }, { width: 22 }, { width: 22 }, { width: 24 }, { width: 24 }];
}
