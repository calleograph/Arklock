/**
 * Контекст шифрования (AAD). Части кодируются JSON-массивом, поэтому границы между ними однозначны:
 * идентификаторы ("a:b","c") и ("a","b:c") дают разные контексты. Тип объекта входит в начало строки.
 */
export function ctx(type: string, ...parts: (string | number)[]): string {
  return `${type}|${JSON.stringify(parts)}`;
}
