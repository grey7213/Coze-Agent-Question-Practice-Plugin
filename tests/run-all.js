/* Run the Chrome suites with redacted, reproducible evidence.
   node tests/run-all.js             all suites, including the configured real API
   node tests/run-all.js --offline   omit the real API suite */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'tests', 'latest');
fs.mkdirSync(output, { recursive: true });
let secrets = [];
try {
  const local = JSON.parse(fs.readFileSync(path.join(root, 'tools/env.local.json'), 'utf8'));
  secrets = [local.apiKey, local.loginStudentId, local.loginName].filter(Boolean);
} catch (_) {}
const redact = text => secrets.reduce((result, value) => result.split(value).join('[REDACTED]'), text);
const suites = ['run-test', 'run-structure', 'run-noisy', 'run-iframe', 'run-login', 'run-e2e', 'run-chapters'];
if (!process.argv.includes('--offline')) suites.push('run-live');
const results = [];
for (const name of suites) {
  console.log('\nRunning ' + name + '...');
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(__dirname, name + '.js')], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024
  });
  const log = redact((result.stdout || '') + (result.stderr || '') + (result.error ? result.error.message : ''));
  fs.writeFileSync(path.join(output, name + '.log'), log);
  const counts = [...log.matchAll(/(\d+)\/(\d+) 通过/g)].at(-1);
  const passed = counts ? Number(counts[1]) : 0;
  const total = counts ? Number(counts[2]) : 0;
  const ok = result.status === 0 && total > 0 && passed === total;
  results.push({ suite: name, ok, passed, total, exitCode: result.status, durationMs: Date.now() - started });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${passed}/${total} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!ok) console.log(log);
}
const summary = {
  checkedAt: new Date().toISOString(), node: process.version,
  passed: results.reduce((sum, row) => sum + row.passed, 0),
  total: results.reduce((sum, row) => sum + row.total, 0),
  ok: results.every(row => row.ok), results
};
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过; ${results.filter(row => row.ok).length}/${results.length} suites passed`);
console.log('Evidence: ' + path.join(output, 'results.json'));
process.exitCode = summary.ok ? 0 : 1;
