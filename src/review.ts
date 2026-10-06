export type PullRequest = {
	title: string;
	url: string;
	additions: number;
	deletions: number;
};

export type PullRequestState = PullRequest & {
	state: string;
	isDraft: boolean;
};

const PULL_REQUEST_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export function pullRequestUrls(links: { url: string }[]) {
	return [
		...new Set(
			links.map((link) => link.url).filter((url) => PULL_REQUEST_URL.test(url)),
		),
	];
}

export function readyForReview(pulls: PullRequestState[]): PullRequest[] {
	return pulls
		.filter((pull) => pull.state === "OPEN" && !pull.isDraft)
		.map(({ title, url, additions, deletions }) => ({
			title,
			url,
			additions,
			deletions,
		}));
}

function escapeHtml(text: string) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function lineCounts(pull: PullRequest) {
	return `(+${pull.additions} -${pull.deletions})`;
}

export function reviewListHtml(pulls: PullRequest[]) {
	const items = pulls.map(
		(pull) =>
			`<li><a href="${escapeHtml(pull.url)}">${escapeHtml(pull.title)}</a> ${lineCounts(pull)}</li>`,
	);
	return `<ul>${items.join("")}</ul>`;
}

export function reviewListText(pulls: PullRequest[]) {
	return pulls
		.map((pull) => `• ${pull.title} ${lineCounts(pull)} ${pull.url}`)
		.join("\n");
}

function hex(text: string) {
	return Buffer.from(text, "utf8").toString("hex");
}

export function richClipboardScript(html: string, text: string) {
	return `set the clipboard to {«class HTML»:«data HTML${hex(html)}», «class utf8»:«data utf8${hex(text)}»}`;
}

export function parsePullRequestState(json: string): PullRequestState {
	const value = JSON.parse(json);
	if (
		typeof value?.title !== "string" ||
		typeof value?.url !== "string" ||
		typeof value?.state !== "string" ||
		typeof value?.isDraft !== "boolean" ||
		!Number.isInteger(value?.additions) ||
		!Number.isInteger(value?.deletions)
	) {
		throw new Error(`Unexpected gh output: ${json.slice(0, 200)}`);
	}
	return value;
}

export type ReviewSources = {
	pullRequestLinks: (identifier: string) => Promise<{ url: string }[]>;
	pullRequestState: (url: string) => Promise<PullRequestState>;
	writeClipboard: (html: string, text: string) => Promise<void>;
};

export type ReviewCopyResult = {
	copied: number;
	copiedTickets: string[];
	notReady: string[];
	failed: string[];
};

function settledValues<T>(results: PromiseSettledResult<T>[]) {
	return results.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
}

async function ticketPullRequests(identifier: string, sources: ReviewSources) {
	const links = await sources.pullRequestLinks(identifier);
	const states = await Promise.allSettled(
		pullRequestUrls(links).map(sources.pullRequestState),
	);
	return {
		pulls: readyForReview(settledValues(states)),
		failedPulls: states.some((state) => state.status === "rejected"),
	};
}

export async function copyForReview(
	identifiers: string[],
	sources: ReviewSources,
): Promise<ReviewCopyResult> {
	const results = await Promise.allSettled(
		identifiers.map((identifier) => ticketPullRequests(identifier, sources)),
	);
	const pulls: PullRequest[] = [];
	const result: ReviewCopyResult = {
		copied: 0,
		copiedTickets: [],
		notReady: [],
		failed: [],
	};
	results.forEach((ticket, index) => {
		const identifier = identifiers[index];
		if (ticket.status === "rejected" || ticket.value.failedPulls) {
			result.failed.push(identifier);
		}
		if (ticket.status === "rejected") return;
		if (ticket.value.pulls.length === 0) {
			if (!ticket.value.failedPulls) result.notReady.push(identifier);
			return;
		}
		pulls.push(...ticket.value.pulls);
		result.copiedTickets.push(identifier);
	});
	if (pulls.length > 0) {
		await sources.writeClipboard(reviewListHtml(pulls), reviewListText(pulls));
	}
	result.copied = pulls.length;
	return result;
}

export function identifierList(identifiers: string[]) {
	return identifiers.join(", ");
}

export function statusQuestion(identifiers: string[]) {
	return `What is the state of ${identifierList(identifiers)}? For each ticket: the Linear status, open PRs with review and CI status, and any blockers.`;
}
