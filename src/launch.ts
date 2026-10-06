import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { LinkedTicket, Ticket } from "./linear";

export type LaunchMode = "implement" | "plan";

const CLOSED_STATE_TYPES = ["completed", "canceled"];

export type LaunchInput = {
	ticket: Ticket;
	mode: LaunchMode;
	workspaceRoot: string;
	repo: string | undefined;
	note: string;
};

export function expandHome(path: string, home: string) {
	return path.replace(/^~(?=$|\/)/, home);
}

export function listRepos(workspaceRoot: string) {
	return readdirSync(workspaceRoot, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(workspaceRoot, entry.name, ".git")),
		)
		.map((entry) => join(workspaceRoot, entry.name))
		.toSorted((a, b) => basename(a).localeCompare(basename(b)));
}

function issueLine(issue: LinkedTicket) {
	return `${issue.identifier} ${issue.title} (${issue.url})`;
}

function blockerLine(issue: LinkedTicket) {
	const links = issue.attachments.nodes.map(
		(link) => `\n  - ${link.title} (${link.url})`,
	);
	return `${issueLine(issue)}, suggested branch ${issue.branchName}${links.join("")}`;
}

function ticketSection(ticket: Ticket) {
	const blockedBy = ticket.inverseRelations.nodes
		.filter((relation) => relation.type === "blocks")
		.map((relation) => relation.issue)
		.filter((issue) => !CLOSED_STATE_TYPES.includes(issue.state.type));
	const blocks = ticket.relations.nodes
		.filter((relation) => relation.type === "blocks")
		.map((relation) => relation.relatedIssue);
	const related = [
		...ticket.relations.nodes
			.filter((relation) => relation.type === "related")
			.map((relation) => relation.relatedIssue),
		...ticket.inverseRelations.nodes
			.filter((relation) => relation.type === "related")
			.map((relation) => relation.issue),
	];

	const lines = [
		`State: ${ticket.state.name}`,
		`Project: ${ticket.project?.name ?? "none"}`,
	];
	const list = (label: string, items: string[]) => {
		if (items.length)
			lines.push(`${label}:`, ...items.map((item) => `- ${item}`));
	};
	list("Blocked by (open)", blockedBy.map(blockerLine));
	list("Blocks", blocks.map(issueLine));
	list("Related", related.map(issueLine));
	list(
		"Linked PRs and attachments",
		ticket.attachments.nodes.map((link) => `${link.title} (${link.url})`),
	);

	return [
		"## Ticket",
		...lines,
		"",
		ticket.description?.trim() || "(no description)",
	].join("\n");
}

function repoStep(input: LaunchInput) {
	if (input.repo) {
		return [
			`1. Work in ${input.repo}. If the ticket also needs changes in other repos under ${input.workspaceRoot}, tell me before you touch them.`,
			"2. Read the repo's AGENTS.md.",
		];
	}
	return [
		`1. This ticket may touch more than one repo. The repos are folders under ${input.workspaceRoot}. Find the affected repos. Start with the clues in the ticket: repo or service names, file paths, linked PRs, and PRs on related tickets. Then confirm with rg in the likely repos. List each repo and why it is affected, and wait for me to confirm.`,
		"2. Read the AGENTS.md of each affected repo. Sessions started from the workspace root do not load them.",
	];
}

function branchStep(input: LaunchInput) {
	const baseRule =
		"Base: if an open blocked-by ticket has an open PR in this repo, branch from that PR's head branch (a stacked branch). Check its linked PRs above, or run `gh pr list --state open --search <ticket ID>`. Otherwise branch from origin/main.";
	if (input.mode === "plan") {
		return [
			`3. Do not create branches yet. In the plan, give the base branch for each repo and why. ${baseRule}`,
		];
	}
	return [
		"3. Set up the branch in each affected repo:",
		"   - If the repo has uncommitted changes, or is on another ticket's branch, stop and ask me. Do not stash or switch.",
		`   - Run git fetch. Name the branch ${input.ticket.branchName}. If it exists locally or on origin, check it out.`,
		`   - ${baseRule}`,
		"   - Tell me which base you chose and why.",
	];
}

export function buildLaunchPrompt(input: LaunchInput) {
	const { ticket } = input;
	const goal =
		input.mode === "plan"
			? `Plan the work for ${ticket.identifier}: ${ticket.title}`
			: `Work on ${ticket.identifier}: ${ticket.title}`;
	const finalStep =
		input.mode === "plan"
			? "Then write a plan for the ticket. Do not edit files."
			: "Then implement the ticket.";

	return [
		goal,
		ticket.url,
		"",
		ticketSection(ticket),
		...(input.note.trim() ? ["", "## Note from me", input.note.trim()] : []),
		"",
		"## Before you start",
		...repoStep(input),
		...branchStep(input),
		"",
		finalStep,
	].join("\n");
}
