import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyze } from "./analyzer.js";
import { projectOverview } from "./project.js";
import { developerMarkdown, markdown, overviewMarkdown } from "./generators.js";

test("context follows arbitrary source labels without domain-specific feature prose", () => {
  for (const label of ["Inventory Desk", "Orbit Planner", "Recipe Library"]) {
    const project = projectOverview("sample", [{ path: "App.jsx", source: `export default () => <h1>${label}</h1>;` }], 0, []);
    assert.equal(project.name, label);
    assert.equal(project.features[0].name, label);
    assert.ok(project.description.includes(label));
    assert.doesNotMatch(project.description, /uptime|downtime|faculty/i);
  }
  const project = projectOverview("sample", [{ path: "module.ts", source: '// <h1>Wrong product</h1>\nexport function reserveSeat() {}' }], 0, []);
  assert.equal(project.name, "sample");
  assert.equal(project.features[0].name, "reserve Seat");
  assert.doesNotMatch(project.description, /Wrong product/);
});

test("developer guide always contains a source-grounded start guide", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const result = await analyze(root);
    const output = developerMarkdown(result);
    assert.match(output, /## How to start/);
    assert.match(output, /npm install/);
    assert.match(output, /npm run dev/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovers routes across major backend ecosystems", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await writeFile(join(root, "Api.java"), '@GetMapping("/users") public void users() {}');
    await writeFile(join(root, "Api.cs"), '[HttpPost("/orders")] public void Orders() {}');
    await writeFile(join(root, "routes.php"), "Route::delete('/sessions/{id}', $handler);");
    await writeFile(join(root, "server.go"), 'r.GET("/health", health)');
    await writeFile(join(root, "routes.rb"), "get '/reports', to: 'reports#index'");
    await writeFile(join(root, "api.rs"), '#[patch("/profiles/{id}")] async fn update() {}');
    const result = await analyze(root);
    const routes = result.services.flatMap(service => service.methods);
    for (const route of ["GET /users", "POST /orders", "DELETE /sessions/{id}", "GET /health", "GET /reports", "PATCH /profiles/{id}"]) assert.ok(routes.includes(route), route);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("builds start instructions from non-Node ecosystem manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await writeFile(join(root, "go.mod"), "module example.com/service\n");
    await writeFile(join(root, "main.go"), "package main\nfunc main() {}\n");
    const output = developerMarkdown(await analyze(root));
    assert.match(output, /go mod download/);
    assert.match(output, /go run \./);
    assert.doesNotMatch(output, /runnable entry point was not safely detected/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("analyzes Sequelize and Express syntax trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await writeFile(join(root, "models.ts"), `
      import { Model, DataTypes } from "sequelize";
      export const User = sequelize.define("User", {
        id: { type: DataTypes.UUID, primaryKey: true },
        email: { type: DataTypes.STRING, allowNull: true },
      });
      export class Post extends Model {}
      Post.init({ title: { type: DataTypes.TEXT } }, { sequelize });
      User.hasMany(Post);
      // router.get('/not-a-real-route', handler)
    `);
    await writeFile(join(root, "routes.ts"), `
      const router = Router();
      router.get("/users/:id", getUser);
      router.post("/users", createUser);
      const text = "router.delete('/not-a-route')";
    `);

    const result = await analyze(root);
    assert.deepEqual(result.models, [
      { name: "User", fields: [{ name: "id", type: "UUID", primary: true, optional: false }, { name: "email", type: "STRING", primary: false, optional: true }] },
      { name: "Post", fields: [{ name: "title", type: "TEXT", primary: false, optional: false }] },
    ]);
    assert.deepEqual(result.relations, [{ from: "User", to: "Post", label: "hasMany" }]);
    assert.deepEqual(result.services, [{ name: "routes", methods: ["GET /users/:id", "POST /users"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documents project purpose and Craft content without vendor and editor false positives", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await mkdir(join(root, "vendor"));
    await mkdir(join(root, "web", "cpresources"), { recursive: true });
    await mkdir(join(root, "config", "project", "sections"), { recursive: true });
    await writeFile(join(root, "vendor", "schema.sql"), "CREATE TABLE fake (id INT);");
    await writeFile(join(root, "web", "cpresources", "example.sql"), "CREATE TABLE fake2 (id INT);");
    await writeFile(join(root, "README.md"), "# University Website\n\nPublic website for university courses and news.\n");
    await writeFile(join(root, "composer.json"), JSON.stringify({ require: { "craftcms/cms": "^5.9" } }));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "gulp build" }, devDependencies: { tailwindcss: "^3" } }));
    await writeFile(join(root, "editor.js"), 'editor.config.define("alignment", { options: [] });');
    await writeFile(join(root, "config", "project", "sections", "courses.yaml"), "name: Courses\nhandle: courses\ntype: channel\n");
    await writeFile(join(root, ".env"), "PASSWORD=secret-marker");
    const result = await analyze(root);
    assert.equal(result.models.length, 0);
    assert.equal(result.project?.name, "University Website");
    assert.equal(result.project?.content[0].name, "Courses");
    assert.ok(result.project?.stack.some(s => s.name === "Craft CMS"));
    const output = markdown(result);
    assert.match(output, /Public website for university courses and news/);
    assert.match(output, /npm run build/);
    assert.match(output, /\.\.\/composer.json/);
    assert.doesNotMatch(output, /secret-marker|```mermaid|fake2?/);
    const overview = overviewMarkdown(result);
    assert.match(overview, /Public website for university courses and news/);
    assert.doesNotMatch(overview, /Technology stack|Components|Development commands|secret-marker/);
    assert.match(developerMarkdown(result), /Developer Guide/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovers a Flask app and SQL schema in a flat Python project", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await writeFile(join(root, "schema.sql"), `
      CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255) NOT NULL);
      CREATE TABLE devices (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES users(id));
    `);
    await writeFile(join(root, "web_app.py"), `
      @app.route("/devices", methods=["GET", "POST"])
      def devices(): pass
      @app.delete("/devices/<int:id>")
      def remove_device(id): pass
    `);
    const result = await analyze(root);
    assert.deepEqual(result.models.map(model => model.name), ["users", "devices"]);
    assert.deepEqual(result.models[0].fields.map(f => f.name), ["id", "email"]);
    assert.deepEqual(result.models[1].fields.map(f => f.name), ["id", "owner_id"]);
    assert.deepEqual(result.relations, [{ from: "devices", to: "users", label: "owner_id" }]);
    assert.deepEqual(result.services, [{ name: "web_app", methods: ["GET /devices", "POST /devices", "DELETE /devices/<int:id>"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("infers an uptime monitor overview from code when no root README exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "website_tracker", dependencies: { express: "^5", sequelize: "^6", "node-cron": "^4", nodemailer: "^9" } }));
    await writeFile(join(root, "index.js"), `
      import cron from "node-cron"; import nodemailer from "nodemailer";
      const Site = sequelize.define("Site", { latency: DataTypes.INTEGER, status: DataTypes.STRING });
      const PingLog = sequelize.define("PingLog", { timestamp: DataTypes.DATE });
      async function checkSite(site) { await axios.get(site.url); await transporter.sendMail({ subject: "DOWN" }); }
      cron.schedule("* * * * *", checkSite);
      app.get("/api/sites/:id/logs", handler);
    `);
    await writeFile(join(root, "App.jsx"), "export default () => <h1>Uptime Monitor</h1>;");
    await writeFile(join(root, "overview.md"), "previous generated overview");
    const result = await analyze(root);
    assert.equal(result.project?.name, "Uptime Monitor");
    assert.match(result.project?.description ?? "", /Uptime Monitor/);
    assert.deepEqual(result.project?.features.map(feature => feature.name), ["Uptime Monitor"]);
    assert.doesNotMatch(overviewMarkdown(result), /previous generated overview|overview\.md/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not combine unrelated files into a hard-coded project classification", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await writeFile(join(root, "README.md"), "# The official website for Example University\n\nTodo: add setup notes.\n");
    await writeFile(join(root, "site.php"), "// public website content\n");
    await writeFile(join(root, "research.php"), "// performance monitoring for research equipment\n");
    await writeFile(join(root, "public-readme.md"), "copied documentation");
    const result = await analyze(root);
    assert.equal(result.project?.name, "The official website for Example University");
    assert.match(result.project?.description ?? "", /official website for Example University/i);
    assert.doesNotMatch(result.project?.description ?? "", /uptime monitor/i);
    assert.equal(result.project?.features.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uses an authored website title instead of framework boilerplate or page headings", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await mkdir(join(root, "register-for-event"));
    await mkdir(join(root, "faculty-login"));
    await writeFile(join(root, "register-for-event", "index.php"), "<?php");
    await writeFile(join(root, "faculty-login", "index.php"), "<?php");
    await writeFile(join(root, "README.md"), "# The official website for Example University\n\nTodo: add setup notes.\n");
    await writeFile(join(root, "composer.json"), JSON.stringify({ name: "laravel/laravel", description: "The Laravel Framework.", require: { "laravel/framework": "^7" } }));
    await writeFile(join(root, "page.php"), "<h1>Uptime Monitor</h1>");
    const result = await analyze(root);
    assert.equal(result.project?.name, "The official website for Example University");
    assert.match(result.project?.description ?? "", /official website for Example University/i);
    assert.deepEqual(result.project?.features, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not treat a nested PHP checkSite helper as a website monitor", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-"));
  try {
    await mkdir(join(root, "blog", "platform"), { recursive: true });
    await writeFile(join(root, "README.md"), "# The official website for Example University\n");
    await writeFile(join(root, "blog", "platform", "Card.php"), "<?php protected function checkSite(&$site) { return $site; }");
    const result = await analyze(root);
    assert.match(result.project?.description ?? "", /official website for Example University/i);
    assert.doesNotMatch(result.project?.description ?? "", /uptime monitoring/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
