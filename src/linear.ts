export type Link = { title: string; url: string };

export type LinkedTicket = {
	identifier: string;
	title: string;
	url: string;
	branchName: string;
	state: { type: string };
	attachments: { nodes: Link[] };
};

export type Ticket = {
	identifier: string;
	title: string;
	url: string;
	branchName: string;
	description: string | null;
	state: { name: string };
	assignee: { displayName: string } | null;
	project: { name: string } | null;
	attachments: { nodes: Link[] };
	relations: { nodes: { type: string; relatedIssue: LinkedTicket }[] };
	inverseRelations: { nodes: { type: string; issue: LinkedTicket }[] };
};

export type TicketSummary = {
	identifier: string;
	title: string;
	url: string;
	state: { name: string; type: string; position: number };
	project: { name: string } | null;
	cycle: { number: number; name: string | null; startsAt: string } | null;
};

export type Linear = {
	ticket(identifier: string): Promise<Ticket>;
	openTickets(): Promise<TicketSummary[]>;
};

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export const MISSING_API_KEY =
	"No Linear API key. Run /linear again to set one.";

const TICKET_QUERY = `
  query Ticket($id: String!) {
    issue(id: $id) {
      identifier
      title
      url
      branchName
      description
      state { name }
      assignee { displayName }
      project { name }
      attachments { nodes { title url } }
      relations { nodes { type relatedIssue { ...LinkedTicket } } }
      inverseRelations { nodes { type issue { ...LinkedTicket } } }
    }
  }

  fragment LinkedTicket on Issue {
    identifier
    title
    url
    branchName
    state { type }
    attachments { nodes { title url } }
  }
`;

const OPEN_TICKETS_QUERY = `
  query OpenTickets {
    viewer {
      assignedIssues(
        first: 50
        orderBy: updatedAt
        filter: {
          state: {
            type: { nin: ["completed", "canceled"] }
            name: { neqIgnoreCase: "Duplicate" }
          }
        }
      ) {
        nodes {
          identifier
          title
          url
          state { name type position }
          project { name }
          cycle { number name startsAt }
        }
      }
    }
  }
`;

const STATE_TYPE_ORDER = ["started", "unstarted", "backlog", "triage"];

function byWorkflowOrder(a: TicketSummary, b: TicketSummary) {
	return (
		STATE_TYPE_ORDER.indexOf(a.state.type) -
			STATE_TYPE_ORDER.indexOf(b.state.type) ||
		a.state.position - b.state.position
	);
}

export function createLinear(options: {
	apiKey: () => string;
	fetch?: typeof fetch;
}): Linear {
	const send = options.fetch ?? fetch;

	async function query<Data>(
		text: string,
		variables?: Record<string, string>,
	): Promise<Data | undefined> {
		const apiKey = options.apiKey();
		if (!apiKey) throw new Error(MISSING_API_KEY);
		const response = await send(LINEAR_GRAPHQL_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: apiKey },
			body: JSON.stringify({ query: text, variables }),
		});
		const json = (await response.json()) as {
			data?: Data;
			errors?: { message: string }[];
		};
		if (json.errors?.length) throw new Error(json.errors[0].message);
		return json.data;
	}

	return {
		async ticket(identifier) {
			const data = await query<{ issue: Ticket | null }>(TICKET_QUERY, {
				id: identifier,
			});
			if (!data?.issue) throw new Error(`Linear has no issue ${identifier}`);
			return data.issue;
		},
		async openTickets() {
			const data = await query<{
				viewer: { assignedIssues: { nodes: TicketSummary[] } };
			}>(OPEN_TICKETS_QUERY);
			return (data?.viewer.assignedIssues.nodes ?? []).toSorted(
				byWorkflowOrder,
			);
		},
	};
}
