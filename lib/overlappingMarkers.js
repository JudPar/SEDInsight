export const FAULT_MARKER_SIZE_PX = 26;
export const FAULT_OVERLAP_DISTANCE_PX = 30;

export function groupOverlappingPoints(items, overlapDistance = FAULT_OVERLAP_DISTANCE_PX) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const cellSize = Math.max(1, overlapDistance);
  const maxDistanceSquared = overlapDistance * overlapDistance;
  const parents = items.map((_, index) => index);
  const ranks = items.map(() => 0);
  const cells = new Map();
  const exactPoints = new Map();

  const find = (index) => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };

  const union = (left, right) => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (ranks[leftRoot] < ranks[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    parents[rightRoot] = leftRoot;
    if (ranks[leftRoot] === ranks[rightRoot]) ranks[leftRoot] += 1;
  };

  items.forEach((item, index) => {
    const exactKey = `${item.x}:${item.y}`;
    const exactMatch = exactPoints.get(exactKey);
    if (exactMatch !== undefined) {
      union(index, exactMatch);
      return;
    }
    exactPoints.set(exactKey, index);

    const cellX = Math.floor(item.x / cellSize);
    const cellY = Math.floor(item.y / cellSize);

    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        const nearby = cells.get(`${cellX + xOffset}:${cellY + yOffset}`) || [];
        nearby.forEach((otherIndex) => {
          const other = items[otherIndex];
          const dx = item.x - other.x;
          const dy = item.y - other.y;
          if ((dx * dx) + (dy * dy) <= maxDistanceSquared) union(index, otherIndex);
        });
      }
    }

    const cellKey = `${cellX}:${cellY}`;
    const members = cells.get(cellKey) || [];
    members.push(index);
    cells.set(cellKey, members);
  });

  const grouped = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    const group = grouped.get(root) || [];
    group.push(item);
    grouped.set(root, group);
  });

  return Array.from(grouped.values()).map((members) => ({
    items: members,
    center: {
      x: members.reduce((sum, item) => sum + item.x, 0) / members.length,
      y: members.reduce((sum, item) => sum + item.y, 0) / members.length
    }
  }));
}

export function getSpiderfyPositions(center, count) {
  if (!center || count <= 0) return [];

  if (count <= 8) {
    const radius = Math.max(38, 26 + (count * 5));
    const startAngle = -Math.PI / 2;
    return Array.from({ length: count }, (_, index) => {
      const angle = startAngle + ((Math.PI * 2 * index) / count);
      return {
        x: center.x + (Math.cos(angle) * radius),
        y: center.y + (Math.sin(angle) * radius)
      };
    });
  }

  return Array.from({ length: count }, (_, index) => {
    const angle = index * 0.82;
    const radius = 34 + (index * 5.5);
    return {
      x: center.x + (Math.cos(angle) * radius),
      y: center.y + (Math.sin(angle) * radius)
    };
  });
}
