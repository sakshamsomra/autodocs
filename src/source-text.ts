import { extname, basename } from "node:path";
import type { SourceFile } from "./project.js";

export const languageExtensions: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", php: "PHP", java: "Java", kt: "Kotlin", kts: "Kotlin", cs: "C#", fs: "F#", fsx: "F#", go: "Go", rb: "Ruby", rs: "Rust",
  ex: "Elixir", exs: "Elixir", swift: "Swift", scala: "Scala", dart: "Dart", c: "C", h: "C/C++", cpp: "C++", cc: "C++", hpp: "C++",
  lua: "Lua", pl: "Perl", pm: "Perl", r: "R", jl: "Julia", hs: "Haskell", clj: "Clojure", cljs: "ClojureScript", erl: "Erlang", hrl: "Erlang",
  vue: "Vue", svelte: "Svelte", sql: "SQL", prisma: "Prisma", sh: "Shell", bash: "Shell", ps1: "PowerShell", graphql: "GraphQL", gql: "GraphQL",
};

/** Unknown source extensions are allowed, while known data/artifacts/secrets stay excluded. */
export function sourceCandidate(path: string): boolean {
  const name = basename(path).toLowerCase();
  const extension = extname(name).slice(1);
  if (!extension || name.startsWith(".") || /(?:^|[._-])(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[._-]|$)/.test(name)) return false;
  if (/^(?:json|jsonl|csv|tsv|txt|log|lock|map|md|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|ico|webp|avif|mp[34]|wav|ogg|zip|gz|tar|7z|rar|exe|dll|so|dylib|o|obj|class|jar|pyc|woff2?|ttf|pem|key|pfx|p12|crt|cer|env|db|sqlite3?|bak|dump|bin)$/i.test(extension)) return false;
  return true;
}

export function isTextSource(source: string): boolean {
  return !/[\x00-\x08\x0e-\x1f\ufffd]/.test(source);
}

export interface SourceLiteral { start: number; end: number; value: string }
export interface SourceComment { start: number; end: number; value: string }
export interface SourceText { code: string; literals: SourceLiteral[]; comments: SourceComment[] }

/** Preserve offsets and newlines while removing literal/comment contents from syntax matching. */
export function sourceText(file: SourceFile): SourceText {
  const source = file.source; const chars = source.split("");
  const extension = extname(file.path).toLowerCase();
  const hashComments = /\.(?:py|rb|php|sh|bash|ps1|r|pl|pm|ex|exs|jl|yaml|yml|toml)$/.test(extension);
  const dashComments = /\.(?:sql|lua|hs)$/.test(extension);
  const semicolonComments = /\.(?:clj|cljs|lisp|el)$/.test(extension);
  const literals: SourceLiteral[] = []; const comments: SourceComment[] = [];
  const blank = (start: number, end: number) => { for (let i = start; i < end; i++) if (!/[\r\n]/.test(chars[i])) chars[i] = " "; };
  let i = 0;
  while (i < source.length) {
    const lineComment = source.startsWith("//", i) || hashComments && source[i] === "#" || dashComments && source.startsWith("--", i) || semicolonComments && source[i] === ";";
    if (lineComment || source.startsWith("/*", i)) {
      const block = source.startsWith("/*", i);
      const stop = source.indexOf(block ? "*/" : "\n", i + (block ? 2 : 1));
      const end = stop < 0 ? source.length : stop + (block ? 2 : 0);
      comments.push({ start: i, end, value: source.slice(i, end).replace(/^\/\*+|\*\/$/g, "").replace(/^\s*(?:\/\/\/?|#|--|;|\*)\s?/gm, "").trim() });
      blank(i, end); i = end; continue;
    }
    const quote = source[i];
    if (!["'", '"', "`"].includes(quote)) { i++; continue; }
    // Rust lifetimes and Haskell/Clojure quote operators are not string literals.
    if (quote === "'" && /\.(?:rs|hs|clj|cljs)$/.test(extension) && !/^'(?:\\.|[^'\n])'/.test(source.slice(i))) { i++; continue; }
    const delimiter = source.slice(i, i + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
    const start = i; i += delimiter.length; const content = i;
    while (i < source.length) {
      if (source[i] === "\\" && quote !== "`") { i += 2; continue; }
      if (source.slice(i, i + delimiter.length) === delimiter) {
        if (delimiter.length === 1 && source[i + 1] === quote && (extension === ".sql" || source[start - 1] === "@")) { i += 2; continue; }
        break;
      }
      i++;
    }
    const end = Math.min(source.length, i + delimiter.length);
    literals.push({ start, end, value: source.slice(content, i) }); blank(start, end); i = end;
  }
  return { code: chars.join(""), literals, comments };
}
