import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, analyzeSources } from "./analyzer.js";
import { inspectSources } from "./inspection.js";
import type { SourceAdapter } from "./inspection.js";
import { explainFile, explainProject, sourceExplanation } from "./explain.js";
import { developerMarkdown } from "./generators.js";

test("common source facts work across language families and drive both outputs", () => {
  const samples = [
    { path: "PaymentService.java", source: "/** Creates payments. */\npackage app.services;\nimport app.repositories.PaymentRepo;\nimport org.postgresql.Driver;\npublic class PaymentService { public String createPayment(String id) { return repository.save(id); } }", operation: "createPayment", dependency: "app.repositories.PaymentRepo" },
    { path: "PaymentService.cs", source: "/// Creates payments.\nusing Microsoft.Data.SqlClient;\npublic class PaymentService { public void CreatePayment(int id) { client.Execute(id); } }", operation: "CreatePayment", dependency: "Microsoft.Data.SqlClient" },
    { path: "payment.php", source: "<?php\n/** Creates payments. */\nuse App\\Repository\\PaymentRepo;\nclass PaymentService { public function createPayment($id) { return $repo->save($id); } }", operation: "createPayment", dependency: "App\\Repository\\PaymentRepo" },
    { path: "payment.go", source: '// Creates payments.\npackage payments\nimport "database/sql"\nfunc CreatePayment(id string) { db.Query("SELECT * FROM payments") }', operation: "CreatePayment", dependency: "database/sql" },
    { path: "payment.rb", source: '# Creates payments.\nrequire "redis"\nclass PaymentService\n  def create_payment\n    client.set("id", 1)\n  end\nend', operation: "create_payment", dependency: "redis" },
    { path: "payment.rs", source: '/// Creates payments.\nuse sqlx::PgPool;\npub struct PaymentService {}\npub fn create_payment(id: i64) { client.save(id); }', operation: "create_payment", dependency: "sqlx::PgPool" },
    { path: "PaymentService.kt", source: '// Creates payments.\nimport app.PaymentRepo\nclass PaymentService { fun createPayment(id: Int) { repo.save(id) } }', operation: "createPayment", dependency: "app.PaymentRepo" },
    { path: "payment.dart", source: "// Creates payments.\nimport 'payment_repo.dart';\nclass PaymentService {\n  void createPayment(int id) { repo.save(id); }\n}", operation: "createPayment", dependency: "payment_repo.dart" },
    { path: "payment.swift", source: '// Creates payments.\nimport Foundation\nclass PaymentService { func createPayment(id: Int) { repo.save(id) } }', operation: "createPayment", dependency: "Foundation" },
    { path: "payment.c", source: '// Creates payments.\n#include "payment.h"\nint create_payment(int id) { return repo.save(id); }', operation: "create_payment", dependency: "payment.h" },
    { path: "payment.ex", source: '# Creates payments.\nalias App.PaymentRepo\ndefmodule PaymentService do\n  def create_payment(id) do\n    PaymentRepo.save(id)\n  end\nend', operation: "create_payment", dependency: "App.PaymentRepo" },
  ];
  const analysis = analyzeSources("payments", samples);
  for (const sample of samples) {
    const insight = analysis.sources!.find(item => item.file === sample.path)!;
    assert.ok(insight.operations.some(operation => operation.includes(sample.operation)), sample.path + " operations");
    assert.ok(insight.dependencies.some(dependency => dependency.module === sample.dependency), sample.path + " imports");
    assert.ok(sourceExplanation(insight, analysis.sources!).includes(sample.operation), sample.path + " explanation");
    assert.ok(developerMarkdown(analysis).includes(sample.operation), sample.path + " Markdown");
  }
  assert.ok(analysis.sources!.find(item => item.file.endsWith(".go"))!.tables.includes("payments"));
  assert.ok(analysis.project!.stack.some(item => item.name === "PostgreSQL"));
  assert.ok(analysis.project!.stack.some(item => item.name === "SQL Server"));
  assert.ok(analysis.project!.stack.some(item => item.name === "Redis"));
});

test("namespace imports resolve source consumers without inventing runtime flow", () => {
  const sources = inspectSources([
    { path: "src/PaymentService.java", source: "package app.services;\npublic class PaymentService { public void pay() {} }" },
    { path: "src/Api.java", source: "package app.api;\nimport app.services.PaymentService;\npublic class Api {}" },
  ]);
  assert.deepEqual(sources[1].dependencies[0].targets, ["src/PaymentService.java"]);
  assert.match(sourceExplanation(sources[0], sources), /USED BY\n• src\/Api.java/);
});

test("SQL schemas support qualified identifiers and table-level primary keys", () => {
  const analysis = analyzeSources("db", [
    { path: "postgres.sql", source: 'CREATE TABLE "public"."users" ("id" INT, "email" VARCHAR(255), PRIMARY KEY ("id"));' },
    { path: "mssql.sql", source: "CREATE TABLE [dbo].[orders] ([id] INT PRIMARY KEY, [owner_id] INT, FOREIGN KEY ([owner_id]) REFERENCES [public].[users]([id]));" },
    { path: "mysql.sql", source: "CREATE TABLE `products` (`id` INT PRIMARY KEY, price DECIMAL(10,2)) ENGINE=InnoDB;" },
  ]);
  assert.deepEqual(analysis.models.map(model => model.name), ["public.users", "dbo.orders", "products"]);
  assert.equal(analysis.models[0].fields[0].primary, true);
  assert.equal(analysis.models[0].fields[0].optional, false);
  assert.deepEqual(analysis.relations, [{ from: "dbo.orders", to: "public.users", label: "owner_id" }]);
});

test("schemas and storage drivers are independent of the host language", () => {
  const analysis = analyzeSources("mixed", [
    { path: "user.py", source: 'from sqlalchemy import Column, Integer, String\nclass User(Base):\n    __tablename__ = "users"\n    id = Column(Integer, primary_key=True)\n    name = Column(String)\n' },
    { path: "Post.java", source: 'import jakarta.persistence.Entity;\n@Entity\npublic class Post { @Id private Long id; @Column private String title; }' },
    { path: "Order.cs", source: '[Table("orders")]\npublic class Order { [Key] public int Id { get; set; } }' },
    { path: "event.ts", source: 'import mongoose from "mongoose"; const eventSchema = new mongoose.Schema({ name: String }); export const Event = mongoose.model("Event", eventSchema);' },
    { path: "cache.go", source: 'package cache\nimport "github.com/redis/go-redis/v9"\nfunc Save() { client.Set(ctx, key, value, 0) }' },
    { path: "package.json", source: JSON.stringify({ dependencies: { pg: "^8", "@qdrant/js-client-rest": "^1", "@aws-sdk/client-dynamodb": "^3" } }) },
  ]);
  for (const name of ["User", "Post", "Order", "Event"]) assert.ok(analysis.models.some(model => model.name === name), name);
  assert.equal(analysis.models.find(model => model.name === "Event")!.fields[0].name, "name");
  for (const name of ["MongoDB", "Redis", "PostgreSQL", "Qdrant", "DynamoDB"]) assert.ok(analysis.project!.stack.some(item => item.name === name), name);
});

test("unknown source files get a fallback and custom adapters feed analyze and explain", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-adapter-"));
  try {
    const file = join(root, "service.acme");
    await writeFile(file, '// Handles Acme records.\nimport vendor.sdk;\nfunction saveRecord(id) { sdk.save(id); }\n');
    await writeFile(join(root, "blob.acme"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, ".env"), "PASSWORD=secret-marker");
    await writeFile(join(root, "README.md"), '# Acme\n\nExample: class FakeService and db.query("SELECT * FROM fake_table").');
    const fallback = await explainFile(file, root);
    assert.match(fallback, /saveRecord/);
    assert.match(fallback, /OBSERVED CALLS\n• sdk.save/);
    assert.match(fallback, /Generic source fallback/);
    assert.match(developerMarkdown(await analyze(root)), /## Source interpretation/);
    const adapter: SourceAdapter = {
      id: "acme", supports: file => file.path.endsWith(".acme"),
      inspect: () => ({ coverage: "structured", name: "RecordService", purpose: "Stores Acme records.", models: [{ name: "AcmeRecord", fields: [{ name: "id", type: "string", primary: true }] }], databases: ["AcmeDB"], notes: [] }),
    };
    const result = await analyze(root, [adapter]);
    assert.equal(result.scannedFiles, 2);
    assert.deepEqual(result.models.map(model => model.name), ["AcmeRecord"]);
    assert.doesNotMatch(developerMarkdown(result), /secret-marker/);
    assert.deepEqual(result.sources!.find(source => source.file === "README.md")!.declarations, []);
    assert.deepEqual(result.sources!.find(source => source.file === "README.md")!.tables, []);
    assert.match(developerMarkdown(result), /AcmeRecord/);
    assert.match(await explainFile(file, root, [adapter]), /AcmeDB driver or provider/);
    assert.match(await explainProject(root, [adapter]), /AcmeDB driver or dialect/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
