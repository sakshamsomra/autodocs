import { basename, extname } from "node:path";
import type { Service } from "./types.js";

const VERBS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

/**
 * Route adapters for common static framework declarations. These adapters only
 * report literal paths and explicit verbs; runtime-generated routes are ignored.
 */
export function frameworkService(source: string, file: string): Service | undefined {
  const extension = extname(file).toLowerCase();
  const methods = new Set<string>();
  const add = (verb: string, path: string) => methods.add(`${verb.toUpperCase()} ${normalizePath(path)}`);

  if ([".py"].includes(extension)) {
    const decorator = new RegExp(`@(?:[\\w.]+\\.)?(get|post|put|patch|delete|head|options)\\s*\\(\\s*["']([^"']+)["']`, "gi");
    for (const match of source.matchAll(decorator)) add(match[1], match[2]);
    const route = /@(?:[\w.]+\.)?route\s*\(\s*["']([^"']+)["']([\s\S]*?)\)\s*\r?\n\s*(?:async\s+)?def\s+\w+/gi;
    for (const match of source.matchAll(route)) {
      const verbs = [...match[2].matchAll(new RegExp(`["'](${VERBS})["']`, "gi"))].map(item => item[1]);
      for (const verb of verbs.length ? verbs : ["GET"]) add(verb, match[1]);
    }
    for (const match of source.matchAll(/\b(?:path|re_path)\s*\(\s*["']([^"']+)["']/g)) add("ROUTE", match[1]);
  }

  if ([".php"].includes(extension)) {
    for (const match of source.matchAll(/\bRoute::(get|post|put|patch|delete|options|any|match)\s*\(\s*["']([^"']+)["']/gi)) {
      if (match[1].toLowerCase() === "any") for (const verb of ["GET", "POST", "PUT", "PATCH", "DELETE"]) add(verb, match[2]);
      else if (match[1].toLowerCase() !== "match") add(match[1], match[2]);
    }
    for (const match of source.matchAll(/#\[Route\s*\(\s*["']([^"']+)["']([\s\S]*?)\)\]/gi)) {
      const verbs = [...match[2].matchAll(new RegExp(`["'](${VERBS})["']`, "gi"))].map(item => item[1]);
      for (const verb of verbs.length ? verbs : ["GET"]) add(verb, match[1]);
    }
  }

  if ([".java", ".kt", ".kts"].includes(extension)) {
    const mappings = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']([^)]*)\)/gi;
    for (const match of source.matchAll(mappings)) {
      const declared = match[1].toUpperCase();
      if (declared !== "REQUEST") add(declared, match[2] || "/");
      else {
        const verbs = [...match[3].matchAll(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/gi)].map(item => item[1]);
        for (const verb of verbs.length ? verbs : ["ANY"]) add(verb, match[2] || "/");
      }
    }
    if (/\bio\.ktor\b|\bktor\.|\brouting\s*\{/.test(source)) for (const match of source.matchAll(/\b(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi)) add(match[1], match[2]);
  }

  if ([".cs", ".fs"].includes(extension)) {
    for (const match of source.matchAll(/\[Http(Get|Post|Put|Patch|Delete|Head|Options)(?:\s*\(\s*["']([^"']*)["']\s*\))?\]/gi)) add(match[1], match[2] || "/");
    for (const match of source.matchAll(/\.Map(Get|Post|Put|Patch|Delete|Methods)\s*\(\s*["']([^"']+)["']/gi)) add(match[1] === "Methods" ? "ANY" : match[1], match[2]);
  }

  if (extension === ".go") {
    for (const match of source.matchAll(/\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*["`]([^"`]+)["`]/g)) add(match[1], match[2]);
    for (const match of source.matchAll(/HandleFunc\s*\(\s*["`]([^"`]+)["`][\s\S]{0,200}?Methods\s*\(([^)]*)\)/g)) {
      for (const verb of match[2].match(new RegExp(VERBS, "gi")) ?? ["ANY"]) add(verb, match[1]);
    }
    for (const match of source.matchAll(/(?:http\.)?HandleFunc\s*\(\s*["`]([^"`]+)["`]/g)) add("ANY", match[1]);
  }

  if ([".rb"].includes(extension)) {
    for (const match of source.matchAll(/^\s*(get|post|put|patch|delete|head|options)\s+["']([^"']+)["']/gim)) add(match[1], match[2]);
    for (const match of source.matchAll(/^\s*resources?\s+:(\w+)/gim)) methods.add(`RESOURCE /${match[1]}`);
  }

  if (extension === ".rs") {
    for (const match of source.matchAll(/#\[(get|post|put|patch|delete|head)\s*\(\s*["']([^"']+)["']\s*\)\]/gi)) add(match[1], match[2]);
    for (const match of source.matchAll(/\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|patch|delete)\s*\(/gi)) add(match[2], match[1]);
  }

  if ([".ex", ".exs"].includes(extension)) {
    for (const match of source.matchAll(/^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gim)) add(match[1], match[2]);
  }

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    for (const match of source.matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*["'`]([^"'`]*)["'`]\s*\)/g)) add(match[1], match[2] || "/");
    const nextRoute = file.match(/(?:^|\/)app\/(?:api\/)?(.+)\/route\.[cm]?[jt]sx?$/i)?.[1]?.replace(/\[(?:\.\.\.)?(\w+)\]/g, ":$1");
    if (nextRoute) for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) add(match[1], `/${nextRoute}`);
    if (/\bfastify\b/i.test(source)) for (const match of source.matchAll(/\b(?:fastify|server)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) add(match[1], match[2]);
    const hapiRoute = new RegExp(`\\bserver\\.route\\s*\\(\\s*\\{[\\s\\S]*?method\\s*:\\s*["'](${VERBS})["'][\\s\\S]*?path\\s*:\\s*["']([^"']+)["'][\\s\\S]*?\\}\\s*\\)`, "gi");
    for (const match of source.matchAll(hapiRoute)) add(match[1], match[2]);
  }

  const ordered = [...methods].sort((left, right) => source.indexOf(routePath(left)) - source.indexOf(routePath(right)));
  return ordered.length ? { name: basename(file, extension), methods: ordered } : undefined;
}

function normalizePath(path: string): string {
  const normalized = path.trim() || "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function routePath(method: string): string { return method.slice(method.indexOf(" ") + 1); }
