import type { DoctorReport, ReproManifest } from "./types.js";

let latestDoctorReport: DoctorReport | null = null;
let latestReproManifest: ReproManifest | null = null;

export function setLatestDoctorReport(report: DoctorReport): void {
  latestDoctorReport = report;
}

export function getLatestDoctorReport(): DoctorReport | null {
  return latestDoctorReport;
}

export function setLatestReproManifest(manifest: ReproManifest): void {
  latestReproManifest = manifest;
}

export function getLatestReproManifest(): ReproManifest | null {
  return latestReproManifest;
}
