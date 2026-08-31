'use client';

import { useCallback } from 'react';
import FaultTable from './FaultTable';

export default function PresentationTablePanel({ points, onRowClick, onExportExcel, onExportPdf, onMajorOverlayChange }) {
  const count = points ? points.length : 0;
  const reportTableOverlay = useCallback((isOpen) => {
    onMajorOverlayChange?.('fault-table', isOpen);
  }, [onMajorOverlayChange]);
  
  return (
    <div className="presentation-table-panel">
      <div className="pres-table-header">
        <div className="pres-table-title">
          <span>Registro de fallas ({count})</span>
        </div>
        <div className="pres-table-actions">
          {onExportPdf && (
            <button
              onClick={onExportPdf}
              className="secondary-action"
              title="Descargar Reporte Técnico en PDF con plano de circuito y fallas"
            >
              <i className="fa-solid fa-file-pdf"></i> PDF
            </button>
          )}
          {onExportExcel && (
            <button
              onClick={onExportExcel}
              className="secondary-action"
              title="Descargar tabla de fallas en Excel agrupada por SED"
            >
              <i className="fa-solid fa-file-excel"></i> Excel
            </button>
          )}
        </div>
      </div>
      <div className="pres-table-body">
        <FaultTable 
          points={points} 
          showActions={false} 
          onRowClick={onRowClick} 
          onOverlayChange={reportTableOverlay}
        />
      </div>
    </div>
  );
}
