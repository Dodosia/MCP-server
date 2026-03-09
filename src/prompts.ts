import { z } from "zod";

export function registerPrompts(mcpServer: any): void {
  if (typeof mcpServer.registerPrompt !== "function") {
    return;
  }

  mcpServer.registerPrompt(
    "reproduce_ci_failure",
    {
      title: "Reproduce CI Failure",
      description: "Guided prompt for reproducing a GitHub Actions job locally with repro_generate output.",
      argsSchema: {
        repo_path: z.string().optional(),
        workflow_file: z.string().optional(),
        job: z.string().optional(),
      },
    },
    (args: { repo_path?: string; workflow_file?: string; job?: string }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "I need a deterministic local CI reproduction plan.",
              `Repository: ${args.repo_path ?? "<set repo_path>"}`,
              `Workflow: ${args.workflow_file ?? "<set workflow_file>"}`,
              `Job: ${args.job ?? "<set job>"}`,
              "Run doctor_scan first, then run repro_generate with write_mode=repro_dir_only.",
              "After generation, build and run commands from repro/README.md.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  mcpServer.registerPrompt(
    "onboarding_pack",
    {
      title: "Onboarding Pack",
      description: "Prompt for onboarding engineers to CI parity checks and local reproduction workflow.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Create an onboarding checklist for CI parity:",
              "1) Run doctor_scan on target repository.",
              "2) Address BLOCKER and MAJOR findings first.",
              "3) Generate local reproduction bundle with repro_generate.",
              "4) Run smoke checks and document exact commands used.",
              "5) Keep toolchain versions aligned between local and CI.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
