import { spawnSync } from 'node:child_process';

// An explicitly separate build keeps unfinished FX out of ordinary production.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run test:browser:input-fx.');
for (const args of [
  ['run', 'build'],
  ['exec', '--', 'playwright', 'test', 'input-fx.spec.ts'],
]) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    stdio: 'inherit',
    env: { ...process.env, VITE_INPUT_FX_PREVIEW: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
