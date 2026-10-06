const ESCAPED_BARE_URL = /(?<![[(<])https?:\/\/[^\s<>"`\]]*\\[^\s<>"`\]]*/g;
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;
const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

function trimBareUrl(url: string) {
	const opens = url.split("(").length;
	let trimmed = url.replace(TRAILING_PUNCTUATION, "");
	while (trimmed.endsWith(")") && trimmed.split(")").length > opens) {
		trimmed = trimmed.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
	}
	return trimmed;
}

export function unescapeBareUrls(markdown: string) {
	return markdown.replace(ESCAPED_BARE_URL, (match) => {
		const url = trimBareUrl(match);
		const trailing = match.slice(url.length);
		return `<${url.replace(MARKDOWN_ESCAPE, "$1")}>${trailing}`;
	});
}

const URL_IN_MARKDOWN = new RegExp(
	[
		/\[[^\]]*\]\(\s*<(https?:\/\/[^>]+)>\s*\)/.source,
		/\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)\s*\)/.source,
		/<(https?:\/\/[^>\s]+)>/.source,
		/(https?:\/\/[^\s<>"`\]]+)/.source,
	].join("|"),
	"g",
);

export function extractUrls(markdown: string) {
	const urls = new Set<string>();
	for (const [, angled, linked, autolink, bare] of markdown.matchAll(
		URL_IN_MARKDOWN,
	)) {
		const url = angled ?? linked ?? autolink ?? trimBareUrl(bare);
		urls.add(url.replace(MARKDOWN_ESCAPE, "$1"));
	}
	return [...urls];
}
