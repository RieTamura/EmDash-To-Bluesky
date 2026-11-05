/**
 * Builds the Bluesky post record. Pure functions, no plugin context.
 */

/** Bluesky's limit for a post's text. */
export const MAX_GRAPHEMES = 300;

export const DEFAULT_TEMPLATE = "{title}\n\n{url}";

export interface BlobRef {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

export interface PostFields {
	title: string;
	url: string;
	excerpt?: string;
	/** The entry's language, e.g. "ja". */
	locale?: string | null;
	thumb?: BlobRef;
	now: string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Removes `by` graphemes from the end, including room for the "…". */
function shorten(text: string, by: number): string {
	const parts = graphemes(text);
	if (by <= 0) return text;
	if (by >= parts.length) return "";
	return `${parts.slice(0, parts.length - by - 1).join("").trimEnd()}…`;
}

function fill(template: string, title: string, url: string, excerpt: string): string {
	// Replace in one pass so a title containing "{url}" stays plain text.
	return template
		.replace(/\{(title|url|excerpt)\}/g, (_match, key: string) =>
			key === "title" ? title : key === "url" ? url : excerpt,
		)
		.trim();
}

/** The post text, within the limit. The excerpt gives way first, then the title; the URL never does. */
export function buildText(template: string, title: string, url: string, excerpt: string): string {
	const over = (t: string, e: string) => graphemes(fill(template, t, url, e)).length - MAX_GRAPHEMES;
	let shortExcerpt = excerpt;
	let shortTitle = title;
	if (over(shortTitle, shortExcerpt) > 0 && template.includes("{excerpt}")) {
		shortExcerpt = shorten(shortExcerpt, over(shortTitle, shortExcerpt));
	}
	if (over(shortTitle, shortExcerpt) > 0 && template.includes("{title}")) {
		shortTitle = shorten(shortTitle, over(shortTitle, shortExcerpt));
	}
	return fill(template, shortTitle, url, shortExcerpt);
}

/** Bluesky doesn't turn URLs into links by itself: each needs a facet with byte offsets. */
export function urlFacets(text: string, url: string) {
	const encoder = new TextEncoder();
	const facets = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf(url, from);
		if (at < 0) return facets;
		const byteStart = encoder.encode(text.slice(0, at)).length;
		facets.push({
			index: { byteStart, byteEnd: byteStart + encoder.encode(url).length },
			features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
		});
		from = at + url.length;
	}
}

export function buildPost(template: string, fields: PostFields) {
	const excerpt = fields.excerpt ?? "";
	const text = buildText(template, fields.title, fields.url, excerpt);
	const facets = urlFacets(text, fields.url);
	return {
		$type: "app.bsky.feed.post",
		text,
		createdAt: fields.now,
		...(fields.locale ? { langs: [fields.locale] } : {}),
		...(facets.length > 0 ? { facets } : {}),
		embed: {
			$type: "app.bsky.embed.external",
			external: {
				uri: fields.url,
				title: fields.title,
				description: excerpt,
				...(fields.thumb ? { thumb: fields.thumb } : {}),
			},
		},
	};
}
