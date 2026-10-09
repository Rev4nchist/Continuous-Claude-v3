/**
 * scope-gate.mjs - the owned-target decision for scoped-scan.mjs.
 *
 * Pure functions, no side effects, no scanner calls. The runner passes the
 * hosts from the real registry. The probe passes fixture hosts. There is no
 * environment override: a caller cannot choose which hosts count as owned.
 */

import { readFileSync } from 'node:fs';

/** Loopback hosts are always owned. `*.localhost` resolves to loopback. */
export function isLoopback(host) {
  const h = String(host).toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Owned hosts from parsed registry JSON. Entries without a real URL are skipped. */
export function registryHosts(registry) {
  const hosts = new Set();
  const projects = Array.isArray(registry) ? registry : registry?.projects || [];
  for (const p of projects) {
    if (!p || typeof p.url !== 'string') continue;
    try {
      hosts.add(new URL(p.url).hostname.toLowerCase());
    } catch {
      // not a URL (e.g. "stdio (...)")
    }
  }
  return hosts;
}

/** Read a registry file. Fails closed: unreadable or invalid => no registry hosts. */
export function loadRegistryHosts(path) {
  try {
    return registryHosts(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return new Set();
  }
}

/**
 * Decide one target. Returns { allowed, host, reason }.
 * Deny by default: allowed only for loopback or an exact registry host.
 */
export function decide(target, hosts) {
  let host;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return { allowed: false, host: null, reason: `"${target}" is not a valid URL` };
  }
  if (!host) return { allowed: false, host, reason: 'URL has no host' };
  if (isLoopback(host)) return { allowed: true, host, reason: 'loopback' };
  if (hosts.has(host)) return { allowed: true, host, reason: 'project registry' };
  return { allowed: false, host, reason: `${host} is not a target you own` };
}
