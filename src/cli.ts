#!/usr/bin/env node
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute, sep } from "node:path";
import { analyze } from "./analyzer.js";
import { explainFile, explainProject } from "./explain.js";
import { developerMarkdown, erDiagramMarkdown, overviewMarkdown } from "./generators.js";

const [command = "analyze", ...args] = process.argv.slice(2);
const target = resolve(args.find(a => !a.startsWith("-")) ?? process.cwd());
if (["--help", "help"].includes(command)) { console.log("Usage: npx @autodocify/autodocs analyze [directory]\n       npx @autodocify/autodocs explain [directory|file]\n       npx @autodocify/autodocs init"); process.exit(0); }
if (command === "init") { await writeFile(join(process.cwd(), "autodocs.config.json"), JSON.stringify({ include: ["src", "prisma"], output: { overview: "docs/overview.md", developer: "docs/architecture.md", erDiagram: "docs/er-diagram.md" } }, null, 2) + "\n"); console.log("Created autodocs.config.json"); process.exit(0); }
if (command === "explain") {
  const info = await lstat(target);
  if (info.isDirectory()) console.log((await explainProject(target)).trimEnd());
  else if (info.isFile()) {
    const fromCwd = relative(process.cwd(), target);
    const root = fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd) ? process.cwd() : dirname(target);
    console.log((await explainFile(target, root)).trimEnd());
  } else throw new Error(`Cannot explain ${target}: expected a file or directory.`);
  process.exit(0);
}
if (command !== "analyze") throw new Error(`Unknown command: ${command}`);
const result = await analyze(target); const docs = join(target, "docs"); const overview = join(docs, "overview.md"); const developer = join(docs, "architecture.md"); const erDiagram = join(docs, "er-diagram.md");
await mkdir(docs, { recursive: true });
await Promise.all([writeFile(overview, overviewMarkdown(result)), writeFile(developer, developerMarkdown(result)), writeFile(erDiagram, erDiagramMarkdown(result))]);
console.log(`Generated ${overview}, ${developer}, and ${erDiagram} for ${result.project?.name ?? "project"}.`);
