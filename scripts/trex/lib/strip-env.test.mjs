import test from 'node:test';
import assert from 'node:assert/strict';
import { stripEnv } from './strip-env.mjs';

const SOURCE = {
  PATH: '/usr/bin',
  HOME: '/home/dave',
  ANTHROPIC_API_KEY: 'sk-secret',
  ANTHROPIC_AUTH_TOKEN: 'tok-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
};

// Breaks if: the function strips only ANTHROPIC_API_KEY.
test('stripEnv removes the API key, the auth token and every CLAUDE_CODE_ key', () => {
  const out = stripEnv(SOURCE);
  assert.deepEqual(Object.keys(out).sort(), ['HOME', 'PATH']);
});

// Breaks if: the key match is case-sensitive. Windows env names are case-insensitive.
test('stripEnv removes keys in any letter case', () => {
  const out = stripEnv({ Path: 'C:\\bin', anthropic_api_key: 'x', Claude_Code_Foo: 'y', Anthropic_Auth_Token: 'z' });
  assert.deepEqual(Object.keys(out), ['Path']);
});

// Breaks if: the function drops PATH, or matches CLAUDE as a bare prefix.
test('stripEnv keeps PATH in any case and keeps keys that only look similar', () => {
  const out = stripEnv({ PATH: 'a', Path: 'b', CLAUDE_HOME: 'c', ANTHROPIC_BASE_URL: 'd', MY_CLAUDE_CODE_X: 'e' });
  assert.deepEqual(Object.keys(out).sort(), ['ANTHROPIC_BASE_URL', 'CLAUDE_HOME', 'MY_CLAUDE_CODE_X', 'PATH', 'Path']);
});

// Breaks if: the function deletes keys from the object it receives.
test('stripEnv returns a copy and leaves the input unchanged', () => {
  const input = { ...SOURCE };
  const out = stripEnv(input);
  assert.notEqual(out, input);
  assert.deepEqual(input, SOURCE);
});
