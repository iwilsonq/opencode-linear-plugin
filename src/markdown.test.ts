import { describe, expect, test } from "bun:test";
import { detectLinks, MarkdownRenderable, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { extractUrls, unescapeBareUrls } from "./markdown";

type LinkDetectionHook = { _linkifyMarkdownChunks: typeof detectLinks };

async function renderedLinks(markdown: string) {
	const { renderer, renderOnce } = await createTestRenderer({
		width: 120,
		height: 20,
	});
	const view = new MarkdownRenderable(renderer, {
		content: "",
		syntaxStyle: SyntaxStyle.fromStyles({ default: {} }),
		conceal: true,
		width: 120,
	});
	const links = new Set<string>();
	const hook = view as unknown as LinkDetectionHook;
	hook._linkifyMarkdownChunks = (chunks, context) => {
		const result = detectLinks(chunks, context);
		for (const chunk of result) if (chunk.link) links.add(chunk.link.url);
		return result;
	};
	renderer.root.add(view);
	view.content = markdown;
	for (let frame = 0; frame < 10; frame++) {
		await renderOnce();
		await Bun.sleep(20);
	}
	renderer.destroy();
	return [...links];
}

describe("unescapeBareUrls", () => {
	test("removes markdown escapes from a bare URL and makes it an autolink", () => {
		expect(unescapeBareUrls("See https://x.com/a?b=c\\_d\\&e=f now")).toBe(
			"See <https://x.com/a?b=c_d&e=f> now",
		);
	});

	test("keeps trailing punctuation outside the link", () => {
		expect(unescapeBareUrls("See https://x.com/a\\_b.")).toBe(
			"See <https://x.com/a_b>.",
		);
	});

	test("leaves URLs without escapes unchanged", () => {
		const markdown = "See https://x.com/a?b=c.";
		expect(unescapeBareUrls(markdown)).toBe(markdown);
	});

	test("keeps a closing parenthesis outside the link", () => {
		expect(unescapeBareUrls("(see https://x.com/a\\_b)")).toBe(
			"(see <https://x.com/a_b>)",
		);
	});

	test("leaves a link whose label is the escaped URL unchanged", () => {
		const markdown = "[https://x.com/a\\_b](<https://x.com/a\\_b>)";
		expect(unescapeBareUrls(markdown)).toBe(markdown);
	});

	test("leaves link destinations and autolinks unchanged", () => {
		const markdown = "[x](https://x.com/a\\_b) <https://x.com/a\\_b>";
		expect(unescapeBareUrls(markdown)).toBe(markdown);
	});

	test("renders one full link for an escaped bare URL", async () => {
		expect(
			await renderedLinks(unescapeBareUrls("See https://x.com/a?b=c\\_d now")),
		).toEqual(["https://x.com/a?b=c_d"]);
	});
});

describe("extractUrls", () => {
	test("returns the full destination of a link whose label is the URL", () => {
		const url = `https://analytics.example.com/replay?filters=${"%7B".repeat(200)}&id=1`;
		expect(extractUrls(`See [${url}](<${url}>).`)).toEqual([url]);
	});

	test("finds link destinations, autolinks, and bare URLs in order", () => {
		expect(
			extractUrls(
				"[a](https://a.com/x) then <https://b.com/y> and https://c.com/z.",
			),
		).toEqual(["https://a.com/x", "https://b.com/y", "https://c.com/z"]);
	});

	test("removes markdown escapes", () => {
		expect(extractUrls("See https://x.com/a?b=c\\_d")).toEqual([
			"https://x.com/a?b=c_d",
		]);
	});

	test("lists each URL once", () => {
		expect(
			extractUrls("https://x.com/a and [x](https://x.com/a)"),
		).toEqual(["https://x.com/a"]);
	});
});
