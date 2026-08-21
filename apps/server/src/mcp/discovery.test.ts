import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { discoverOAuth, parseResourceMetadata, registerClient, DiscoveryError } from "./discovery.js";

const localPolicy = { mode: "local" as const, ownHosts: [] };

// One fake host plays the MCP resource server, its protected resource
// metadata, the authorization server metadata, and dynamic registration.
let server: Server;
let base: string;
let issuerMismatch = false;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (obj: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    switch (url.pathname) {
      case "/mcp":
        // Unauthenticated: point at the protected resource metadata.
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      case "/.well-known/oauth-protected-resource/mcp":
        json({ resource: `${base}/mcp`, authorization_servers: [base] });
        return;
      case "/.well-known/oauth-authorization-server":
        json({
          issuer: issuerMismatch ? "https://evil.example.test" : base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: ["files:read", "files:write"],
        });
        return;
      case "/register": {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => json({ client_id: "dyn-client-1" }, 201));
        return;
      }
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

test("parseResourceMetadata pulls the URL out of a Bearer challenge", () => {
  assert.equal(
    parseResourceMetadata('Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource"'),
    "https://x.test/.well-known/oauth-protected-resource",
  );
  assert.equal(parseResourceMetadata("Bearer realm=\"x\""), null);
});

test("discovery walks the 401 challenge to the authorization server metadata", async () => {
  issuerMismatch = false;
  const discovered = await discoverOAuth(`${base}/mcp`, localPolicy);
  assert.equal(discovered.authorizationEndpoint, `${base}/authorize`);
  assert.equal(discovered.tokenEndpoint, `${base}/token`);
  assert.equal(discovered.registrationEndpoint, `${base}/register`);
  assert.equal(discovered.issuer, base);
  assert.equal(discovered.issParameterSupported, true);
  assert.equal(discovered.resource, `${base}/mcp`);
  assert.equal(discovered.scopesSupported, "files:read files:write");
});

test("discovery refuses metadata that claims a different issuer", async () => {
  issuerMismatch = true;
  await assert.rejects(discoverOAuth(`${base}/mcp`, localPolicy), (err: unknown) => {
    return err instanceof DiscoveryError && /different issuer/.test(err.message);
  });
  issuerMismatch = false;
});

test("dynamic registration returns a client id", async () => {
  const registered = await registerClient(`${base}/register`, `${base}/cb`, localPolicy);
  assert.equal(registered.clientId, "dyn-client-1");
  assert.equal(registered.clientSecret, null);
});
