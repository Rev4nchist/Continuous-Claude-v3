import { register } from 'node:module';

await register(new URL('./resolve-ts.mjs', import.meta.url).href, import.meta.url);
