import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type { Evidence, ProjectOverview } from "./types.js";
import { inferProjectContext } from "./context.js";

// Do not inspect installed libraries, generated bundles, uploaded data or secrets.
const excludedDirectories = new Set(["node_modules", "vendor", ".git", "dist", "build", "venv", ".venv", "__pycache__", "storage", "runtime", "cache", "uploads", "coverage", ".next", "cpresources"]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".php", ".twig", ".html", ".css", ".scss", ".sql", ".prisma", ".yaml", ".yml", ".md"]);
const manifests = new Set(["package.json", "composer.json", "requirements.txt", "pyproject.toml", "Dockerfile", "Makefile"]);
export interface SourceFile { path: string; source: string }

export async function discover(root: string): Promise<{ files: SourceFile[]; excluded: number; warnings: string[] }> {
  const files: SourceFile[] = []; const warnings: string[] = []; let excluded = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { warnings.push(`Could not read directory: ${relative(root, dir)}`); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) { excluded++; continue; }
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name.toLowerCase())) excluded++;
        else await walk(path);
        continue;
      }
      if (!entry.isFile() || ["architecture.md", "overview.md"].includes(entry.name) || /(?:\.min\.[cm]?js|\.bundle\.js|\.map|\.lock|\.test\.ts)$/.test(entry.name)) { excluded++; continue; }
      if (!extensions.has(extname(entry.name).toLowerCase()) && !manifests.has(entry.name)) continue;
      try {
        if ((await stat(path)).size > 1_000_000) { warnings.push(`Skipped file larger than 1 MB: ${relative(root, path)}`); continue; }
        files.push({ path: relative(root, path).replace(/\\/g, "/"), source: await readFile(path, "utf8") });
      } catch { warnings.push(`Could not read file: ${relative(root, path)}`); }
    }
  }
  await walk(root);
  return { files, excluded, warnings };
}

function plain(value: string): string { return value.trim().replace(/^['"]|['"]$/g, ""); }
function yamlValue(source: string, key: string): string { return plain(source.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1] ?? ""); }

export function projectOverview(root: string, files: SourceFile[], excluded: number, warnings: string[]): ProjectOverview {
  const project: ProjectOverview = { name: basename(root), description: "", features: [], stack: [], components: [], content: [], commands: [], connections: [], documents: [], languages: {}, excluded, warnings: [...warnings] };
  const readme = files.find(f => /^readme\.md$/i.test(f.path));
  if (readme) {
    project.name = readme.source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? project.name;
    const paragraphs = readme.source.replace(/^# .+\r?\n/, "").trim().split(/\r?\n\s*\r?\n/);
    project.description = paragraphs.find(p => !/^(#|```|\[!|<|[-*]|todo\b|tbd\b|coming soon\b)/im.test(p))?.replace(/\r?\n/g, " ") ?? "";
    let featureSection = false;
    for (const line of readme.source.split(/\r?\n/)) {
      if (/^#{1,6} /.test(line)) featureSection = /features|functionality|what works|what it does|capabilities/i.test(line);
      else if (featureSection && /^[-*] /.test(line)) project.features.push({ name: line.slice(2), detail: line.slice(2), file: readme.path });
      else if (featureSection && /^\|/.test(line) && !/^\|?\s*:?-{3,}/.test(line)) {
        const cells = line.split("|").slice(1, -1).map(value => value.trim());
        if (cells.length >= 2 && !/^(capability|feature|description)$/i.test(cells[0])) project.features.push({ name: cells[0], detail: cells[1], file: readme.path });
      }
    }
  }
  const known: Record<string, string> = { "craftcms/cms": "Craft CMS", "laravel/framework": "Laravel", "yiisoft/yii2": "Yii", "flask": "Flask", "django": "Django", "fastapi": "FastAPI", "mysql-connector-python": "MySQL connector", "pysnmp": "SNMP", "express": "Express", "sequelize": "Sequelize", "react": "React", "next": "Next.js", "vue": "Vue", "tailwindcss": "Tailwind CSS", "alpinejs": "Alpine.js", "gulp": "Gulp", "typescript": "TypeScript", "craftcms/aws-s3": "AWS S3 integration", "craftcms/ckeditor": "CKEditor", "miranj/craft-router": "Craft Router" };
  const languages: Record<string, string> = { ".php": "PHP", ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".twig": "Twig", ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".sql": "SQL" };
  for (const file of files) {
    const language = languages[extname(file.path)];
    if (language) project.languages[language] = (project.languages[language] ?? 0) + 1;
    if (/\.md$/i.test(file.path) && isProjectDocument(file.path)) project.documents.push(file.path);
    if (/(^|\/)(package|composer)\.json$/.test(file.path)) {
      try {
        const manifest = JSON.parse(file.source);
        if (!project.description && !file.path.includes("/") && typeof manifest.description === "string" && !isFrameworkBoilerplate(manifest.description, manifest.name)) project.description = manifest.description;
        const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.require, ...manifest["require-dev"] };
        for (const [name, version] of Object.entries(deps)) project.stack.push({ name: known[name.toLowerCase()] ?? name, detail: `Dependency: ${name} ${version}`, file: file.path });
        for (const name of Object.keys(manifest.scripts ?? {})) project.commands.push({ name: `${file.path.endsWith("composer.json") ? "composer run-script" : "npm run"} ${name}`, detail: "Declared script; run from the manifest directory. Not executed during analysis.", file: file.path });
      } catch { project.warnings.push(`Invalid JSON manifest: ${file.path}`); }
    }
    if (basename(file.path) === "requirements.txt") {
      for (const line of file.source.split(/\r?\n/)) {
        const dep = line.match(/^([\w-]+)\s*([<>=!~].*)?$/);
        if (dep) project.stack.push({ name: known[dep[1].toLowerCase()] ?? dep[1], detail: `Declared Python dependency ${dep[2] ?? "(unversioned)"}`, file: file.path });
      }
      project.commands.push({ name: "pip install -r requirements.txt", detail: "Installs the declared Python dependencies; use a virtual environment.", file: file.path });
    }
    if (/config\/project\/(sections|globalSets)\/[^/]+\.yaml$/.test(file.path)) {
      const name = yamlValue(file.source, "name"); const handle = yamlValue(file.source, "handle"); const type = yamlValue(file.source, "type");
      const template = file.source.match(/^\s+template:\s+(.+)$/m)?.[1];
      const uri = file.source.match(/^\s+uriFormat:\s+(.+)$/m)?.[1];
      if (name) project.content.push({ name, detail: `Craft content configuration; handle: ${handle || "unspecified"}${type ? `; type: ${type}` : ""}${template ? `; template: ${plain(template)}` : ""}${uri ? `; URI pattern: ${plain(uri)}` : ""}.`, file: file.path });
    }
    if (extname(file.path) === ".py") {
      const description = file.source.match(/^\s*(?:#![^\n]*\n)?\s*(?:"""|''')([\s\S]*?)(?:"""|''')/)?.[1]?.trim().split(/\r?\n\s*\r?\n/)[0];
      const functions = [...file.source.matchAll(/^(?:async )?def (\w+)\s*\(/gm)].map(m => m[1]);
      const classes = [...file.source.matchAll(/^class (\w+)/gm)].map(m => m[1]);
      project.components.push({ name: basename(file.path), detail: [description?.replace(/\r?\n/g, " "), classes.length ? `Classes: ${classes.join(", ")}.` : "", functions.length ? `Top-level functions: ${functions.join(", ")}.` : ""].filter(Boolean).join(" ") || "Python module; responsibility needs review.", file: file.path });
      for (const imported of file.source.matchAll(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
        const module = imported[1] ?? imported[2];
        const target = files.find(f => f.path === `${module.replace(/\./g, "/")}.py`);
        if (target) project.connections.push({ name: `${file.path} → ${target.path}`, detail: "Local Python import; indicates a module dependency, not execution order.", file: file.path });
      }
      if (/if\s+__name__\s*==\s*["']__main__["']/.test(file.source)) project.commands.push({ name: `python ${file.path}`, detail: "Contains a script entry point. Required arguments and configuration must be checked in the source or README before running.", file: file.path });
    }
    if (/\.php$/.test(file.path) && /(?:modules|controllers|services)\//.test(file.path)) {
      const className = file.source.match(/\bclass\s+(\w+)/)?.[1];
      const methods = [...file.source.matchAll(/public\s+(?:static\s+)?function\s+(\w+)/g)].map(m => m[1]);
      if (className) project.components.push({ name: className, detail: `PHP class${methods.length ? `; public methods: ${methods.join(", ")}` : ""}. Responsibility is indicated by the declaration; behavior needs code review.`, file: file.path });
    }
  }
  for (const [language, count] of Object.entries(project.languages)) project.stack.unshift({ name: language, detail: `${count} first-party files`, file: files.find(f => languages[extname(f.path)] === language)!.path });
  const directories = [...new Set(files.filter(f => f.path.includes("/")).map(f => f.path.split("/")[0]))];
  for (const directory of directories) {
    const members = files.filter(f => f.path.startsWith(`${directory}/`));
    project.components.push({ name: `${directory}/`, detail: members.slice(0, 5).map(f => f.path).join(", "), file: members[0].path });
  }
  inferProjectContext(project, files);
  return project;
}


function isFrameworkBoilerplate(description: string, packageName: unknown): boolean {
  return /^(?:the )?(?:laravel|symfony|django|flask|express|react|next(?:\.js)?)\s+(?:framework|application|project)\.?$/i.test(description.trim()) || packageName === "laravel/laravel";
}

function isProjectDocument(path: string): boolean {
  if (path === "README.md") return true;
  if (/(?:^|\/)(?:public|assets|tinymce|ckeditor|node_modules|vendor)(?:\/|$)/i.test(path)) return false;
  // A README in an immediate application subproject is useful; deeper README
  // files are commonly copied third-party documentation.
  return /(^|\/)README\.md$/i.test(path) && path.split("/").length <= 2;
}
