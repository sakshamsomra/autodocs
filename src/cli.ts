#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { analyze } from "./analyzer.js";
import { developerMarkdown, overviewMarkdown } from "./generators.js";

const [command = "analyze", ...args] = process.argv.slice(2);
const target = resolve(args.find(a => !a.startsWith("-")) ?? process.cwd());
if (["--help", "help"].includes(command)) { console.log("Usage: npx @autodocify/autodocs analyze [path]\n       npx @autodocify/autodocs init"); process.exit(0); }
if (command === "init") { await writeFile(join(process.cwd(), "autodocs.config.json"), JSON.stringify({ include: ["src", "prisma"], output: { overview: "docs/overview.md", developer: "docs/architecture.md" } }, null, 2) + "\n"); console.log("Created autodocs.config.json"); process.exit(0); }
if (command !== "analyze") throw new Error(`Unknown command: ${command}`);
const result = await analyze(target); const docs = join(target, "docs"); const overview = join(docs, "overview.md"); const developer = join(docs, "architecture.md");
await mkdir(docs, { recursive: true });
await Promise.all([writeFile(overview, overviewMarkdown(result)), writeFile(developer, developerMarkdown(result))]);
console.log(`Generated ${overview} and ${developer} for ${result.project?.name ?? "project"}.`);
