import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const started = Date.now();
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", "tests/unit", "tests/integration", "tests/recovery"], {
  encoding: "utf8",
  env: { ...process.env, NODE_TEST_CONTEXT: "report" },
});
const elapsed = Date.now() - started;
const report = {
  generated_at: new Date().toISOString(),
  elapsed_ms: elapsed,
  exit_code: result.status,
  stdout: result.stdout,
  stderr: result.stderr,
};
mkdirSync("docs", { recursive: true });
const md = `# Test report

Generated: ${report.generated_at}
Elapsed: ${elapsed} ms
Exit code: ${report.exit_code}

\`\`\`
${result.stdout}
${result.stderr}
\`\`\`
`;
writeFileSync(join("docs", "test-report.md"), md);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
