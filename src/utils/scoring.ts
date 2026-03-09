import type { DoctorFinding } from "../types.js";

export function calculateReproScore(findings: DoctorFinding[]): number {
  let score = 100;
  for (const finding of findings) {
    if (finding.severity === "BLOCKER") {
      score -= 25;
    } else if (finding.severity === "MAJOR") {
      score -= 10;
    } else {
      score -= 3;
    }
  }
  return Math.max(0, Math.min(100, score));
}
