// Part 2 stubs. They read nothing and write nothing. Part 2 replaces them (it waits for the gate-2 contract).
import { ExitError } from './errors.mjs';

export function notBuilt(verb) {
  throw new ExitError(5, `program.mjs ${verb}: not built (part 2: waits for the gate-2 contract commit, pre-go.md 5.3). Nothing was read or written.`);
}
