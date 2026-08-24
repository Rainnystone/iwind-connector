import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { AuthProps } from "../mcp/create-server";

export interface AccessFlowSession {
  readonly phase: "access";
  readonly oauthRequest: AuthRequest;
  readonly client: Pick<ClientInfo, "clientId" | "clientName" | "clientUri">;
  readonly state: string;
  readonly nonce: string;
}

export interface ConsentFlowSession {
  readonly phase: "consent";
  readonly oauthRequest: AuthRequest;
  readonly client: Pick<ClientInfo, "clientId" | "clientName" | "clientUri">;
  readonly authProps: AuthProps;
  readonly csrf: string;
  readonly marker: string;
}

export type IWindOAuthHelpers = Pick<
  OAuthHelpers,
  "parseAuthRequest" | "lookupClient" | "completeAuthorization"
>;
