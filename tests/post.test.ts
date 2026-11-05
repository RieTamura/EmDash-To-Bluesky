import { describe, expect, it } from "vitest";

import { buildPost, buildText, DEFAULT_TEMPLATE, MAX_GRAPHEMES, urlFacets } from "../src/post";

const URL = "https://example.com/posts/hello";
const count = (text: string) => [...new Intl.Segmenter().segment(text)].length;

describe("buildText", () => {
	it("fills the default template", () => {
		expect(buildText(DEFAULT_TEMPLATE, "こんにちは", URL, "")).toBe(`こんにちは\n\n${URL}`);
	});

	it("keeps the URL whole when the title is too long", () => {
		const text = buildText(DEFAULT_TEMPLATE, "あ".repeat(400), URL, "");
		expect(count(text)).toBeLessThanOrEqual(MAX_GRAPHEMES);
		expect(text.endsWith(URL)).toBe(true);
		expect(text).toContain("…");
	});

	it("shortens the excerpt before the title", () => {
		const text = buildText("{title}\n{excerpt}\n{url}", "タイトル", URL, "い".repeat(400));
		expect(count(text)).toBeLessThanOrEqual(MAX_GRAPHEMES);
		expect(text.startsWith("タイトル\n")).toBe(true);
	});

	it("does not treat a placeholder inside the title as one", () => {
		expect(buildText("{title} {url}", "{url}", URL, "")).toBe(`{url} ${URL}`);
	});
});

describe("urlFacets", () => {
	it("counts bytes, not characters", () => {
		const text = `日本語\n\n${URL}`;
		const [facet] = urlFacets(text, URL);
		// 3 Japanese characters are 9 bytes, then 2 newlines.
		expect(facet?.index).toEqual({ byteStart: 11, byteEnd: 11 + URL.length });
	});
});

describe("buildPost", () => {
	it("makes a link card and sets the language", () => {
		const post = buildPost(DEFAULT_TEMPLATE, {
			title: "T",
			url: URL,
			excerpt: "E",
			locale: "ja",
			now: "2026-11-05T00:00:00.000Z",
		});
		expect(post.langs).toEqual(["ja"]);
		expect(post.embed.external).toEqual({ uri: URL, title: "T", description: "E" });
	});
});
