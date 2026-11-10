// Cross-platform test discovery. No hardcoded test-file list: future *.test.ts
// additions are automatically included in npm run test:all.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(root, 'tests');
const testFiles = readdirSync(testDirectory)
  .filter(file => file.endsWith('.test.ts') && !file.startsWith('_'))
  .sort()
  .map(file => path.join(testDirectory, file));

if (testFiles.length === 0) {
  console.error('No *.test.ts files found in tests/.');
  process.exit(1);
}
console.log(`Running all ${testFiles.length} regression test files...`);
const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}
process.exit(child.status ?? 1);
