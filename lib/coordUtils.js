/**
 * Formats and validates coordinate array
 * @param {Array} pt - The [x, y] or [lat, lng] coordinate array
 * @returns {Array} - The [lat, lng] array in EPSG:4326 format
 */
export function normalizeNetworkCoordinatePair(pt) {
  if (!Array.isArray(pt) || pt.length < 2) return null;
  let val1 = parseFloat(pt[0]);
  let val2 = parseFloat(pt[1]);
  
  if (!Number.isFinite(val1) || !Number.isFinite(val2)) return null;
  
  // The canonical project contract is [latitude, longitude]. Only reverse when
  // the supplied order cannot itself be a latitude/longitude pair.
  if (Math.abs(val1) <= 90 && Math.abs(val2) <= 180) {
    return [val1, val2];
  }
  if (Math.abs(val2) <= 90 && Math.abs(val1) <= 180) {
    return [val2, val1];
  }
  
  // UTM coordinates (x: 100000-900000, y: >8000000)
  if (val1 >= 100000 && val1 <= 900000 && val2 > 8000000) {
    const lng = -77.15 + (val1 - 280000) / 100000;
    const lat = -12.04 + (val2 - 8668000) / 110000;
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? [lat, lng] : null;
  } else if (val2 >= 100000 && val2 <= 900000 && val1 > 8000000) {
    const lng = -77.15 + (val2 - 280000) / 100000;
    const lat = -12.04 + (val1 - 8668000) / 110000;
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? [lat, lng] : null;
  }
  
  // Web Mercator (EPSG:3857)
  if (Math.abs(val1) > 1000000 && Math.abs(val2) > 1000000) {
    const x = val1;
    const y = val2;
    const lng = (x / 20037508.34) * 180;
    const lat = (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90;
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? [lat, lng] : null;
  }
  
  return null;
}

export function getNetworkCoordinateKind(pt) {
  if (!Array.isArray(pt) || pt.length < 2) return 'invalid';
  const first = Number.parseFloat(pt[0]);
  const second = Number.parseFloat(pt[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return 'invalid';
  if (Math.abs(first) <= 90 && Math.abs(second) <= 180) return 'canonical_wgs84';
  if (Math.abs(second) <= 90 && Math.abs(first) <= 180) return 'reversed_wgs84';
  if ((first >= 100000 && first <= 900000 && second > 8000000) ||
      (second >= 100000 && second <= 900000 && first > 8000000)) return 'legacy_utm';
  if (Math.abs(first) <= 20037508.34 && Math.abs(second) <= 20037508.34 &&
      Math.abs(first) > 1000000 && Math.abs(second) > 1000000) return 'web_mercator';
  return 'invalid';
}

export function fixCoord(pt) {
  return normalizeNetworkCoordinatePair(pt) || [0, 0];
}

/**
 * Returns a complete, drawable Leaflet polyline or an empty array.
 * Invalid vertices invalidate the whole line so unrelated points are never joined.
 */
export function getDrawableLineCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const normalized = [];
  for (const coord of coords) {
    const fixed = normalizeNetworkCoordinatePair(coord);
    if (!Array.isArray(fixed) || fixed.length < 2 || !fixed.every(Number.isFinite)) return [];
    normalized.push(fixed);
  }
  return normalized;
}

/**
 * Returns polyline weight based on zoom level
 * @param {number} zoom - Current map zoom level
 * @returns {number} - Polyline weight
 */
export function getWeightForZoom(zoom) {
  if (zoom <= 14) return 1.2;
  if (zoom <= 16) return 2.0;
  if (zoom <= 18) return 2.8;
  return 3.5;
}
