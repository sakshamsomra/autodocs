import ts from "typescript";
import type { ProjectOverview, Evidence } from "./types.js";
import type { SourceFile } from "./project.js";

const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();

/** Extract project-owned labels and declarations, without assigning a business category. */
export function inferProjectContext(project: ProjectOverview, files: SourceFile[]): void {
  const headings: Evidence[] = [];
  const operations: Evidence[] = [];
  for (const file of files) {
    if (/(?:^|\/)(?:public|vendor|node_modules|tests?|platform)(?:\/|$)/i.test(file.path) || /\.(?:test|spec)\./i.test(file.path)) continue;
    if (!/\.[cm]?[jt]sx?$/i.test(file.path)) continue;
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, /\.[cm]?tsx?$/i.test(file.path) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && /^h[1-3]$/.test(node.openingElement.tagName.getText(ast))) {
        const label = node.children.filter(ts.isJsxText).map(n => n.text.trim()).join(" ").trim();
        if (label && label.length < 100 && node.children.every(ts.isJsxText)) headings.push({ name: label, detail: label, file: file.path });
      }
      let name: string | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) name = node.name.text;
      // Named operations are recorded as declarations, not promises of behavior.
      if (name && /[a-z][A-Z]|_/.test(name) && !name.startsWith("_")) operations.push({ name: words(name), detail: `Operation: ${name}`, file: file.path });
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const readme = files.find(f => /^readme\.md$/i.test(f.path));
  const authoredTitle = readme?.source.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!authoredTitle && headings.length === 1) project.name = headings[0].name;
  if (!project.features.length) {
    const candidates = headings.length ? headings : operations;
    project.features = [...new Map(candidates.map(f => [f.name, f])).values()].slice(0, 16);
  }
  if (!project.description) {
    if (authoredTitle) project.description = `${authoredTitle.replace(/\.$/, "")}.`;
    else if (project.features.length) project.description = `${project.name} includes ${project.features.slice(0, 6).map(f => f.name).join(", ")}.`;
    else if (project.content.length) project.description = `${project.name} contains ${project.content.map(f => f.name).join(", ")}.`;
    else project.description = project.name;
  }
}
