export type Severity = "BLOCKER" | "MAJOR" | "MINOR";

export interface DoctorFinding {
  id: string;
  severity: Severity;
  title: string;
  evidence: string[];
  fix: string;
  files: string[];
}

export interface DoctorSummary {
  repro_score: number;
  blockers: number;
  majors: number;
  minors: number;
}

export interface DoctorReport {
  summary: DoctorSummary;
  findings: DoctorFinding[];
  quickstart: {
    recommended_next_tool: "repro_generate";
    commands: string[];
  };
}

export interface ReproGeneratedFile {
  path: string;
}

export interface ReproManifest {
  repro_dir: "./repro";
  generated_files: ReproGeneratedFile[];
  how_to_run: string[];
}
