export function validCoordinatePair(pair) {
  return Array.isArray(pair) && pair.length >= 2 &&
    typeof pair[0] === 'number' && Number.isFinite(pair[0]) &&
    typeof pair[1] === 'number' && Number.isFinite(pair[1]) &&
    pair[0] >= -90 && pair[0] <= 90 &&
    pair[1] >= -180 && pair[1] <= 180;
}

export function validNetworkCoordinatePair(pair) {
  if (!Array.isArray(pair) || pair.length < 2 ||
      typeof pair[0] !== 'number' || !Number.isFinite(pair[0]) ||
      typeof pair[1] !== 'number' || !Number.isFinite(pair[1])) return false;
  if (validCoordinatePair(pair)) return true;

  const first = pair[0];
  const second = pair[1];
  const utm = (first >= 100000 && first <= 900000 && second > 8000000 && second < 10000000) ||
    (second >= 100000 && second <= 900000 && first > 8000000 && first < 10000000);
  const webMercator = Math.abs(first) <= 20037508.34 && Math.abs(second) <= 20037508.34 &&
    Math.abs(first) > 1000000 && Math.abs(second) > 1000000;
  return utm || webMercator;
}

export function hasCanonicalNetworkGeometry(line) {
  return Boolean(line && typeof line === 'object' && !Array.isArray(line) &&
    Array.isArray(line.coords) && line.coords.length >= 2 &&
    line.coords.every(validNetworkCoordinatePair));
}
