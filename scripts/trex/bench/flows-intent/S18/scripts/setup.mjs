import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function make(dir, reason, runs, fork) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (args) => execSync(`git ${args}`, { cwd: dir, encoding: 'utf8' }).trim();
  git('init -b main');
  git('remote add origin https://github.com/rev4nchist/continuous-claude-v3.git');
  const body = 'Evidence body checked by pre-pr.\n';
  writeFileSync(join(dir, 'body.md'), body);
  writeFileSync(join(dir, 'other.md'), 'A different PR body.\n');
  git('add body.md other.md');
  git('-c user.email=trex@example.com -c user.name=trex commit -m init');
  const head = git('rev-parse HEAD');
  if (fork === 'other') {
    git('-c user.email=trex@example.com -c user.name=trex commit --allow-empty -m later');
    git(`update-ref refs/remotes/fork/main ${git('rev-parse HEAD')}`);
    git(`reset --hard ${head}`);
  } else {
    git(`update-ref refs/remotes/fork/main ${head}`);
  }
  const stampDir = join(dir, '.claude/cache/pre-pr');
  mkdirSync(stampDir, { recursive: true });
  writeFileSync(join(stampDir, 'stamp.json'), JSON.stringify({
    head, branch: 'main', at: new Date().toISOString(),
    body_sha256: createHash('sha256').update(body).digest('hex'),
    cr_skipped: true, cr_skip_reason: reason, cr_finished_runs: runs, cr_retry_minutes: null,
  }));
}

make('/tmp/trex-s18-ok', 'cli-missing', 0, 'same');
make('/tmp/trex-s18-bad', 'cap', 0, 'same');
make('/tmp/trex-s18-pushed', 'cli-missing', 0, 'other');
