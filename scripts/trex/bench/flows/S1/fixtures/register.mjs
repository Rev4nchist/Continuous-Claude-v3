import { register } from 'node:module';

await register('./hook.mjs', import.meta.url);
