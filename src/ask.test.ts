import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { answerQuestion, askProject } from "./ask.js";
import { buildCodeGraph } from "./code-graph.js";
import type { SourceFile } from "./project.js";

const auth: SourceFile[] = [
  { path: "src/server.ts", source: `import express from "express";
import authRouter from "./routes/auth.js";
const app = express();
app.use("/api/auth", authRouter);` },
  { path: "src/routes/auth.ts", source: `import { Router } from "express";
import { AuthController } from "../controllers/auth.js";
const controller = new AuthController();
const router = Router();
router.post("/login", controller.login);
export default router;` },
  { path: "src/controllers/auth.ts", source: `import { AuthService } from "../services/auth.js";
export class AuthController {
  private service = new AuthService();
  async login(req, res) {
    const token = await this.service.authenticate(req.body.email, req.body.password);
    return res.json({ token });
  }
}` },
  { path: "src/services/auth.ts", source: `import bcrypt from "bcrypt";
import { UserRepository } from "../repositories/user.js";
import { JWTService } from "./jwt.js";
/** Verifies credentials and creates a signed access token. */
export class AuthService {
  async authenticate(email, password) {
    const user = await UserRepository.findByEmail(email);
    if (!await bcrypt.compare(password, user.passwordHash)) throw new Error("Invalid credentials");
    return JWTService.generateToken(user.id);
  }
}` },
  { path: "src/repositories/user.ts", source: `export class UserRepository {
  static findByEmail(email) { return db.query("SELECT * FROM users WHERE email = ?", [email]); }
}` },
  { path: "src/services/jwt.ts", source: `import jwt from "jsonwebtoken";
export class JWTService {
  static generateToken(id) { return jwt.sign({ id }, process.env.JWT_SECRET); }
}` },
];

test("ask traces a mounted route through imported classes, instances and real call sites", () => {
  const graph = buildCodeGraph(auth);
  const route = graph.find(node => node.label === "POST /api/auth/login");
  assert.ok(route, JSON.stringify(graph, null, 2));
  const controller = graph.find(node => node.label === "AuthController.login")!;
  const service = graph.find(node => node.label === "AuthService.authenticate")!;
  assert.equal(route.calls[0].target, controller.id);
  assert.equal(controller.calls[0].target, service.id);
  assert.equal(service.calls.find(call => call.label === "UserRepository.findByEmail()")?.target,
    graph.find(node => node.label === "UserRepository.findByEmail")?.id);
  const output = answerQuestion("How does authentication work?", auth);
  assert.match(output, /FLOW CHART[\s\S]*POST \/api\/auth\/login[\s\S]*AuthController\.login\(\)[\s\S]*AuthService\.authenticate\(\)[\s\S]*UserRepository\.findByEmail\(\)[\s\S]*bcrypt\.compare\(\)[\s\S]*JWTService\.generateToken\(\)/);
  assert.match(output, /src\/services\/auth\.ts:6/);
  assert.match(output, /res\.json\(\)/);
  assert.match(output, /definition not resolved/);
  assert.match(output, /not guaranteed execution order/);
  assert.match(output, /ANSWER\n[\s\S]*FLOW CHART[\s\S]*VERDICT\n/);
  assert.match(output, /VERDICT\nDocumented responsibility: Verifies credentials and creates a signed access token\./);
  assert.match(output, /└──► AuthController\.login\(\) \[src\/controllers\/auth\.ts:4\]/);
  assert.doesNotMatch(output, /const token|await bcrypt|SELECT \*|return res|^\s*\d+\s*\|/m);
});

test("call resolution respects lexical scopes and does not guess similarly named methods", () => {
  const graph = buildCodeGraph([
    { path: "service.ts", source: `import { find as lookup } from './repo.js';
export function search(client) { client.find(); lookup(); }
export function other() { const lookup = () => console.log('local'); lookup(); }` },
    { path: "repo.ts", source: "export function find() { return 1; }" },
    { path: "unrelated.ts", source: "export class WrongRepository { find() { return 2; } }" },
  ]);
  const search = graph.find(node => node.label === "search")!;
  assert.equal(search.calls[0].target, undefined);
  assert.equal(search.calls[1].target, graph.find(node => node.file === "repo.ts")?.id);
  const other = graph.find(node => node.label === "other")!;
  assert.equal(other.calls[0].target, graph.find(node => node.label === "lookup")?.id);
  assert.ok(!graph.some(node => node.calls.some(call => call.target === graph.find(item => item.label === "WrongRepository.find")?.id && call.target)));
});

test("anonymous handlers, bound methods and callback references retain distinct call ownership", () => {
  const graph = buildCodeGraph([{ path: "app.ts", source: `import express from 'express';
const app = express();
function save() { return db.insert(); }
class Tasks { run() { queue.submit(save); } }
const tasks = new Tasks();
app.post('/tasks', tasks.run.bind(tasks));
app.get('/status', (req, res) => { return res.json({ status: 'ok' }); });` }]);
  const route = graph.find(node => node.label === "POST /tasks")!;
  const run = graph.find(node => node.label === "Tasks.run")!;
  assert.equal(route.calls[0].target, run.id);
  assert.ok(run.calls.some(call => call.callback && call.label === "save()"));
  assert.ok(!run.calls.some(call => call.label === "db.insert()"));
  const inline = graph.find(node => node.label === "GET /status")!;
  assert.ok(graph.find(node => node.id === inline.calls[0].target)?.calls.some(call => call.label === "res.json()"));
});

test("CommonJS routers work, dynamic mounts are flagged and HTTP clients are not routes", () => {
  const graph = buildCodeGraph([{ path: "server.js", source: `const express = require('express');
const { Router } = require('express');
const axios = require('axios');
const app = express();
const router = Router();
router.get('/health', (req, res) => res.json({ ok: true }));
app.use(process.env.API_PREFIX, router);
axios.get('/outbound');` }]);
  const routes = graph.filter(node => node.kind === "route");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].label, "GET /health");
  assert.match(routes[0].notes!.join(" "), /Mount prefix unresolved at server\.js:7/);
});

test("unrelated imports and prompt text never become call edges", () => {
  const graph = buildCodeGraph([
    { path: "main.ts", source: `import { removeEverything } from './danger.js';
const prompt = 'removeEverything(); POST /invented';
export function preview() { return prompt; }` },
    { path: "danger.ts", source: "export function removeEverything() { throw new Error('never execute'); }" },
  ]);
  assert.equal(graph.find(node => node.label === "preview")!.calls.length, 0);
  assert.equal(graph.filter(node => node.kind === "route").length, 0);
});

test("arbitrary domain questions retrieve evidence across languages, docs and database schemas", () => {
  const files = [
    { path: "billing/reconcile.go", source: `package billing
// Reconcile invoices with settled transfers before the daily report.
func Reconcile() { ledger.SettleTransfers() }` },
    { path: "worker.py", source: `def reconcile_invoices():
    """Retry unsettled invoices from the ledger."""
    return ledger.unsettled_invoices()` },
    { path: "ledger.sql", source: "CREATE TABLE invoices (id INT PRIMARY KEY, transfer_id INT, settled BOOLEAN);" },
    { path: "architecture-notes.md", source: "# Reconciliation\nReconcile invoices after settlement, before reporting." },
    { path: "pipeline.custom", source: "operation reconcile_invoices { ledger.settle(); }" },
  ];
  const output = answerQuestion("Where are invoices reconciled?", files);
  for (const file of files) assert.ok(output.includes(file.path), file.path);
  assert.match(output, /Operation: Reconcile\(\) \[billing\/reconcile\.go:3\]/);
  assert.match(output, /SOURCE MAP/);
  assert.match(output, /VERDICT\nStart with/);
  assert.doesNotMatch(output, /FLOW CHART|CREATE TABLE|func Reconcile|def reconcile/);
  assert.doesNotMatch(output, /AuthController|JWTService/);
});

test("configuration and persistence questions use source facts and not just authentication templates", () => {
  const output = answerQuestion("Where is Redis caching configured?", [
    { path: "cache.rs", source: 'use redis::Client;\nfn connect_cache() { let client = Client::open(std::env::var("REDIS_URL").unwrap()); }' },
    { path: "unrelated.java", source: "class Customer { void greet() {} }" },
  ]);
  assert.match(output, /cache\.rs/);
  assert.match(output, /REDIS_URL/);
  assert.match(output, /Environment: REDIS_URL \[cache\.rs:2\]/);
  assert.match(output, /SOURCE MAP[\s\S]*VERDICT\nConfiguration is referenced through Environment: REDIS_URL/);
  assert.doesNotMatch(output, /let client|fn connect_cache|std::env::var\("/);
  assert.doesNotMatch(output, /unrelated\.java/);
});

test("external API questions answer from detected providers and hide unrelated auth routes", () => {
  const output = answerQuestion("Which external API is it using?", [
    { path: "api/scan.ts", source: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export async function scan() { return client.messages.create({ model: "model", messages: [] }); }` },
    { path: "api/auth.ts", source: 'export async function login() { return fetch(process.env.BACKEND_URL); }' },
    { path: "api/prices.ts", source: 'export async function prices() { return fetch(process.env.BACKEND_URL); }' },
  ]);
  assert.match(output, /ANSWER\nExternal API detected: Anthropic \[api\/scan\.ts:1\]/);
  assert.match(output, /SOURCE MAP[\s\S]*External API: Anthropic/);
  assert.match(output, /VERDICT\nThe code imports or calls Anthropic/);
  assert.doesNotMatch(output, /api\/auth|api\/prices|getAuthenticatedUserId/);
});

test("database questions prioritize runtime drivers and schema providers over unused manifest dependencies", () => {
  const output = answerQuestion("Which database is being used?", [
    { path: "package.json", source: '{ "dependencies": { "pg": "1", "mariadb": "1" } }' },
    { path: "server.js", source: 'const mariadb = require("mariadb");\nconst pool = mariadb.createPool({ host: process.env.DB_HOST });' },
    { path: "prisma/schema.prisma", source: 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}' },
    { path: "api/auth.ts", source: 'export async function login() { return fetch(process.env.BACKEND_URL); }' },
  ]);
  assert.match(output, /ANSWER\nDatabase detected: Runtime adapter\/driver: MariaDB \[server\.js:1\] and Prisma schema provider: MySQL \[prisma\/schema\.prisma:2\]/);
  assert.match(output, /VERDICT\nRuntime code imports\/initializes MariaDB; the schema declares MySQL/);
  assert.match(output, /SOURCE MAP[\s\S]*server\.js[\s\S]*schema\.prisma/);
  assert.doesNotMatch(output, /PostgreSQL|package\.json|api\/auth/);
});

test("no evidence and empty questions do not produce invented answers", () => {
  assert.match(answerQuestion("How does teleportation work?", auth), /No relevant source evidence found/);
  assert.match(answerQuestion("What does it do?", auth), /No relevant source evidence found/);
  assert.match(answerQuestion("Where is login?", []), /Searched 0 files/);
  assert.throws(() => answerQuestion(" ", auth), /question is required/);
  assert.throws(() => answerQuestion("x".repeat(2001), auth), /2,000/);
});

test("recursive call trees stop and do not fabricate a response or route", () => {
  const output = answerQuestion("How does countdown work?", [{ path: "count.ts", source: "export function countdown(n) { return n ? countdown(n - 1) : 0; }" }]);
  assert.match(output, /recursive reference; stopped/);
  assert.doesNotMatch(output, /HTTP Response|POST|GET/);
  assert.ok(output.length < 10000);
});

test("search redacts obvious credential literals and skips secret files", () => {
  const output = answerQuestion("How is the payment API configured?", [
    { path: "payment.ts", source: 'const api_key = "dont-print-this";\nconst password = "dont-print-password";\nconst url = "mysql://user:dbpass@localhost/db";\nexport function payment() { return fetch(url); }' },
    { path: "config/secrets.py", source: 'payment = "private-secret-file"' },
    { path: ".env", source: "PAYMENT_SECRET=env-secret" },
  ]);
  assert.match(output, /\[payment\.ts:4\]/);
  assert.doesNotMatch(output, /const api_key|const password|const url/);
  assert.doesNotMatch(output, /dont-print|dbpass|private-secret-file|env-secret/);
});

test("caller questions get a reverse-reference chart and a specific verdict", () => {
  const output = answerQuestion("Who calls AuthService.authenticate?", auth);
  assert.match(output, /CALLER CHART/);
  assert.match(output, /referenced by AuthController\.login\(\) \[src\/controllers\/auth\.ts:4\]/);
  assert.match(output, /VERDICT\nFound 1 local caller\/handler reference to AuthService\.authenticate\(\)/);
  assert.doesNotMatch(output, /FLOW CHART|const token/);
  const unused = answerQuestion("Who calls lonely?", [{ path: "lonely.ts", source: "export function lonely() { return 1; }" }]);
  assert.match(unused, /does not prove lonely\(\) is unused/);
});

test("database questions show a schema map and references without SQL source", () => {
  const output = answerQuestion("Which database tables store invoices?", [{
    path: "schema.sql", source: "-- Invoice schema\n\nCREATE TABLE invoices (id INT PRIMARY KEY, amount DECIMAL);",
  }]);
  assert.match(output, /SOURCE MAP[\s\S]*Storage reference: invoices \[schema\.sql:3\]/);
  assert.match(output, /VERDICT[\s\S]*does not verify a live database/);
  assert.doesNotMatch(output, /CREATE TABLE|PRIMARY KEY|DECIMAL/);
});

test("documentation-only and absent evidence get honest verdicts without source excerpts", () => {
  const output = answerQuestion("How does teleportation work?", [{ path: "README.md", source: "# Teleportation\nTeleportation is planned but unimplemented." }]);
  assert.match(output, /SOURCE MAP/);
  assert.match(output, /Documentation\/metadata match; implementation not verified/);
  assert.match(output, /VERDICT\n[\s\S]*insufficient implementation evidence/);
  assert.doesNotMatch(output, /# Teleportation|Teleportation is planned/);
  assert.match(answerQuestion("How does teleportation work?", auth), /VERDICT\nInsufficient source evidence/);
});

test("unresolved handlers never print object literals or inline source", () => {
  const output = answerQuestion("How does payment work?", [{ path: "server.ts", source: `import fastify from 'fastify';
const app = fastify();
app.post('/payment', { handler: unknownHandler, config: { privateLabel: 'NEVER_PRINT_THIS_BODY' } });` }]);
  assert.match(output, /FLOW CHART/);
  assert.match(output, /Unresolved call \[server\.ts:3\]/);
  assert.doesNotMatch(output, /NEVER_PRINT_THIS_BODY|privateLabel|handler: unknownHandler/);
});

test("CLI accepts quoted questions and paths with spaces, reports errors and writes no docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs ask-"));
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  try {
    await writeFile(join(root, "health.ts"), "export function health() { return { status: 'ok' }; }");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "secret.ts"), "health should not print installed dependency");
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
    const result = run("ask", "How does health work?", "--path", root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /health\(\)/);
    assert.doesNotMatch(result.stdout, /installed dependency/);
    assert.deepEqual((await readdir(root)).sort(), ["health.ts", "node_modules"]);
    const current = run("ask", "Where is health?");
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /health\.ts/);
    assert.equal(run("ask", "--help").status, 0);
    assert.match(run("--help").stdout, /ask/);
    assert.match(run("ask").stderr, /question is required/);
    assert.equal(run("ask").status, 1);
    assert.match(run("ask", "health", "--path").stderr, /requires a directory/);
    assert.equal(run("ask", "health", "--unknown").status, 1);
    assert.equal(run("ask", "health", "--path", "missing-directory").status, 1);
    await assert.rejects(askProject(join(root, "health.ts"), "health"), /directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
