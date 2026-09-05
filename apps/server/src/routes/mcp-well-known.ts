import { Hono, type Context } from "hono";
import type { AppContext } from "../context.js";
import { canonicalResource, requestOrigin } from "../mcp/oauth-as.js";

/**
 * RFC 9728 protected-resource metadata and RFC 8414 authorization
 * server metadata. MCP hosts fetch these after a 401 on /mcp, before
 * they know who the user is, so they sit outside actor and tenant
 * middleware.
 */
export function mcpWellKnownRoutes(ctx: AppContext) {
  const routes = new Hono();

  function originOf(c: Context) {
    return requestOrigin(c, ctx.env.BETTER_AUTH_URL);
  }

  const protectedResource = (c: Context) => {
    const origin = originOf(c);
    return c.json({
      resource: canonicalResource(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  };

  routes.get("/oauth-protected-resource", (c) => protectedResource(c));
  routes.get("/oauth-protected-resource/mcp", (c) => protectedResource(c));

  routes.get("/oauth-authorization-server", (c) => {
    const origin = originOf(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/mcp-oauth/authorize`,
      token_endpoint: `${origin}/mcp-oauth/token`,
      registration_endpoint: `${origin}/mcp-oauth/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  return routes;
}
