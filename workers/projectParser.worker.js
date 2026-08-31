import { parseAndValidateProjectInputText } from '../lib/projectValidation.js';

self.onmessage = async (event) => {
  try {
    const result = await parseAndValidateProjectInputText(event.data.text);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: {
        code: error?.code || 'PROJECT_PARSE_FAILED',
        message: error?.message || 'No se pudo procesar el proyecto.'
      }
    });
  }
};
