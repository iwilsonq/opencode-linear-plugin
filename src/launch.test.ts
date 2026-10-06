import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LaunchInput,
	type TicketContext,
	buildLaunchPrompt,
	expandHome,
	listRepos,
} from "./launch";

function linkedIssue(identifier: string, title: string, stateType = "started") {
	return {
		identifier,
		title,
		url: `https://linear.app/i/${identifier}`,
		branchName: `sam/${identifier.toLowerCase()}`,
		state: { type: stateType },
		attachments: { nodes: [] as { title: string; url: string }[] },
	};
}

const openBlocker = {
	...linkedIssue("ENG-2", "Queue refactor"),
	attachments: {
		nodes: [{ title: "PR #7", url: "https://github.com/acme/q/pull/7" }],
	},
};

const ticket: TicketContext = {
	identifier: "ENG-123",
	title: "Fix webhook retries",
	url: "https://linear.app/acme/issue/ENG-123",
	branchName: "sam/eng-123-fix-webhook-retries",
	description: "Retries stop after one attempt.",
	state: { name: "Todo" },
	project: { name: "Webhooks" },
	attachments: {
		nodes: [
			{ title: "PR #12", url: "https://github.com/acme/webhooks/pull/12" },
		],
	},
	relations: {
		nodes: [
			{ type: "related", relatedIssue: linkedIssue("ENG-1", "Retry policy") },
			{ type: "blocks", relatedIssue: linkedIssue("ENG-9", "Retry dashboard") },
		],
	},
	inverseRelations: {
		nodes: [
			{ type: "blocks", issue: openBlocker },
			{
				type: "blocks",
				issue: linkedIssue("ENG-3", "Old blocker", "completed"),
			},
			{ type: "related", issue: linkedIssue("ENG-4", "Retry metrics") },
		],
	},
};

const input: LaunchInput = {
	ticket,
	mode: "implement",
	workspaceRoot: "/work",
	repo: undefined,
	note: "",
};

describe("buildLaunchPrompt", () => {
	test("includes the ticket and its linked PRs", () => {
		const prompt = buildLaunchPrompt(input);
		expect(prompt).toStartWith("Work on ENG-123: Fix webhook retries\n");
		expect(prompt).toContain("Retries stop after one attempt.");
		expect(prompt).toContain(
			"- PR #12 (https://github.com/acme/webhooks/pull/12)",
		);
	});

	test("lists open blockers with their branch and PRs, and drops closed ones", () => {
		const prompt = buildLaunchPrompt(input);
		expect(prompt).toContain(
			"Blocked by (open):\n- ENG-2 Queue refactor (https://linear.app/i/ENG-2), suggested branch sam/eng-2\n  - PR #7 (https://github.com/acme/q/pull/7)",
		);
		expect(prompt).not.toContain("ENG-3");
	});

	test("lists tickets this one blocks separately from its blockers", () => {
		const prompt = buildLaunchPrompt(input);
		expect(prompt).toContain("Blocks:\n- ENG-9 Retry dashboard");
		const blockedBy = prompt.slice(
			prompt.indexOf("Blocked by (open):"),
			prompt.indexOf("Blocks:"),
		);
		expect(blockedBy).not.toContain("ENG-9");
	});

	test("lists related tickets from both directions", () => {
		const prompt = buildLaunchPrompt(input);
		expect(prompt).toContain(
			"Related:\n- ENG-1 Retry policy (https://linear.app/i/ENG-1)\n- ENG-4 Retry metrics",
		);
	});

	test("handles a ticket with no description, project, or links", () => {
		const prompt = buildLaunchPrompt({
			...input,
			ticket: {
				...ticket,
				description: null,
				project: null,
				attachments: { nodes: [] },
				relations: { nodes: [] },
				inverseRelations: { nodes: [] },
			},
		});
		expect(prompt).toContain("Project: none");
		expect(prompt).toContain("(no description)");
		expect(prompt).not.toContain("Blocked by");
	});

	test("asks the agent to find repos when no repo is chosen", () => {
		const prompt = buildLaunchPrompt(input);
		expect(prompt).toContain("folders under /work. Find the affected repos.");
		expect(prompt).toContain("wait for me to confirm");
	});

	test("names the chosen repo instead of searching", () => {
		const prompt = buildLaunchPrompt({ ...input, repo: "/work/webhooks" });
		expect(prompt).toContain("1. Work in /work/webhooks.");
		expect(prompt).not.toContain("Find the affected repos");
	});

	test("sets up the branch before implementing", () => {
		const prompt = buildLaunchPrompt(input);
		expect(prompt).toContain(
			"Run git fetch. Name the branch sam/eng-123-fix-webhook-retries. If it exists locally or on origin, check it out.",
		);
		expect(prompt).toContain("stop and ask me. Do not stash or switch.");
		expect(prompt).toContain("gh pr list --state open --search <ticket ID>");
		expect(prompt).toEndWith("Then implement the ticket.");
	});

	test("defers branching and forbids edits in plan mode", () => {
		const prompt = buildLaunchPrompt({
			...input,
			mode: "plan",
			repo: "/work/webhooks",
		});
		expect(prompt).toStartWith("Plan the work for ENG-123");
		expect(prompt).toContain("1. Work in /work/webhooks.");
		expect(prompt).toContain("Do not create branches yet.");
		expect(prompt).not.toContain("Name the branch");
		expect(prompt).toEndWith("Do not edit files.");
	});

	test("adds the note only when there is one", () => {
		expect(buildLaunchPrompt(input)).not.toContain("## Note from me");
		expect(
			buildLaunchPrompt({ ...input, note: "  only the API part " }),
		).toContain("## Note from me\nonly the API part");
	});
});

describe("expandHome", () => {
	test("expands a leading ~ only", () => {
		expect(expandHome("~/projects", "/home/sam")).toBe("/home/sam/projects");
		expect(expandHome("~", "/home/sam")).toBe("/home/sam");
		expect(expandHome("~other/x", "/home/sam")).toBe("~other/x");
		expect(expandHome("/work/~/x", "/home/sam")).toBe("/work/~/x");
	});
});

describe("listRepos", () => {
	const root = mkdtempSync(join(tmpdir(), "repos-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test("lists folders that have a .git entry, sorted by name", () => {
		mkdirSync(join(root, "zeta", ".git"), { recursive: true });
		mkdirSync(join(root, "alpha"));
		writeFileSync(join(root, "alpha", ".git"), "gitdir: elsewhere");
		mkdirSync(join(root, "notes"));
		writeFileSync(join(root, "file.md"), "");
		expect(listRepos(root)).toEqual([join(root, "alpha"), join(root, "zeta")]);
	});
});
