import { lstat, readFile } from "node:fs/promises";
import { basename, extname, relative, sep } from "node:path";
import { posix } from "node:path";
import ts from "typescript";
import { analyzeSources } from "./analyzer.js";
import { discover } from "./project.js";
import type { SourceFile } from "./project.js";

const scriptExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const explainableExtensions = new Set([...scriptExtensions, ".sql", ".prisma", ".py", ".php", ".java", ".kt", ".cs", ".go", ".rb", ".rs"]);
const routePattern = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+\//;
const integrationPackages: [RegExp, string][] = [
  [/^stripe$/, "Stripe"], [/^(?:@aws-sdk\/|aws-sdk$)/, "AWS"], [/^twilio$/, "Twilio"],
  [/^(?:nodemailer|@sendgrid\/mail)$/, "Email provider"], [/^openai$/, "OpenAI"],
  [/^(?:firebase-admin|@google-cloud\/)/, "Google Cloud"], [/^@supabase\//, "Supabase"],
  [/^@sentry\//, "Sentry"], [/^@slack\/web-api$/, "Slack"],
];

interface ImportRef { module: string; names: string[] }

export async function explainProject(root: string): Promise<string> {
  const discovery = await discover(root);
  const files = discovery.files;
  const analysis = analyzeSources(root, files, discovery.excluded, discovery.warnings);
  const project = analysis.project!;
  const endpoints = new Set(analysis.services.flatMap(service => service.methods.filter(method => routePattern.test(method))));
  const services = new Set<string>();
  const integrations = new Set<string>();
  let jwt = false; let mysql = false; let sequelize = false;
  for (const file of files) {
    if (!scriptExtensions.has(extname(file.path))) continue;
    const source = parse(file);
    const declarations = classNames(source).filter(name => /Service$/.test(name));
    if (declarations.length) declarations.forEach(name => services.add(name));
    else if (/(?:^|\/)services?\//i.test(file.path)) services.add(file.path);
    const imports = importsOf(source);
    for (const imported of imports) {
      const integration = integrationName(imported.module);
      if (integration && usesImportedName(source, imported.names)) integrations.add(integration);
      if (/^(?:jsonwebtoken|jose)$/.test(imported.module) && usesImportedName(source, imported.names)) jwt = true;
      if (/^(?:mysql|mysql2)(?:\/|$)/.test(imported.module) && usesImportedName(source, imported.names)) mysql = true;
      if (imported.module === "sequelize" && usesImportedName(source, imported.names)) sequelize = true;
    }
    if (/\bdialect\s*:\s*["'`]mysql["'`]/.test(file.source)) mysql = true;
  }
  const databaseModels = new Set(analysis.models.map(model => model.name));
  const title = project.description || project.name;
  const lines = [title, "", "Detected in the scanned source:",
    `• ${endpoints.size} API endpoints`, `• ${databaseModels.size} database models`,
    `• ${services.size} services`, `• ${integrations.size} external integrations`];
  if (jwt) lines.push("• JWT authentication code");
  if (mysql) lines.push("• MySQL driver or dialect");
  const layers: string[] = [];
  if (endpoints.size) layers.push("Client", frameworkName(project.stack.map(item => item.name)) + " routes");
  if (files.some(file => /(?:^|\/)controllers?\//i.test(file.path) || /Controller\b/.test(file.source) && scriptExtensions.has(extname(file.path)))) layers.push("Controllers");
  if (services.size) layers.push("Services");
  if (sequelize && databaseModels.size) layers.push("Sequelize models");
  else if (databaseModels.size) layers.push("Data models");
  if (mysql) layers.push("MySQL");
  lines.push("", "Application layers (inferred from declarations and dependencies):");
  lines.push(layers.length > 1 ? layers.join("\n  ↓\n") : "Not enough evidence to outline a flow.");
  lines.push("", "Counts cover statically detected declarations and literal routes; runtime-generated behavior may be missing.");
  return `${lines.join("\n")}\n`;
}

export async function explainFile(filePath: string, root: string): Promise<string> {
  const extension = extname(filePath).toLowerCase();
  if (!explainableExtensions.has(extension)) throw new Error(`Cannot explain ${filePath}: unsupported file type ${extension || "(none)"}.`);
  const info = await lstat(filePath);
  if (!info.isFile() || info.size > 1_000_000) throw new Error(`Cannot explain ${filePath}: expected a regular source file under 1 MB.`);
  const path = relative(root, filePath).split(sep).join("/");
  const source = await readFile(filePath, "utf8");
  const discovery = await discover(root);
  const files = discovery.files.filter(item => item.path !== path);
  const target: SourceFile = { path, source };
  const parsed = scriptExtensions.has(extension) ? parse(target) : undefined;
  const names = parsed ? classNames(parsed) : [];
  const title = names[0] ?? basename(filePath, extension);
  const imports = parsed ? importsOf(parsed) : [];
  const localDependencies = imports.flatMap(item => item.module.startsWith(".") ? item.names.length ? item.names : [moduleLabel(item.module)] : []);
  const externalDependencies = imports.filter(item => !item.module.startsWith(".")).map(item => integrationName(item.module) ?? item.module);
  const dependencies = [...new Set([...localDependencies, ...externalDependencies])];
  const usedBy = [...new Set(files.filter(item => {
    if (!scriptExtensions.has(extname(item.path))) return false;
    return importsOf(parse(item)).some(imported => imported.module.startsWith(".") && resolvesTo(item.path, imported.module, path));
  }).map(item => classNames(parse(item))[0] ?? basename(item.path, extname(item.path))))];
  const tables = new Set(tableReferences(target));
  for (const imported of imports.filter(item => item.module.startsWith("."))) {
    const dependency = files.find(item => resolvesTo(path, imported.module, item.path));
    if (dependency) for (const table of tableReferences(dependency)) tables.add(table);
  }
  const calls = parsed ? externalCalls(parsed, imports) : [];
  const purpose = parsed ? purposeOf(parsed, names, path) : `Source file ${path}.`;
  const lines = [title, "", "PURPOSE", purpose, "", "USED BY", ...listOrUnknown(usedBy, "No local imports found."),
    "", "DEPENDS ON", ...listOrUnknown(dependencies, "No direct imports found."),
    "", "DATABASE", ...listOrUnknown([...tables], "No direct or one-hop table references detected."),
    "", "EXTERNAL CALLS", ...listOrUnknown(calls, "No recognized external SDK calls detected.")];
  return `${lines.join("\n")}\n`;
}

function parse(file: SourceFile): ts.SourceFile {
  const extension = extname(file.path).toLowerCase();
  const kind = extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : extension === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, kind);
}

function importsOf(source: ts.SourceFile): ImportRef[] {
  const imports: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.isTypeOnly) return;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) names.push(...clause.namedBindings.elements.filter(element => !element.isTypeOnly).map(element => element.name.text));
      imports.push({ module: node.moduleSpecifier.text, names });
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "require" && ts.isStringLiteral(node.initializer.arguments[0])) {
      const names = ts.isIdentifier(node.name) ? [node.name.text] : ts.isObjectBindingPattern(node.name) ? node.name.elements.map(element => element.name.getText(source)) : [];
      imports.push({ module: node.initializer.arguments[0].text, names });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function classNames(source: ts.SourceFile): string[] {
  return source.statements.filter(ts.isClassDeclaration).flatMap(node => node.name ? [node.name.text] : []);
}

function purposeOf(source: ts.SourceFile, classes: string[], path: string): string {
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === classes[0]);
  const comments = declaration ? ts.getLeadingCommentRanges(source.text, declaration.getFullStart()) ?? [] : [];
  const doc = comments.map(comment => source.text.slice(comment.pos, comment.end)).find(text => text.startsWith("/**"));
  if (doc) {
    const summary = doc.replace(/^\/\*\*|\*\/$/g, "").split(/\r?\n/).map(line => line.replace(/^\s*\*\s?/, "").trim()).filter(line => line && !line.startsWith("@"))[0];
    if (summary) return summary;
  }
  const methods = declaration && ts.isClassDeclaration(declaration) ? declaration.members.filter(ts.isMethodDeclaration).flatMap(member => ts.isIdentifier(member.name) ? [member.name.text] : []) : [];
  if (classes.length) return methods.length ? `Defines ${classes[0]} with methods ${methods.slice(0, 8).join(", ")}.` : `Defines ${classes[0]}.`;
  const functions = source.statements.filter(ts.isFunctionDeclaration).flatMap(node => node.name ? [node.name.text] : []);
  return functions.length ? `Defines functions ${functions.slice(0, 8).join(", ")}.` : `Source module ${path}; no purpose comment or named declaration found.`;
}

function resolvesTo(importer: string, module: string, target: string): boolean {
  const resolved = posix.normalize(posix.join(posix.dirname(importer), module));
  const bare = resolved.replace(/\.[cm]?[jt]sx?$/, "");
  const targetBare = target.replace(/\.[cm]?[jt]sx?$/, "");
  return target === resolved || targetBare === bare || targetBare === `${bare}/index`;
}

function tableReferences(file: SourceFile): string[] {
  const strings: string[] = [];
  if (scriptExtensions.has(extname(file.path))) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "define" && ts.isStringLiteral(node.arguments[0])) strings.push(`TABLE ${node.arguments[0].text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else strings.push(file.source);
  const tables = new Set<string>();
  for (const value of strings) {
    for (const match of value.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"]?([A-Za-z_]\w*)/gi)) tables.add(match[1]);
  }
  return [...tables];
}

function externalCalls(source: ts.SourceFile, imports: ImportRef[]): string[] {
  const names = new Map<string, string>();
  for (const imported of imports) {
    const integration = integrationName(imported.module);
    if (integration) for (const name of imported.names) names.set(name, integration);
  }
  const calls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
      const integration = names.get(node.initializer.expression.text);
      if (integration) names.set(node.name.text, integration);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const chain = node.expression.getText(source).split(".");
      const integration = names.get(chain[0]);
      if (integration && chain.length > 1) calls.add(integration === "Stripe" && chain[1] === "paymentIntents" ? "Stripe PaymentIntent API" : `${integration}: ${chain.slice(1).join(".")}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...calls];
}

function integrationName(module: string): string | undefined { return integrationPackages.find(([pattern]) => pattern.test(module))?.[1]; }
function moduleLabel(module: string): string { return basename(module).replace(/\.[cm]?[jt]sx?$/, ""); }
function listOrUnknown(values: string[], unknown: string): string[] { return values.length ? values.map(value => `• ${value}`) : [unknown]; }
function usesImportedName(source: ts.SourceFile, names: string[]): boolean {
  if (!names.length) return false;
  const wanted = new Set(names);
  let used = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || used) return;
    if (ts.isIdentifier(node) && wanted.has(node.text)) used = true;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return used;
}
function frameworkName(stack: string[]): string { return ["Express", "NestJS", "FastAPI", "Flask", "Laravel", "Spring", "Next.js"].find(name => stack.includes(name)) ?? "API"; }
