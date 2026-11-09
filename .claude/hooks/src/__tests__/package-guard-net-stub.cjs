/**
 * Network stub for the package-install-guard subprocess tests (preloaded with `node -r`).
 *
 * It replaces https.get and https.request on the shared `https` module object, so the
 * built hook (which imports `https` as an external) never reaches the real network.
 * Every request is answered from a canned document. A host the guard does not know gets `{}`.
 *
 * Knobs (environment variables, hours before now):
 *   PIG_STUB_AGE_HOURS   age of the `latest` npm release and of the PyPI release (default 2400 = 100 days)
 *   PIG_STUB_NEXT_HOURS  age of the `next` and `beta` npm dist-tags (default 2400)
 *   PIG_STUB_OSV_MAL     "1": OSV answers every query with one MAL- advisory (default: no advisories)
 *   PIG_STUB_OSV_CRIT    "1": OSV answers every query with one CRITICAL GHSA advisory (wins over PIG_STUB_OSV_MAL)
 *   PIG_STUB_REGISTRY_MODE   PyPI and npm only, not OSV. An HTTP status ("404", "500", "403", ...) answers that
 *                        status with a JSON body; "garbage" answers 200 with a body that is not JSON; "timeout"
 *                        emits the request timeout event; "error" emits a socket error. Default: normal 200.
 *   PIG_STUB_REGISTRY_ONLY   comma list of substrings (package names): the mode applies only to a URL holding one
 */
'use strict';
const https = require('https');
const { EventEmitter } = require('events');

const HOUR = 3600 * 1000;
const hoursFromEnv = (name) => Number(process.env[name] ?? 2400);
const iso = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

function documentFor(host) {
  if (host.includes('api.osv.dev')) {
    if (process.env.PIG_STUB_OSV_CRIT === '1') return { vulns: [{ id: 'GHSA-zzzz-crit-0001', summary: 'stub critical advisory', database_specific: { severity: 'CRITICAL' } }] };
    return { vulns: process.env.PIG_STUB_OSV_MAL === '1' ? [{ id: 'MAL-2026-0001', summary: 'stub malware advisory' }] : [] };
  }
  if (host.includes('pypi.org')) {
    return { info: { version: '1.0.0' }, releases: { '1.0.0': [{ upload_time_iso_8601: iso(hoursFromEnv('PIG_STUB_AGE_HOURS')) }] } };
  }
  if (host.includes('registry.npmjs.org')) {
    return {
      'dist-tags': { latest: '1.0.0', next: '2.0.0-next.1', beta: '2.0.0-beta.1' },
      time: {
        created: iso(5000),
        '1.0.0': iso(hoursFromEnv('PIG_STUB_AGE_HOURS')),
        '2.0.0-next.1': iso(hoursFromEnv('PIG_STUB_NEXT_HOURS')),
        '2.0.0-beta.1': iso(hoursFromEnv('PIG_STUB_NEXT_HOURS')),
      },
    };
  }
  return {};
}

function hostOf(first) {
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') return String(first.hostname || first.host || first.href || '');
  return '';
}

// The registry knob answers PyPI and npm only, never OSV. With PIG_STUB_REGISTRY_ONLY set, it
// answers only a URL that contains one of the listed substrings (the package names).
function registryFault(host) {
  const mode = process.env.PIG_STUB_REGISTRY_MODE;
  if (!mode || !(host.includes('pypi.org') || host.includes('registry.npmjs.org'))) return null;
  const only = (process.env.PIG_STUB_REGISTRY_ONLY || '').split(',').filter(Boolean);
  if (only.length > 0 && !only.some((n) => host.includes(n))) return null;
  return mode;
}

function fakeRequest(args) {
  const host = hostOf(args[0]);
  const cb = args.find((a) => typeof a === 'function');
  const req = new EventEmitter();
  req.write = () => true;
  req.destroy = () => {};
  req.setTimeout = () => req;
  const reply = () => setImmediate(() => {
    const fault = registryFault(host);
    if (fault === 'timeout') return req.emit('timeout');
    if (fault === 'error') return req.emit('error', new Error('ECONNREFUSED'));
    const res = new EventEmitter();
    res.statusCode = 200;
    let body = JSON.stringify(documentFor(host));
    if (fault === 'garbage') body = '<html>not json {';
    else if (fault) { res.statusCode = Number(fault); body = '{"error":"stub"}'; }
    if (cb) cb(res);
    res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  req.end = reply;
  req.__reply = reply;
  return req;
}

https.get = (...args) => { const req = fakeRequest(args); req.__reply(); return req; };
https.request = (...args) => fakeRequest(args);

// Optional fs trace (PIG_STUB_FS_TRACE=<file>): every statSync or openSync on an rc file name appends one line to <file>.
// A test reads it to see WHETHER the guard looked for an rc file. The dist imports statSync and openSync by name,
// so the exports are synced after the patch.
if (process.env.PIG_STUB_FS_TRACE) {
  const fs = require('fs');
  const trace = process.env.PIG_STUB_FS_TRACE;
  const RC = /(?:^|[\\/])(?:\.npmrc|\.yarnrc\.yml|\.?bunfig\.toml|pip\.conf|pip\.ini|uv\.toml)$/;
  for (const name of ['statSync', 'openSync']) {
    const real = fs[name];
    fs[name] = function patched(p, ...rest) {
      if (typeof p === 'string' && RC.test(p)) fs.appendFileSync(trace, `${name} ${p}\n`);
      return real.call(this, p, ...rest);
    };
  }
  require('module').syncBuiltinESMExports();
}
