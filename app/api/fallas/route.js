import { NextResponse } from 'next/server';
import { getAuthenticatedSupabase } from '@/lib/supabase-server';

async function authenticatedClient(request) {
  const result = await getAuthenticatedSupabase(request);
  if (result.error) return { response: NextResponse.json({ error: result.error }, { status: 401 }) };
  return result;
}

export async function GET(request) {
  const auth = await authenticatedClient(request);
  if (auth.response) return auth.response;
  const { supabase } = auth;
  const { searchParams } = new URL(request.url);
  const sedId = searchParams.get('sed_id');
  const minLat = searchParams.get('minLat');
  const maxLat = searchParams.get('maxLat');
  const minLng = searchParams.get('minLng');
  const maxLng = searchParams.get('maxLng');
  
  let query = supabase.from('fallas').select('*');
  if (sedId) {
    query = query.eq('sed_id', sedId);
  }

  // Filtrado Bounding Box (BBOX) si se proporcionan coordenadas
  if (minLat && maxLat && minLng && maxLng) {
    query = query
      .gte('latitud', parseFloat(minLat))
      .lte('latitud', parseFloat(maxLat))
      .gte('longitud', parseFloat(minLng))
      .lte('longitud', parseFloat(maxLng));
  }
  
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'No se pudieron cargar las fallas.' }, { status: 500 });
  
  return NextResponse.json(data);
}

export async function POST(request) {
  try {
    const auth = await authenticatedClient(request);
    if (auth.response) return auth.response;
    const { supabase } = auth;
    const body = await request.json();
    if (Array.isArray(body)) {
      // Inserción en lote (Bulk Insert)
      const { data, error } = await supabase.from('fallas').insert(body).select();
      if (error) throw error;
      return NextResponse.json(data);
    } else {
      const { data, error } = await supabase.from('fallas').insert(body).select();
      if (error) throw error;
      return NextResponse.json(data[0]);
    }
  } catch (error) {
    return NextResponse.json({ error: 'No se pudo guardar la falla.' }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const auth = await authenticatedClient(request);
    if (auth.response) return auth.response;
    const { supabase } = auth;
    const body = await request.json();
    const { id, ...updates } = body;
    if (!id) return NextResponse.json({ error: 'Falta el id' }, { status: 400 });
    
    const { data, error } = await supabase.from('fallas').update(updates).eq('id', id).select();
    if (error) throw error;
    return NextResponse.json(data[0]);
  } catch (error) {
    return NextResponse.json({ error: 'No se pudo actualizar la falla.' }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const auth = await authenticatedClient(request);
    if (auth.response) return auth.response;
    const { supabase } = auth;
    const id = new URL(request.url).searchParams.get('id');

    if (!id || !/^\d+$/.test(id)) {
      return NextResponse.json({ error: 'Falta un id de falla válido.' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('fallas')
      .delete()
      .eq('id', Number(id))
      .select('id');

    if (error) {
      return NextResponse.json(
        { error: 'La falla no pudo eliminarse. Verifica tus permisos.' },
        { status: 403 }
      );
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'La falla no existe o no es accesible.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, id: data[0].id });
  } catch {
    return NextResponse.json({ error: 'No se pudo eliminar la falla.' }, { status: 500 });
  }
}
