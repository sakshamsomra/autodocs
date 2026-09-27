import { extname, basename } from "node:path";
import ts from "typescript";
import type { SourceFile } from "./project.js";
import type { SourceText } from "./source-text.js";
import type { Field, Model, Relation } from "./types.js";
import { sqlTables } from "./sql.js";

const drivers: [RegExp, string][] = [
  [/(?:^|[./\\:_-])(?:pg|postgresql|postgres|psycopg\w*|asyncpg|npgsql|pq)(?:$|[./\\:_-])/i, "PostgreSQL"],
  [/(?:mysql\w*|pymysql)/i, "MySQL"], [/mariadb/i, "MariaDB"], [/sqlite|better-sqlite|rusqlite/i, "SQLite"],
  [/sqlclient|sqlserver|mssql|tedious/i, "SQL Server"], [/oracle|oracledb|ojdbc/i, "Oracle"],
  [/mongodb|mongoose|pymongo|mongoengine|mongo-driver/i, "MongoDB"], [/(?:^|[./\\_-])(?:ioredis|redis|jedis|lettuce)(?:$|[./\\_-])/i, "Redis"],
  [/elasticsearch|opensearch/i, "Elasticsearch / OpenSearch"], [/neo4j/i, "Neo4j"], [/cassandra|scylla/i, "Cassandra / ScyllaDB"],
  [/dynamodb/i, "DynamoDB"], [/pinecone/i, "Pinecone"], [/qdrant/i, "Qdrant"], [/weaviate/i, "Weaviate"], [/chromadb/i, "Chroma"],
  [/firestore/i, "Firestore"], [/couchdb|couchbase/i, "CouchDB / Couchbase"], [/supabase/i, "Supabase"],
];

/** Database families are inferred from driver/provider declarations, never field names. */
export function storageInsight(file: SourceFile, text: SourceText, modules: string[]): { databases: string[]; tables: string[]; models: Model[]; relations: Relation[] } {
  const databases = new Set<string>(); const tables = new Set<string>(); const models: Model[] = []; const relations: Relation[] = [];
  const dependencies = [...modules]; const name = basename(file.path).toLowerCase();
  if (["package.json", "composer.json"].includes(name)) {
    try { const manifest = JSON.parse(file.source); dependencies.push(...Object.keys({ ...manifest.dependencies, ...manifest.require })); } catch { /* Reported by project context. */ }
  }
  if (name === "requirements.txt") dependencies.push(...file.source.split(/\r?\n/).map(line => line.match(/^([\w.-]+)/)?.[1] ?? ""));
  if (name === "go.mod") dependencies.push(...file.source.split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]));
  if (name === "pom.xml" || /\.(?:csproj|fsproj)$/.test(name)) dependencies.push(...[...file.source.matchAll(/<artifactId>([^<]+)|<PackageReference\s+Include="([^"]+)"/g)].map(match => match[1] ?? match[2]));
  for (const module of dependencies) for (const [pattern, label] of drivers) if (pattern.test(module)) databases.add(label);
  for (const literal of text.literals) {
    const prefix = text.code.slice(Math.max(0, literal.start - 180), literal.start);
    if (/\b(?:dialect|provider)\s*[:=]\s*$/.test(prefix) || /^jdbc:\w+:/.test(literal.value)) {
      const provider = literal.value.replace(/^jdbc:/, "").split(":")[0];
      for (const [pattern, label] of drivers) if (pattern.test(provider)) databases.add(label);
    }
    if (/(?:\.|->|::)(?:execute|executemany|executescript|query|raw|Query|Exec|prepare|ExecuteSqlRaw|ExecuteReader)\s*\(\s*$/.test(prefix)) sqlTables(literal.value).forEach(table => tables.add(table));
    if (/(?:\.|->|::)(?:collection|getCollection|table|Table)\s*\(\s*$/.test(prefix) && /^[\w.-]+$/.test(literal.value) && (databases.size || /\b(?:db|database|Schema)(?:\.|->|::)/.test(prefix))) tables.add(literal.value);
    if (/(?:\b__tablename__|\bdb_table|\$table)\s*=\s*$/.test(prefix) && /^[\w.]+$/.test(literal.value)) tables.add(literal.value);
    if (/(?:@|\[)Table\s*\(\s*(?:name\s*=\s*)?$/.test(prefix) && /^[\w.]+$/.test(literal.value)) tables.add(literal.value);
  }
  const extension = extname(file.path).toLowerCase();
  if (extension === ".py") {
    for (const match of text.code.matchAll(/^([ \t]*)class\s+(\w+)\s*\(([^)]*)\)\s*:/gm)) {
      if (!/\b(?:models\.Model|db\.Model|Base|Document)\b/.test(match[3]) || !dependencies.some(dep => /sqlalchemy|django|mongoengine|sqlmodel/.test(dep))) continue;
      const after = text.code.slice(match.index! + match[0].length);
      const boundary = after.search(new RegExp(`\\n${match[1]}(?:class|def)\\s`));
      const body = after.slice(0, boundary < 0 ? undefined : boundary);
      const fields: Field[] = [];
      for (const field of body.matchAll(/^\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:\w+\.)?(\w+(?:Field)?|Column|mapped_column)\s*\(([^\n]*)/gm)) {
        if (!/(?:Field|Column|mapped_column)$/.test(field[2])) continue;
        const args = field[3]; const primary = /primary_key\s*=\s*True/.test(args);
        fields.push({ name: field[1], type: field[2] === "Column" || field[2] === "mapped_column" ? args.match(/^\s*(?:\w+\.)?(\w+)/)?.[1] ?? "unknown" : field[2], primary, optional: /(?:null|nullable)\s*=\s*True/.test(args) });
      }
      models.push({ name: match[2], fields });
    }
  }
  if ([".java", ".kt", ".cs", ".ts"].includes(extension)) {
    for (const match of text.code.matchAll(/\bclass\s+(\w+)[^{]*\{/g)) {
      const preceding = text.code.slice(Math.max(0, text.code.lastIndexOf("}", match.index!) + 1, match.index! - 400), match.index);
      if (!/@Entity\b|\[Table\s*\(/.test(preceding)) continue;
      let depth = 1; let end = match.index! + match[0].length;
      const start = end;
      while (end < text.code.length && depth) { if (text.code[end] === "{") depth++; else if (text.code[end] === "}") depth--; end++; }
      const body = text.code.slice(start, end - 1);
      const fields: Field[] = [];
      for (const field of body.matchAll(/(?:@(Id|PrimaryGeneratedColumn|PrimaryColumn|Column)\b(?:\([^)]*\))?|\[(Key|Column)(?:\([^)]*\))?\])\s*(?:private\s+|public\s+|protected\s+)?(?:([\w<>?\[\]]+)\s+(\w+)|(\w+)[!?]?\s*:\s*([\w<>?\[\]]+))/g)) {
        fields.push({ name: field[4] ?? field[5], type: field[3] ?? field[6], primary: /^(?:Id|Key|Primary)/.test(field[1] ?? field[2]) });
      }
      models.push({ name: match[1], fields });
    }
  }
  if (extension === ".php" && dependencies.some(module => /Illuminate\\Database\\Eloquent\\Model/.test(module))) {
    for (const match of text.code.matchAll(/class\s+(\w+)\s+extends\s+Model\b/g)) models.push({ name: match[1], fields: [] });
  }
  if (/\.[cm]?[jt]sx?$/.test(extension) && dependencies.includes("mongoose")) {
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    const schemas = new Map<string, Field[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && /(?:^|\.)Schema$/.test(node.initializer.expression.getText(ast))) {
        const object = node.initializer.arguments?.[0]; const fields: Field[] = [];
        if (object && ts.isObjectLiteralExpression(object)) for (const property of object.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const value = property.initializer;
          const options = ts.isObjectLiteralExpression(value) ? value.properties.filter(ts.isPropertyAssignment) : [];
          const type = options.find(option => option.name.getText(ast) === "type")?.initializer ?? value;
          fields.push({ name: property.name.getText(ast).replace(/^['"]|['"]$/g, ""), type: ts.isIdentifier(type) || ts.isPropertyAccessExpression(type) ? type.getText(ast) : "unknown" });
        }
        schemas.set(node.name.text, fields);
      }
      if (ts.isCallExpression(node) && /(?:^|\.)model$/.test(node.expression.getText(ast)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const schema = node.arguments[1]; models.push({ name: node.arguments[0].text, fields: schema && ts.isIdentifier(schema) ? schemas.get(schema.text) ?? [] : [] });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return { databases: [...databases], tables: [...tables], models, relations };
}
