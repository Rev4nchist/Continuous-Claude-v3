# Source A6 — Fourth MCP Server Management API (OpenAPI v1)

> Downloaded 2026-08-05 from https://mcp-qai.fourth.com/admin/openapi/v1.json (Scalar docs at /admin/docs/).
> Title: Fourth.MCPServer.Management.Api | v1 · version 1.0.0 · servers: http://mcp-admin-qai.fourth.com/

## Endpoints

| Path | Method | Summary | Tag |
|---|---|---|---|
| `/customers` | GET | Returns all customers. | Customers |
| `/customers/{customerCanonicalId}` | GET | Returns a customer by ID. | Customers |
| `/customers/{customerCanonicalId}/tools` | GET | Returns all tools allowed for a customer. | Customers |
| `/customers/{customerCanonicalId}/locations` | GET | Returns all locations for a customer. | Customers |
| `/customers/{customerCanonicalId}/configuration` | PUT | Updates the configuration of a customer. | Customers |
| `/customers/{customerCanonicalId}/personal-access-tokens` | GET | Returns all personal access tokens for a customer. | Customers |
| `/customers/{customerCanonicalId}/allowed-scopes` | POST | Adds allowed scopes to a customer. | CustomerScopes |
| `/customers/{customerCanonicalId}/allowed-scopes` | DELETE | Removes allowed scopes from a customer. | CustomerScopes |
| `/personal-access-tokens/{id}` | GET | Returns a personal access token by ID. | PersonalAccessTokens |
| `/personal-access-tokens/{id}` | DELETE | Deletes (revokes) a personal access token. | PersonalAccessTokens |
| `/personal-access-tokens/customer` | GET | Returns all personal access tokens for a customer. | PersonalAccessTokens |
| `/personal-access-tokens` | GET | Returns the personal access token for a specific customer and user. | PersonalAccessTokens |
| `/personal-access-tokens` | POST | Creates a new personal access token. | PersonalAccessTokens |
| `/scopes` | GET | Returns all scopes. | Scopes |
| `/scopes` | POST | Creates a new scope. | Scopes |
| `/scopes/{name}` | GET | Returns a scope by ID. | Scopes |
| `/scopes/{name}` | PUT | Updates an existing scope. | Scopes |
| `/scopes/{name}` | DELETE | Deletes a scope. | Scopes |
| `/scopes/{name}/tools` | GET | Returns tools assigned to a scope. | Scopes |
| `/scopes-tools` | PUT | Assigns a scope to a tool. | Scopes |
| `/tools` | GET | Returns all tools. | Tools |
| `/tools` | POST | Creates a new tool. | Tools |
| `/tools/{name}` | GET | Returns a tool by ID. | Tools |
| `/tools/{name}` | PUT | Updates an existing tool. | Tools |
| `/tools/{name}` | DELETE | Deletes a tool. | Tools |

## Security schemes

- **Bearer**: {"type":"http","description":"JWT Authorization header using the Bearer scheme.","scheme":"bearer","bearerFormat":"JWT"}

## Schemas

`CreatePersonalAccessTokenRequest` · `CreatePersonalAccessTokenResponse` · `CustomerConfigurationModel` · `CustomerModel` · `CustomerStatus` · `ErrorCodes` · `ErrorModel` · `ErrorResponseModel` · `Exception` · `LocationModel` · `MethodBase` · `PersonalAccessTokenResponse` · `ScopeModel` · `ScopeToolModel` · `TokenType` · `ToolModel`
