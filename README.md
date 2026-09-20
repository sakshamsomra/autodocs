# AutoDocs Diagram Generator

An `npx`-friendly CLI that creates readable codebase documentation from project manifests, README files, source declarations and content configuration.

## Quick start

```bash
npx autodocs-diagram-generator analyze .
```

This writes two plain-Markdown files:

- `docs/overview.md` — a project-facing introduction with its purpose and capabilities, suitable for users, customers and evaluators.
- `docs/architecture.md` — a developer guide with the stack, components, dependencies, data model, endpoints and development commands.

Neither generated file includes scanner statistics, exclusion details, tool branding or Mermaid blocks.

Discovery is recursive and does not require a `src/` directory. Composer dependencies, Node dependencies, Python virtual environments, Craft control-panel resources, generated builds and uploaded data are excluded. Environment files and configuration JSON values are not read. Application code and setup commands are never executed.

## Current coverage

Project content comes from README text, manifest metadata, content declarations and source labels. Fallback summaries use AST-extracted headings and named operations; there are no product-category classifiers or predefined business feature descriptions. Sparse source context produces a sparse overview, not a fabricated product narrative. Framework display names and Markdown layouts remain formatting rules.

- JavaScript/TypeScript: AST discovery for common Express and Sequelize declarations.
- Python: module descriptions, top-level declarations, local imports, script entry points and common Flask decorators.
- PHP/Craft CMS: Composer stack, custom PHP classes, Twig inventory and Craft content sections with template/URI configuration.
- Data: common SQL CREATE TABLE statements and Prisma models.
- Project context: README purpose/features, package and Composer scripts, requirements, existing documentation links.

Python, PHP, SQL and Craft extraction currently supports specific textual conventions; it is not full semantic analysis. Dynamic routes, aliased Sequelize instances and runtime configuration can be missed. Business purpose comes from repository descriptions; absent documentation is reported explicitly. Manifest dependencies do not prove runtime usage. Commands are listed for review, not certified as working. Add a clear README purpose/features section to improve the overview for any stack.

```bash
npx autodocs-diagram-generator init
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
