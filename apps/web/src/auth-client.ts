import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient, organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [deviceAuthorizationClient(), organizationClient()],
});

export const { useSession, signIn, signUp, signOut, organization, useListOrganizations, useActiveOrganization } = authClient;
