import { describe, expect, test } from "bun:test";
import {
	LINEAR_GRAPHQL_URL,
	MISSING_API_KEY,
	type TicketSummary,
	createLinear,
} from "./linear";

type Request = {
	url: string;
	headers: Record<string, string>;
	query: string;
	variables?: Record<string, string>;
};

function fakeLinear(body: unknown, apiKey = "lin_api_test") {
	const requests: Request[] = [];
	const fetch = (async (url: string, init: RequestInit) => {
		const { query, variables } = JSON.parse(String(init.body));
		requests.push({
			url,
			headers: init.headers as Record<string, string>,
			query,
			variables,
		});
		return new Response(JSON.stringify(body));
	}) as unknown as typeof globalThis.fetch;
	return { linear: createLinear({ apiKey: () => apiKey, fetch }), requests };
}

function summary(
	identifier: string,
	type: string,
	position: number,
): TicketSummary {
	return {
		identifier,
		title: identifier,
		url: `https://linear.app/acme/issue/${identifier}`,
		state: { name: type, type, position },
		project: null,
		cycle: null,
	};
}

describe("openTickets", () => {
	test("sorts started, unstarted, backlog, then triage, by position", async () => {
		const { linear } = fakeLinear({
			data: {
				viewer: {
					assignedIssues: {
						nodes: [
							summary("ENG-1", "backlog", 0),
							summary("ENG-2", "started", 2),
							summary("ENG-3", "triage", 0),
							summary("ENG-4", "started", 1),
							summary("ENG-5", "unstarted", 0),
						],
					},
				},
			},
		});
		const tickets = await linear.openTickets();
		expect(tickets.map((ticket) => ticket.identifier)).toEqual([
			"ENG-4",
			"ENG-2",
			"ENG-5",
			"ENG-1",
			"ENG-3",
		]);
	});

	test("asks Linear only for open, non-duplicate tickets", async () => {
		const { linear, requests } = fakeLinear({
			data: { viewer: { assignedIssues: { nodes: [] } } },
		});
		await linear.openTickets();
		expect(requests[0].query).toContain(
			'type: { nin: ["completed", "canceled"] }',
		);
		expect(requests[0].query).toContain('name: { neqIgnoreCase: "Duplicate" }');
	});
});

describe("ticket", () => {
	test("sends the API key and ticket ID to the GraphQL endpoint", async () => {
		const { linear, requests } = fakeLinear({
			data: { issue: { identifier: "ENG-7" } },
		});
		await linear.ticket("ENG-7");
		expect(requests[0].url).toBe(LINEAR_GRAPHQL_URL);
		expect(requests[0].headers.Authorization).toBe("lin_api_test");
		expect(requests[0].variables).toEqual({ id: "ENG-7" });
	});

	test("rejects when Linear has no such ticket", async () => {
		const { linear } = fakeLinear({ data: { issue: null } });
		await expect(linear.ticket("ENG-404")).rejects.toThrow(
			"Linear has no issue ENG-404",
		);
	});
});

describe("errors", () => {
	test("rejects with the first GraphQL error message", async () => {
		const { linear } = fakeLinear({
			errors: [{ message: "Authentication required" }, { message: "other" }],
		});
		await expect(linear.openTickets()).rejects.toThrow(
			"Authentication required",
		);
		await expect(linear.ticket("ENG-1")).rejects.toThrow(
			"Authentication required",
		);
	});

	test("rejects without a request when there is no API key", async () => {
		const { linear, requests } = fakeLinear({}, "");
		await expect(linear.openTickets()).rejects.toThrow(MISSING_API_KEY);
		expect(requests).toEqual([]);
	});

	test("reads the API key on each call", async () => {
		let apiKey = "";
		const requests: string[] = [];
		const linear = createLinear({
			apiKey: () => apiKey,
			fetch: (async (_url: string, init: RequestInit) => {
				requests.push((init.headers as Record<string, string>).Authorization);
				return new Response(
					JSON.stringify({
						data: { viewer: { assignedIssues: { nodes: [] } } },
					}),
				);
			}) as unknown as typeof fetch,
		});
		await expect(linear.openTickets()).rejects.toThrow(MISSING_API_KEY);
		apiKey = "lin_api_new";
		await linear.openTickets();
		expect(requests).toEqual(["lin_api_new"]);
	});
});
