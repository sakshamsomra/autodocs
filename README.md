# AutoDocs

An `npx`-friendly CLI that creates readable codebase documentation from project manifests, README files, source declarations and content configuration.

## Quick start

```bash
npx @autodocify/autodocs analyze .
```

This writes three plain-Markdown files:

- `docs/overview.md` — a project-facing introduction with its purpose and capabilities, suitable for users, customers and evaluators.
- `docs/architecture.md` — a developer guide with the stack, components, dependencies, data model, endpoints and a source-grounded local start guide.

Generated files include no scanner statistics, exclusion details or tool branding. `er-diagram.md` is the exception for Mermaid: it contains the generated ER diagram.

Discovery is recursive and does not require a `src/` directory. Composer dependencies, Node dependencies, Python virtual environments, Craft control-panel resources, generated builds and uploaded data are excluded. Environment files and configuration JSON values are not read. Application code and setup commands are never executed.

`docs/er-diagram.md` contains a Mermaid entity-relationship diagram and field reference for detected data models.

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

- Support TypeORM, Mongoose, Laravel Eloquent, and Django.
- Add `--output README.md` and `--agents` marker replacement.
- Infer real call chains for richer sequence diagrams.
- Publish the package to npm under a unique package name.
