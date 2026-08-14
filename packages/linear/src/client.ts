const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface LinearIssueState {
  id: string;
  name: string;
  type: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  state: LinearIssueState;
  team: { id: string };
  labels: { nodes: { id: string; name: string }[] };
}

export interface LinearIssuePage {
  issues: LinearIssue[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  updatedAt
  state { id name type }
  team { id }
  labels { nodes { id name } }
`;

/**
 * Minimal GraphQL client for the Linear API. Personal API keys are sent
 * as-is in the Authorization header, without a Bearer prefix.
 */
export class LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new LinearApiError(`Linear API responded ${res.status}`, res.status);
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new LinearApiError(body.errors.map((e) => e.message).join("; "));
    }
    if (!body.data) throw new LinearApiError("Linear API returned no data");
    return body.data;
  }

  async viewer(): Promise<LinearViewer> {
    const data = await this.query<{ viewer: LinearViewer }>(`query { viewer { id name email } }`);
    return data.viewer;
  }

  async teams(): Promise<LinearTeam[]> {
    const data = await this.query<{ teams: { nodes: LinearTeam[] } }>(
      `query { teams(first: 100) { nodes { id key name } } }`,
    );
    return data.teams.nodes;
  }

  async teamStates(teamId: string): Promise<LinearWorkflowState[]> {
    const data = await this.query<{ team: { states: { nodes: LinearWorkflowState[] } } }>(
      `query TeamStates($teamId: String!) {
        team(id: $teamId) { states { nodes { id name type position } } }
      }`,
      { teamId },
    );
    return data.team.states.nodes;
  }

  /** Pages issues for a team, optionally restricted to the given state types. */
  async issues(options: {
    teamId: string;
    stateTypes?: string[] | undefined;
    after?: string | undefined;
  }): Promise<LinearIssuePage> {
    const filter: Record<string, unknown> = { team: { id: { eq: options.teamId } } };
    if (options.stateTypes?.length) {
      filter.state = { type: { in: options.stateTypes } };
    }
    const data = await this.query<{
      issues: { nodes: LinearIssue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } };
    }>(
      `query Issues($filter: IssueFilter, $after: String) {
        issues(filter: $filter, first: 50, after: $after, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      { filter, after: options.after },
    );
    return {
      issues: data.issues.nodes,
      endCursor: data.issues.pageInfo.endCursor,
      hasNextPage: data.issues.pageInfo.hasNextPage,
    };
  }

  async issue(id: string): Promise<LinearIssue | null> {
    const data = await this.query<{ issue: LinearIssue | null }>(
      `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id },
    );
    return data.issue;
  }

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.query(
      `mutation UpdateIssue($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
      }`,
      { issueId, stateId },
    );
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.query(
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId, body },
    );
  }

  async webhookCreate(options: { url: string; secret: string }): Promise<string> {
    const data = await this.query<{ webhookCreate: { success: boolean; webhook: { id: string } } }>(
      `mutation WebhookCreate($url: String!, $secret: String!) {
        webhookCreate(input: { url: $url, secret: $secret, allPublicTeams: true, resourceTypes: ["Issue"] }) {
          success
          webhook { id }
        }
      }`,
      options,
    );
    if (!data.webhookCreate.success) throw new LinearApiError("Linear refused to create the webhook");
    return data.webhookCreate.webhook.id;
  }

  async webhookDelete(id: string): Promise<void> {
    await this.query(
      `mutation WebhookDelete($id: String!) { webhookDelete(id: $id) { success } }`,
      { id },
    );
  }
}
