export const GEOPLUZ_PROJECT_FORMAT = 'GEOPLUZ_PROJECT';
export const GEOPLUZ_PROJECT_VERSION = 1;
export const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ProjectParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectParseError';
    this.code = code;
  }
}

export function parseProjectJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ProjectParseError('EMPTY_JSON', 'El contenido JSON está vacío.');
  }

  try {
    return JSON.parse(text, (key, value) => {
      if (DANGEROUS_JSON_KEYS.has(key)) {
        throw new ProjectParseError('UNSAFE_PROPERTY', `El JSON contiene una propiedad no permitida: ${key}.`);
      }
      return value;
    });
  } catch (error) {
    if (error instanceof ProjectParseError) throw error;
    const detail = String(error?.message || '');
    const position = Number(detail.match(/position\s+(\d+)/i)?.[1]);
    const failsAtEnd = Number.isFinite(position) && position >= text.trimEnd().length - 1;
    const looksTruncated = /unexpected end|unterminated|end of json/i.test(detail) ||
      (failsAtEnd && /expected|after property value/i.test(detail));
    throw new ProjectParseError(
      looksTruncated ? 'TRUNCATED_JSON' : 'INVALID_JSON',
      looksTruncated
        ? 'El JSON parece estar incompleto o truncado. Verifica que hayas copiado todo el contenido.'
        : 'El contenido no es un JSON válido. Revisa la sintaxis e inténtalo nuevamente.'
    );
  }
}

export function isGeopluzProject(value) {
  return Boolean(value && typeof value === 'object' && value.format === GEOPLUZ_PROJECT_FORMAT);
}

export function isLegacyNetworkJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isGeopluzProject(value)) return false;
  return Object.entries(value).some(([key, item]) => (
    item && typeof item === 'object' && !Array.isArray(item) &&
    (item.llaves || item.sedCoord || key.startsWith('SED') || key.endsWith('S'))
  ));
}

function canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalizeValue(value[key])]));
  }
  return value;
}

function canonicalizeEntityList(values) {
  return (values || [])
    .map(canonicalizeValue)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function canonicalizeProjectPayload(project) {
  return {
    seds: canonicalizeEntityList(project.seds),
    llaves: canonicalizeEntityList(project.llaves),
    fallas: canonicalizeEntityList(project.fallas),
    external_assets: canonicalizeValue(project.external_assets)
  };
}

export async function computeProjectChecksum(project) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return null;
  const payload = JSON.stringify(canonicalizeProjectPayload(project));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hash}`;
}
