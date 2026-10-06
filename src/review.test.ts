import { describe, expect, test } from "bun:test";
import {
	type PullRequestState,
	type ReviewSources,
	copyForReview,
	identifierList,
	parsePullRequestState,
	pullRequestUrls,
	readyForReview,
	reviewListHtml,
	reviewListText,
	richClipboardScript,
	statusQuestion,
} from "./review";

describe("pullRequestUrls", () => {
	test("keeps GitHub pull request links once, in order", () => {
		expect(
			pullRequestUrls([
				{ url: "https://github.com/acme/web/pull/12" },
				{ url: "https://app.intercom.com/a/apps/1/conversations/2" },
				{ url: "https://github.com/acme/web/issues/3" },
				{ url: "https://github.com/acme/api/pull/7" },
				{ url: "https://github.com/acme/web/pull/12" },
			]),
		).toEqual([
			"https://github.com/acme/web/pull/12",
			"https://github.com/acme/api/pull/7",
		]);
	});

	test("rejects URLs with spaces, queries, or fragments", () => {
		expect(
			pullRequestUrls([
				{ url: "https://github.com/acme/web app/pull/1" },
				{ url: "https://github.com/acme/web/pull/1?x=1" },
				{ url: "https://github.com/acme/web/pull/1#discussion" },
			]),
		).toEqual([]);
	});
});

describe("readyForReview", () => {
	test("keeps open pull requests that are not drafts", () => {
		const pull = (state: string, isDraft: boolean, number: number) => ({
			title: `PR ${number}`,
			url: `https://github.com/acme/web/pull/${number}`,
			state,
			isDraft,
			additions: number * 10,
			deletions: number,
		});
		expect(
			readyForReview([
				pull("OPEN", false, 1),
				pull("OPEN", true, 2),
				pull("MERGED", false, 3),
				pull("CLOSED", false, 4),
			]),
		).toEqual([
			{
				title: "PR 1",
				url: "https://github.com/acme/web/pull/1",
				additions: 10,
				deletions: 1,
			},
		]);
	});
});

const pulls = [
	{
		title: "Add retry backoff",
		url: "https://github.com/acme/web/pull/12",
		additions: 140,
		deletions: 27,
	},
	{
		title: 'Fix <script> & "quotes"',
		url: "https://github.com/acme/api/pull/7",
		additions: 3,
		deletions: 0,
	},
];

describe("reviewListHtml", () => {
	test("makes a list of linked titles with line counts and HTML escaped", () => {
		expect(reviewListHtml(pulls)).toBe(
			'<ul><li><a href="https://github.com/acme/web/pull/12">Add retry backoff</a> (+140 -27)</li>' +
				'<li><a href="https://github.com/acme/api/pull/7">Fix &lt;script&gt; &amp; &quot;quotes&quot;</a> (+3 -0)</li></ul>',
		);
	});
});

describe("reviewListText", () => {
	test("puts one pull request on each line", () => {
		expect(reviewListText(pulls)).toBe(
			'• Add retry backoff (+140 -27) https://github.com/acme/web/pull/12\n• Fix <script> & "quotes" (+3 -0) https://github.com/acme/api/pull/7',
		);
	});
});

describe("richClipboardScript", () => {
	test("hex-encodes both formats so no text reaches AppleScript as code", () => {
		const script = richClipboardScript('<a href="x">"</a>', 'say "hi"');
		expect(script).toBe(
			`set the clipboard to {«class HTML»:«data HTML${Buffer.from('<a href="x">"</a>').toString("hex")}», «class utf8»:«data utf8${Buffer.from('say "hi"').toString("hex")}»}`,
		);
		expect(script).not.toContain('"');
	});
});

describe("parsePullRequestState", () => {
	test("returns gh output with the expected fields", () => {
		const json =
			'{"title":"T","url":"https://github.com/a/b/pull/1","state":"OPEN","isDraft":false,"additions":5,"deletions":2}';
		expect(parsePullRequestState(json).title).toBe("T");
	});

	test("throws on unexpected gh output", () => {
		expect(() => parsePullRequestState('{"title":"T"}')).toThrow(
			"Unexpected gh output",
		);
		expect(() =>
			parsePullRequestState(
				'{"title":"T","url":"u","state":"OPEN","isDraft":false}',
			),
		).toThrow("Unexpected gh output");
	});
});

describe("copyForReview", () => {
	const pr = (repo: string, number: number) =>
		`https://github.com/acme/${repo}/pull/${number}`;
	const states: Record<string, Omit<PullRequestState, "url">> = {
		[pr("web", 1)]: {
			title: "Open one",
			additions: 1,
			deletions: 1,
			state: "OPEN",
			isDraft: false,
		},
		[pr("web", 2)]: {
			title: "Draft",
			additions: 1,
			deletions: 1,
			state: "OPEN",
			isDraft: true,
		},
		[pr("api", 3)]: {
			title: "Merged",
			additions: 1,
			deletions: 1,
			state: "MERGED",
			isDraft: false,
		},
		[pr("api", 4)]: {
			title: "Open two",
			additions: 1,
			deletions: 1,
			state: "OPEN",
			isDraft: false,
		},
	};
	const links: Record<string, string[]> = {
		"ENG-1": [pr("web", 1), "https://app.intercom.com/x", pr("web", 2)],
		"ENG-2": [pr("api", 3)],
		"ENG-3": [pr("api", 4), pr("api", 5)],
	};

	function sources(clipboard: { html?: string; text?: string }): ReviewSources {
		return {
			pullRequestLinks: async (identifier) => {
				if (!(identifier in links)) throw new Error(`no ticket ${identifier}`);
				return links[identifier].map((url) => ({ url }));
			},
			pullRequestState: async (url) => {
				const state = states[url];
				if (!state) throw new Error(`gh failed for ${url}`);
				return { ...state, url };
			},
			writeClipboard: async (html, text) => {
				clipboard.html = html;
				clipboard.text = text;
			},
		};
	}

	test("copies ready PRs and reports tickets without them", async () => {
		const clipboard: { html?: string; text?: string } = {};
		const result = await copyForReview(["ENG-1", "ENG-2"], sources(clipboard));
		expect(result).toEqual({
			copied: 1,
			copiedTickets: ["ENG-1"],
			notReady: ["ENG-2"],
			failed: [],
		});
		expect(clipboard.text).toBe(`• Open one (+1 -1) ${pr("web", 1)}`);
	});

	test("copies what it can when a ticket or a PR check fails", async () => {
		const clipboard: { html?: string; text?: string } = {};
		const result = await copyForReview(
			["ENG-1", "ENG-3", "ENG-404"],
			sources(clipboard),
		);
		expect(result).toEqual({
			copied: 2,
			copiedTickets: ["ENG-1", "ENG-3"],
			notReady: [],
			failed: ["ENG-3", "ENG-404"],
		});
		expect(clipboard.text).toBe(
			`• Open one (+1 -1) ${pr("web", 1)}\n• Open two (+1 -1) ${pr("api", 4)}`,
		);
	});

	test("does not touch the clipboard when nothing is ready", async () => {
		const clipboard: { html?: string; text?: string } = {};
		const result = await copyForReview(["ENG-2"], sources(clipboard));
		expect(result.copied).toBe(0);
		expect(clipboard).toEqual({});
	});
});

describe("identifierList", () => {
	test("joins identifiers with commas", () => {
		expect(identifierList(["ENG-1", "ENG-4"])).toBe("ENG-1, ENG-4");
	});
});

describe("statusQuestion", () => {
	test("asks about every ticket", () => {
		expect(statusQuestion(["ENG-1", "ENG-4"])).toStartWith(
			"What is the state of ENG-1, ENG-4? For each ticket:",
		);
	});
});
