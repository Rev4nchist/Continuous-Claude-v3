/**
 * C2c: a test file that starts a pwsh walker child imports this module for its side effect. Each decision of a PowerShell text costs a child process (0.5 to 1 s alone, several
 * seconds on a loaded 2 CPU runner with the suite in parallel), and the default of 5 s per test turned that load into failures. The long timeout is scoped to these files, so a
 * hang in any other file still ends at the default. A test of the fail-closed path uses a provider that errors, never a real wait.
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
