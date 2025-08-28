export function getPropertyByPath<T = unknown>(obj: any, path: string): T | undefined {
  if (!obj || !path) return undefined;
  const segments = path.split('.').map((s) => s.trim()).filter(Boolean);
  let current: any = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    current = current[seg];
  }
  return current as T | undefined;
}


