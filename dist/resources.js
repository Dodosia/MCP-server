import { getLatestDoctorReport, getLatestReproManifest } from "./state.js";

function uriToString(uri, fallback) {
  if (typeof uri === "string") {
    return uri;
  }
  if (uri && typeof uri === "object" && "href" in uri && typeof uri.href === "string") {
    return uri.href;
  }
  return fallback;
}

export function registerResources(mcpServer) {
  if (typeof mcpServer.registerResource !== "function") {
    return;
  }

  mcpServer.registerResource(
    "doctor_latest",
    "resource://doctor/latest",
    {
      title: "Latest doctor_scan report",
      description: "Returns the most recent doctor_scan JSON result stored in memory.",
      mimeType: "application/json",
    },
    async (uri) => {
      const value = getLatestDoctorReport();
      return {
        contents: [
          {
            uri: uriToString(uri, "resource://doctor/latest"),
            mimeType: "application/json",
            text: JSON.stringify(value ?? { message: "No doctor_scan result yet." }, null, 2),
          },
        ],
      };
    },
  );

  mcpServer.registerResource(
    "repro_manifest",
    "resource://repro/manifest",
    {
      title: "Latest repro manifest",
      description: "Returns the most recent repro_generate manifest stored in memory.",
      mimeType: "application/json",
    },
    async (uri) => {
      const value = getLatestReproManifest();
      return {
        contents: [
          {
            uri: uriToString(uri, "resource://repro/manifest"),
            mimeType: "application/json",
            text: JSON.stringify(value ?? { message: "No repro_generate result yet." }, null, 2),
          },
        ],
      };
    },
  );
}
