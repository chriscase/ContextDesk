import { runDoctor } from "./doctor.js";

function printHuman(report: Awaited<ReturnType<typeof runDoctor>>): void {
  process.stdout.write(`ContextDesk Collab doctor: ${report.ok ? "ready" : "not ready"}\n`);
  for (const item of report.checks) {
    const marker = item.status === "ok" ? "OK" : item.status === "warn" ? "WARN" : "ERROR";
    process.stdout.write(`${marker.padEnd(5)} ${item.id}: ${item.message}\n`);
  }
}

const json = process.argv.includes("--json");
runDoctor()
  .then((report) => {
    if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else printHuman(report);
    if (!report.ok) process.exitCode = 1;
  })
  .catch(() => {
    process.stderr.write("ContextDesk Collab doctor could not complete.\n");
    process.exitCode = 1;
  });
