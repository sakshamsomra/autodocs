import type { Analysis, Evidence } from "./types.js";

/** A concise, reader-facing explanation of what the project provides. */
export function overviewMarkdown(a: Analysis): string {
  const p = a.project;
  const sections = [`# ${cell(p?.name ?? "Project")}`];
  sections.push(`## About\n\n${p?.description ?? "This project does not include a written overview."}`);
  if (p?.features.length) sections.push(`## What it offers\n\n${table(["Capability", "Description"], p.features.map(feature => [feature.name, feature.detail]))}`);
  else if (p?.content.length) sections.push(`## What it manages\n\n${table(["Area", "Description"], p.content.map(item => [item.name, item.detail]))}`);
  else sections.push("## What it offers\n\nSee the project README for product information and usage guidance.");
  if (p?.documents.length) sections.push(`## Learn more\n\n${p.documents.map(file => `- ${sourceLink(file)}`).join("\n")}`);
  return `${sections.join("\n\n")}\n`;
}

/** Technical implementation reference for contributors and maintainers. */
export function developerMarkdown(a: Analysis): string {
  const p = a.project;
  const sections = [`# ${cell(p?.name ?? "Project")} — Developer Guide`];
  sections.push(`## Project context\n\n${p?.description ?? "See the project README for an overview."}`);
  if (p?.stack.length) sections.push(`## Technology stack\n\n${evidenceTable(p.stack)}`);
  if (p?.components.length) sections.push(`## Components\n\n${evidenceTable(p.components)}`);
  if (p?.connections.length) sections.push(`## Module dependencies\n\n${evidenceTable(p.connections)}`);
  if (p?.content.length) sections.push(`## Content model\n\n${evidenceTable(p.content)}`);
  if (a.models.length) {
    sections.push("## Data model");
    for (const model of a.models) sections.push(`### ${cell(model.name)}\n\n${table(["Field", "Type", "Primary key"], model.fields.map(field => [field.name, field.type, field.primary ? "Yes" : "—"]))}`);
    if (a.relations.length) sections.push(`### Relationships\n\n${table(["Source", "Target", "Key"], a.relations.map(relation => [relation.from, relation.to, relation.label]))}`);
  }
  if (a.services.length) sections.push(`## Endpoints and service methods\n\n${table(["Module", "Endpoint / method"], a.services.flatMap(service => service.methods.map(method => [service.name, method])))}`);
  sections.push(startGuide(p));
  if (p?.commands.length) sections.push(`## Other development commands\n\n${evidenceTable(p.commands)}`);
  if (p?.documents.length) sections.push(`## Project documentation\n\n${p.documents.map(file => `- ${sourceLink(file)}`).join("\n")}`);
  return `${sections.join("\n\n")}\n`;
}

// Kept for consumers that import the original generator directly.
export const markdown = developerMarkdown;

function cell(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]+/g, " "); }
function sourceLink(file: string): string { return `[${cell(file).replace(/[\[\]]/g, "")}](${"../" + file.split("/").map(encodeURIComponent).join("/")})`; }
function table(headers: string[], rows: string[][]): string { return [headers.map(cell).join(" | "), headers.map(() => "---").join(" | "), ...rows.map(row => row.map(cell).join(" | "))].join("\n"); }
function evidenceTable(items: Evidence[]): string { return table(["Component", "Details", "Source"], items.map(item => [item.name, item.detail, sourceLink(item.file)])); }

/** Always provide a launch path, while only recommending commands supported by repository evidence. */
function startGuide(project: Analysis["project"]): string {
  const commands = project?.commands ?? [];
  const verified = commands.filter(command => /^(?:Install|Restore|Build and start|Start)\b/i.test(command.detail));
  const steps = verified.map((command, index) => {
    const directory = command.file.includes("/") ? command.file.slice(0, command.file.lastIndexOf("/")) : ".";
    const location = directory === "." ? "the project root" : `\`${directory}\``;
    return `${index + 1}. From ${location}, ${lowerFirst(command.detail)}\n\n   \`\`\`sh\n   ${command.name}\n   \`\`\``;
  });
  if (!steps.length) {
    steps.push("Follow the setup instructions in the project documentation.");
  }
  return `## How to start\n\n${steps.join("\n\n")}`;
}

function lowerFirst(value: string): string { return value.charAt(0).toLowerCase() + value.slice(1); }
