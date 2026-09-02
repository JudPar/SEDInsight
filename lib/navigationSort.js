function sedSortKey(value) {
  const text = String(value || '');
  const match = text.match(/\d+/);
  return { number: match ? Number(match[0]) : Number.MAX_SAFE_INTEGER, text };
}

export function sortSedIds(ids) {
  return [...ids].sort((a, b) => {
    const left = sedSortKey(a);
    const right = sedSortKey(b);
    return left.number - right.number || left.text.localeCompare(right.text, 'es', { numeric: true });
  });
}

export function sortLlaveIds(ids) {
  return [...ids].sort((left, right) =>
    String(left).localeCompare(String(right), 'es', { numeric: true, sensitivity: 'base' }) ||
    String(left).localeCompare(String(right), 'es')
  );
}

export function resolvePresentationSedSelection(sedId) {
  return {
    sedId: String(sedId || ''),
    llaveId: '',
    showFullSedView: Boolean(sedId)
  };
}

export function resolvePresentationLlaveSelection(sedId, llaveId) {
  return {
    sedId: String(sedId || ''),
    llaveId: String(llaveId || ''),
    showFullSedView: Boolean(sedId) && !llaveId
  };
}
