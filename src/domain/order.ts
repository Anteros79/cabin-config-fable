/** Locale-independent ordering by UTF-16 code unit. The only string comparator the domain, importer, server and tools use. */
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => compareCodePoints(key(a), key(b));
}
