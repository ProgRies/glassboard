// The browser and server use the same three-way merge. Only objects changed
// locally are applied; edits to an object changed by both parties are conflicts.
export function equal(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}
export function mergeSnapshots(base, local, remote) {
  const result = structuredClone(remote);
  const conflicts = [];
  if (local.title !== base.title) {
    if (remote.title !== base.title && remote.title !== local.title) conflicts.push('board title');
    else result.title = local.title;
  }
  const before = new Map(base.items.map(o => [o.id, o]));
  const mine = new Map(local.items.map(o => [o.id, o]));
  const theirs = new Map(remote.items.map(o => [o.id, o]));
  const merged = new Map(theirs);
  for (const id of new Set([...before.keys(), ...mine.keys()])) {
    const b = before.get(id), l = mine.get(id), r = theirs.get(id);
    if (equal(b, l)) continue;
    if (!equal(b, r) && !equal(l, r)) { conflicts.push(id); continue; }
    if (l === undefined) merged.delete(id); else merged.set(id, structuredClone(l));
  }
  result.items = [...merged.values()];
  return { board: result, conflicts };
}
