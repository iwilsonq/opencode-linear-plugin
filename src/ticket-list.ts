import type { TicketSummary } from "./linear";

export const GROUP_MODES = ["state", "project", "cycle"] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

export type TicketListState = {
	readonly groupMode: GroupMode;
	readonly selectedId?: string;
	readonly marked: ReadonlySet<string>;
};

export const initialTicketListState: TicketListState = {
	groupMode: "state",
	marked: new Set(),
};

export type TicketListInput = {
	readonly tickets: readonly TicketSummary[];
	readonly branch?: string;
};

export type TicketGroup = {
	readonly label: string;
	readonly tickets: readonly TicketSummary[];
};

export type TicketListView = {
	readonly groupMode: GroupMode;
	readonly groups: readonly TicketGroup[];
	readonly selected?: TicketSummary;
	readonly isMarked: (ticket: TicketSummary) => boolean;
	readonly markedCount: number;
	readonly chosen: readonly string[];
};

export type TicketListAction =
	| { type: "move"; delta: number }
	| { type: "extendMark"; delta: number }
	| { type: "select"; id: string }
	| { type: "toggleMark" }
	| { type: "toggleGroupMarks" }
	| { type: "unmark"; ids: readonly string[] }
	| { type: "clearMarks" }
	| { type: "cycleGroupMode" };

const NO_GROUP_SORT_KEY = "\uffff";

type GroupKey = { label: string; sortKey: string };

const groupKey: Record<GroupMode, (ticket: TicketSummary) => GroupKey> = {
	state: (ticket) => ({ label: ticket.state.name, sortKey: "" }),
	project: (ticket) =>
		ticket.project
			? { label: ticket.project.name, sortKey: ticket.project.name }
			: { label: "No project", sortKey: NO_GROUP_SORT_KEY },
	cycle: (ticket) =>
		ticket.cycle
			? {
					label: ticket.cycle.name ?? `Cycle ${ticket.cycle.number}`,
					sortKey: ticket.cycle.startsAt,
				}
			: { label: "No cycle", sortKey: NO_GROUP_SORT_KEY },
};

const groupCache = new WeakMap<
	readonly TicketSummary[],
	Partial<Record<GroupMode, readonly TicketGroup[]>>
>();

function groupTickets(
	tickets: readonly TicketSummary[],
	mode: GroupMode,
): readonly TicketGroup[] {
	const cached = groupCache.get(tickets) ?? {};
	groupCache.set(tickets, cached);
	cached[mode] ??= buildGroups(tickets, mode);
	return cached[mode];
}

function buildGroups(
	tickets: readonly TicketSummary[],
	mode: GroupMode,
): TicketGroup[] {
	const groups = new Map<string, { key: GroupKey; tickets: TicketSummary[] }>();
	for (const ticket of tickets) {
		const key = groupKey[mode](ticket);
		const group = groups.get(key.label) ?? { key, tickets: [] };
		group.tickets.push(ticket);
		groups.set(key.label, group);
	}
	return [...groups.values()]
		.toSorted((a, b) => a.key.sortKey.localeCompare(b.key.sortKey))
		.map(({ key, tickets }) => ({ label: key.label, tickets }));
}

export function ticketIdFromBranch(branch: string | undefined) {
	const match = branch?.match(/([a-z]+-\d+)/i);
	return match ? match[1].toUpperCase() : undefined;
}

function layout(state: TicketListState, input: TicketListInput) {
	const groups = groupTickets(input.tickets, state.groupMode);
	const order = groups.flatMap((group) => group.tickets);
	const wanted = state.selectedId ?? ticketIdFromBranch(input.branch);
	const index = Math.max(
		0,
		order.findIndex((ticket) => ticket.identifier === wanted),
	);
	return { groups, order, index, selected: order[index] };
}

export function viewTicketList(
	state: TicketListState,
	input: TicketListInput,
): TicketListView {
	const { groups, order, selected } = layout(state, input);
	const isMarked = (ticket: TicketSummary) =>
		state.marked.has(ticket.identifier);
	const marked = order.filter(isMarked).map((ticket) => ticket.identifier);
	return {
		groupMode: state.groupMode,
		groups,
		selected,
		isMarked,
		markedCount: marked.length,
		chosen: marked.length > 0 ? marked : selected ? [selected.identifier] : [],
	};
}

function withMarks(
	state: TicketListState,
	ids: readonly string[],
	on: boolean,
): TicketListState {
	const marked = new Set(state.marked);
	for (const id of ids) {
		if (on) marked.add(id);
		else marked.delete(id);
	}
	return { ...state, marked };
}

export function updateTicketList(
	state: TicketListState,
	input: TicketListInput,
	action: TicketListAction,
): TicketListState {
	const { groups, order, index, selected } = layout(state, input);
	const at = (delta: number) =>
		order[Math.min(order.length - 1, Math.max(0, index + delta))];

	switch (action.type) {
		case "move":
			return { ...state, selectedId: at(action.delta)?.identifier };
		case "extendMark": {
			const to = at(action.delta);
			if (!selected || !to) return state;
			return withMarks(
				{ ...state, selectedId: to.identifier },
				[selected.identifier, to.identifier],
				true,
			);
		}
		case "select":
			return { ...state, selectedId: action.id };
		case "toggleMark":
			if (!selected) return state;
			return withMarks(
				state,
				[selected.identifier],
				!state.marked.has(selected.identifier),
			);
		case "toggleGroupMarks": {
			const group = groups.find((group) =>
				group.tickets.some((ticket) => ticket === selected),
			);
			if (!group) return state;
			const ids = group.tickets.map((ticket) => ticket.identifier);
			return withMarks(state, ids, !ids.every((id) => state.marked.has(id)));
		}
		case "unmark":
			return withMarks(state, action.ids, false);
		case "clearMarks":
			return { ...state, marked: new Set() };
		case "cycleGroupMode": {
			const next =
				(GROUP_MODES.indexOf(state.groupMode) + 1) % GROUP_MODES.length;
			return { ...state, groupMode: GROUP_MODES[next] };
		}
	}
}
