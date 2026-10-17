#!/usr/bin/env node
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute, sep } from "node:path";
import { analyze } from "./analyzer.js";
import { explainFile, explainProject } from "./explain.js";
import { developerMarkdown, erDiagramMarkdown, overviewMarkdown } from "./generators.js";
import { askProject } from "./ask.js";
import { createInterface } from "node:readline/promises";

const [command = "analyze", ...args] = process.argv.slice(2);
const askUsage = 'Usage: npx @autodocify/autodocs ask "<question>" [--path directory]\n       npx @autodocify/autodocs ask\n\nSearches the current project locally; prints source evidence and detected call relationships.\nWithout a question, prompts once in an interactive terminal. No files are written.';
if (["--help", "help"].includes(command)) { console.log('Usage: npx @autodocify/autodocs analyze [directory]\n       npx @autodocify/autodocs explain [directory|file]\n       npx @autodocify/autodocs ask "<question>" [--path directory]\n       npx @autodocify/autodocs init'); process.exit(0); }
if (command === "ask") {
  if (args.includes("--help") || args.includes("-h")) { console.log(askUsage); process.exit(0); }
  try {
    const parts: string[] = []; let root = process.cwd();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--") { parts.push(...args.slice(i + 1)); break; }
      if (args[i] === "--path") {
        if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--path requires a directory.");
        root = resolve(args[++i]);
      } else if (args[i].startsWith("-")) throw new Error(`Unknown ask option: ${args[i]}. Use ask --help.`);
      else parts.push(args[i]);
    }
    let question = parts.join(" ").trim();
    if (!question && process.stdin.isTTY) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { question = (await prompt.question("What would you like to know about this codebase? ")).trim(); }
      finally { prompt.close(); }
    }
    if (!question) throw new Error('A question is required. Example: autodocs ask "How does authentication work?"');
    console.log((await askProject(root, question)).trimEnd());
  } catch (error) { console.error(`autodocs: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
  process.exit(0);
}
const target = resolve(args.find(a => !a.startsWith("-")) ?? process.cwd());
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
