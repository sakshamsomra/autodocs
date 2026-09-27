import { extname, posix } from "node:path";
import type { SourceFile } from "./project.js";
import type { SourceDependency, SourceInsight } from "./types.js";
import { languageExtensions, sourceText } from "./source-text.js";
import type { SourceText } from "./source-text.js";
import { inspectPython, resolvePythonImport } from "./python.js";
import { inspectJavaScript } from "./javascript.js";
import { frameworkService } from "./routes.js";
import { expressService, prismaModels, sequelizeAnalysis, sqlSchema } from "./syntax.js";
import { storageInsight } from "./storage.js";

export interface AdapterContext { files: SourceFile[]; text: SourceText }
export interface SourceAdapter {
  id: string;
  supports(file: SourceFile): boolean;
  inspect(file: SourceFile, context: AdapterContext): Partial<SourceInsight>;
}

const javascript = /\.[cm]?[jt]sx?$/i;
const unique = (values: string[]) => [...new Set(values)];

/** Shared by Markdown generation and terminal explanations. Custom adapters extend these facts. */
export function inspectSources(files: SourceFile[], adapters: SourceAdapter[] = []): SourceInsight[] {
  const texts = new Map(files.map(file => [file.path, sourceText(file)]));
  const namespaces = new Map<string, string[]>();
  for (const file of files) {
    const code = texts.get(file.path)!.code;
    const namespace = code.match(/\b(?:package|namespace)\s+([\w.\\]+)/)?.[1]?.replace(/\\/g, ".");
    if (!namespace) continue;
    const names = [namespace, ...[...code.matchAll(/\b(?:class|interface|struct|enum|record)\s+(\w+)/g)].map(match => `${namespace}.${match[1]}`)];
    for (const name of names) namespaces.set(name, [...(namespaces.get(name) ?? []), file.path]);
  }
  return files.map(file => {
    const text = texts.get(file.path)!;
    const extension = extname(file.path).slice(1).toLowerCase();
    const metadata = /^(?:md|json|yaml|yml|xml|toml|csproj|fsproj|txt)$/.test(extension) || /(?:^|\/)(?:go\.mod|Gemfile|Dockerfile|Makefile)$/i.test(file.path);
    let result: SourceInsight = {
      file: file.path, language: languageExtensions[extension] ?? `Source (${extension || "text"})`,
      adapter: "generic", coverage: "generic", name: posix.basename(file.path, extname(file.path)),
      purpose: "", declarations: [], operations: [], dependencies: [], calls: [], externalCalls: [], integrations: [],
      configuration: [], databases: [], tables: [], models: [], relations: [], endpoints: [], serviceNames: [], sections: [], notes: [],
      ...(metadata ? { adapter: "metadata", coverage: "metadata" as const } : genericInsight(file, text)),
    };
    if (javascript.test(file.path)) {
      result = { ...result, ...inspectJavaScript(file), adapter: "javascript-typescript", coverage: "structured" };
      const schemas = sequelizeAnalysis(file.source, file.path);
      result.models = schemas.models; result.relations = schemas.relations;
      const service = expressService(file.source, file.path);
      result.endpoints.push(...(service?.methods.filter(method => /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL) /.test(method)) ?? []));
    } else if (extension === "py") {
      const python = inspectPython(file);
      const dependencies = new Map<string, SourceDependency>();
      for (const item of python.imports) {
        const dep = dependencies.get(item.module) ?? { module: item.module, names: [], display: item.module, targets: [] };
        if (item.name) dep.names.push(`${item.name}${item.alias !== item.name ? ` as ${item.alias}` : ""}`);
        const target = resolvePythonImport(file.path, item, files);
        if (target) dep.targets.push(target.path);
        dependencies.set(item.module, dep);
      }
      for (const dep of dependencies.values()) dep.display = `${dep.module}${dep.names.length ? ` (${dep.names.join(", ")})` : ""}`;
      result = { ...result, name: python.title, purpose: python.purpose, adapter: "python", coverage: "heuristic",
        declarations: python.classes, operations: python.operations, dependencies: [...dependencies.values()],
        externalCalls: python.externalCalls, integrations: python.integrations, configuration: python.configuration, tables: python.tables,
        sections: [{ title: "CALLS BY OPERATION", items: python.callsByOperation }, { title: "INSTANCES", items: python.instances }], notes: python.notes };
    } else if (extension === "prisma" || extension === "sql") {
      const schemas = extension === "prisma" ? prismaModels(file.source) : sqlSchema(file.source);
      result = { ...result, adapter: extension, coverage: "heuristic", models: schemas.models, relations: schemas.relations,
        purpose: `Declares ${schemas.models.length} data models in ${result.language}.`, declarations: schemas.models.map(model => model.name) };
    }
    result.endpoints.push(...(frameworkService(file.source, file.path)?.methods ?? []));
    for (const dependency of result.dependencies) {
      if (!dependency.targets.length && extension !== "py") dependency.targets = resolveDependency(file.path, dependency.module, files, namespaces);
    }
    const storage = storageInsight(file, metadata ? { code: "", literals: [], comments: [] } : text, result.dependencies.map(item => item.module));
    result.tables = unique([...result.tables, ...storage.tables]);
    result.databases = storage.databases;
    for (const model of storage.models) if (!result.models.some(item => item.name === model.name)) result.models.push(model);
    result.relations.push(...storage.relations);
    for (const adapter of adapters.filter(adapter => adapter.supports(file))) result = { ...result, ...adapter.inspect(file, { files, text }), adapter: adapter.id };
    result.endpoints = unique(result.endpoints);
    result.tables = unique([...result.tables, ...(extension === "sql" ? result.models.map(model => model.name) : [])]);
    result.serviceNames = unique([...result.serviceNames, ...result.declarations.filter(name => /Service$/.test(name))]);
    if (!result.serviceNames.length && /(?:^|\/)services?\//i.test(file.path) && result.operations.length) result.serviceNames.push(result.name);
    if (!result.purpose) result.purpose = result.declarations.length ? `Defines ${result.declarations.join(", ")}.` : result.operations.length ? `Contains operations in ${result.language}.` : `${result.language} file; no documented purpose or recognizable declarations found.`;
    return result;
  });
}

function genericInsight(file: SourceFile, text: SourceText): Partial<SourceInsight> {
  const { code, literals, comments } = text;
  const extension = extname(file.path).slice(1).toLowerCase();
  const declarations = unique([...code.matchAll(/\b(?:class|interface|record|struct|enum|trait|object|protocol|actor|module|defmodule)\s+([\w.]+)|\btype\s+(\w+)\s+(?:struct|interface)/g)].map(match => match[1] ?? match[2]));
  const operations = new Set<string>();
  const operationPatterns = [
    /\b(?:async\s+)?(?:function|fun|fn|defp?|func|sub)\s+(?:\([^\n)]*\)\s*)?([A-Za-z_][\w.:]*)\s*(\([^\n{;]*?\))[^\n{;]*/g,
    /\b(?:public|protected|private|internal)\s+(?:(?:static|async|virtual|override|final|suspend)\s+)*(?:[\w<>?,\[\].]+\s+)?([A-Za-z_]\w*)\s*(\([^\n{;]*?\))[^\n{;]*/g,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(\([^\n]*?\))\s*=>/gm,
    /^\s*\(defn\s+([\w!?-]+)\s*(\[[^\n\]]*\])/gm,
    /^\s*def\s+([\w!?]+)([ \t]*[^\n(]*)$/gm,
    /^[ \t]*(?:[\w*:&<>]+[ \t]+)+([A-Za-z_]\w*)[ \t]*(\([^\n]*?\))[ \t]*(?:const[ \t]*)?\{/gm,
    /^[ \t]*(\w+)[ \t]*<-[ \t]*function[ \t]*(\([^\n)]*\))/gm,
  ];
  for (const pattern of operationPatterns) for (const match of code.matchAll(pattern)) {
    const description = comments.filter(comment => comment.end <= match.index! && !code.slice(comment.end, match.index).trim()).at(-1)?.value;
    operations.add(`${match[1]}${match[2].replace(/\s+/g, " ")}${description ? ` — ${description.replace(/\s+/g, " ").slice(0, 250)}` : ""}`);
  }
  const dependencies: SourceDependency[] = [];
  const configuration = new Set<string>();
  const addImport = (module: string, names: string[] = []) => {
    if (module && !dependencies.some(item => item.module === module)) dependencies.push({ module, names, display: names.length ? `${module} (${names.join(", ")})` : module, targets: [] });
  };
  for (const match of code.matchAll(/^\s*(?:import(?:\s+static)?|using|use|alias|require|open)\s+([A-Za-z_][\w.\\:/{}*, ]*)[;\n]/gm)) {
    const module = match[1].trim().replace(/\s+(?:as|=>)\s+.*$/, "").replace(/\s*\{.*$/, "").replace(/[.*:]+$/, "");
    if (!/^(?:var|static)\s/.test(module)) addImport(module);
  }
  for (const literal of literals) {
    const prefix = code.slice(Math.max(0, literal.start - 160), literal.start);
    const after = code.slice(literal.end, literal.end + 50);
    if (/(?:\b(?:import|from|require(?:_relative)?|include(?:_once)?|require_once)|#\s*include)\s*\(?\s*$/.test(prefix) || /\bimport\s+[\w{}, *]+\s+from\s*$/.test(prefix) || /\bimport\s*\([^)]*$/.test(prefix) || extension === "go" && /\bimport\s+\w+\s*$/.test(prefix)) addImport(literal.value);
    if (/\b(?:getenv|Getenv|env|GetEnvironmentVariable|getProperty)\s*\(\s*$/.test(prefix) && /^[A-Za-z_]\w*$/.test(literal.value)) configuration.add(`Environment: ${literal.value}`);
    if (extension === "dart" && /\bimport\s*$/.test(prefix) && /^\s*;/.test(after)) addImport(literal.value);
  }
  for (const match of code.matchAll(/^\s*#\s*include\s*<([^>]+)>/gm)) addImport(match[1]);
  const calls = unique([...code.matchAll(/\b([A-Za-z_]\w*(?:(?:\.|::|->)[A-Za-z_]\w*)+)\s*\(/g)].map(match => match[1]).filter(call => !call.startsWith("self.") && !call.startsWith("this.")));
  const firstDeclaration = code.search(/\b(?:class|function|func|def|fn|public|interface|struct)\b/);
  const purpose = comments.find(comment => comment.value && !/copyright|license|^!/i.test(comment.value) && (firstDeclaration < 0 || comment.start < firstDeclaration))?.value.replace(/\s+/g, " ").slice(0, 500) ?? "";
  const notes = languageExtensions[extension] ? ["Syntax-based extraction; dynamic imports, reflection and runtime behavior may need review."] : ["Generic source fallback: declarations, imports and calls are best-effort; no dedicated language adapter is installed."];
  return { name: declarations[0] ?? posix.basename(file.path, extname(file.path)), purpose, declarations, operations: [...operations], dependencies, calls, configuration: [...configuration],
    adapter: languageExtensions[extension] ? "common-syntax" : "generic", coverage: languageExtensions[extension] ? "heuristic" : "generic", notes };
}

function resolveDependency(importer: string, module: string, files: SourceFile[], namespaces: Map<string, string[]>): string[] {
  const candidates = new Set<string>();
  const pathModule = module.replace(/\\/g, "/").replace(/::/g, "/");
  if (module.startsWith(".")) candidates.add(posix.normalize(posix.join(posix.dirname(importer), pathModule)));
  else {
    candidates.add(pathModule); candidates.add(module.replace(/\./g, "/"));
    candidates.add(posix.join(posix.dirname(importer), pathModule));
    if (/^(?:crate|self|super)::/.test(module)) candidates.add(posix.join(module.startsWith("crate::") ? "src" : posix.dirname(importer), pathModule.replace(/^(?:crate|self|super)\//, "")));
    const goModule = files.find(file => file.path === "go.mod")?.source.match(/^module\s+(\S+)/m)?.[1];
    if (goModule && module.startsWith(goModule + "/")) candidates.add(module.slice(goModule.length + 1));
  }
  const bare = (path: string) => path.replace(/\.[cm]?[jt]sx?$|\.(?:php|java|kt|cs|go|rb|rs|dart|swift|scala|ex|exs|h|hpp)$/i, "");
  const direct = files.filter(file => [...candidates].some(candidate => bare(file.path) === bare(candidate) || bare(file.path) === `${bare(candidate)}/index` || bare(file.path) === `${bare(candidate)}/mod`));
  if (direct.length) return direct.map(file => file.path);
  if (importer.endsWith(".go")) {
    const packages = files.filter(file => file.path.endsWith(".go") && candidates.has(posix.dirname(file.path)));
    if (packages.length) return packages.map(file => file.path);
  }
  return namespaces.get(module.replace(/\\/g, ".")) ?? [];
}
