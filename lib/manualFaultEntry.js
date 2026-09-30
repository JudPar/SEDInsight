import { derivePeriodKeyFromStartTime } from './monthlyFaultImport.js';
import { isValidCoordinatePair, markCoordinatesManual, normalizeSuministro } from './faultGeolocation.js';

export function createManualFaultDraft(coordinate, sedId, llaveId = '') {
  const coords = [Number(coordinate?.lat), Number(coordinate?.lng)];
  if (!isValidCoordinatePair(coords)) throw new Error('Selecciona una ubicación válida en el mapa.');
  if (!sedId) throw new Error('Selecciona una SED antes de marcar una falla.');
  return markCoordinatesManual({
    sed: sedId,
    llaveSistema: llaveId,
    sedLlave: `${sedId}-${llaveId}`,
    ticket: '',
    horaInicio: '',
    falla: '',
    causa: '',
    suministro: '',
    fotos: []
  }, coords);
}

export function completeManualFault(draft, formData) {
  const horaInicio = String(formData.horaInicio || '').trim();
  const periodKey = derivePeriodKeyFromStartTime(horaInicio);
  if (!periodKey) throw new Error('Indica una Hora de inicio válida (por ejemplo, 30/09/2026 14:32).');
  if (!isValidCoordinatePair(formData.coords)) throw new Error('Las coordenadas de la falla no son válidas.');
  if (Array.isArray(formData.coords?.[0]) && formData.coords.some(coord => !isValidCoordinatePair(coord))) {
    throw new Error('Las coordenadas del segundo punto no son válidas.');
  }
  const setAlimentador = String(formData.setAlimentador || '').trim();
  const separator = setAlimentador.indexOf('/');
  const set = separator < 0 ? setAlimentador : setAlimentador.slice(0, separator).trim();
  const alimentador = separator < 0 ? '' : setAlimentador.slice(separator + 1).trim();
  return markCoordinatesManual({
    ...draft,
    ticket: String(formData.ticket || '').trim(),
    horaInicio,
    periodKey,
    suministro: normalizeSuministro(formData.suministro) || '',
    sedLlave: draft.sedLlave,
    odm: String(formData.odm || '').trim(),
    zona: String(formData.zona || '').trim(),
    set,
    alimentador,
    setAlimentador,
    falla: String(formData.fallaReal || '').trim(),
    causa: String(formData.causa || '').trim(),
    nota: String(formData.nota || '').trim(),
    linkCroquis: String(formData.linkCroquis || '').trim(),
    fotos: formData.fotos || [],
    coordLookupSuministro: null
  }, formData.coords);
}

export async function saveManualFaultToSupabase(supabase, record, periodKey, periodLabel) {
  const { data: period, error: periodError } = await supabase.from('fault_periods')
    .select('period_key').eq('period_key', periodKey).maybeSingle();
  if (periodError) throw new Error(`No se pudo comprobar el periodo: ${periodError.message}`);
  if (period) {
    const { data, error } = await supabase.from('fallas').insert(record).select('id').single();
    if (error || !data?.id) throw new Error(`No se pudo guardar la falla: ${error?.message || 'sin confirmación de la base'}`);
    return data.id;
  }
  const { error } = await supabase.rpc('geopluz_import_fault_period', {
    p_period_key: periodKey,
    p_label: periodLabel,
    p_rows: [record],
    p_replace: false
  });
  if (error) throw new Error(`No se pudo crear el nuevo periodo: ${error.message}`);
  const { data, error: lookupError } = await supabase.from('fallas').select('id')
    .eq('period_key', periodKey).eq('source_record_id', record.source_record_id).single();
  if (lookupError || !data?.id) throw new Error('El periodo se creó, pero no se pudo confirmar el ID de la falla. Recarga antes de intentarlo otra vez.');
  return data.id;
}
