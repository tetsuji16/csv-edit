const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDirectory = path.join(__dirname, '..', 'out', 'test');
const testFiles = fs.readdirSync(testDirectory)
  .filter(file => file.endsWith('.test.js'))
  .sort()
  .map(file => path.join(testDirectory, file));

if (!testFiles.length) {
  throw new Error(`No compiled tests found in ${testDirectory}`);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
