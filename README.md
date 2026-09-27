# AutoDocs

An `npx`-friendly CLI that creates readable codebase documentation from project manifests, README files, source declarations and content configuration.

## Quick start

```bash
npx @autodocify/autodocs analyze .
```

This writes three plain-Markdown files:

- `docs/overview.md` — a project-facing introduction with its purpose and capabilities, suitable for users, customers and evaluators.
- `docs/architecture.md` — a developer guide with the stack, components, dependencies, data model, endpoints and a source-grounded local start guide.
- `docs/er-diagram.md` — a Mermaid entity-relationship diagram and field reference for detected data models.

Generated files include no scanner statistics, exclusion details or tool branding. `er-diagram.md` is the exception for Mermaid: it contains the generated ER diagram.

Discovery is recursive and does not require a `src/` directory. Composer dependencies, Node dependencies, Python virtual environments, Craft control-panel resources, generated builds and uploaded data are excluded. Environment files and configuration JSON values are not read. Application code and setup commands are never executed.

## Explain a project or file

```bash
npx @autodocify/autodocs explain .
npx @autodocify/autodocs explain src/services/payment.ts
```

`analyze` and `explain` use the same source inspection pipeline. `analyze` renders the collected facts into Markdown; `explain` prints them to the terminal. A directory explanation summarizes detected routes, models, services, integrations and database drivers. A file explanation shows its documented purpose, operations, importers, dependencies, models, storage references, configuration and observed calls. The application layer order is inferred from declarations and dependencies, not a verified runtime call trace.

The commands automatically select syntax adapters for each file in a mixed-stack repository. For example:

```bash
npx @autodocify/autodocs explain backend/services/llm_service.py
npx @autodocify/autodocs explain src/PaymentService.java
npx @autodocify/autodocs explain services/payment.go
npx @autodocify/autodocs analyze .
```

There is no language-extension whitelist for source discovery or file explanations. Unknown text source files receive a generic fallback that looks for common declarations, imports and calls and explicitly identifies its limited coverage. Binary files, common data files, secrets, dependencies and generated output remain excluded. Unrecognized libraries still appear as dependencies and observed calls; an observed call is not automatically labeled an external network request.

Analysis runs entirely in Node and never imports or executes application code. JavaScript/TypeScript use a syntax tree; Python and the common syntax adapters use static extraction. Python explanations retain docstrings, typed operations, SDK calls, configuration references and instances. Dynamic imports, reflection, custom module paths and injected clients may not resolve.

## Language and database coverage

The pipeline is extensible across stacks, but it does not claim complete semantic support for every language, framework or database:

- Common syntax extraction covers declarations, imports and operations in Java/Kotlin, C#, PHP, Go, Ruby, Rust, Swift, Dart, C/C++, Elixir and other recognizable source syntax. Namespace and relative imports are resolved when source evidence is available.
- Database driver/provider detection is separate from schema extraction. It recognizes common SQL databases, MongoDB, Redis, Elasticsearch/OpenSearch, Neo4j, Cassandra, DynamoDB, Firestore and several vector databases from declarations. This does not verify a live connection or inspect database contents.
- Schema adapters cover common SQL DDL, Prisma and Sequelize, plus common Mongoose schemas, Django/SQLAlchemy fields, JPA/TypeORM annotations, C# table annotations and Eloquent model declarations. Fields and relationships can be partial; unsupported schema syntax requires an adapter.
- SQL DDL accepts quoted and schema-qualified identifiers and table-level primary keys. Model classes are kept distinct from physical table names. NoSQL collection names are recorded where explicitly declared; key-value stores do not acquire invented table schemas.

File explanations report their analysis mode: structured syntax, heuristic extraction or generic fallback. For a new stack, a `SourceAdapter` can supply additional facts to both outputs without changing either renderer. The programmatic API accepts adapters explicitly; the CLI uses the built-in adapters and fallback.

```ts
import { analyze } from "@autodocify/autodocs/dist/analyzer.js";
import { explainProject } from "@autodocify/autodocs/dist/explain.js";
import type { SourceAdapter } from "@autodocify/autodocs/dist/inspection.js";

const adapter: SourceAdapter = {
  id: "custom-language",
  supports: file => file.path.endsWith(".custom"),
  inspect: (file, context) => {
    // Extract facts from file.source; context provides project files and masked syntax.
    return { purpose: "Custom source module.", coverage: "heuristic" };
  },
};
const result = await analyze(".", [adapter]);
const explanation = await explainProject(".", [adapter]);
```

## Current coverage

Project content comes from README text, manifest metadata, content declarations and source labels. Fallback summaries use AST-extracted headings and named operations; there are no product-category classifiers or predefined business feature descriptions. Sparse source context produces a sparse overview, not a fabricated product narrative. Framework display names and Markdown layouts remain formatting rules.

- JavaScript/TypeScript: AST discovery for Express and Sequelize, plus NestJS decorators and Next.js route handlers.
- Python: module descriptions, top-level declarations, local imports, script entry points, Flask and FastAPI-style decorators.
- PHP: Composer projects, Laravel and Symfony-style routes, custom classes, and Craft content configuration.
- JVM and .NET: Java/Kotlin Spring mappings, ASP.NET attributes/minimal APIs, Maven, Gradle, and project manifests.
- Go, Ruby, Rust and Elixir: common router declarations, source components, dependency manifests, and detected launch commands.
- Dart/Flutter and containerized projects: package/runtime discovery and manifest-derived setup commands.
- Data: common SQL CREATE TABLE statements and Prisma models.
- Project context: README purpose/features, package and Composer scripts, requirements, existing documentation links.

Framework adapters report literal routes and manifest-backed commands. Routes assembled dynamically at runtime, generated source, reflection, metaprogramming and custom build systems can still require a dedicated adapter. Business purpose comes from repository descriptions and source-owned labels; add a clear README purpose/features section to improve the overview for any stack.

```bash
npx @autodocify/autodocs analyze /path/to/another-project
```

## Development

```bash
npm install
npm run build
node dist/cli.js analyze ../your-backend
```

## Roadmap

- Expand schema fields and relationship extraction for ORM and migration dialects.
- Add `--output README.md` and `--agents` marker replacement.
- Infer real call chains for richer sequence diagrams.
- Publish the package to npm under a unique package name.
