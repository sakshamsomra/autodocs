import { posix } from "node:path";
import type { SourceFile } from "./project.js";
import { sourceText } from "./source-text.js";

interface Manifest {
  file: string;
  data: { name?: string; packageManager?: string; workspaces?: string[] | { packages?: string[] }; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; engines?: { node?: string } };
}

const readManifest = (file: SourceFile): Manifest | undefined => {
  if (!/(?:^|\/)package\.json$/i.test(file.path)) return undefined;
  try { return { file: file.path, data: JSON.parse(file.source) }; } catch { return undefined; }
};
const scripts = (manifest: Manifest) => Object.fromEntries(Object.entries(manifest.data.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const filesIn = (path: string, files: SourceFile[]) => files.filter(file => file.path.startsWith(path + "/"));
const manifestRef = (manifest: Manifest) => `[${manifest.file}]`;
const lineRef = (file: SourceFile, expression: RegExp) => {
  const match = expression.exec(file.source);
  return match ? `[${file.path}:${file.source.slice(0, match.index).split(/\r?\n/).length}]` : `[${file.path}]`;
};
const backendEntrypoint = (files: SourceFile[]) => files.find(file => /(?:^|\/)(?:server|index|main)\.[cm]?js$/i.test(file.path) &&
  /startServer\s*\(\s*\)\s*;?\s*$/.test(file.source) && /sequelize\.(?:authenticate|sync)/.test(file.source) && /\bcreateServer\s*\(|\bserver\.listen\s*\(/.test(file.source));

function packageManager(root: Manifest, files: SourceFile[]): "npm" | "pnpm" | "yarn" | "bun" {
  const declared = root.data.packageManager?.match(/^(npm|pnpm|yarn|bun)@/)?.[1];
  if (declared) return declared as ReturnType<typeof packageManager>;
  const names = new Set(files.map(file => posix.basename(file.path)));
  return names.has("pnpm-lock.yaml") ? "pnpm" : names.has("yarn.lock") ? "yarn" : names.has("bun.lockb") || names.has("bun.lock") ? "bun" : "npm";
}
function installCommand(manager: ReturnType<typeof packageManager>): string { return `${manager} install`; }
function workspaceCommand(manager: ReturnType<typeof packageManager>, name: string, script: string): string {
  if (manager === "npm") return `npm --workspace ${name} run ${script}`;
  if (manager === "yarn") return `yarn workspace ${name} ${script}`;
  if (manager === "pnpm") return `pnpm --filter ${name} run ${script}`;
  return `bun run --filter ${name} ${script}`;
}
function rootCommand(manager: ReturnType<typeof packageManager>, name: string): string { return `${manager} run ${name}`; }
function portFromScript(command: string): string | undefined { return command.match(/(?:--port\s+|PORT\s*=\s*)(\d{2,5})/)?.[1]; }

/** Return source-backed launch instructions when the question asks how to start/run a project. */
export function startupAnswer(question: string, files: SourceFile[]): string | undefined {
  if (/\b(?:tests?|specs?)\b/i.test(question) && /\b(?:run|execute|start)\b/i.test(question)) return undefined;
  if (!/\b(?:start|run|launch|boot|develop|development|setup|set up)\b/i.test(question)) return undefined;
  const root = files.find(file => file.path === "package.json");
  const rootManifest = root && readManifest(root);
  if (!root || !rootManifest) return undefined;
  const manager = packageManager(rootManifest, files);
  const manifests = files.map(readManifest).filter((value): value is Manifest => !!value);
  const rootScripts = scripts(rootManifest);
  const workspaces = manifests.filter(manifest => manifest.file !== "package.json" && /^apps?\//.test(manifest.file));
  const childDirs = new Map(workspaces.map(manifest => [manifest.file.slice(0, -"/package.json".length), manifest]));
  const customServer = backendEntrypoint(files);
  const databaseLoader = customServer && files.find(file => /sequelize/i.test(file.source) && /config\.json/.test(file.source));
  const output = ["CODEBASE ANSWER", question, "", "ANSWER", "From the repository root, install dependencies, then start the editor and its collaboration backend in separate terminals:", "", "1. Dependencies", `   ${installCommand(manager)}  ${manifestRef(rootManifest)}`];

  const editor = workspaces.find(manifest => {
    const dir = manifest.file.slice(0, -"/package.json".length);
    const names = Object.keys({ ...manifest.data.dependencies, ...manifest.data.devDependencies });
    return names.some(name => /y-websocket/i.test(name)) && filesIn(dir, files).some(file => /WebsocketProvider/.test(sourceText(file).code));
  });
  let editorPort: string | undefined;
  let websocketPort: string | undefined;
  let editorFiles: SourceFile[] = [];
  if (editor) {
    const dir = editor.file.slice(0, -"/package.json".length);
    editorFiles = filesIn(dir, files);
    const connection = editorFiles.map(file => ({ file, match: file.source.match(/new\s+WebsocketProvider\s*\(\s*['"`]wss?:\/\/[^:'"`/]+:(\d{2,5})/i) })).find(item => item.match);
    websocketPort = connection?.match?.[1];
    const serviceWorkspace = websocketPort && workspaces.find(manifest => scripts(manifest).start && /y-websocket-server/.test(scripts(manifest).start!) && portFromScript(scripts(manifest).start!) === websocketPort);
    if (customServer && connection) {
      output.push("2. Database/API and collaboration backend (Terminal 1)", `   node ${customServer.path}  ${lineRef(customServer, /startServer\s*\(\s*\)\s*;?\s*$/)}`,
        "   The server connects to its database, syncs Sequelize models, serves the API, and accepts WebSocket connections.");
      if (databaseLoader) {
        const configPath = databaseLoader.source.match(/require\s*\(\s*['"]([^'"]*config\.json)['"]\s*\)/)?.[1];
        const configFile = configPath ? posix.normalize(posix.join(posix.dirname(databaseLoader.path), configPath)) : undefined;
        const nodeEnv = /process\.env\.NODE_ENV/.test(databaseLoader.source);
        output.push(`   Database setup: ${configFile ?? "the server's Sequelize config"} is selected${nodeEnv ? " by NODE_ENV" : ""}; provide the connection settings it references ${lineRef(databaseLoader, /config\.json/)}`);
      } else output.push("   Configure a development database before starting it.");
      const serverManifest = workspaces.find(manifest => customServer.path.startsWith(manifest.file.slice(0, -"package.json".length)));
      if (serverManifest && scripts(serverManifest).start && !scripts(serverManifest).start!.includes(customServer.path.slice(customServer.path.lastIndexOf("/") + 1))) {
        output.push(`   Its package \"start\" script runs a different WebSocket command and does not launch this API/database entry point ${manifestRef(serverManifest)}.`);
      }
      if (/sequelize\.sync\s*\(\s*\{\s*alter\s*:\s*true/.test(customServer.source)) output.push("   Note: startup runs Sequelize sync with alter enabled; point it at a development database.");
    } else if (connection && serviceWorkspace) {
      output.push("2. Collaboration backend (Terminal 1)", `   ${workspaceCommand(manager, serviceWorkspace.data.name ?? posix.basename(posix.dirname(serviceWorkspace.file)), "start")}  ${manifestRef(serviceWorkspace)}`);
    } else if (connection) output.push("2. Collaboration backend", "   No matching backend start script or source entry point was found in the scanned files.");
    const startScript = scripts(editor).start ? "start" : scripts(editor).dev ? "dev" : undefined;
    if (startScript) {
      const run = childDirs.has(dir) ? workspaceCommand(manager, editor.data.name ?? posix.basename(dir), startScript) : `${manager} --prefix ${dir} run ${startScript}`;
      output.push(`${connection ? "3" : "2"}. Editor (Terminal 2)`, `   ${run}  ${manifestRef(editor)}`);
    }
    const readme = files.find(file => /^README\.md$/i.test(file.path) && file.path.startsWith(dir + "/"));
    const browser = editorFiles.find(file => /README\.md$/i.test(file.path)) ?? readme;
    editorPort = editorFiles.map(file => file.source.match(/localhost:(\d{2,5})/i)?.[1]).find(Boolean);
    if (!editorPort && scripts(editor).start?.includes("react-scripts start")) editorPort = "3000";
    if (editorPort) output.push(`   Then open http://localhost:${editorPort}${browser ? `  ${lineRef(browser, new RegExp(`https?://localhost:${editorPort}`))}` : ""}.`);
  }

  const workspacePatterns = rootManifest.data.workspaces;
  const declaredWorkspaces = Array.isArray(workspacePatterns) ? workspacePatterns : workspacePatterns?.packages ?? [];
  const isWorkspaceRepo = declaredWorkspaces.length > 0 || /turbo\s+run\s+dev/.test(rootScripts.dev ?? "");
  const launchApps = workspaces.filter(manifest => scripts(manifest).dev && /^(?:apps?\/)/.test(manifest.file));
  const rootDev = rootScripts.dev;
  const nextOption = isWorkspaceRepo && rootDev && launchApps.length > 0;
  if (editor && nextOption) {
    output.push("", "Other apps in this workspace", `   ${rootCommand(manager, "dev")}  ${manifestRef(rootManifest)} (runs ${launchApps.map(manifest => manifest.data.name ?? posix.basename(posix.dirname(manifest.file))).join(" and ")} development scripts)`);
    const ports = launchApps.map(manifest => {
      const port = portFromScript(scripts(manifest).dev!);
      return `${manifest.data.name ?? posix.basename(posix.dirname(manifest.file))}${port ? ` :${port}` : ""}`;
    });
    output.push(`   These are optional web apps: ${ports.join(", ")}.${editorPort && launchApps.some(manifest => portFromScript(scripts(manifest).dev!) === editorPort) ? ` The web app shares port ${editorPort} with the editor, so run one or the other.` : ""}`);
  } else if (!editor && (rootDev || rootScripts.start)) {
    const script = rootDev ? "dev" : "start";
    output.push("2. Development server", `   ${rootCommand(manager, script)}  ${manifestRef(rootManifest)}`);
    if (launchApps.length) output.push(`   The workspace runner starts: ${launchApps.map(manifest => manifest.data.name ?? posix.basename(posix.dirname(manifest.file))).join(", ")}.`);
  } else if (!editor) {
    const runnable = workspaces.filter(manifest => scripts(manifest).dev || scripts(manifest).start);
    if (!runnable.length && !Object.keys(rootScripts).some(name => /^(?:dev|start|serve)$/.test(name))) return undefined;
    for (const [index, manifest] of runnable.slice(0, 6).entries()) {
      const script = scripts(manifest).dev ? "dev" : "start";
      output.push(`${index + 2}. ${manifest.data.name ?? manifest.file}`, `   ${workspaceCommand(manager, manifest.data.name ?? posix.basename(posix.dirname(manifest.file)), script)}  ${manifestRef(manifest)}`);
    }
  }

  output.push("", "VERDICT", editor ? `The startup path is the ${editor.data.name ?? "editor"} workspace plus its collaboration server. The root development command starts the other workspace apps, so it is optional.` : "Commands above come from the root and workspace manifests. Review any environment or service prerequisites documented by those apps.");
  return output.join("\n") + "\n";
}

function nodeCommandForWebSocket(files: SourceFile[], workspaces: Manifest[], manager: ReturnType<typeof packageManager>, port: string): string {
  const custom = files.find(file => /(?:^|\/)server\.[cm]?js$/i.test(file.path) && /startServer\s*\(\s*\)\s*;?\s*$/.test(file.source) && file.source.includes(`|| ${port}`));
  if (custom) return `node ${custom.path}`;
  const targetManifest = workspaces.find(manifest => scripts(manifest).start && /y-websocket-server/.test(scripts(manifest).start!) && portFromScript(scripts(manifest).start!) === port);
  return targetManifest ? workspaceCommand(manager, targetManifest.data.name ?? posix.basename(posix.dirname(targetManifest.file)), "start") : `npx y-websocket-server --port ${port}`;
}
function webSocketRef(files: SourceFile[], workspaces: Manifest[], port: string): string {
  const source = files.find(file => /new\s+WebsocketProvider\s*\(\s*['"`]wss?:\/\/[^:'"`/]+:${port}/i.test(file.source));
  if (source) return lineRef(source, new RegExp(`new\\s+WebsocketProvider\\s*\\(\\s*['"\x60]wss?:\\/\\/[^:'"\x60/]+:${port}`));
  const manifest = workspaces.find(item => portFromScript(scripts(item).start ?? "") === port);
  return manifest ? manifestRef(manifest) : "";
}
