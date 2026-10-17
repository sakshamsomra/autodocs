import { lstat } from "node:fs/promises";
import { discover, type SourceFile } from "./project.js";
import { inspectSources, type SourceAdapter } from "./inspection.js";
import { buildCodeGraph, type CodeNode } from "./code-graph.js";
import { renderAnswer, type AskMatch } from "./ask-output.js";
import { startupAnswer } from "./startup.js";

const stopWords = new Set("a an the and or to of in on at by for from with without is are was were be been being do does did can could would should will shall i me my we our you your this that these those it its they them their how what which where when why who work works working happen happens happening explain describe tell show find code codebase project repository file files function functions method methods please used use using implemented implementation handle handles handling".split(" "));
const synonyms = [
  "authentication authenticate auth login signin jwt oauth bcrypt password session",
  "authorization authorize permission permissions role roles access rbac guard",
  "database persistence storage db sql query repository model schema table collection",
  "configuration configure config settings environment env",
  "payment payments billing charge checkout stripe transaction refund",
  "email mail smtp notification sendgrid mailgun",
  "error errors exception exceptions failure failed catch throw retry",
  "logging logs logger log tracing telemetry",
  "cache caching cached redis memcached ttl",
  "queue queued job jobs worker background task schedule cron",
  "upload uploads attachment multipart fileupload",
  "test tests testing spec assert assertion",
  "deployment deploy docker container compose kubernetes hosting",
  "discovery discover",
  "exclusion exclude skip ignore",
];
const stem = (word: string) => word.length > 5 ? word.replace(/ies$/, "y").replace(/(?:ing|ed|s)$/, "").replace(/e$/, "") : word;
function tokens(value: string): string[] {
  return (value.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
}
const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "");

/** Best-effort redaction before indexing, not a substitute for a secret scanner. Preserve line numbers. */
function redact(source: string): string {
  return clean(source)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, value => value.replace(/[^\r\n]/g, "*"))
    .replace(/((?:["']?[\w.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)[\w.-]*["']?)\s*[:=]\s*)(["'`])([^\r\n]*?)\2/gi, "$1$2[redacted]$2")
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/:'"`]+:[^\s/@'"`]+@/gi, "$1[redacted]@");
}

export async function askProject(root: string, question: string, adapters: SourceAdapter[] = []): Promise<string> {
  if (!(await lstat(root)).isDirectory()) throw new Error("The ask search path must be a project directory.");
  const discovery = await discover(root);
  return answerQuestion(question, discovery.files, adapters, discovery.warnings);
}

/** Local retrieval + static relationships, deliberately independent of a hosted model or a particular stack. */
export function answerQuestion(question: string, input: SourceFile[], adapters: SourceAdapter[] = [], warnings: string[] = []): string {
  question = clean(question).trim();
  if (!question) throw new Error('A question is required. Example: autodocs ask "How does authentication work?"');
  if (question.length > 2000) throw new Error("Please keep the question under 2,000 characters.");
  const terms = [...new Set(tokens(question).filter(token => !stopWords.has(token) && !stopWords.has(token + "s") && token.length > 1))];
  const weights = new Map(terms.map(term => [term, 1]));
  for (const group of synonyms) {
    const words = tokens(group);
    if (words.some(word => weights.get(word) === 1)) for (const word of words) if (!weights.has(word)) weights.set(word, 0.45);
  }
  // Discovery already skips dependency/build/data directories. Also suppress explicitly secret-named source/config files.
  const files = input.filter(file => !file.path.split(/[\\/]/).some(part => /^(?:\.env)(?:\.|$)/i.test(part) || /(?:^|[._-])(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part)))
    .map(file => ({ path: clean(file.path), source: redact(file.source) }));
  const startup = startupAnswer(question, files);
  if (startup) return startup;
  const sources = inspectSources(files, adapters);
  const vocabulary = files.map(file => new Set(tokens(file.path + " " + file.source)));
  for (const [term, weight] of weights) {
    const frequency = vocabulary.filter(words => words.has(term)).length;
    // Ubiquitous vocabulary (e.g. "source" in a compiler) should not overwhelm a specific feature.
    weights.set(term, weight * Math.log(1 + (files.length - frequency + 0.5) / (frequency + 0.5)));
  }
  const score = (value: string) => {
    const found = new Map<string, number>();
    for (const token of tokens(value)) if (weights.has(token)) found.set(token, (found.get(token) ?? 0) + 1);
    let total = 0;
    for (const [token, count] of found) total += weights.get(token)! * (1 + Math.log(Math.min(count, 3)));
    return total;
  };
  const ranked: AskMatch[] = files.map((file, i) => {
    const insight = sources[i];
    const lines = file.source.split(/\r?\n/);
    const lineScores = lines.map(line => score(line));
    const facts = [insight.purpose, ...insight.declarations, ...insight.endpoints, ...insight.tables, ...insight.databases, ...insight.configuration].join(" ");
    return { file, insight, lines, lineScores, score: score(file.path) * 2 + score(facts) * 0.5 + score(file.source) * 0.5 + lineScores.reduce((max, value) => Math.max(max, value), 0) * 2 };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const output = ["CODEBASE ANSWER", question, "", "ANSWER"];
  if (!terms.length || !ranked.length) {
    output.push("No relevant source evidence found in the scanned files.", "Try a feature, symbol, route, table or configuration name, or select another project with --path.");
    if (warnings.length) output.push("", "SCAN WARNINGS", ...warnings.map(warning => `- ${clean(warning)}`));
    output.push("", "VERDICT", "Insufficient source evidence to answer this question. This does not prove the feature is absent.", "", `Searched ${files.length} files. Excluded or runtime-generated code is not searchable.`);
    return output.join("\n") + "\n";
  }

  const graph = buildCodeGraph(files);
  const byId = new Map(graph.map(node => [node.id, node]));
  const fileLines = new Map(files.map(file => [file.path, file.source.split(/\r?\n/)]));
  const nodeScores = new Map(graph.map(node => {
    const text = fileLines.get(node.file)!.slice(node.line - 1, node.endLine).join("\n");
    return [node.id, score(node.label) * 6 + score(node.file) + score(text)];
  }));
  const relationshipScores = new Map<string, number>();
  const relatedScore = (node: CodeNode, depth = 0): number => {
    if (depth > 5) return 0;
    const key = `${node.id}:${depth}`;
    const cached = relationshipScores.get(key);
    if (cached !== undefined) return cached;
    const value = Math.max(nodeScores.get(node.id) ?? 0, ...node.calls.slice(0, 30).map(call => call.target && byId.has(call.target) ? relatedScore(byId.get(call.target)!, depth + 1) * 0.8 : 0));
    relationshipScores.set(key, value);
    return value;
  };
  const functions = graph.filter(node => node.kind === "function" && !node.label.startsWith("callback@")).sort((a, b) => (nodeScores.get(b.id)! - nodeScores.get(a.id)!));
  const best = functions.find(node => nodeScores.get(node.id)! > 0);
  if (best) {
    const position = ranked.findIndex(match => match.file.path === best.file);
    if (position > 0) ranked.unshift(...ranked.splice(position, 1));
  }
  const wantsFlow = /\b(?:how|flow|trace|calls?|happens?|process|explain|used by|uses|caller)\b/i.test(question);
  const routes = graph.filter(node => node.kind === "route").map(node => ({ node, score: relatedScore(node) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  const roots = !wantsFlow ? [] : routes.length && routes[0].score >= (best ? nodeScores.get(best.id)! * 0.4 : 0)
    ? routes.slice(0, 2).map(item => item.node) : best ? [best] : [];
  return renderAnswer({ question, matches: ranked, graph, best, roots, files, warnings: warnings.map(clean), score });
}
