#!/usr/bin/env node
// Fails when a service in docker-compose.yml publishes a port on a non-loopback address.
// Postgres here holds every session, lane and memory row, so it must not listen on the LAN.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docker =
  process.env.DOCKER_EXE ||
  (process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker');

const res = spawnSync(docker, ['compose', '-f', join(here, 'docker-compose.yml'), 'config', '--format', 'json'], {
  encoding: 'utf8',
});
if (res.status !== 0) {
  console.error(res.stderr || 'docker compose config failed');
  process.exit(2);
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const offenders = [];
for (const [name, service] of Object.entries(JSON.parse(res.stdout).services ?? {})) {
  for (const port of service.ports ?? []) {
    if (!LOOPBACK.has(port.host_ip)) {
      offenders.push(`${name}: ${port.published} -> ${port.target} on ${port.host_ip || 'all interfaces'}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(`FAIL: published on a non-loopback address:\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log('PASS: every published port is bound to a loopback address');
