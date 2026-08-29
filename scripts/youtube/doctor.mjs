#!/usr/bin/env node
import { mediaDoctor } from './lib/media.mjs';

const report = mediaDoctor();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 2;
