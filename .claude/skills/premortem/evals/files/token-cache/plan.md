# Plan: share the partner API access token across workers

## Problem

Each of the 12 API workers fetches its own OAuth access token from the partner. The partner
rate-limits the token endpoint to 10 calls per minute. On deploy, all 12 workers start at once and
some get HTTP 429 from the token endpoint.

## Design

1. Store the access token and the refresh token in Redis under the key `partner:token`.
2. Set the Redis TTL to the token's `expires_in` (3600 s).
3. On a cache miss, a worker calls `refreshToken()` in `token_client.ts` with the stored refresh
   token, then writes the new pair to Redis.
4. The partner rotates refresh tokens: each refresh returns a new refresh token, and the old one
   stops working at once.
5. Workers read the token from Redis on every request. No in-process copy.

## Rollout

Ship to all 12 workers in one deploy. No feature flag: the old per-worker code path is deleted.

## Testing

Unit test for the Redis read and write helpers.
