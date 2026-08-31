'use client';

import { useState, useEffect, useRef } from 'react';
import { FAULT_CAUSES, DEFAULT_CAUSE_COLOR } from '@/lib/constants';
import { supabase } from '@/lib/supabase';
import { getCoordinateSourceLabel } from '@/lib/faultGeolocation';


export default function FaultForm({
  isOpen,
  onClose,
  onSave,
  editingPoint,
  defaultSedLlave
}) {
  const [formData, setFormData] = useState({
    ticket: '',
    horaInicio: '',
    suministro: '',
    sedLlave: '',
    odm: '',
    zona: '',
    setAlimentador: '',
    fallaReal: '',
    causa: '',
    nota: '',
    linkCroquis: '',
    latitud: '',
    longitud: '',
    latitud2: '',
    longitud2: ''
  });

  const [fotos, setFotos] = useState([]);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const photoInputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      if (editingPoint) {
        const isMulti = editingPoint.coords && Array.isArray(editingPoint.coords[0]);
        const pt1 = isMulti ? editingPoint.coords[0] : editingPoint.coords;
        const pt2 = isMulti ? editingPoint.coords[1] : null;

        setFormData({
          ticket: editingPoint.ticket || '',
          horaInicio: editingPoint.horaInicio || '',
          suministro: editingPoint.suministro || '',
          sedLlave: editingPoint.sedLlave || '',
          odm: editingPoint.odm || '',
          zona: editingPoint.zona || '',
          setAlimentador: `${editingPoint.set || ''} / ${editingPoint.alimentador || ''}`,
          fallaReal: editingPoint.falla || editingPoint.fallaReal || '',
          causa: editingPoint.causa || '',
          nota: editingPoint.nota || '',
          linkCroquis: editingPoint.linkCroquis || editingPoint.link_croquis || editingPoint.croquis || '',
          latitud: pt1 ? pt1[0] : '',
          longitud: pt1 ? pt1[1] : '',
          latitud2: pt2 ? pt2[0] : '',
          longitud2: pt2 ? pt2[1] : ''
        });
        setFotos(editingPoint.fotos || []);
      } else {
        setFormData({
          ticket: '',
          horaInicio: new Date().toLocaleString(),
          suministro: '',
          sedLlave: defaultSedLlave || '',
          odm: '',
          zona: '',
          setAlimentador: '',
          fallaReal: '',
          causa: '',
          nota: '',
          linkCroquis: '',
          latitud: '',
          longitud: '',
          latitud2: '',
          longitud2: ''
        });
        setFotos([]);
      }
    }
  }, [isOpen, editingPoint, defaultSedLlave]);

  const handleChange = (e) => {
    const { id, value } = e.target;
    setFormData(prev => ({ ...prev, [id]: value }));
  };

  // Compresión ligera en cliente mediante Canvas HTML5 (rápida y sin ocupar espacio excesivo)
  const compressImage = (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxDim = 1200;
          let width = img.width;
          let height = img.height;
          if (width > height && width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => {
            resolve(new File([blob], file.name, { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.82);
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    });
  };

  const handlePhotoUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setIsUploadingPhoto(true);

    for (const rawFile of files) {
      try {
        const compressed = await compressImage(rawFile);
        const data = new FormData();
        data.append('file', compressed);
        data.append('fileName', `${formData.ticket || 'falla'}_${Date.now()}.jpg`);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');

        const res = await fetch('/api/upload-drive', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: data
        });
        const result = await res.json();
        if (result.success) {
          setFotos(prev => [...prev, { url: result.url, name: result.name }]);
        } else {
          alert('Error subiendo foto: ' + result.error);
        }
      } catch (err) {
        alert('Error procesando foto: ' + err.message);
      }
    }
    setIsUploadingPhoto(false);
    e.target.value = '';
  };

  const handleRemovePhoto = (index) => {
    setFotos(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    let coords = null;
    if (formData.latitud && formData.longitud) {
      const p1 = [parseFloat(formData.latitud), parseFloat(formData.longitud)];
      if (formData.latitud2 && formData.longitud2) {
        const p2 = [parseFloat(formData.latitud2), parseFloat(formData.longitud2)];
        coords = [p1, p2];
      } else {
        coords = p1;
      }
    }

    onSave({ ...formData, coords, fotos });
  };

  if (!isOpen) return null;

  const displayNum = editingPoint ? (editingPoint.localNumber || editingPoint.number) : '#';

  return (
    <div className="modal-backdrop active">
      <div className="point-form-modal" style={{ width: '620px', maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ color: 'var(--accent-cyan)', fontSize: '14px', marginBottom: '12px', display: 'flex', justifyContent: 'space-between' }}>
          <span>📍 {editingPoint ? `Datos de Falla Reparada #${displayNum}` : 'Registro de Falla Atendida'}</span>
          <span onClick={onClose} style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>&times;</span>
        </h3>

        {editingPoint?.coordSource && (
          <div style={{ marginBottom: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Origen de ubicacion: <strong>{getCoordinateSourceLabel(editingPoint.coordSource)}</strong>
            {editingPoint.coordLookupSuministro ? ` (suministro ${editingPoint.coordLookupSuministro})` : ''}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-group">
              <label>NRO (Auto):</label>
              <input type="text" className="input-control" value={displayNum} readOnly />
            </div>
            <div className="form-group">
              <label>TICKET / INCIDENCIA:</label>
              <input type="text" id="ticket" className="input-control" value={formData.ticket} onChange={handleChange} placeholder="Ej: TK-99201" />
            </div>
            <div className="form-group">
              <label>HORA / FECHA DE INICIO:</label>
              <input type="text" id="horaInicio" className="input-control" value={formData.horaInicio} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>SUMINISTRO / NIS:</label>
              <input type="text" id="suministro" className="input-control" value={formData.suministro} onChange={handleChange} placeholder="Ej: 424383" />
            </div>
            <div className="form-group">
              <label>SED-LLAVE:</label>
              <input type="text" id="sedLlave" className="input-control" value={formData.sedLlave} onChange={handleChange} placeholder="Ej: 00007S-5SP" />
            </div>
            <div className="form-group">
              <label>ODM:</label>
              <input type="text" id="odm" className="input-control" value={formData.odm} onChange={handleChange} placeholder="Ej: ODM-8831" />
            </div>
            <div className="form-group">
              <label>ZONA:</label>
              <input type="text" id="zona" className="input-control" value={formData.zona} onChange={handleChange} placeholder="Ej: Zona Norte" />
            </div>
            <div className="form-group">
              <label>SET / ALIMENTADOR:</label>
              <input type="text" id="setAlimentador" className="input-control" value={formData.setAlimentador} onChange={handleChange} placeholder="Ej: SET San Juan / Alim 1" />
            </div>
            <div className="form-group full-width">
              <label>FALLA REAL (Constatada en Campo):</label>
              <input type="text" id="fallaReal" className="input-control" value={formData.fallaReal} onChange={handleChange} placeholder="Ej: Cable subterráneo dañado por excavación de terceros" />
            </div>
            <div className="form-group full-width">
              <label>CAUSA / DIAGNÓSTICO ESTANDARIZADO:</label>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                <select 
                  className="input-control" 
                  style={{ flex: '1', fontWeight: 'bold' }}
                  value={
                    FAULT_CAUSES.some(c => c.label === formData.causa) 
                      ? formData.causa 
                      : (formData.causa ? 'OTRO' : '')
                  } 
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val && val !== 'OTRO') {
                      setFormData(prev => ({ ...prev, causa: val }));
                    } else if (val === 'OTRO') {
                      setFormData(prev => ({ ...prev, causa: '' }));
                    }
                  }}
                >
                  <option value="">-- Seleccionar Causa Estandarizada --</option>
                  {FAULT_CAUSES.map(c => (
                    <option key={c.id} value={c.label}>
                      ● {c.label}
                    </option>
                  ))}
                  <option value="OTRO">⚪ OTRO / DIFERENTE (Escribir en texto)</option>
                </select>
              </div>
              <input 
                type="text" 
                id="causa" 
                className="input-control" 
                value={formData.causa} 
                onChange={handleChange} 
                placeholder="Escribe la causa o detalle específico (Ej: Humedad / Sobrecarga)" 
              />
            </div>
            <div className="form-group full-width">
              <label>NOTA ESPECÍFICA DE REPARACIÓN:</label>
              <input type="text" id="nota" className="input-control" value={formData.nota} onChange={handleChange} placeholder="Ej: Empalme termocontraíble instalado y circuito restablecido" />
            </div>
            <div className="form-group full-width">
              <label style={{ color: 'var(--accent-cyan)' }}>🗺️ LINK DEL CROQUIS / MAPA:</label>
              <input type="text" id="linkCroquis" className="input-control" value={formData.linkCroquis || ''} onChange={handleChange} placeholder="Ej: https://maps.google.com/?q=... o link al diagrama" />
            </div>
            <div className="form-group">
              <label>LATITUD (Punto 1):</label>
              <input type="text" id="latitud" className="input-control" value={formData.latitud} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>LONGITUD (Punto 1):</label>
              <input type="text" id="longitud" className="input-control" value={formData.longitud} onChange={handleChange} />
            </div>

            {/* SECCIÓN 2DO PUNTO DE ARREGLO (OPCIONAL) */}
            <div className="form-group">
              <label style={{ color: 'var(--accent-warning)' }}>LATITUD 2 (Empalme 2 - Opcional):</label>
              <input type="text" id="latitud2" className="input-control" value={formData.latitud2} onChange={handleChange} placeholder="Ej: -11.9604" />
            </div>
            <div className="form-group">
              <label style={{ color: 'var(--accent-warning)' }}>LONGITUD 2 (Empalme 2 - Opcional):</label>
              <input type="text" id="longitud2" className="input-control" value={formData.longitud2} onChange={handleChange} placeholder="Ej: -76.9857" />
            </div>

            {/* SECCIÓN DE EVIDENCIAS FOTOGRÁFICAS DE CAMPO */}
            <div className="form-group full-width" style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--border-color)' }}>
              <label style={{ color: 'var(--accent-cyan)', fontWeight: 'bold' }}>
                📸 Evidencias Fotográficas de la Reparación:
              </label>
              
              <input 
                type="file" 
                ref={photoInputRef}
                onChange={handlePhotoUpload}
                accept="image/*"
                multiple
                style={{ display: 'none' }}
              />

              <div style={{ display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' }}>
                <button 
                  type="button" 
                  className="btn btn-outline" 
                  style={{ width: 'auto', padding: '6px 12px', fontSize: '11px' }}
                  onClick={() => photoInputRef.current && photoInputRef.current.click()}
                  disabled={isUploadingPhoto}
                >
                  <i className="fa-solid fa-camera"></i> {isUploadingPhoto ? ' Subiendo...' : ' Subir / Tomar Foto(s)'}
                </button>
                <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                  (Adjunta fotos del cable, empalme o zanja)
                </span>
              </div>

              {/* Previsualizaciones en miniatura */}
              {fotos.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
                  {fotos.map((foto, idx) => (
                    <div key={idx} style={{ position: 'relative', width: '70px', height: '70px', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                      <img src={foto.url} alt={foto.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button
                        type="button"
                        onClick={() => handleRemovePhoto(idx)}
                        style={{ position: 'absolute', top: '2px', right: '2px', background: 'rgba(211,47,47,0.85)', color: 'white', border: 'none', borderRadius: '50%', width: '18px', height: '18px', cursor: 'pointer', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        title="Eliminar foto"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button type="submit" className="btn btn-green" style={{ flex: 1 }}>
              <i className="fa-solid fa-floppy-disk"></i> Guardar Registro de Falla
            </button>
            <button type="button" className="btn btn-outline" onClick={onClose} style={{ flex: 1 }}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
