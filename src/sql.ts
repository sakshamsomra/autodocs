/** Accept SQL statements, never isolated English words such as "from" in prose. */
export function sqlTables(value: string): string[] {
  const sql = value.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(?:SELECT\b[\s\S]*?\bFROM\b|WITH\b[\s\S]*?\bSELECT\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*?\bSET\b|DELETE\s+FROM\b|(?:CREATE|ALTER|DROP)\s+TABLE\b)/i.test(sql)) return [];
  const identifiers = [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`\[]?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/gi)];
  return [...new Set(identifiers.map(match => match[1]))];
}
