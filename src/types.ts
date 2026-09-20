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
export interface Analysis { models: Model[]; relations: Relation[]; services: Service[]; scannedFiles: number; project?: ProjectOverview }
