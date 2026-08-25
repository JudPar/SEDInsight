import { NextResponse } from 'next/server';
import { getAuthenticatedSupabase } from '@/lib/supabase-server';

export async function POST(request) {
  try {
    const session = await getAuthenticatedSupabase(request);
    if (session.error) return NextResponse.json({ error: session.error }, { status: 401 });
    const formData = await request.formData();
    const file = formData.get('file');
    const fileName = formData.get('fileName') || `falla_${Date.now()}.jpg`;

    if (!file) {
      return NextResponse.json({ success: false, error: 'No se recibió archivo de imagen' }, { status: 400 });
    }

    const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_PRIVATE_KEY;
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    // Verificar si hay credenciales reales de Google Drive
    const isGoogleDriveConfigured = Boolean(
      clientEmail && 
      privateKey && 
      folderId && 
      !clientEmail.includes('tu-service-account')
    );

    if (!isGoogleDriveConfigured) {
      // MODO FALLBACK LOCAL: Si aún no hay Service Account configurada, convertir a DataURL para pruebas inmediatas
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const mimeType = file.type || 'image/jpeg';
      const base64Image = `data:${mimeType};base64,${buffer.toString('base64')}`;

      return NextResponse.json({
        success: true,
        url: base64Image,
        name: fileName,
        isMock: true,
        message: 'Modo Local Activo: Imagen almacenada localmente en la sesión'
      });
    }

    // MODO GOOGLE DRIVE OFICIAL (Service Account)
    const { google } = require('googleapis');

    if (privateKey) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }

    const auth = new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']
    );

    const drive = google.drive({ version: 'v3', auth });

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const { Readable } = require('stream');

    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    // 1. Subir archivo a la carpeta especificada en Google Drive
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId]
      },
      media: {
        mimeType: file.type || 'image/jpeg',
        body: stream
      },
      fields: 'id, webViewLink, webContentLink'
    });

    const fileId = response.data.id;

    // 2. Dar permisos de lectura pública ("cualquiera con el enlace")
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    // URL directa para renderizado en HTML/React
    const directUrl = `https://lh3.googleusercontent.com/d/${fileId}`;

    return NextResponse.json({
      success: true,
      fileId: fileId,
      url: directUrl,
      webViewLink: response.data.webViewLink,
      name: fileName
    });

  } catch (err) {
    console.error('Error subiendo a Google Drive:', err);
    return NextResponse.json({ success: false, error: 'No se pudo subir la imagen.' }, { status: 500 });
  }
}
