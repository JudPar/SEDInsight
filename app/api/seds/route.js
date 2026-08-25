import { NextResponse } from 'next/server';
import { getAuthenticatedSupabase } from '@/lib/supabase-server';
import { hydrateLlave, serializeLlaveLines } from '@/lib/circuitAnalysis';

async function authenticatedClient(request) {
  const result = await getAuthenticatedSupabase(request);
  if (result.error) return { response: NextResponse.json({ error: result.error }, { status: 401 }) };
  return result;
}

export async function GET(request) {
  try {
    const auth = await authenticatedClient(request);
    if (auth.response) return auth.response;
    const { supabase } = auth;
    const { data: sedsData, error: sedsError } = await supabase.from('seds').select('*');
    if (sedsError) throw sedsError;
    
    const { data: llavesData, error: llavesError } = await supabase.from('llaves').select('*');
    if (llavesError) throw llavesError;
    
    const db = {};
    sedsData.forEach(sed => {
      db[sed.id] = {
        id: sed.id,
        name: sed.name,
        sedCoord: sed.sed_coord,
        llaves: {}
      };
    });
    
    llavesData.forEach(llave => {
      if (db[llave.sed_id]) {
        db[llave.sed_id].llaves[llave.llave_code] = hydrateLlave(llave);
      }
    });
    
    return NextResponse.json(db);
  } catch (error) {
    return NextResponse.json({ error: 'No se pudo cargar la información solicitada.' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const auth = await authenticatedClient(request);
    if (auth.response) return auth.response;
    const { supabase } = auth;
    const db = await request.json();
    const sedsBatch = [];
    const llavesBatch = [];

    for (const sedId in db) {
      const sed = db[sedId];
      sedsBatch.push({
        id: sedId,
        name: sed.name || `SED ${sedId}`,
        sed_coord: sed.sedCoord || null
      });

      if (sed.llaves) {
        for (const llaveCode in sed.llaves) {
          const llave = sed.llaves[llaveCode];
          llavesBatch.push({
            sed_id: sedId,
            llave_code: llaveCode,
            name: llave.name || llaveCode,
            lines_data: serializeLlaveLines(llave)
          });
        }
      }
    }

    const CHUNK_SIZE = 500;

    // Inserción en lote (Bulk Upsert) de SEDs
    for (let i = 0; i < sedsBatch.length; i += CHUNK_SIZE) {
      const chunk = sedsBatch.slice(i, i + CHUNK_SIZE);
      const { error } = await supabase.from('seds').upsert(chunk);
      if (error) throw error;
    }

    // Inserción en lote (Bulk Upsert) de Llaves
    for (let i = 0; i < llavesBatch.length; i += CHUNK_SIZE) {
      const chunk = llavesBatch.slice(i, i + CHUNK_SIZE);
      const { error } = await supabase.from('llaves').upsert(chunk, { onConflict: 'sed_id,llave_code' });
      if (error) throw error;
    }

    return NextResponse.json({ success: true, countSeds: sedsBatch.length, countLlaves: llavesBatch.length });
  } catch (error) {
    return NextResponse.json({ error: 'No se pudieron guardar los cambios.' }, { status: 500 });
  }
}

export async function DELETE() {
  return NextResponse.json({ error: 'Eliminar registros está deshabilitado.' }, { status: 405 });
}
