import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { execFile, spawn } from "node:child_process";
import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { homedir } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
	type LaunchMode,
	type TicketContext,
	buildLaunchPrompt,
	expandHome,
	listRepos,
} from "./launch";
import { extractUrls, unescapeBareUrls } from "./markdown";
import {
	type ReviewCopyResult,
	type ReviewSources,
	copyForReview,
	identifierList,
	parsePullRequestState,
	richClipboardScript,
	statusQuestion,
} from "./review";
import {
	For,
	Show,
	createEffect,
	createResource,
	createSignal,
} from "solid-js";

const PANEL = "linear.ticket";
const PAGE = "tickets";

const ISSUE_QUERY = `
  query Issue($id: String!) {
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
      relations { nodes { type relatedIssue { ...LinkedIssue } } }
      inverseRelations { nodes { type issue { ...LinkedIssue } } }
    }
  }

  fragment LinkedIssue on Issue {
    identifier
    title
    url
    branchName
    state { type }
    attachments { nodes { title url } }
  }
`;

const ASSIGNED_ISSUES = `
  query AssignedIssues {
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

type Issue = TicketContext & {
	assignee: { displayName: string } | null;
};

type IssueSummary = Pick<Issue, "identifier" | "title" | "url"> & {
	state: { name: string; type: string; position: number };
	project: { name: string } | null;
	cycle: { number: number; name: string | null; startsAt: string } | null;
};

const STATE_TYPE_ORDER = ["started", "unstarted", "backlog", "triage"];

function byWorkflowOrder(a: IssueSummary, b: IssueSummary) {
	return (
		STATE_TYPE_ORDER.indexOf(a.state.type) -
			STATE_TYPE_ORDER.indexOf(b.state.type) ||
		a.state.position - b.state.position
	);
}

const GROUP_MODES = ["state", "project", "cycle"] as const;
type GroupMode = (typeof GROUP_MODES)[number];

type GroupKey = { label: string; sortKey: string };

const NO_GROUP_SORT_KEY = "\uffff";

const groupKey: Record<GroupMode, (issue: IssueSummary) => GroupKey> = {
	state: (issue) => ({ label: issue.state.name, sortKey: "" }),
	project: (issue) =>
		issue.project
			? { label: issue.project.name, sortKey: issue.project.name }
			: { label: "No project", sortKey: NO_GROUP_SORT_KEY },
	cycle: (issue) =>
		issue.cycle
			? {
					label: issue.cycle.name ?? `Cycle ${issue.cycle.number}`,
					sortKey: issue.cycle.startsAt,
				}
			: { label: "No cycle", sortKey: NO_GROUP_SORT_KEY },
};

function groupIssues(issues: IssueSummary[], mode: GroupMode) {
	const groups = new Map<string, { key: GroupKey; issues: IssueSummary[] }>();
	for (const issue of issues) {
		const key = groupKey[mode](issue);
		const group = groups.get(key.label) ?? { key, issues: [] };
		group.issues.push(issue);
		groups.set(key.label, group);
	}
	return [...groups.values()]
		.toSorted((a, b) => a.key.sortKey.localeCompare(b.key.sortKey))
		.map(({ key, issues }) => ({ label: key.label, issues }));
}

async function fetchIssue(apiKey: string, id: string): Promise<Issue> {
	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: apiKey },
		body: JSON.stringify({ query: ISSUE_QUERY, variables: { id } }),
	});
	const json = (await response.json()) as {
		data?: { issue: Issue | null };
		errors?: { message: string }[];
	};
	if (json.errors?.length) throw new Error(json.errors[0].message);
	if (!json.data?.issue) throw new Error(`Linear has no issue ${id}`);
	return json.data.issue;
}

async function fetchAssignedIssues(apiKey: string): Promise<IssueSummary[]> {
	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: apiKey },
		body: JSON.stringify({ query: ASSIGNED_ISSUES }),
	});
	const json = (await response.json()) as {
		data?: { viewer: { assignedIssues: { nodes: IssueSummary[] } } };
		errors?: { message: string }[];
	};
	if (json.errors?.length) throw new Error(json.errors[0].message);
	return (json.data?.viewer.assignedIssues.nodes ?? []).toSorted(
		byWorkflowOrder,
	);
}

function ticketIdFromBranch(branch: string | undefined) {
	const match = branch?.match(/([a-z]+-\d+)/i);
	return match ? match[1].toUpperCase() : undefined;
}

type PluginContext = ReturnType<typeof usePlugin>;

function markdownStyle(theme: PluginContext["theme"]) {
	const markdown = theme.markdown;
	return SyntaxStyle.fromStyles({
		default: { fg: theme.text.default },
		"markup.heading": { fg: markdown.heading, bold: true },
		"markup.heading.1": { fg: markdown.heading, bold: true, underline: true },
		"markup.strong": { fg: markdown.strong, bold: true },
		"markup.italic": { fg: markdown.emphasis, italic: true },
		"markup.list": { fg: markdown.listItem },
		"markup.quote": { fg: markdown.blockQuote, italic: true },
		"markup.raw": { fg: markdown.code },
		"markup.link": { fg: markdown.link, underline: true },
		"markup.link.url": { fg: markdown.link, underline: true },
		"markup.link.label": { fg: markdown.linkText, underline: true },
		"markup.strikethrough": { fg: theme.text.subdued },
	});
}

function openUrl(url: string) {
	const protocol = URL.parse(url)?.protocol;
	if (protocol === "http:" || protocol === "https:") execFile("open", [url]);
}

function TicketDetail(props: {
	context: PluginContext;
	apiKey: string;
	identifier: string;
	onPickLink: (urls: string[]) => void;
}) {
	const theme = () => props.context.theme;
	const syntaxStyle = () => markdownStyle(props.context.theme);
	const [issue] = createResource(() =>
		fetchIssue(props.apiKey, props.identifier),
	);
	const urls = () => extractUrls(issue()?.description ?? "");

	props.context.keymap.layer(() => ({
		mode: "global",
		commands: [
			{
				id: "linear.detail.browser",
				title: "Open ticket in browser",
				bind: "o",
				run: () => {
					const url = issue()?.url;
					if (url) openUrl(url);
				},
			},
			{
				id: "linear.detail.links",
				title: "Open a link from the description",
				bind: "l",
				enabled: () => urls().length > 0,
				run: () => props.onPickLink(urls()),
			},
		],
	}));

	return (
		<box
			style={{
				flexDirection: "column",
				gap: 1,
				padding: 1,
				height: "100%",
			}}
		>
			<Show when={issue.loading}>
				<text fg={theme().text.subdued}>Loading {props.identifier}…</text>
			</Show>
			<Show when={issue.error}>
				<text fg={theme().text.default}>
					{String(issue.error?.message ?? issue.error)}
				</text>
			</Show>
			<Show when={issue()}>
				{(data) => (
					<>
						<text fg={theme().text.default}>
							<b>
								{data().identifier} {data().title}
							</b>
						</text>
						<text fg={theme().text.subdued}>
							{data().state.name} ·{" "}
							{data().assignee?.displayName ?? "Unassigned"}
						</text>
						<scrollbox focused style={{ flexGrow: 1 }}>
							<markdown
								content={
									data().description
										? unescapeBareUrls(data().description ?? "")
										: "_No description._"
								}
								syntaxStyle={syntaxStyle()}
								fg={theme().text.default}
								conceal
							/>
						</scrollbox>
					</>
				)}
			</Show>
			<text fg={theme().text.subdued}>
				{[
					"[↑↓] scroll",
					"[o] browser",
					...(urls().length > 0 ? [`[l] links (${urls().length})`] : []),
					"[esc] close",
				].join(" · ")}
			</text>
		</box>
	);
}

const run = promisify(execFile);

function reviewSources(apiKey: string): ReviewSources {
	return {
		pullRequestLinks: async (identifier) =>
			(await fetchIssue(apiKey, identifier)).attachments.nodes,
		pullRequestState: async (url) => {
			const { stdout } = await run("gh", [
				"pr",
				"view",
				url,
				"--json",
				"title,url,state,isDraft,additions,deletions",
			]);
			return parsePullRequestState(stdout);
		},
		writeClipboard: async (html, text) => {
			await run("osascript", ["-e", richClipboardScript(html, text)]);
		},
	};
}

function reviewCopyToast(result: ReviewCopyResult) {
	const parts = [
		result.copied > 0
			? `Copied ${result.copied} PR${result.copied === 1 ? "" : "s"} for review.`
			: "Nothing copied.",
	];
	if (result.notReady.length > 0) {
		parts.push(`No PRs ready for review: ${result.notReady.join(", ")}.`);
	}
	if (result.failed.length > 0) {
		parts.push(`Could not check: ${result.failed.join(", ")}.`);
	}
	const variant: "success" | "warning" =
		result.copied > 0 && result.failed.length === 0 ? "success" : "warning";
	return { message: parts.join(" "), variant };
}

function resolveWorkspaceRoot(context: PluginContext) {
	return expandHome(
		(context.options.workspaceRoot as string | undefined) ?? "~/projects",
		homedir(),
	);
}

function writePlainClipboard(text: string) {
	return new Promise<void>((resolve, reject) => {
		const pbcopy = spawn("pbcopy");
		pbcopy.on("error", reject);
		pbcopy.stdin.on("error", reject);
		pbcopy.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`)),
		);
		pbcopy.stdin.end(text);
	});
}

const WORKSPACE = "";

type RepoMemory = {
	repoFor: (project: string) => string | undefined;
	remember: (project: string, repo: string) => void;
};

async function findPlanAgent(context: PluginContext, directory: string) {
	const { data: agents } = await context.client.agent.list({
		location: { directory },
	});
	const plan = agents.find(
		(agent) => agent.id === "plan" || agent.name.toLowerCase() === "plan",
	);
	if (!plan) {
		const names = agents.map((agent) => agent.id).join(", ");
		throw new Error(`No plan agent in ${directory}. Agents: ${names}`);
	}
	return plan;
}

async function launchTicketSession(
	context: PluginContext,
	apiKey: string,
	identifier: string,
	memory: RepoMemory,
) {
	const workspaceRoot = resolveWorkspaceRoot(context);

	const ticket = await fetchIssue(apiKey, identifier);
	const remembered = ticket.project
		? memory.repoFor(ticket.project.name)
		: undefined;
	const current = (context.location ?? context.data.location.default())
		.directory;
	const repos = listRepos(workspaceRoot);
	const preferred = [remembered, current].filter(
		(repo): repo is string => !!repo && repos.includes(repo),
	);
	const repoOptions = [...new Set([...preferred, WORKSPACE, ...repos])].map(
		(repo) => ({
			title:
				repo === WORKSPACE ? `Workspace (${workspaceRoot})` : basename(repo),
			description:
				repo === WORKSPACE
					? "Let the agent find the repos"
					: repo === remembered
						? `Last used for ${ticket.project?.name}`
						: repo === current
							? "Current repo"
							: undefined,
			value: repo,
		}),
	);

	const repo = await context.ui.dialog.select({
		title: `Start ${identifier} in`,
		placeholder: "Filter repos",
		options: repoOptions,
	});
	if (repo === undefined) return;

	const mode = await context.ui.dialog.select<LaunchMode>({
		title: `How to start ${identifier}`,
		options: [
			{
				title: "Implement",
				description: "Set up the branch and do the work",
				value: "implement",
			},
			{
				title: "Plan only",
				description: "Plan agent, no file edits",
				value: "plan",
			},
		],
	});
	if (mode === undefined) return;

	const note = await context.ui.dialog.prompt({
		title: "Note for the agent (optional)",
		placeholder: "Enter to skip",
	});
	if (note === undefined) return;

	const directory = repo === WORKSPACE ? workspaceRoot : repo;
	const planAgent =
		mode === "plan" ? await findPlanAgent(context, directory) : undefined;

	const session = await context.client.session.create({
		title: `${ticket.identifier} ${ticket.title}`,
		agent: planAgent?.id,
		location: { directory },
	});
	if (ticket.project && repo !== WORKSPACE) {
		memory.remember(ticket.project.name, repo);
	}
	context.ui.router.navigate({ type: "session", sessionID: session.id });
	await context.client.session.prompt({
		sessionID: session.id,
		text: buildLaunchPrompt({
			ticket,
			mode,
			workspaceRoot,
			repo: repo === WORKSPACE ? undefined : repo,
			note,
		}),
	});
}

function TicketList(props: {
	apiKey: () => string;
	memory: RepoMemory;
	onClose: () => void;
	onToggleFullscreen?: () => void;
	sessionID?: string;
}) {
	const context = usePlugin();
	const location = () => context.location ?? context.data.location.default();
	const branch = () =>
		context.data.location.vcs.info(location())?.branch.current;

	const [issues, { refetch }] = createResource(
		() => ({ key: props.apiKey() }),
		async ({ key }) => {
			if (!key)
				throw new Error("No Linear API key. Run /linear again to set one.");
			return fetchAssignedIssues(key);
		},
	);

	const [groupMode, setGroupMode] = createSignal<GroupMode>("state");
	const cycleGroupMode = () =>
		setGroupMode(
			GROUP_MODES[(GROUP_MODES.indexOf(groupMode()) + 1) % GROUP_MODES.length],
		);
	const groups = () => groupIssues(issues() ?? [], groupMode());
	const visibleIssues = () => groups().flatMap((group) => group.issues);

	const [selectedId, setSelectedId] = createSignal<string>();
	const selectedIndex = () => {
		const id = selectedId() ?? ticketIdFromBranch(branch());
		return Math.max(
			0,
			visibleIssues().findIndex((issue) => issue.identifier === id),
		);
	};
	const selected = () => visibleIssues()[selectedIndex()];

	const move = (delta: number) => {
		const list = visibleIssues();
		const index = Math.min(
			list.length - 1,
			Math.max(0, selectedIndex() + delta),
		);
		setSelectedId(list[index]?.identifier);
	};

	const [marked, setMarked] = createSignal<ReadonlySet<string>>(new Set());
	const isMarked = (issue: IssueSummary) => marked().has(issue.identifier);
	const setMarks = (issues: IssueSummary[], on: boolean) => {
		const next = new Set(marked());
		for (const issue of issues) {
			if (on) next.add(issue.identifier);
			else next.delete(issue.identifier);
		}
		setMarked(next);
	};
	const toggleMark = () => {
		const issue = selected();
		if (issue) setMarks([issue], !isMarked(issue));
	};
	const extendMark = (delta: number) => {
		const from = selected();
		move(delta);
		const to = selected();
		if (from && to) setMarks([from, to], true);
	};
	const toggleGroupMarks = () => {
		const issue = selected();
		const group = groups().find((group) => group.issues.includes(issue));
		if (group) setMarks(group.issues, !group.issues.every(isMarked));
	};

	const [copying, setCopying] = createSignal(false);
	const chosenIdentifiers = () => {
		const markedIds = visibleIssues()
			.filter(isMarked)
			.map((issue) => issue.identifier);
		if (markedIds.length > 0) return markedIds;
		const issue = selected();
		return issue ? [issue.identifier] : [];
	};

	const showError = (title: string) => (error: unknown) =>
		context.ui.toast.show({
			title,
			message: String((error as Error)?.message ?? error),
			variant: "error",
		});

	const copyIdentifiers = () => {
		const identifiers = chosenIdentifiers();
		if (identifiers.length === 0) return;
		const text = identifierList(identifiers);
		writePlainClipboard(text)
			.then(() => context.ui.toast.show({ message: `Copied ${text}` }))
			.catch(showError("Could not copy ticket IDs"));
	};

	const askAbout = async () => {
		const identifiers = chosenIdentifiers();
		if (identifiers.length === 0) return;
		const question = await context.ui.dialog.prompt({
			title: `Ask about ${identifierList(identifiers)}`,
			value: statusQuestion(identifiers),
		});
		if (!question?.trim()) return;
		if (props.sessionID) {
			await context.client.session.prompt({
				sessionID: props.sessionID,
				text: question,
				delivery: "queue",
			});
			context.ui.toast.show({
				message: `Asked about ${identifierList(identifiers)}`,
			});
			return;
		}
		const session = await context.client.session.create({
			title: `Ask about ${identifierList(identifiers)}`,
			location: { directory: resolveWorkspaceRoot(context) },
		});
		context.ui.router.navigate({ type: "session", sessionID: session.id });
		await context.client.session.prompt({
			sessionID: session.id,
			text: question,
		});
	};

	const copySelection = () => {
		const identifiers = chosenIdentifiers();
		if (identifiers.length === 0 || copying()) return;
		setCopying(true);
		context.ui.toast.show({ message: "Finding open PRs…" });
		copyForReview(identifiers, reviewSources(props.apiKey()))
			.then((result) => {
				context.ui.toast.show(reviewCopyToast(result));
				const done = result.copiedTickets.filter(
					(identifier) => !result.failed.includes(identifier),
				);
				setMarked(
					new Set(
						[...marked()].filter((identifier) => !done.includes(identifier)),
					),
				);
			})
			.catch((error) =>
				context.ui.toast.show({
					title: "Could not copy PRs",
					message: String(error?.message ?? error),
					variant: "error",
				}),
			)
			.finally(() => setCopying(false));
	};

	const idWidth = () =>
		Math.max(0, ...(issues() ?? []).map((issue) => issue.identifier.length));

	let scroll: ScrollBoxRenderable | undefined;
	const rowId = (issue: IssueSummary) => `linear-${issue.identifier}`;
	createEffect(() => {
		const issue = selected();
		if (issue) scroll?.scrollChildIntoView(rowId(issue));
	});

	const openInBrowser = () => {
		const url = selected()?.url;
		if (url) openUrl(url);
	};

	const [detailOpen, setDetailOpen] = createSignal(false);
	const pickLink = async (issue: IssueSummary, urls: string[]) => {
		const url = await context.ui.dialog.select({
			title: `Links in ${issue.identifier}`,
			placeholder: "Filter links",
			options: urls.map((url) => ({ title: url, value: url })),
		});
		if (url) openUrl(url);
		openDetail(issue);
	};

	const openDetail = (issue = selected()) => {
		if (!issue) return;
		setDetailOpen(true);
		context.ui.dialog.show(
			() => (
				<TicketDetail
					context={context}
					apiKey={props.apiKey()}
					identifier={issue.identifier}
					onPickLink={(urls) => pickLink(issue, urls)}
				/>
			),
			() => setDetailOpen(false),
		);
		context.ui.dialog.set({ size: "xlarge", centered: true });
	};

	const [launching, setLaunching] = createSignal(false);
	const startSession = () => {
		const issue = selected();
		if (!issue || launching()) return;
		setLaunching(true);
		context.ui.toast.show({ message: `Loading ${issue.identifier}…` });
		launchTicketSession(context, props.apiKey(), issue.identifier, props.memory)
			.catch((error) =>
				context.ui.toast.show({
					title: `Could not start ${issue.identifier}`,
					message: String(error?.message ?? error),
					variant: "error",
				}),
			)
			.finally(() => setLaunching(false));
	};

	context.keymap.layer(() => ({
		enabled: () => !detailOpen(),
		commands: [
			{
				id: "linear.ticket.mark",
				title: "Mark ticket",
				bind: "space",
				run: toggleMark,
			},
			{
				id: "linear.ticket.mark.up",
				title: "Mark and move up",
				bind: "shift+up",
				run: () => extendMark(-1),
			},
			{
				id: "linear.ticket.mark.down",
				title: "Mark and move down",
				bind: "shift+down",
				run: () => extendMark(1),
			},
			{
				id: "linear.ticket.mark.group",
				title: "Mark all tickets in the group",
				bind: "a",
				run: toggleGroupMarks,
			},
			{
				id: "linear.ticket.mark.clear",
				title: "Clear all marks",
				bind: "x",
				enabled: () => marked().size > 0,
				run: () => {
					setMarked(new Set<string>());
				},
			},
			{
				id: "linear.ticket.copy",
				title: "Copy open PRs for review",
				bind: "y",
				run: copySelection,
			},
			{
				id: "linear.ticket.copy.ids",
				title: "Copy ticket IDs",
				bind: "c",
				run: copyIdentifiers,
			},
			{
				id: "linear.ticket.ask",
				title: "Ask the agent about the tickets",
				bind: "?",
				run: () => {
					askAbout().catch(showError("Could not ask about the tickets"));
				},
			},
			{
				id: "linear.ticket.work",
				title: "Start a session for this ticket",
				bind: "w",
				run: startSession,
			},
			{
				id: "linear.ticket.detail",
				title: "Show ticket details",
				bind: "return",
				run: () => openDetail(),
			},
			{
				id: "linear.ticket.up",
				title: "Previous ticket",
				bind: "up",
				run: () => move(-1),
			},
			{
				id: "linear.ticket.down",
				title: "Next ticket",
				bind: "down",
				run: () => move(1),
			},
			{
				id: "linear.ticket.group",
				title: "Change grouping",
				bind: "g",
				run: cycleGroupMode,
			},
			{
				id: "linear.ticket.browser",
				title: "Open ticket in browser",
				bind: "o",
				run: openInBrowser,
			},
			{
				id: "linear.ticket.refresh",
				title: "Refresh tickets",
				bind: "r",
				run: () => refetch(),
			},
			{
				id: "linear.ticket.fullscreen",
				title: "Toggle fullscreen",
				bind: "f",
				enabled: () => !!props.onToggleFullscreen,
				run: () => props.onToggleFullscreen?.(),
			},
			{
				id: "linear.ticket.close",
				title: "Close tickets",
				bind: "q",
				run: props.onClose,
			},
		],
	}));

	return (
		<box style={{ flexDirection: "column", padding: 1, gap: 1, flexGrow: 1 }}>
			<Show when={issues.loading}>
				<text fg={context.theme.text.subdued}>Loading tickets…</text>
			</Show>
			<Show when={issues.error}>
				<text fg={context.theme.text.default}>
					{String(issues.error?.message ?? issues.error)}
				</text>
			</Show>
			<Show when={issues()?.length === 0}>
				<text fg={context.theme.text.subdued}>No open tickets.</text>
			</Show>
			<scrollbox ref={scroll} style={{ flexGrow: 1 }}>
				<For each={groups()}>
					{(group) => (
						<box style={{ flexDirection: "column", marginBottom: 1 }}>
							<text fg={context.theme.text.subdued}>
								<b>
									{group.label} ({group.issues.length})
								</b>
							</text>
							<For each={group.issues}>
								{(issue) => {
									const isSelected = () => issue === selected();
									const textColor = () =>
										isSelected()
											? context.theme.text.formfield.focused
											: context.theme.text.default;
									return (
										<box
											id={rowId(issue)}
											style={{ flexDirection: "row", gap: 2, paddingX: 1 }}
											backgroundColor={
												isSelected()
													? context.theme.background.formfield.focused
													: undefined
											}
											onMouseDown={() => setSelectedId(issue.identifier)}
											onMouseUp={() => {
												if (isSelected()) openDetail();
											}}
										>
											<text
												fg={textColor()}
												style={{ width: 1, flexShrink: 0 }}
											>
												{isMarked(issue) ? "●" : " "}
											</text>
											<text
												fg={textColor()}
												style={{ width: idWidth(), flexShrink: 0 }}
											>
												<b>{issue.identifier}</b>
											</text>
											<text
												fg={textColor()}
												style={{ flexGrow: 1, flexShrink: 1 }}
												wrapMode="none"
												truncate
											>
												{isSelected() ? <b>{issue.title}</b> : issue.title}
											</text>
											<Show when={groupMode() !== "state"}>
												<text
													fg={
														isSelected()
															? textColor()
															: context.theme.text.subdued
													}
													style={{ flexShrink: 0 }}
												>
													{issue.state.name}
												</text>
											</Show>
										</box>
									);
								}}
							</For>
						</box>
					)}
				</For>
			</scrollbox>
			<text fg={context.theme.text.subdued}>
				{[
					`by ${groupMode()}`,
					...(marked().size > 0 ? [`${marked().size} marked · [x] clear`] : []),
					"[↑↓] select",
					"[enter] details",
					"[space] mark",
					"[a] mark group",
					"[y] copy PRs",
					"[c] copy IDs",
					"[?] ask",
					"[w] work",
					"[g] group",
					"[o] browser",
					"[r] refresh",
					...(props.onToggleFullscreen ? ["[f] fullscreen"] : []),
					"[q] close",
				].join(" · ")}
			</text>
		</box>
	);
}

export default Plugin.define({
	id: "linear.cli",
	setup(context) {
		const location = context.location ?? context.data.location.default();
		void context.data.location.vcs.sync(location);

		const [settings, updateSettings] = context.storage.store("settings", {
			initial: { apiKey: "", repoByProject: {} as Record<string, string> },
		});

		const memory: RepoMemory = {
			repoFor: (project) => settings.repoByProject?.[project],
			remember: (project, repo) => {
				void updateSettings((draft) => {
					draft.repoByProject = { ...draft.repoByProject, [project]: repo };
				});
			},
		};

		const ensureApiKey = async () => {
			if (settings.apiKey) return true;
			const key = await context.ui.dialog.prompt({
				title: "Linear personal API key",
				placeholder: "lin_api_...",
			});
			if (!key) return false;
			await updateSettings((draft) => {
				draft.apiKey = key;
			});
			return true;
		};

		context.ui.slot({
			append: "session.panel",
			render: (panel) => (
				<Show when={panel.name === PANEL}>
					<TicketList
						apiKey={() => settings.apiKey}
						memory={memory}
						onClose={panel.close}
						onToggleFullscreen={panel.toggleFullscreen}
						sessionID={panel.sessionID}
					/>
				</Show>
			),
		});

		const goHome = () => context.ui.router.navigate({ type: "home" });
		context.ui.router.register({
			name: PAGE,
			render: () => (
				<TicketList
					apiKey={() => settings.apiKey}
					memory={memory}
					onClose={goHome}
				/>
			),
		});

		const onTicketsPage = () => {
			const route = context.ui.router.current();
			return (
				route.type === "plugin" &&
				route.id === "linear.cli" &&
				route.name === PAGE
			);
		};

		const toggleTickets = async () => {
			if (context.ui.panel.current()?.name === PANEL) {
				context.ui.panel.close();
				return;
			}
			if (onTicketsPage()) {
				goHome();
				return;
			}
			if (!(await ensureApiKey())) return;
			if (!context.ui.panel.open(PANEL)) {
				context.ui.router.navigate({ type: "plugin", name: PAGE });
			}
		};

		context.ui.slot({
			append: "app",
			render: () => {
				context.keymap.layer(() => ({
					mode: "global",
					commands: [
						{
							id: "linear.ticket.toggle",
							title: "Toggle Linear tickets",
							group: "Linear",
							palette: true,
							slash: { name: "linear" },
							run: toggleTickets,
						},
					],
				}));
				return null;
			},
		});
	},
});
