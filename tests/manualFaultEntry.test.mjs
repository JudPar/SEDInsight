import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { completeManualFault, createManualFaultDraft, saveManualFaultToSupabase } from '../lib/manualFaultEntry.js';

const form = {
  ticket: ' INC-123 ', horaInicio: '30/09/2026 14:32', suministro: ' 00123.0 ',
  odm: ' ODM-8 ', zona: ' Norte ', setAlimentador: 'SET Norte / Alimentador 1',
  fallaReal: ' Cable cortado ', causa: ' Humedad ', nota: ' Reparación manual ',
  linkCroquis: '', fotos: [], coords: [-12.04, -77.03]
};

test('placing a manual fault creates a draft without invented incident data', () => {
  const draft = createManualFaultDraft({ lat: -12.04, lng: -77.03 }, '00007S', '10SP');
  assert.deepEqual(draft.coords, [-12.04, -77.03]);
  assert.equal(draft.sedLlave, '00007S-10SP');
  assert.equal(draft.ticket, '');
  assert.equal(draft.falla, '');
  assert.throws(() => createManualFaultDraft({ lat: -12.04, lng: -77.03 }, '', ''), /Selecciona una SED/);
  assert.throws(() => createManualFaultDraft({ lat: 200, lng: -77.03 }, '00007S'), /ubicación válida/);
});

test('manual form fields become canonical fault fields and date determines the period', () => {
  const draft = createManualFaultDraft({ lat: -12.04, lng: -77.03 }, '00007S', '10SP');
  const saved = completeManualFault(draft, form);
  assert.equal(saved.periodKey, '2026-09');
  assert.equal(saved.ticket, 'INC-123');
  assert.equal(saved.falla, 'Cable cortado');
  assert.equal(saved.set, 'SET Norte');
  assert.equal(saved.alimentador, 'Alimentador 1');
  assert.equal(saved.suministro, '00123');
  assert.equal(saved.coordSource, 'MANUAL');
  assert.deepEqual(saved.coords, form.coords);
  assert.equal(saved.sedLlave, '00007S-10SP');
  assert.deepEqual(draft.coords, form.coords);
});

test('manual entry rejects invalid dates and coordinates before writing', () => {
  const draft = createManualFaultDraft({ lat: -12.04, lng: -77.03 }, '00007S', '10SP');
  assert.throws(() => completeManualFault(draft, { ...form, horaInicio: 'sin fecha' }), /Hora de inicio válida/);
  assert.throws(() => completeManualFault(draft, { ...form, coords: null }), /coordenadas de la falla/);
  assert.throws(() => completeManualFault(draft, { ...form, coords: [[-12.04, -77.03], [200, -77.03]] }), /segundo punto/);
});

test('map click opens a draft; cancel cannot leave a ghost fault; database insert is confirmed before state update', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const click = page.slice(page.indexOf('const handleMapClick'), page.indexOf('// Guardado de Falla'));
  const save = page.slice(page.indexOf('async function handleSavePoint'), page.indexOf('function buildFallaRecord'));
  assert.match(click, /setNewFaultDraft\(createManualFaultDraft/);
  assert.doesNotMatch(click, /setNumberedPointsList\(updated\)/);
  assert.match(save, /saveManualFaultToSupabase\(supabase, record/);
  assert.ok(save.indexOf('setNumberedPointsList(previous => [...previous, newPoint])') > save.indexOf('if (isSupabaseSource)'));
  assert.match(page, /onClose=\{\(\) => \{ setIsFormOpen\(false\); setEditingPointIndex\(null\); setNewFaultDraft\(null\); \}\}/);
  assert.match(page, /setIsSegmentSelectionMode\(false\);\s*setRelocatingPointIndex\(null\);\s*}\s*setIsAddPointMode\(active\)/);
  const map = readFileSync(new URL('../components/MapViewer.js', import.meta.url), 'utf8');
  assert.match(map, /if \(isAddPointMode\) \{\s*marker\.closePopup\(\);\s*onMapClickRef\.current\?\.\(marker\.getLatLng\(\)\)/);
  assert.match(map, /if \(isAddPointMode\) onMapClickRef\.current\?\.\(groupMarker\.getLatLng\(\)\)/);
});

test('existing month inserts one manual fault, while a new month uses non-replacing RPC', async () => {
  const record = { period_key: '2026-09', source_record_id: 'manual:test', sed_id: '00007S' };
  const insertCalls = [];
  const existing = {
    from(table) {
      if (table === 'fault_periods') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { period_key: '2026-09' }, error: null }) }) }) };
      if (table === 'fallas') return { insert: value => ({ select: () => ({ single: async () => { insertCalls.push(value); return { data: { id: 10 }, error: null }; } }) }) };
      throw new Error('Unexpected table');
    },
    rpc() { throw new Error('Existing period must never be replaced'); }
  };
  assert.equal(await saveManualFaultToSupabase(existing, record, '2026-09', 'Septiembre 2026'), 10);
  assert.deepEqual(insertCalls, [record]);

  const rpcCalls = [];
  const fresh = {
    from(table) {
      if (table === 'fault_periods') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      if (table === 'fallas') return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 11 }, error: null }) }) }) }) };
      throw new Error('Unexpected table');
    },
    async rpc(name, args) { rpcCalls.push({ name, args }); return { error: null }; }
  };
  assert.equal(await saveManualFaultToSupabase(fresh, record, '2026-09', 'Septiembre 2026'), 11);
  assert.equal(rpcCalls[0].name, 'geopluz_import_fault_period');
  assert.equal(rpcCalls[0].args.p_replace, false);
  assert.deepEqual(rpcCalls[0].args.p_rows, [record]);
});

test('failed remote insert never reports a saved manual fault', async () => {
  const rejected = {
    from(table) {
      if (table === 'fault_periods') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { period_key: '2026-09' }, error: null }) }) }) };
      return { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'RLS blocked' } }) }) }) };
    }
  };
  await assert.rejects(() => saveManualFaultToSupabase(rejected, {}, '2026-09', 'Septiembre 2026'), /RLS blocked/);
});
