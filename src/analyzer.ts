import { extname, basename } from "node:path";
import ts from "typescript";
import { discover, projectOverview } from "./project.js";
import type { Analysis, Field, Model, Relation, Service } from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

function prismaModels(source: string): { models: Model[]; relations: Relation[] } {
  const models: Model[] = []; const relations: Relation[] = [];
  for (const match of source.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
    const [, name, body] = match; const fields: Field[] = [];
    for (const line of body.split("\n")) {
      const field = line.trim().match(/^(\w+)\s+([\w\[\]?]+)(.*)$/);
      if (!field || field[1].startsWith("@@")) continue;
      const [, fieldName, type, attrs] = field;
      fields.push({ name: fieldName, type: type.replace(/[?\[\]]/g, ""), primary: attrs.includes("@id"), optional: type.includes("?") });
      const related = type.replace(/[?\[\]]/g, "");
      if (/^[A-Z]/.test(related) && related !== name && !["String", "Int", "Boolean", "DateTime", "Float", "Decimal", "Json", "Bytes"].includes(related)) relations.push({ from: name, to: related, label: fieldName });
    }
    models.push({ name, fields });
  }
  return { models, relations };
}

function sqlSchema(source: string): { models: Model[]; relations: Relation[] } {
  const models: Model[] = []; const relations: Relation[] = [];
  for (const match of source.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\"]?([\w]+)[`\"]?\s*\(([\s\S]*?)\)\s*;/gi)) {
    const [, name, body] = match; const fields: Field[] = [];
    for (const rawLine of splitSqlColumns(body)) {
      const line = rawLine.trim().replace(/,$/, "");
      const foreignKey = line.match(/FOREIGN\s+KEY\s*\(\s*[`\"]?(\w+)[`\"]?\s*\)\s*REFERENCES\s*[`\"]?(\w+)[`\"]?/i);
      if (foreignKey) { relations.push({ from: name, to: foreignKey[2], label: foreignKey[1] }); continue; }
      const field = line.match(/^[`\"]?(\w+)[`\"]?\s+([A-Z]+(?:\s*\([^)]*\))?)/i);
      if (!field || /^(CONSTRAINT|PRIMARY|UNIQUE|INDEX|KEY|FOREIGN)$/i.test(field[1])) continue;
      fields.push({ name: field[1], type: field[2].replace(/\s+/g, ""), primary: /\bPRIMARY\s+KEY\b/i.test(line), optional: !/\bNOT\s+NULL\b/i.test(line) });
    }
    models.push({ name, fields });
  }
  return { models, relations };
}

// Split only top-level commas, preserving DECIMAL precision and ENUM literals.
function splitSqlColumns(body: string): string[] {
  const parts: string[] = []; let start = 0; let depth = 0; let quote = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote && body[i + 1] === quote) i++;
      else if (char === quote) quote = "";
    } else if (["'", '"', "`"].includes(char)) quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start)); return parts;
}

function flaskService(source: string, file: string): Service | undefined {
  const methods = new Set<string>();
  // Flask decorators bind a route to the following function. This deliberately
  // reads only decorator syntax, avoiding generic text/function matches.
  const route = /@(?:\w+\.)?(?:route|get|post|put|patch|delete)\s*\(\s*(["'])(.*?)\1([\s\S]*?)\)\s*\n\s*def\s+\w+/g;
  for (const match of source.matchAll(route)) {
    const decorator = match[0]; const path = match[2];
    const explicit = [...decorator.matchAll(/["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']/gi)].map(item => item[1].toUpperCase());
    const shorthand = decorator.match(/@(?:\w+\.)?(get|post|put|patch|delete)\s*\(/i)?.[1]?.toUpperCase();
    for (const verb of explicit.length ? explicit : [shorthand ?? "GET"]) methods.add(`${verb} ${path}`);
  }
  return methods.size ? { name: basename(file, extname(file)), methods: [...methods] } : undefined;
}

function propertyName(node: ts.PropertyName | ts.MemberName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : undefined;
}

function expressionName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return undefined;
}

function stringValue(node: ts.Expression | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) if (ts.isPropertyAssignment(member) && propertyName(member.name) === name) return member.initializer;
  return undefined;
}

function dataType(value: ts.Expression | undefined): string {
  if (!value) return "unknown";
  if (ts.isPropertyAccessExpression(value)) return value.name.text;
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isCallExpression(value)) return dataType(value.expression);
  return "unknown";
}

function fieldsFromObject(node: ts.ObjectLiteralExpression): Field[] {
  const fields: Field[] = [];
  for (const member of node.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const name = propertyName(member.name); if (!name) continue;
    const options = ts.isObjectLiteralExpression(member.initializer) ? member.initializer : undefined;
    const primary = options && objectProperty(options, "primaryKey");
    const nullable = options && objectProperty(options, "allowNull");
    fields.push({ name, type: dataType(options ? objectProperty(options, "type") : member.initializer), primary: primary?.kind === ts.SyntaxKind.TrueKeyword, optional: nullable?.kind === ts.SyntaxKind.TrueKeyword });
  }
  return fields;
}

function sequelizeAnalysis(source: string, file: string): { models: Model[]; relations: Relation[] } {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, extname(file) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const models: Model[] = []; const relations: Relation[] = []; const classModels = new Set<string>();
  const addModel = (name: string, fields: Field[]) => { if (!models.some(model => model.name === name)) models.push({ name, fields }); };
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && node.heritageClauses?.some(c => c.token === ts.SyntaxKind.ExtendsKeyword && expressionName(c.types[0]?.expression) === "Model")) { classModels.add(node.name.text); addModel(node.name.text, []); }
    if (ts.isCallExpression(node)) {
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
      if (method === "define" && ts.isPropertyAccessExpression(node.expression) && expressionName(node.expression.expression) === "sequelize") { const name = stringValue(node.arguments[0]); const attrs = node.arguments[1]; if (name && attrs && ts.isObjectLiteralExpression(attrs)) addModel(name, fieldsFromObject(attrs)); }
      if (method === "init" && ts.isPropertyAccessExpression(node.expression)) { const name = expressionName(node.expression.expression); const attrs = node.arguments[0]; const model = name && models.find(item => item.name === name); if (name && classModels.has(name) && model && attrs && ts.isObjectLiteralExpression(attrs)) model.fields = fieldsFromObject(attrs); }
      if (method && ["hasMany", "hasOne", "belongsTo", "belongsToMany"].includes(method) && ts.isPropertyAccessExpression(node.expression)) { const from = expressionName(node.expression.expression); const to = expressionName(node.arguments[0]); if (from && to) relations.push({ from, to, label: method }); }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); return { models, relations };
}

function expressService(source: string, file: string): Service | undefined {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, extname(file) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const routers = new Set<string>(); const methods = new Set<string>(); let controller = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) { const factory = expressionName(node.initializer.expression); if (factory === "Router" || factory === "express") routers.add(node.name.text); }
    if (ts.isClassDeclaration(node) && node.name && /(?:Service|Controller)$/i.test(node.name.text)) { controller = true; for (const member of node.members) if (ts.isMethodDeclaration(member) && !member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) { const name = member.name && propertyName(member.name); if (name && name !== "constructor") methods.add(name); } }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) { const target = node.expression.expression; const verb = node.expression.name.text.toLowerCase(); if (ts.isIdentifier(target) && routers.has(target.text) && HTTP_METHODS.has(verb)) methods.add(`${verb.toUpperCase()} ${stringValue(node.arguments[0]) ?? "<dynamic>"}`); }
    ts.forEachChild(node, visit);
  };
  visit(ast); return methods.size || controller ? { name: basename(file, extname(file)), methods: [...methods] } : undefined;
}

export async function analyze(root: string): Promise<Analysis> {
  const discovery = await discover(root);
  const files = discovery.files; const models: Model[] = []; const relations: Relation[] = []; const services: Service[] = [];
  for (const { path: file, source } of files) {
    if (extname(file) === ".prisma") { const found = prismaModels(source); models.push(...found.models); relations.push(...found.relations); }
    else if (extname(file) === ".sql") { const found = sqlSchema(source); models.push(...found.models); relations.push(...found.relations); }
    else if (extname(file) === ".py") { const service = flaskService(source, file); if (service) services.push(service); }
    else if ([".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs"].includes(extname(file))) { const found = sequelizeAnalysis(source, file); models.push(...found.models); relations.push(...found.relations); const service = expressService(source, file); if (service) services.push(service); }
  }
  const uniqueModels = [...new Map(models.map(m => [JSON.stringify(m), m])).values()];
  const uniqueRelations = [...new Map(relations.filter(r => models.some(m => m.name === r.from) && models.some(m => m.name === r.to)).map(r => [JSON.stringify(r), r])).values()];
  return { models: uniqueModels, relations: uniqueRelations, services, scannedFiles: files.length, project: projectOverview(root, files, discovery.excluded, discovery.warnings) };
}
