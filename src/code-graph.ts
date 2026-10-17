import ts from "typescript";
import type { SourceFile } from "./project.js";

export interface CodeCall {
  label: string;
  line: number;
  target?: string;
  callback?: boolean;
}
export interface CodeNode {
  id: string;
  file: string;
  label: string;
  line: number;
  endLine: number;
  kind: "function" | "route";
  calls: CodeCall[];
  notes?: string[];
  documentation?: { text: string; subject: string; line: number };
}

/** An in-memory compiler host: never loads project config, libraries, plugins or application code. */
export function buildCodeGraph(files: SourceFile[]): CodeNode[] {
  const prefix = "/__autodocs__/";
  const sources = new Map(files.filter(file => /\.[cm]?[jt]sx?$/i.test(file.path)).map(file => {
    const path = prefix + file.path;
    return [path, ts.createSourceFile(path, file.source, ts.ScriptTarget.Latest, true)];
  }));
  if (!sources.size) return [];
  const directories = new Set<string>();
  for (const name of sources.keys()) {
    const segments = name.split("/");
    for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join("/"));
  }
  const host: ts.CompilerHost = {
    getSourceFile: name => sources.get(name),
    getDefaultLibFileName: () => prefix + "__no_lib__.d.ts",
    writeFile: () => {}, getCurrentDirectory: () => prefix,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n", fileExists: name => sources.has(name),
    readFile: name => sources.get(name)?.text,
    directoryExists: name => directories.has(name.replace(/\/$/, "")),
  };
  const program = ts.createProgram([...sources.keys()], {
    allowJs: true, noLib: true, noEmit: true, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  }, host);
  const checker = program.getTypeChecker();
  const nodes: CodeNode[] = [];
  const declarations = new Map<ts.Node, CodeNode>();
  const bodies = new Map<CodeNode, ts.Node>();
  const registrations: ts.CallExpression[] = [];
  const mounts: { parent: ts.Symbol; child: ts.Symbol; path: string; note: string }[] = [];
  const routers = new Set<ts.Symbol>();
  const walk = (node: ts.Node, visit: (node: ts.Node) => void) => { visit(node); node.forEachChild(child => walk(child, visit)); };
  const line = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    let found = checker.getSymbolAtLocation(node);
    if (found && found.flags & ts.SymbolFlags.Alias) found = checker.getAliasedSymbol(found);
    return found;
  };
  const objectSymbol = (node: ts.Node, seen = new Set<ts.Symbol>()): ts.Symbol | undefined => {
    const found = symbol(node);
    if (!found || seen.has(found)) return found;
    seen.add(found);
    for (const declaration of found.declarations ?? []) {
      if (ts.isExportAssignment(declaration)) return objectSymbol(declaration.expression, seen);
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isIdentifier(declaration.initializer)) return objectSymbol(declaration.initializer, seen);
    }
    return found;
  };
  const importedFrom = (node: ts.Node): string | undefined => {
    // Inspect the local import, not its possibly missing external declaration.
    const found = checker.getSymbolAtLocation(node);
    for (const declaration of found?.declarations ?? []) {
      let current: ts.Node | undefined = declaration;
      while (current && !ts.isImportDeclaration(current)) current = current.parent;
      if (current && ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) return current.moduleSpecifier.text;
      let variable: ts.Node | undefined = declaration;
      while (variable && !ts.isVariableDeclaration(variable)) variable = variable.parent;
      if (variable && ts.isVariableDeclaration(variable) && variable.initializer && ts.isCallExpression(variable.initializer)) {
        const init = variable.initializer;
        if (init.expression.getText() === "require" && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) return init.arguments[0].text;
      }
    }
    return undefined;
  };
  const isFunction = (node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
  const functionName = (node: ts.Node): string => {
    if (ts.isConstructorDeclaration(node)) return `${(node.parent as ts.ClassDeclaration).name?.text ?? "class"}.constructor`;
    const named = node as ts.NamedDeclaration;
    if (named.name) {
      const owner = node.parent;
      const container = ts.isClassLike(owner) ? owner.name?.text
        : ts.isObjectLiteralExpression(owner) && ts.isVariableDeclaration(owner.parent) ? owner.parent.name.getText() : undefined;
      return [container, named.name.getText()].filter(Boolean).join(".");
    }
    if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
    if (ts.isPropertyDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) return functionName(node.parent);
    if (ts.isExportAssignment(node.parent)) return "default";
    return `callback@${line(node)}`;
  };
  for (const source of sources.values()) walk(source, node => {
    if (isFunction(node) && node.body) {
      const item: CodeNode = { id: `${source.fileName}:${node.pos}`, file: source.fileName.slice(prefix.length),
        label: functionName(node), line: line(node), endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
        kind: "function", calls: [] };
      nodes.push(item); declarations.set(node, item); bodies.set(item, node.body);
      const documented = [node, ...(ts.isClassLike(node.parent) ? [node.parent] : [])].find(candidate => ts.getJSDocCommentsAndTags(candidate).some(ts.isJSDoc));
      if (documented) {
        const doc = ts.getJSDocCommentsAndTags(documented).find(ts.isJSDoc)!;
        const text = ts.getTextOfJSDocComment(doc.comment)?.trim();
        if (text) item.documentation = { text, subject: documented === node ? item.label : (documented as ts.ClassDeclaration).name?.text ?? item.label, line: line(doc) };
      }
      if (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent)) declarations.set(node.parent, item);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && (ts.isCallExpression(node.initializer) || ts.isNewExpression(node.initializer))) {
      const expression = node.initializer.expression;
      const root = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
      const module = importedFrom(root);
      const key = objectSymbol(node.name);
      if (key && module && /^(?:express|fastify|koa-router|@koa\/router)$/.test(module) &&
        (!ts.isPropertyAccessExpression(expression) || expression.name.text === "Router")) routers.add(key);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) registrations.push(node);
  });

  const resolveReference = (expression: ts.Node): CodeNode | undefined => {
    const direct = declarations.get(expression);
    if (direct) return direct;
    // Binding a method preserves the referenced handler; other wrappers are not assumed to.
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "bind") return resolveReference(expression.expression.expression);
    const found = symbol(expression);
    const candidates = (found?.declarations ?? []).map(declaration => declarations.get(declaration)).filter((value): value is CodeNode => !!value);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  for (const [owner, body] of bodies) {
    const visit = (node: ts.Node) => {
      // A callback body is not an unconditional call from its enclosing function.
      if (isFunction(node)) return;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        // Evaluate nested argument calls first; the tree is still not a runtime trace.
        node.forEachChild(visit);
        if (node.expression.getText() === "require") return;
        const signature = checker.getResolvedSignature(node);
        const target = signature?.declaration ? declarations.get(signature.declaration) : undefined;
        const resolved = target ?? resolveReference(node.expression);
        let label = node.expression.getText().replace(/\s+/g, " ");
        if (label.length > 100 || !/^[\w$.[\]?!]+$/.test(label)) label = "dynamic call";
        owner.calls.push({ label: `${ts.isNewExpression(node) ? "new " : ""}${label}()`, line: line(node), target: resolved?.id });
        for (const argument of node.arguments ?? []) {
          const callback = resolveReference(argument);
          if (callback) owner.calls.push({ label: `${callback.label}()`, line: line(argument), target: callback.id, callback: true });
        }
        return;
      }
      node.forEachChild(visit);
    };
    visit(body);
  }

  for (const call of registrations) {
    const member = call.expression as ts.PropertyAccessExpression;
    const parent = objectSymbol(member.expression);
    if (!parent || !routers.has(parent) || member.name.text !== "use") continue;
    const first = call.arguments[0];
    const path = first && ts.isStringLiteralLike(first) ? first.text : "";
    for (const argument of call.arguments.slice(path ? 1 : 0)) {
      const child = objectSymbol(argument);
      if (child && routers.has(child)) {
        const firstIsHandler = first && (isFunction(first) || checker.getTypeAtLocation(first).getCallSignatures().length > 0);
        const unknown = first && !ts.isStringLiteralLike(first) && objectSymbol(first) !== child && !firstIsHandler;
        const location = `${call.getSourceFile().fileName.slice(prefix.length)}:${line(call)}`;
        mounts.push({ parent, child, path, note: `${unknown ? "Mount prefix unresolved at" : "Mounted via"} ${location}` });
      }
    }
  }
  const prefixes = (router: ts.Symbol, seen = new Set<ts.Symbol>()): { path: string; notes: string[] }[] => {
    if (seen.has(router) || seen.size > 10) return [{ path: "", notes: ["Mount prefix unresolved: cyclic or deeply nested mounts."] }];
    const next = new Set(seen).add(router);
    const parents = mounts.filter(mount => mount.child === router);
    return parents.length ? parents.slice(0, 20).flatMap(mount => prefixes(mount.parent, next).map(prefix => ({ path: prefix.path + mount.path, notes: [...prefix.notes, mount.note] }))).slice(0, 20) : [{ path: "", notes: [] }];
  };
  for (const call of registrations) {
    const member = call.expression as ts.PropertyAccessExpression;
    const router = objectSymbol(member.expression);
    const route = call.arguments[0];
    if (!router || !routers.has(router) || !/^(?:get|post|put|patch|delete|head|options|all)$/.test(member.name.text) || !route || !ts.isStringLiteralLike(route)) continue;
    const calls: CodeCall[] = call.arguments.slice(1).flatMap(argument => {
      if (ts.isArrayLiteralExpression(argument)) return argument.elements.map(element => ({ element, target: resolveReference(element) }));
      return [{ element: argument, target: resolveReference(argument) }];
    }).map(({ element, target }) => ({ label: target ? `${target.label}()` : `${element.getText().replace(/\s+/g, " ").slice(0, 80)} [handler unresolved]`, line: line(element), target: target?.id }));
    const paths = prefixes(router);
    for (const { path, notes } of paths) nodes.push({ id: `${call.getSourceFile().fileName}:route:${call.pos}:${path}`,
      file: call.getSourceFile().fileName.slice(prefix.length), label: `${member.name.text.toUpperCase()} ${(path + route.text).replace(/\/{2,}/g, "/")}`,
      line: line(call), endLine: call.getSourceFile().getLineAndCharacterOfPosition(call.end).line + 1, kind: "route", calls, notes });
  }
  return nodes;
}
