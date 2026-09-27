import { lstat, readFile } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { analyzeSources } from "./analyzer.js";
import { discover } from "./project.js";
import { inspectSources } from "./inspection.js";
import type { SourceAdapter } from "./inspection.js";
import { sourceCandidate, isTextSource } from "./source-text.js";
import type { SourceInsight } from "./types.js";

export async function explainProject(root: string, adapters: SourceAdapter[] = []): Promise<string> {
  const discovery = await discover(root);
  const analysis = analyzeSources(root, discovery.files, discovery.excluded, discovery.warnings, adapters);
  const sources = analysis.sources!;
  const endpoints = new Set(sources.flatMap(source => source.endpoints));
  const services = new Set(sources.flatMap(source => source.serviceNames.map(name => source.file + ":" + name)));
  const integrations = new Set(sources.flatMap(source => source.integrations));
  const databases = [...new Set(sources.flatMap(source => source.databases))];
  const modules = sources.flatMap(source => source.dependencies.map(dependency => dependency.module));
  const lines = [analysis.project!.description || analysis.project!.name, "", "Detected in the scanned source:",
    "• " + endpoints.size + " API endpoints", "• " + new Set(analysis.models.map(model => model.name)).size + " database models",
    "• " + services.size + " services", "• " + integrations.size + " external integrations"];
  if (modules.some(module => /(?:^|[./])(?:jsonwebtoken|jose|jwt)(?:$|[./])/.test(module))) lines.push("• JWT authentication code");
  lines.push(...databases.map(database => "• " + database + " driver or dialect"));
  const layers: string[] = [];
  if (endpoints.size) layers.push("Client", (["Express", "NestJS", "FastAPI", "Flask", "Laravel", "Spring", "Next.js"].find(name => analysis.project!.stack.some(item => item.name === name)) ?? "API") + " routes");
  if (sources.some(source => source.declarations.some(name => /Controller$/.test(name)))) layers.push("Controllers");
  if (services.size) layers.push("Services");
  if (analysis.models.length) layers.push(modules.includes("sequelize") ? "Sequelize models" : "Data models");
  if (databases.length) layers.push(databases.join(" / "));
  lines.push("", "Application layers (inferred from declarations and dependencies):", layers.length > 1 ? layers.join("\n  ↓\n") : "Not enough evidence to outline a flow.");
  const generic = sources.filter(source => source.coverage === "generic");
  if (generic.length) lines.push("", "Generic source fallback used for: " + generic.slice(0, 10).map(source => source.file).join(", ") + (generic.length > 10 ? " (+" + (generic.length - 10) + " more)" : "") + ".");
  lines.push("", "Counts cover statically detected declarations and literal routes; runtime-generated behavior may be missing.");
  return lines.join("\n") + "\n";
}

export async function explainFile(filePath: string, root: string, adapters: SourceAdapter[] = []): Promise<string> {
  if (!sourceCandidate(filePath)) throw new Error("Cannot explain " + filePath + ": expected a source file, not a data, generated or secret file.");
  const info = await lstat(filePath);
  if (!info.isFile() || info.size > 1_000_000) throw new Error("Cannot explain " + filePath + ": expected a regular source file under 1 MB.");
  const source = await readFile(filePath, "utf8");
  if (!isTextSource(source)) throw new Error("Cannot explain " + filePath + ": binary or unsupported text encoding.");
  const path = relative(root, filePath).split(sep).join("/");
  const discovery = await discover(root);
  const sources = inspectSources([...discovery.files.filter(item => item.path !== path), { path, source }], adapters);
  return sourceExplanation(sources.find(item => item.file === path)!, sources);
}

export function sourceExplanation(source: SourceInsight, sources: SourceInsight[]): string {
  const usedBy = sources.filter(item => item.file !== source.file && item.dependencies.some(dependency => dependency.targets.includes(source.file)))
    .map(item => /\.[cm]?[jt]sx?$/.test(item.file) ? item.name : item.file);
  const dependencies = [...source.dependencies].sort((a, b) => Number(b.targets.length > 0 || b.module.startsWith(".")) - Number(a.targets.length > 0 || a.module.startsWith("."))).map(item => item.display);
  const tables = [...source.tables];
  for (const dependency of source.dependencies) for (const target of dependency.targets) {
    const found = sources.find(item => item.file === target);
    if (found) tables.push(...found.tables.map(table => table + " (via " + target + ")"));
  }
  const sections = [source.name, "PURPOSE\n" + source.purpose];
  const section = (title: string, values: string[], fallback?: string) => {
    if (values.length || fallback) sections.push(title + "\n" + (values.length ? [...new Set(values)].map(value => "• " + value).join("\n") : fallback));
  };
  section("OPERATIONS", source.operations);
  section("ENDPOINTS", source.endpoints);
  section("USED BY", usedBy, "No local imports found in the scanned project.");
  section("DEPENDS ON", dependencies, "No direct imports found.");
  section("DATA MODELS", source.models.map(model => model.name + (model.fields.length ? " (" + model.fields.map(field => field.name + ": " + field.type).join(", ") + ")" : " (fields not statically resolved)")));
  section("DATABASE", tables, extname(source.file) === ".py" ? "No SQL or table declarations detected in this file or its direct local imports." : "No direct or one-hop table references detected.");
  section("PERSISTENCE", source.databases.map(database => database + " driver or provider detected"));
  section("EXTERNAL CALLS", source.externalCalls, "No recognized external SDK calls detected.");
  section("OBSERVED CALLS", source.calls.slice(0, 30));
  for (const extra of source.sections) section(extra.title, extra.items);
  section("CONFIGURATION", source.configuration);
  section("ANALYSIS NOTES", [source.language + ": " + source.coverage + " analysis (" + source.adapter + ").", ...source.notes]);
  return sections.join("\n\n") + "\n";
}
