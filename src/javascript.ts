import ts from "typescript";
import { extname, basename } from "node:path";
import type { SourceFile } from "./project.js";
import type { SourceDependency, SourceInsight } from "./types.js";

const providers: [RegExp, string][] = [[/^stripe$/, "Stripe"], [/^(?:@aws-sdk\/|aws-sdk$)/, "AWS"], [/^twilio$/, "Twilio"], [/^(?:nodemailer|@sendgrid\/mail)$/, "Email provider"], [/^openai$/, "OpenAI"], [/^@google\/(?:genai|generative-ai)$/, "Google Gemini"], [/^(?:firebase-admin|@google-cloud\/)/, "Google Cloud"], [/^@supabase\//, "Supabase"], [/^@sentry\//, "Sentry"], [/^@slack\/web-api$/, "Slack"]];
export function inspectJavaScript(file: SourceFile): Partial<SourceInsight> {
  const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, /tsx?$/.test(file.path) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
  const dependencies: SourceDependency[] = []; const declarations: string[] = []; const operations: string[] = [];
  const calls = new Set<string>(); const configuration = new Set<string>(); const bindings = new Map<string, string>();
  let purpose = "";
  const addImport = (module: string, names: string[]) => {
    const provider = providers.find(([pattern]) => pattern.test(module))?.[1];
    dependencies.push({ module, names, display: module.startsWith(".") ? names.join(", ") || basename(module) : provider ?? module, targets: [] });
    if (provider) names.forEach(name => bindings.set(name, provider));
  };
  const doc = (node: ts.Node) => (ts.getLeadingCommentRanges(file.source, node.getFullStart()) ?? []).map(range => file.source.slice(range.pos, range.end)).find(value => value.startsWith("/**"))?.replace(/^\/\*\*|\*\/$/g, "").split(/\r?\n/).map(line => line.replace(/^\s*\*\s?/, "").trim()).filter(line => line && !line.startsWith("@"))[0];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const names = node.importClause?.name ? [node.importClause.name.text] : [];
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) names.push(named.name.text);
      if (named && ts.isNamedImports(named)) names.push(...named.elements.filter(item => !item.isTypeOnly).map(item => item.name.text));
      addImport(node.moduleSpecifier.text, names);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === "require" && node.initializer.arguments[0] && ts.isStringLiteral(node.initializer.arguments[0])) {
        const names = ts.isIdentifier(node.name) ? [node.name.text] : ts.isObjectBindingPattern(node.name) ? node.name.elements.map(item => item.name.getText(ast)) : [];
        addImport(node.initializer.arguments[0].text, names);
      }
      if (ts.isIdentifier(node.name) && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
        const provider = bindings.get(node.initializer.expression.text); if (provider) bindings.set(node.name.text, provider);
      }
      if (ts.isIdentifier(node.name) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) operations.push(`${node.name.text}(${node.initializer.parameters.map(p => p.name.getText(ast)).join(", ")})`);
    }
    if (ts.isClassDeclaration(node) && node.name) { declarations.push(node.name.text); purpose ||= doc(node) ?? ""; }
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) {
      const name = node.name.getText(ast); const summary = doc(node);
      operations.push(`${name}(${node.parameters.map(p => p.name.getText(ast) + (p.type ? `: ${p.type.getText(ast)}` : "")).join(", ")})${node.type ? ` -> ${node.type.getText(ast)}` : ""}${summary ? ` — ${summary}` : ""}`);
      if (ts.isFunctionDeclaration(node)) purpose ||= summary ?? "";
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) calls.add(node.expression.getText(ast));
    if (ts.isPropertyAccessExpression(node) && /^(?:process\.env|settings|config)$/.test(node.expression.getText(ast))) configuration.add(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const externalCalls = [...calls].flatMap(call => {
    const parts = call.split("."); const provider = bindings.get(parts[0]);
    return provider ? [provider === "Stripe" && parts[1] === "paymentIntents" ? "Stripe PaymentIntent API" : `${provider}: ${parts.slice(1).join(".")}`] : [];
  });
  return { name: declarations[0] ?? basename(file.path, extname(file.path)), purpose: purpose || (declarations.length ? `Defines ${declarations.join(", ")}${operations.length ? ` with operations ${operations.slice(0, 8).map(item => item.split("(")[0]).join(", ")}` : ""}.` : operations.length ? `Defines operations ${operations.slice(0, 8).map(item => item.split("(")[0]).join(", ")}.` : ""),
    declarations, operations, dependencies, calls: [...calls], externalCalls: [...new Set(externalCalls)], integrations: [...new Set(bindings.values())], configuration: [...configuration], notes: [] };
}
