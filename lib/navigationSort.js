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

export function filterLlaveIdsByStatus(llaves = {}, statusFilter = 'todos') {
  const ids = Object.keys(llaves || {}).filter(llaveId => {
    if (statusFilter === 'todos') return true;
    return (llaves[llaveId]?.analysis?.status || 'cargado') === statusFilter;
  });
  return sortLlaveIds(ids);
}

export function filterSedsByCircuitStatus(localDatabase = {}, statusFilter = 'todos') {
  if (statusFilter === 'todos') return localDatabase;
  return Object.fromEntries(
    Object.entries(localDatabase).filter(([, sed]) =>
      filterLlaveIdsByStatus(sed?.llaves || {}, statusFilter).length > 0
    )
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
