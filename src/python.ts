import { posix } from "node:path";
import type { SourceFile } from "./project.js";
import { sqlTables } from "./sql.js";

interface Literal { start: number; end: number; value: string; prefix: string }
interface PythonImport { module: string; name?: string; alias: string }
interface Declaration { name: string; kind: "class" | "function"; start: number; headerEnd: number; end: number; indent: number; doc: string; signature: string }
interface Call { chain: string; start: number; open: number; end: number; operation?: string }
export interface PythonInsight {
  title: string;
  purpose: string;
  classes: string[];
  imports: PythonImport[];
  operations: string[];
  callsByOperation: string[];
  externalCalls: string[];
  integrations: string[];
  configuration: string[];
  instances: string[];
  tables: string[];
  notes: string[];
}

/** A tolerant static scanner. It never imports or executes the analyzed Python. */
export function inspectPython(file: SourceFile): PythonInsight {
  const { code, literals } = maskPython(file.source);
  const imports = pythonImports(code);
  const declarations = pythonDeclarations(code, literals);
  const classes = declarations.filter(item => item.kind === "class");
  const functions = declarations.filter(item => item.kind === "function");
  const unindented = functions.filter(fn => classes.some(item => item.start < fn.start && fn.indent <= item.indent) && /^\s*self\b/.test(fn.signature.slice(fn.signature.indexOf("(") + 1)));
  // Pasted snippets sometimes lose indentation. Keep their declarations useful,
  // but explicitly flag that method ownership and nesting cannot be established.
  for (const fn of unindented) fn.end = declarations.find(item => item.start > fn.start)?.start ?? code.length;
  const title = classes[0]?.name ?? posix.basename(file.path, ".py");
  const firstCode = code.search(/\S/);
  const moduleDoc = literals.find(item => item.start < (firstCode < 0 ? code.length : firstCode) && !/[fb]/i.test(item.prefix));
  const purpose = classes[0]?.doc || (moduleDoc ? docSummary(moduleDoc.value) : "") ||
    `Defines ${classes.length ? classes.map(item => item.name).join(", ") : functions.length ? functions.map(item => item.name).join(", ") : `Python module ${file.path}`}.`;
  const bindings = new Map(imports.map(item => [item.alias, item.name ? `${item.module}.${item.name}`.replace(/^\./, "") : item.alias === item.module.split(".")[0] ? item.alias : item.module]));
  const calls = pythonCalls(code, functions);
  // Follow simple client assignments, including self.client and aliases of clients.
  for (let pass = 0; pass < 3; pass++) {
    for (const match of code.matchAll(/\b((?:self\.)?\w+)\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?=\(|\n|$)/g)) {
      const resolved = resolveBinding(match[2], bindings);
      if (resolved) bindings.set(match[1], resolved);
    }
  }
  const externalCalls: string[] = [];
  const integrations = new Set<string>();
  const operationCalls = new Map<string, Set<string>>();
  for (const call of calls) {
    const resolved = resolveBinding(call.chain, bindings);
    const provider = resolved && providerName(resolved);
    const isExternal = provider && isNetworkOperation(resolved!);
    if (provider) integrations.add(provider);
    if (isExternal) externalCalls.push(`${provider}: ${call.chain}${call.operation ? ` (in ${call.operation})` : ""}`);
    const localMethod = call.chain.match(/^self\.(\w+)$/)?.[1];
    if (call.operation && (isExternal || localMethod && functions.some(fn => fn.name === localMethod))) {
      const labels = operationCalls.get(call.operation) ?? new Set<string>();
      labels.add(isExternal ? `${provider}: ${call.chain.replace(/^self\./, "")}` : localMethod!);
      operationCalls.set(call.operation, labels);
    }
  }
  const configuration = new Set<string>();
  for (const match of code.matchAll(/\b(?:settings|config)\.[A-Za-z_]\w*/g)) configuration.add(match[0]);
  for (const literal of literals) {
    const prefix = code.slice(code.lastIndexOf("\n", literal.start - 1) + 1, literal.start);
    const model = prefix.match(/\b((?:self\.)?(?:chat_model|embedding_model|model_name|model))\s*=\s*$/);
    if (model && /^[\w./:-]{1,120}$/.test(literal.value)) configuration.add(`${model[1]} = ${literal.value}`);
  }
  for (const call of calls.filter(item => /(?:^|\.)(?:getenv|environ\.get)$/.test(item.chain))) {
    const literal = literals.find(item => item.start > call.open && item.end <= call.end);
    if (literal && /^[A-Za-z_]\w*$/.test(literal.value)) configuration.add(`Environment: ${literal.value}`);
  }
  const tables = new Set<string>();
  const assigned = new Map<string, Literal>();
  for (const literal of literals) {
    const prefix = code.slice(code.lastIndexOf("\n", literal.start - 1) + 1, literal.start);
    const assignment = prefix.match(/^\s*(\w+)\s*=\s*$/);
    if (assignment) assigned.set(assignment[1], literal);
    if (/\b(?:__tablename__|db_table)\s*=\s*$/.test(prefix) && /^[A-Za-z_]\w*$/.test(literal.value)) tables.add(literal.value);
  }
  for (const call of calls) {
    if (/(?:^|\.)(?:execute|executemany|executescript|query|raw)$/.test(call.chain)) {
      const argument = code.slice(call.open + 1, call.end);
      const firstArgumentEnd = argument.indexOf(",") < 0 ? call.end : call.open + 1 + argument.indexOf(",");
      const literal = literals.find(item => item.start > call.open && item.start < firstArgumentEnd);
      const variable = argument.trim().match(/^(\w+)\s*[,)]?/)?.[1];
      const sql = literal ?? (variable ? assigned.get(variable) : undefined);
      if (sql) sqlTables(sql.value).forEach(table => tables.add(table));
    }
    const resolved = resolveBinding(call.chain, bindings);
    if (resolved === "sqlalchemy.Table") {
      const literal = literals.find(item => item.start > call.open && item.end <= call.end);
      if (literal && /^\w+$/.test(literal.value)) tables.add(literal.value);
    }
  }
  const instances = [...code.matchAll(/^([A-Za-z_]\w*)\s*=\s*(\w+)\s*\(/gm)]
    .filter(match => classes.some(item => item.name === match[2]))
    .map(match => `${match[1]} = ${match[2]}()`);
  return {
    title, purpose, classes: classes.map(item => item.name), imports,
    operations: functions.filter(item => item.name !== "__init__").sort((a, b) => Number(a.name.startsWith("_")) - Number(b.name.startsWith("_"))).map(item => `${displaySignature(item.signature)}${item.doc ? ` — ${item.doc}` : ""}`),
    callsByOperation: [...operationCalls].filter(([name]) => name !== "__init__").map(([name, labels]) => `${name}: ${[...labels].join("; ")}`),
    externalCalls: [...new Set(externalCalls)], integrations: [...integrations],
    configuration: [...configuration], instances, tables: [...tables],
    notes: unindented.length ? ["Indentation appears incomplete; declarations are listed without assuming class ownership."] : [],
  };
}

export function pythonExplanation(target: SourceFile, files: SourceFile[]): string {
  const insight = inspectPython(target);
  const allFiles = [...files, target];
  const parsed = new Map(files.filter(item => item.path.endsWith(".py")).map(item => [item.path, inspectPython(item)]));
  const usedBy = files.filter(item => parsed.get(item.path)?.imports.some(imported =>
    resolvePythonImport(item.path, imported, allFiles)?.path === target.path)).map(item => item.path);
  const dependencyGroups = new Map<string, string[]>();
  for (const item of insight.imports) {
    const names = dependencyGroups.get(item.module) ?? [];
    if (item.name) names.push(`${item.name}${item.alias !== item.name ? ` as ${item.alias}` : ""}`);
    else if (item.alias !== item.module.split(".")[0]) names.push(`as ${item.alias}`);
    dependencyGroups.set(item.module, names);
  }
  const dependencies = [...dependencyGroups].map(([module, names]) => `${module}${names.length ? ` (${names.join(", ")})` : ""}`);
  const tables = [...insight.tables];
  for (const imported of insight.imports) {
    const local = resolvePythonImport(target.path, imported, files);
    if (local) for (const table of parsed.get(local.path)?.tables ?? []) tables.push(`${table} (via ${local.path})`);
  }
  const sections = [insight.title, `PURPOSE\n${insight.purpose}`];
  const section = (title: string, values: string[], fallback?: string) => {
    if (values.length || fallback) sections.push(`${title}\n${values.length ? [...new Set(values)].map(value => `• ${value}`).join("\n") : fallback}`);
  };
  section("OPERATIONS", insight.operations);
  section("USED BY", usedBy, "No static Python importers found in the scanned project.");
  section("DEPENDS ON", dependencies, "No Python imports found.");
  section("EXTERNAL CALLS", insight.externalCalls, "No recognized external API calls detected.");
  section("CALLS BY OPERATION", insight.callsByOperation);
  section("CONFIGURATION", insight.configuration);
  section("INSTANCES", insight.instances);
  section("DATABASE", tables, "No SQL or table declarations detected in this file or its direct local imports.");
  section("ANALYSIS NOTES", insight.notes);
  return `${sections.join("\n\n")}\n`;
}

export function resolvePythonImport(importer: string, imported: PythonImport, files: SourceFile[]): SourceFile | undefined {
  const dots = imported.module.match(/^\.+/)?.[0].length ?? 0;
  const module = imported.module.slice(dots).replace(/\./g, "/");
  const bases: string[] = [];
  if (dots) {
    let directory = posix.dirname(importer);
    for (let i = 1; i < dots; i++) directory = posix.dirname(directory);
    bases.push(posix.join(directory, module));
  } else {
    bases.push(module);
    // Python applications often put a nested backend directory on sys.path.
    let directory = posix.dirname(importer);
    while (directory !== ".") { bases.push(posix.join(directory, module)); directory = posix.dirname(directory); }
  }
  for (const base of [...new Set(bases)]) {
    const candidates = imported.name ? [`${base}/${imported.name}.py`, `${base}/${imported.name}/__init__.py`, `${base}.py`, `${base}/__init__.py`] : [`${base}.py`, `${base}/__init__.py`];
    for (const candidate of candidates) {
      const found = files.find(file => file.path === posix.normalize(candidate));
      if (found) return found;
    }
  }
  return undefined;
}

function pythonImports(code: string): PythonImport[] {
  const imports: PythonImport[] = [];
  for (const match of code.matchAll(/^[ \t]*(?:from\s+([.\w]+)\s+import\s+|import\s+)([^\n]*(?:\\\n[^\n]*)?)/gm)) {
    let clause = match[2];
    if (clause.includes("(")) {
      const opening = match.index! + match[0].indexOf("(");
      clause = code.slice(opening + 1, closing(code, opening));
    }
    for (const part of clause.replace(/[()\\\n]/g, " ").split(",")) {
      const name = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
      if (!name) continue;
      if (match[1]) imports.push({ module: match[1], name: name[1], alias: name[2] ?? name[1] });
      else imports.push({ module: name[1], alias: name[2] ?? name[1].split(".")[0] });
    }
  }
  return imports;
}

function pythonDeclarations(code: string, literals: Literal[]): Declaration[] {
  const declarations: Declaration[] = [];
  for (const match of code.matchAll(/^([ \t]*)(?:async\s+)?(class|def)\s+(\w+)\s*(?=[(:])/gm)) {
    const start = match.index!;
    let offset = start + match[0].length;
    if (code[offset] === "(") offset = closing(code, offset) + 1;
    const colon = code.indexOf(":", offset);
    if (colon < 0) continue;
    const indent = match[1].replace(/\t/g, "    ").length;
    let end = code.length;
    for (const line of code.slice(colon + 1).matchAll(/\n([ \t]*)(\S)/g)) {
      if (line[1].replace(/\t/g, "    ").length <= indent) { end = colon + 1 + line.index!; break; }
    }
    const literal = literals.find(item => item.start > colon && !code.slice(colon + 1, item.start).trim());
    const header = code.slice(start + match[1].length, colon).replace(/\s+/g, " ").replace(/^(?:async )?def /, "");
    declarations.push({ name: match[3], kind: match[2] === "class" ? "class" : "function", start, headerEnd: colon + 1, end, indent,
      doc: literal && !/[fb]/i.test(literal.prefix) ? docSummary(literal.value) : "",
      signature: header });
  }
  return declarations;
}

function pythonCalls(code: string, functions: Declaration[]): Call[] {
  const calls: Call[] = [];
  for (const match of code.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
    if (/\b(?:def|class)\s+$/.test(code.slice(Math.max(0, match.index! - 10), match.index))) continue;
    const operation = functions.filter(fn => fn.headerEnd <= match.index! && match.index! < fn.end).sort((a, b) => b.start - a.start)[0]?.name;
    const open = match.index! + match[0].lastIndexOf("(");
    calls.push({ chain: match[1], start: match.index!, open, end: closing(code, open), operation });
  }
  return calls;
}

function closing(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if ("([{".includes(code[i])) depth++;
    else if (")]}".includes(code[i]) && --depth === 0) return i;
  }
  return code.length;
}

function resolveBinding(chain: string, bindings: Map<string, string>): string | undefined {
  for (const [name, resolved] of [...bindings].sort(([a], [b]) => b.length - a.length)) {
    if (chain === name || chain.startsWith(`${name}.`)) return resolved + chain.slice(name.length);
  }
  return undefined;
}

function providerName(module: string): string | undefined {
  const providers: [RegExp, string][] = [
    [/^google\.(?:genai|generativeai)\b/, "Google Gemini"], [/^openai\b/, "OpenAI"],
    [/^anthropic\b/, "Anthropic"], [/^pinecone\b/, "Pinecone"], [/^boto3\b/, "AWS"],
    [/^stripe\b/, "Stripe"], [/^requests\b/, "HTTP (requests)"], [/^httpx\b/, "HTTP (httpx)"],
  ];
  return providers.find(([pattern]) => pattern.test(module))?.[1];
}

function isNetworkOperation(module: string): boolean {
  return /\.(?:generate_content|generate_content_stream|embed_content|chat\.completions\.create|responses\.create|messages\.create|payment_intents\.(?:create|retrieve|confirm)|query|upsert|fetch|delete|list_indexes|create_index|get|post|put|patch|request|invoke_model|send_message|upload_file|download_file|put_object|get_object)$/.test(module);
}

function docSummary(value: string): string {
  return value.trim().split(/\r?\n\s*\r?\n|\r?\n\s*(?:Args|Returns|Raises|Parameters|Examples):/)[0].replace(/\s+/g, " ").slice(0, 600);
}

function displaySignature(header: string): string {
  const open = header.indexOf("(");
  const end = closing(header, open);
  const params: string[] = [];
  let start = open + 1; let depth = 0;
  for (let i = start; i <= end; i++) {
    if (i === end || header[i] === "," && depth === 0) {
      const parameter = header.slice(start, i).trim().replace(/\s*=.*$/, " = ...");
      if (parameter && !/^(?:self|cls)\b/.test(parameter)) params.push(parameter);
      start = i + 1;
    } else if ("([{".includes(header[i])) depth++;
    else if (")]}".includes(header[i])) depth--;
  }
  return `${header.slice(0, open)}(${params.join(", ")})${header.slice(end + 1)}`;
}

function maskPython(source: string): { code: string; literals: Literal[] } {
  const chars = source.split("");
  const literals: Literal[] = [];
  const blank = (start: number, end: number) => { for (let i = start; i < end; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " "; };
  let i = 0;
  while (i < source.length) {
    if (source[i] === "#") {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? source.length : end); i = end < 0 ? source.length : end; continue;
    }
    const prefixed = !/[\w]/.test(source[i - 1] ?? "") ? source.slice(i).match(/^([rRuUbBfF]{1,2})(?=["'])/) : undefined;
    const prefix = prefixed?.[1] ?? "";
    const quoteStart = i + prefix.length;
    const quote = source[quoteStart];
    if (quote !== "'" && quote !== '"') { i++; continue; }
    const delimiter = source.slice(quoteStart, quoteStart + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
    const valueStart = quoteStart + delimiter.length;
    let end = valueStart;
    while (end < source.length) {
      if (source[end] === "\\") { end += 2; continue; }
      if (source.slice(end, end + delimiter.length) === delimiter) break;
      end++;
    }
    literals.push({ start: i, end: Math.min(source.length, end + delimiter.length), value: source.slice(valueStart, end), prefix });
    blank(i, Math.min(source.length, end + delimiter.length));
    i = end + delimiter.length;
  }
  return { code: chars.join(""), literals };
}
