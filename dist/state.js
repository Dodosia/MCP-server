let latestDoctorReport = null;
let latestReproManifest = null;

export function setLatestDoctorReport(report) {
  latestDoctorReport = report;
}

export function getLatestDoctorReport() {
  return latestDoctorReport;
}

export function setLatestReproManifest(manifest) {
  latestReproManifest = manifest;
}

export function getLatestReproManifest() {
  return latestReproManifest;
}
