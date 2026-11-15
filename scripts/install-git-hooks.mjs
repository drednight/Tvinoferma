import { execFileSync } from 'node:child_process';

// npm prepare runs after npm install/ci. No packages, credentials, or global Git config are needed.
if (!process.env.CI && process.env.SKIP_GIT_HOOKS !== '1') {
  try {
    const git = (...args) =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('rev-parse', '--show-toplevel');
    let existing = '';
    try {
      existing = git('config', '--get', 'core.hooksPath');
    } catch {
      /* No custom hooks. */
    }
    if (existing && existing !== '.githooks') {
      console.warn(
        `Git hooks: custom hooksPath already configured; kept unchanged. Add npm run format:staged to your pre-commit hook.`
      );
    } else {
      git('config', '--local', 'core.hooksPath', '.githooks');
      console.log('Git hooks: Prettier pre-commit enabled.');
    }
  } catch {
    console.warn('Git hooks: no Git checkout available; installation skipped.');
  }
}
