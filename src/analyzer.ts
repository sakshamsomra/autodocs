import { basename, extname } from "node:path";
import { discover, projectOverview } from "./project.js";
import type { SourceFile } from "./project.js";
import type { Analysis, Service } from "./types.js";
import { inspectSources } from "./inspection.js";
import type { SourceAdapter } from "./inspection.js";
import { expressService } from "./syntax.js";

export async function analyze(root: string, adapters: SourceAdapter[] = []): Promise<Analysis> {
  const discovery = await discover(root);
  return analyzeSources(root, discovery.files, discovery.excluded, discovery.warnings, adapters);
}

/** One evidence model powers both generated documentation and explanations. */
export function analyzeSources(root: string, files: SourceFile[], excluded = 0, warnings: string[] = [], adapters: SourceAdapter[] = []): Analysis {
  const sources = inspectSources(files, adapters);
  const models = [...new Map(sources.flatMap(source => source.models).map(model => [JSON.stringify(model), model])).values()];
  const relations = [...new Map(sources.flatMap(source => source.relations).filter(relation => models.some(model => model.name === relation.from) && models.some(model => model.name === relation.to)).map(relation => [JSON.stringify(relation), relation])).values()];
  const services: Service[] = [];
  for (const source of sources) {
    const methods = [...source.endpoints];
    const file = files.find(file => file.path === source.file)!;
    if (/\.[cm]?[jt]sx?$/.test(source.file)) methods.push(...(expressService(file.source, file.path)?.methods ?? []));
    else if (source.serviceNames.length || source.declarations.some(name => /Controller$/.test(name))) methods.push(...source.operations.map(operation => operation.split("(")[0]));
    if (methods.length) services.push({ name: basename(source.file, extname(source.file)), methods: [...new Set(methods)] });
  }
  const project = projectOverview(root, files, excluded, warnings);
  for (const source of sources) {
    if (source.operations.length || source.declarations.length) project.components.push({ name: source.name, detail: source.purpose + (source.operations.length ? " Operations: " + source.operations.slice(0, 6).join("; ") + "." : ""), file: source.file });
    for (const dependency of source.dependencies) for (const target of dependency.targets) {
      project.connections.push({ name: source.file + " → " + target, detail: "Static import dependency; execution order is not established.", file: source.file });
    }
    for (const database of source.databases) if (!project.stack.some(item => item.name === database)) project.stack.push({ name: database, detail: "Database driver or provider declaration; a running database was not inspected.", file: source.file });
  }
  return { models, relations, services, scannedFiles: files.length, project, sources };
}
