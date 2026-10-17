import type { CodeCall, CodeNode } from "./code-graph.js";
import type { SourceFile } from "./project.js";
import type { SourceInsight } from "./types.js";
import { sourceText } from "./source-text.js";

export interface AskMatch {
  file: SourceFile;
  insight: SourceInsight;
  score: number;
  lines: string[];
  lineScores: number[];
}
interface AnswerContext {
  question: string;
  matches: AskMatch[];
  graph: CodeNode[];
  best?: CodeNode;
  roots: CodeNode[];
  files: SourceFile[];
  warnings: string[];
  score: (value: string) => number;
}

const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const symbolName = (value: string) => {
  const name = value.match(/(?:[\p{L}_$][\p{L}\p{N}_$]*[.:])*[\p{L}_$][\p{L}\p{N}_$]*(?=\s*\()/u)?.[0];
  return name ? `${name}()` : /^[\p{L}\p{N}_$.:@-]+$/u.test(value) ? value : "Unnamed operation";
};
const nodeName = (node: CodeNode) => node.kind === "route" ? compact(node.label) : symbolName(node.label + "()");
const nodeRef = (node: CodeNode) => `[${node.file}:${node.line}]`;
const sentenceList = (values: string[]) => values.length < 2 ? values.join("") : values.slice(0, -1).join(", ") + " and " + values.at(-1);
const knownApis: [RegExp, string][] = [
  [/@anthropic-ai\/sdk|anthropic/i, "Anthropic"], [/openai/i, "OpenAI"], [/google.*(?:genai|generative)|@google\/(?:genai|generative-ai)/i, "Google Gemini"],
  [/stripe/i, "Stripe"], [/cohere/i, "Cohere"], [/mistral/i, "Mistral AI"], [/@xai-org|xai/i, "xAI"], [/twilio/i, "Twilio"],
  [/@sendgrid|sendgrid/i, "SendGrid"], [/mailgun/i, "Mailgun"], [/aws-sdk|aws\./i, "AWS"],
];

export function utilityCall(label: string): boolean {
  return /^(?:new (?:Map|Set|Error|Promise)\b|(?:Object|Array|String|Number|Boolean|JSON|Math|console|Buffer|Date)\.|dynamic call\b)|\.(?:push|pop|map|flatMap|forEach|filter|sort|join|split|replace|match|matchAll|slice|startsWith|endsWith|includes|some|every|test|trim|toLowerCase|toUpperCase|localeCompare|add|has)\(/.test(label);
}

/** Present symbols and references, never source statements, bodies or argument values. */
export function renderAnswer(context: AnswerContext): string {
  const { question, matches, graph, best, roots, files, warnings, score } = context;
  let selected = matches.slice(0, 5);
  const byId = new Map(graph.map(node => [node.id, node]));
  const sourceLines = new Map(files.map(file => [file.path, file.source.split(/\r?\n/)]));
  const codeLines = new Map(files.map(file => [file.path, sourceText(file).code.split(/\r?\n/)]));
  const reference = (match: AskMatch, name?: string): string => {
    if (name) {
      const needle = name.replace(/^Environment: /, "").replace(/\(.*$/, "").toLowerCase();
      const codeIndex = codeLines.get(match.file.path)!.findIndex(line => line.toLowerCase().includes(needle));
      const index = codeIndex >= 0 ? codeIndex : match.lines.findIndex(line => line.toLowerCase().includes(needle));
      // Inspector facts without an exact source anchor get a file reference, not a fabricated line.
      return `[${match.file.path}${index >= 0 ? ":" + (index + 1) : ""}]`;
    }
    const index = match.lineScores.reduce((best, value, i, all) => value > all[best] ? i : best, 0);
    return `[${match.file.path}:${index + 1}]`;
  };
  const significant = (node: CodeNode) => node.calls.filter(call =>
    call.target && !call.label.startsWith("callback@") || !call.callback && (!utilityCall(call.label) || score(call.label) > 0));
  const callName = (call: CodeCall) => {
    const target = call.target ? byId.get(call.target) : undefined;
    // Unresolved route expressions may contain an entire inline object or body. Do not echo them.
    return target ? nodeName(target) : /^[\w$.[\]?!]+\(\)$/.test(call.label) ? call.label : "Unresolved call";
  };
  const calls = best ? [...new Set(significant(best).filter(call => !call.callback).map(callName))].slice(0, 4) : [];
  const factsFor = (match: AskMatch): { label: string; value: string }[] => {
    const source = match.insight;
    const groups: [string, string[]][] = [
      ["Configuration", source.configuration.map(value => value.split(/\s+=\s+/)[0])], ["Database provider", source.databases],
      ["External API", source.integrations], ["External SDK call", source.externalCalls],
      ["Storage reference", source.tables], ["Model", source.models.map(model => model.name)],
      ["Route", source.endpoints], ["Operation", source.operations.map(symbolName)],
      ["Observed call", source.calls.map(symbolName)],
    ];
    return groups.flatMap(([label, values]) => [...new Set(values)].map(value => ({ label, value: compact(value) })))
      .sort((a, b) => score(b.label + " " + b.value) - score(a.label + " " + a.value));
  };
  const allFacts = selected.flatMap(match => factsFor(match).map(fact => ({ ...fact, match })));
  const configurationQuestion = /\b(?:config\w*|settings?|environment|env)\b/i.test(question);
  const storageQuestion = /\b(?:database|db|persistence|storage|tables?|models?|schema|collections?)\b/i.test(question);
  const externalApiQuestion = /\b(?:api|apis|sdk)\b/i.test(question) &&
    /\b(?:external|third[ -]?party|vendor|provider|use|using|calls?|integrat\w*)\b/i.test(question) &&
    !/\b(?:endpoint|routes?)\b/i.test(question);
  const declaredDatabases = matches.flatMap(match => match.insight.databases.map(name => ({ name, match })));
  // A package manifest only says a driver is installed. Prefer imported drivers and explicit schema providers.
  const runtimeDatabases = declaredDatabases.filter(item => item.match.insight.coverage !== "metadata");
  const databaseEvidence = (runtimeDatabases.length ? runtimeDatabases : declaredDatabases)
    .filter(item => item.name && /\b(?:database|persistence|storage|tables?|models?|schema|collections?)\b/i.test(question));
  const apiEvidence = matches.flatMap(match => {
    const known = new Map<string, string>();
    for (const provider of match.insight.integrations) known.set(provider, provider);
    for (const dependency of match.insight.dependencies) for (const [pattern, provider] of knownApis) if (pattern.test(dependency.module)) known.set(provider, provider);
    for (const call of match.insight.externalCalls) {
      const provider = call.match(/^([^:]+):/)?.[1];
      if (provider) known.set(provider, provider);
    }
    return [...known.values()].map(name => ({ name, match }));
  });
  const relevantMatches = externalApiQuestion ? apiEvidence.map(item => item.match)
    : storageQuestion ? databaseEvidence.map(item => item.match) : [];
  if (relevantMatches.length) {
    const unique = [...new Map(relevantMatches.map(match => [match.file.path, match])).values()];
    selected = unique.sort((a, b) => {
      if (storageQuestion) {
        const priority = (match: AskMatch) => match.insight.coverage === "metadata" ? 0 : /\.prisma$/i.test(match.file.path) ? 1 : 2;
        return priority(b) - priority(a);
      }
      const priority = (match: AskMatch) => Number(match.insight.externalCalls.length > 0) * 2 + Number(match.insight.integrations.length > 0);
      return priority(b) - priority(a) || b.score - a.score;
    }).slice(0, 5);
  }
  const callerQuestion = /\b(?:who|what)\s+(?:calls?|uses?|invokes?)\b|\b(?:used by|callers?)\b/i.test(question);
  const callers = best ? graph.filter(node => node.calls.some(call => call.target === best.id)) : [];
  const focusedFacts = allFacts.filter(fact => configurationQuestion ? fact.label === "Configuration"
    : storageQuestion ? /Database|Storage|Model/.test(fact.label) : fact.label === "Operation").slice(0, 3);
  const factSummary = focusedFacts.map(fact => `${fact.value} ${reference(fact.match, fact.value)}`);
  let answer: string;
  let verdict: string;
  if (externalApiQuestion && apiEvidence.length) {
    const providers = [...new Map(apiEvidence.map(item => [item.name, item])).values()];
    answer = `External API${providers.length === 1 ? "" : "s"} detected: ${sentenceList(providers.map(item => `${item.name} ${reference(item.match, item.name)}`))}.`;
    verdict = `The code imports or calls ${sentenceList(providers.map(item => item.name))}. These are source declarations; this scan does not verify successful live requests.`;
  } else if (externalApiQuestion) {
    const httpMatches = matches.filter(match => match.insight.calls.some(call => /\b(?:fetch|axios|request)\b/i.test(call)) || match.insight.externalCalls.length);
    if (httpMatches.length) {
      selected = httpMatches.slice(0, 5);
      answer = `HTTP client usage is present in ${sentenceList(httpMatches.slice(0, 3).map(match => reference(match)))}; the external API provider or host is not identified in the scanned source.`;
    } else answer = "No external API provider was identified in the scanned source.";
    verdict = "Generic HTTP calls do not identify which external service they reach; the target may be set dynamically or in excluded configuration.";
  } else if (storageQuestion && databaseEvidence.length) {
    const byProvider = new Map<string, AskMatch[]>();
    for (const item of databaseEvidence) byProvider.set(item.name, [...(byProvider.get(item.name) ?? []), item.match]);
    const databaseEntries = [...byProvider].map(([name, sources]) => ({ name, sources, schema: sources.some(source => /\.prisma$/i.test(source.file.path)) }))
      .sort((a, b) => Number(a.sources[0].insight.coverage === "metadata") - Number(b.sources[0].insight.coverage === "metadata") || Number(a.schema) - Number(b.schema));
    const databaseSummary = databaseEntries.map(({ name, sources, schema }) => `${sources[0].insight.coverage === "metadata" ? "Manifest declares: " : schema ? "Prisma schema provider: " : "Runtime adapter/driver: "}${name} ${reference(sources[0], name)}`);
    answer = `Database detected: ${sentenceList(databaseSummary)}.`;
    const providers = databaseEntries.map(({ name }) => name);
    verdict = providers.length === 1 ? `${providers[0]} is the only database provider detected in the scanned declarations. A live connection was not tested.`
      : `Runtime code imports/initializes ${providers[0]}; the schema declares ${providers.slice(1).join(" and ")}. The source indicates the runtime adapter and schema provider, but does not verify the deployed connection.`;
  } else if (callerQuestion && best) {
    answer = callers.length ? `${nodeName(best)} is referenced by ${sentenceList(callers.slice(0, 4).map(node => `${nodeName(node)} ${nodeRef(node)}`))}.`
      : `No direct local callers of ${nodeName(best)} were resolved in the scanned code ${nodeRef(best)}.`;
    verdict = callers.length ? `Found ${callers.length} local caller/handler reference${callers.length === 1 ? "" : "s"} to ${nodeName(best)}. Callback references do not establish invocation; dynamic callers may be missing.`
      : `The declaration exists, but its callers are not established by this scan. This does not prove ${nodeName(best)} is unused.`;
  } else if ((configurationQuestion || storageQuestion) && factSummary.length) {
    answer = `The matching ${configurationQuestion ? "configuration references are" : "storage declarations/references are"} ${sentenceList(factSummary)}.`;
    verdict = `${configurationQuestion ? "Configuration is referenced through" : "The source identifies"} ${sentenceList(focusedFacts.map(fact => fact.value))}. ${configurationQuestion ? "Deployed values are not established by static source analysis." : "This does not verify a live database connection or its contents."}`;
  } else if (best) {
    const entry = roots.find(node => node.kind === "route");
    answer = entry ? `The matching request entry is ${nodeName(entry)} ${nodeRef(entry)}. The closest matching operation is ${nodeName(best)} ${nodeRef(best)}.`
      : `The closest matching implementation is ${nodeName(best)} ${nodeRef(best)}.`;
    if (calls.length) answer += ` It references ${sentenceList(calls)}.`;
    verdict = calls.length ? `${nodeName(best)} connects to ${sentenceList(calls)} in the source. These are static call relationships, not guaranteed runtime execution or successful behavior.`
      : `${nodeName(best)} is the strongest implementation match. No further relevant call path was resolved; its behavior cannot be concluded from the declaration alone.`;
    const documentation = best.documentation;
    // Only short prose descriptions belong in the answer, never fenced examples or source statements.
    if (documentation && !/[{};`]|\b(?:return|import|export|const|SELECT)\b/.test(documentation.text)) {
      const description = compact(documentation.text).slice(0, 220);
      answer += ` Documented role of ${documentation.subject}: ${description} [${best.file}:${documentation.line}]`;
      verdict = `Documented responsibility: ${description} ${verdict}`;
    }
    if (configurationQuestion || storageQuestion) verdict += ` No matching ${configurationQuestion ? "configuration" : "storage"} declaration was identified; that part of the question remains unresolved.`;
  } else {
    answer = factSummary.length ? `The matching operations are ${sentenceList(factSummary)}.`
      : `Relevant ${selected.every(match => match.insight.coverage === "metadata") ? "documentation/metadata" : "source"} matches are located in ${sentenceList(selected.slice(0, 3).map(match => reference(match)))}.`;
    verdict = factSummary.length ? `Start with ${sentenceList(focusedFacts.map(fact => fact.value))}. These operations match the question, but a cross-file execution path has not been established for this stack.`
      : "The scan found related references, but insufficient implementation evidence to answer the behavior conclusively. The source map is a starting point, not a verified flow.";
  }

  const output = ["CODEBASE ANSWER", question, "", "ANSWER", answer, ""];
  const box = (label: string) => {
    const text = compact(label);
    return [`┌${"─".repeat(text.length + 2)}┐`, `│ ${text} │`, `└${"─".repeat(text.length + 2)}┘`];
  };
  if (callerQuestion && best) {
    output.push("CALLER CHART", "Links mean a source reference to the operation, not verified invocation.", ...box(nodeName(best)), nodeRef(best));
    if (!callers.length) output.push("  └── No resolved local callers");
    for (const [index, caller] of callers.slice(0, 8).entries()) {
      const callbackOnly = caller.calls.filter(call => call.target === best.id).every(call => call.callback);
      output.push(`  ${index === Math.min(callers.length, 8) - 1 ? "└" : "├"}── referenced by ${nodeName(caller)} ${nodeRef(caller)}${callbackOnly ? " [callback reference]" : ""}`);
    }
    if (callers.length > 8) output.push(`  (${callers.length - 8} additional references omitted)`);
  } else if (roots.length && !configurationQuestion && !storageQuestion) {
    output.push("FLOW CHART", "Arrows mean calls/references, not guaranteed execution order. [?] = definition not resolved.");
    let remaining = 30;
    const render = (node: CodeNode, prefix: string, seen: Set<string>, depth: number) => {
      if (seen.has(node.id)) { output.push(prefix + "└── [recursive reference; stopped]"); return; }
      if (depth >= 6) { if (node.calls.length) output.push(prefix + "└── [depth limit reached]"); return; }
      const next = new Set(seen).add(node.id);
      const relevant = significant(node);
      const visible = relevant.slice(0, 7);
      for (const [index, call] of visible.entries()) {
        if (remaining-- <= 0) { output.push(prefix + "└── [additional calls omitted]"); return; }
        const target = call.target ? byId.get(call.target) : undefined;
        const last = index === visible.length - 1 && visible.length === relevant.length;
        const branch = last ? "└──► " : "├──► ";
        output.push(prefix + branch + callName(call) + " " + (target ? nodeRef(target) : `[${node.file}:${call.line}] [?]`) + (call.callback ? " [callback reference]" : ""));
        if (target) render(target, prefix + (last ? "     " : "│    "), next, depth + 1);
      }
      if (relevant.length > visible.length) output.push(prefix + `└── [${relevant.length - visible.length} additional calls omitted]`);
      if (!relevant.length && depth === 0) output.push(prefix + "└── No further relevant calls resolved");
    };
    for (const root of roots) {
      output.push(...box(nodeName(root)), nodeRef(root), ...(root.notes ?? []).map(note => "  " + note.replace(/^(Mounted via|Mount prefix unresolved at) (.+:\d+)$/, "$1 [$2]")));
      render(root, "", new Set(), 0);
      output.push("");
    }
    output.push("RELATED FILES", ...selected.map(match => `- ${reference(match)} (${match.insight.language})`));
  } else {
    output.push("SOURCE MAP", "Grouped source facts; connecting lines do not imply execution order.", ...box(configurationQuestion ? "Configuration" : storageQuestion ? "Storage" : "Matching sources"));
    for (const [index, match] of selected.entries()) {
      const last = index === selected.length - 1;
      const prefix = last ? "     " : "│    ";
      output.push(`${last ? "└" : "├"}── ${reference(match)} (${match.insight.language})`);
      const facts = factsFor(match).filter(fact => externalApiQuestion ? /External API|External SDK/.test(fact.label)
        : storageQuestion ? /Database|Storage|Model/.test(fact.label) : !configurationQuestion || fact.label === "Configuration").slice(0, 4);
      const importers = matches.filter(candidate => candidate.insight.dependencies.some(dependency => dependency.targets.includes(match.file.path))).slice(0, 2);
      const details = facts.map(fact => `${fact.label}: ${fact.value} ${reference(match, fact.value)}`);
      for (const importer of importers) {
        const dependency = importer.insight.dependencies.find(item => item.targets.includes(match.file.path))!;
        const line = sourceLines.get(importer.file.path)!.findIndex(text => text.includes(dependency.module));
        details.push(`Imported by [${importer.file.path}${line >= 0 ? ":" + (line + 1) : ""}] (dependency only)`);
      }
      if (!details.length) details.push(match.insight.coverage === "metadata" ? "Documentation/metadata match; implementation not verified" : "Text match; no structured relationship resolved");
      for (const [i, detail] of details.entries()) output.push(prefix + (i === details.length - 1 ? "└── " : "├── ") + detail);
    }
  }
  output.push("", "VERDICT", verdict, "", `Scope: Searched ${files.length} files locally; showing ${selected.length} of ${matches.length} matching files. No code execution or upload.`,
    "Static evidence only. Utility calls may be omitted; dynamic/injected behavior can remain unresolved.");
  if (warnings.length) output.push("", "SCAN WARNINGS", ...warnings.map(warning => `- ${warning}`));
  return output.join("\n") + "\n";
}
