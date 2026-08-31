const DATA_IMAGE_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\r\n]+$/i;
const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export function classifyExternalReference(value, { allowDataImage = false } = {}) {
  if (value === null || value === undefined || value === '') return { kind: 'empty', navigable: false, url: null };
  if (typeof value !== 'string') return { kind: 'invalid-type', navigable: false, url: null };
  if (allowDataImage && DATA_IMAGE_PATTERN.test(value)) return { kind: 'data-image', navigable: false, url: value };

  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'web', navigable: true, url: url.href };
    }
    return { kind: 'unsafe-scheme', navigable: false, url: null };
  } catch {
    return {
      kind: EXPLICIT_SCHEME_PATTERN.test(value) ? 'unsafe-scheme' : 'legacy',
      navigable: false,
      url: null
    };
  }
}

export function safeExternalNavigationUrl(value) {
  const result = classifyExternalReference(value);
  return result.navigable ? result.url : null;
}

export function safeExternalImageSource(value) {
  const result = classifyExternalReference(value, { allowDataImage: true });
  return result.kind === 'web' || result.kind === 'data-image' ? result.url : null;
}
