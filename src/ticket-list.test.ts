import { describe, expect, test } from "bun:test";
import type { TicketSummary } from "./linear";
import {
	type TicketListAction,
	type TicketListInput,
	type TicketListState,
	initialTicketListState,
	ticketIdFromBranch,
	updateTicketList,
	viewTicketList,
} from "./ticket-list";

function ticket(
	identifier: string,
	state: string,
	project: string | null,
	cycle: number | null = null,
): TicketSummary {
	return {
		identifier,
		title: `Title ${identifier}`,
		url: `https://linear.app/acme/issue/${identifier}`,
		state: { name: state, type: "started", position: 0 },
		project: project ? { name: project } : null,
		cycle: cycle
			? { number: cycle, name: null, startsAt: `2026-0${cycle}-01` }
			: null,
	};
}

const tickets = [
	ticket("ENG-1", "In Progress", "Web", 2),
	ticket("ENG-2", "In Progress", "API", 1),
	ticket("ENG-3", "Todo", "Web", 1),
	ticket("ENG-4", "Todo", null),
];

const input: TicketListInput = { tickets };

function run(
	actions: TicketListAction[],
	from: TicketListState = initialTicketListState,
	with_: TicketListInput = input,
) {
	return actions.reduce(
		(state, action) => updateTicketList(state, with_, action),
		from,
	);
}

const view = (state: TicketListState, with_: TicketListInput = input) =>
	viewTicketList(state, with_);

const order = (state: TicketListState) =>
	view(state).groups.flatMap((group) =>
		group.tickets.map((ticket) => ticket.identifier),
	);

describe("grouping", () => {
	test("groups by state in the order tickets arrive", () => {
		expect(
			view(initialTicketListState).groups.map((group) => group.label),
		).toEqual(["In Progress", "Todo"]);
	});

	test("cycles through state, project, and cycle", () => {
		const byProject = run([{ type: "cycleGroupMode" }]);
		expect(view(byProject).groupMode).toBe("project");
		expect(view(byProject).groups.map((group) => group.label)).toEqual([
			"API",
			"Web",
			"No project",
		]);

		const byCycle = run([{ type: "cycleGroupMode" }], byProject);
		expect(view(byCycle).groups.map((group) => group.label)).toEqual([
			"Cycle 1",
			"Cycle 2",
			"No cycle",
		]);

		expect(view(run([{ type: "cycleGroupMode" }], byCycle)).groupMode).toBe(
			"state",
		);
	});
});

describe("rendering stability", () => {
	test("keeps the same group objects until the tickets or group mode change", () => {
		const before = view(initialTicketListState).groups;
		const moved = run([{ type: "move", delta: 1 }, { type: "toggleMark" }]);
		expect(view(moved).groups).toBe(before);
		expect(view(run([{ type: "cycleGroupMode" }])).groups).not.toBe(before);
		expect(view(moved, { tickets: [...tickets] }).groups).not.toBe(before);
	});
});

describe("selection", () => {
	test("starts on the branch ticket, or the first ticket", () => {
		expect(view(initialTicketListState).selected?.identifier).toBe("ENG-1");
		expect(
			view(initialTicketListState, { tickets, branch: "sam/eng-3-fix" })
				.selected?.identifier,
		).toBe("ENG-3");
	});

	test("moves in visible order across groups and stops at the ends", () => {
		const byProject = run([{ type: "cycleGroupMode" }]);
		expect(order(byProject)).toEqual(["ENG-2", "ENG-1", "ENG-3", "ENG-4"]);
		const moved = run(
			[
				{ type: "select", id: "ENG-2" },
				{ type: "move", delta: 2 },
			],
			byProject,
		);
		expect(view(moved).selected?.identifier).toBe("ENG-3");
		expect(
			view(run([{ type: "move", delta: 10 }], moved)).selected?.identifier,
		).toBe("ENG-4");
		expect(
			view(run([{ type: "move", delta: -10 }], moved)).selected?.identifier,
		).toBe("ENG-2");
	});

	test("keeps the selected ticket when regrouping", () => {
		const state = run([
			{ type: "select", id: "ENG-3" },
			{ type: "cycleGroupMode" },
		]);
		expect(view(state).selected?.identifier).toBe("ENG-3");
	});

	test("falls back to the first ticket when the selected one disappears", () => {
		const state = run([{ type: "select", id: "ENG-3" }]);
		const refetched = {
			tickets: tickets.filter((t) => t.identifier !== "ENG-3"),
		};
		expect(view(state, refetched).selected?.identifier).toBe("ENG-1");
	});
});

describe("marks", () => {
	test("chooses the selected ticket when nothing is marked", () => {
		expect(view(initialTicketListState).chosen).toEqual(["ENG-1"]);
	});

	test("toggles a mark on the selected ticket", () => {
		const marked = run([{ type: "toggleMark" }]);
		expect(view(marked).isMarked(tickets[0])).toBe(true);
		expect(view(run([{ type: "toggleMark" }], marked)).markedCount).toBe(0);
	});

	test("marks the start and end tickets while moving", () => {
		const state = run([
			{ type: "extendMark", delta: 1 },
			{ type: "extendMark", delta: 1 },
		]);
		expect(view(state).chosen).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
		expect(view(state).selected?.identifier).toBe("ENG-3");
	});

	test("marks the whole group, then unmarks it when all are marked", () => {
		const marked = run([{ type: "toggleGroupMarks" }]);
		expect(view(marked).chosen).toEqual(["ENG-1", "ENG-2"]);
		const partly = run([{ type: "toggleMark" }], marked);
		expect(view(run([{ type: "toggleGroupMarks" }], partly)).chosen).toEqual([
			"ENG-1",
			"ENG-2",
		]);
		expect(view(run([{ type: "toggleGroupMarks" }], marked)).markedCount).toBe(
			0,
		);
	});

	test("lists chosen tickets in visible order and keeps marks across regroups", () => {
		const state = run([
			{ type: "select", id: "ENG-3" },
			{ type: "toggleMark" },
			{ type: "select", id: "ENG-2" },
			{ type: "toggleMark" },
			{ type: "cycleGroupMode" },
		]);
		expect(view(state).chosen).toEqual(["ENG-2", "ENG-3"]);
	});

	test("unmarks given tickets and clears all marks", () => {
		const state = run([{ type: "toggleGroupMarks" }]);
		expect(
			view(run([{ type: "unmark", ids: ["ENG-1"] }], state)).chosen,
		).toEqual(["ENG-2"]);
		expect(view(run([{ type: "clearMarks" }], state)).markedCount).toBe(0);
	});

	test("counts only marks on tickets that are still listed", () => {
		const state = run([{ type: "toggleGroupMarks" }]);
		const refetched = {
			tickets: tickets.filter((t) => t.identifier !== "ENG-2"),
		};
		expect(view(state, refetched).markedCount).toBe(1);
		expect(view(state, refetched).chosen).toEqual(["ENG-1"]);
	});
});

describe("ticketIdFromBranch", () => {
	test("finds the ticket ID in a branch name", () => {
		expect(ticketIdFromBranch("sam/eng-123-fix-retries")).toBe("ENG-123");
		expect(ticketIdFromBranch("main")).toBeUndefined();
		expect(ticketIdFromBranch(undefined)).toBeUndefined();
	});
});

describe("empty list", () => {
	test("has no selection, nothing chosen, and ignores actions", () => {
		const empty = { tickets: [] };
		const state = run(
			[
				{ type: "move", delta: 1 },
				{ type: "toggleMark" },
				{ type: "toggleGroupMarks" },
			],
			initialTicketListState,
			empty,
		);
		expect(view(state, empty).selected).toBeUndefined();
		expect(view(state, empty).chosen).toEqual([]);
	});
});
