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

function fakeRequest(args) {
  const host = hostOf(args[0]);
  const cb = args.find((a) => typeof a === 'function');
  const req = new EventEmitter();
  req.write = () => true;
  req.destroy = () => {};
  req.setTimeout = () => req;
  const reply = () => setImmediate(() => {
    const res = new EventEmitter();
    if (cb) cb(res);
    res.emit('data', Buffer.from(JSON.stringify(documentFor(host))));
    res.emit('end');
  });
  req.end = reply;
  req.__reply = reply;
  return req;
}

https.get = (...args) => { const req = fakeRequest(args); req.__reply(); return req; };
https.request = (...args) => fakeRequest(args);
