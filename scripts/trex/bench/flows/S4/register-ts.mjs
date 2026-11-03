import { register } from 'node:module'

await register('./ts-resolve.mjs', import.meta.url)
