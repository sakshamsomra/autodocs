export interface Field { name: string; type: string; primary?: boolean; optional?: boolean }
export interface Relation { from: string; to: string; label: string }
export interface Model { name: string; fields: Field[] }
export interface Service { name: string; methods: string[] }
export interface Evidence { name: string; detail: string; file: string }
export interface ProjectOverview {
  name: string;
  description: string;
  features: Evidence[];
  stack: Evidence[];
  components: Evidence[];
  content: Evidence[];
  commands: Evidence[];
  connections: Evidence[];
  documents: string[];
  languages: Record<string, number>;
  excluded: number;
  warnings: string[];
}
export interface SourceDependency { module: string; names: string[]; display: string; targets: string[] }
export interface SourceInsight {
  file: string;
  language: string;
  adapter: string;
  coverage: "structured" | "heuristic" | "generic" | "metadata";
  name: string;
  purpose: string;
  declarations: string[];
  operations: string[];
  dependencies: SourceDependency[];
  calls: string[];
  externalCalls: string[];
  integrations: string[];
  configuration: string[];
  databases: string[];
  tables: string[];
  models: Model[];
  relations: Relation[];
  endpoints: string[];
  serviceNames: string[];
  sections: { title: string; items: string[] }[];
  notes: string[];
}
export interface Analysis { models: Model[]; relations: Relation[]; services: Service[]; scannedFiles: number; project?: ProjectOverview; sources?: SourceInsight[] }
