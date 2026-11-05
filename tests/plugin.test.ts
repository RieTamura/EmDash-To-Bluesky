import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

const API = "https://bsky.social/xrpc";
const SITE = "https://example.com";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const BLOB = { $type: "blob", ref: { $link: "bafk" }, mimeType: "image/png", size: 11 };
const POST_URI = "at://did:plc:me/app.bsky.feed.post/abc";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function setup({ configured = true } = {}) {
	host = await createPluginRuntimeTestHost({
		site: { url: SITE, name: "Site", locale: "ja" },
		i18n: { defaultLocale: "ja", locales: ["ja", "en"] } as never,
	});
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		urlPattern: "/posts/{slug}",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "excerpt", label: "Excerpt", type: "text" },
			{ slug: "featured_image", label: "Image", type: "image" },
		],
	} as never);
	await host.actions.plugin.activate();
	if (configured) {
		await host.fixtures.plugin.setting("handle", "example.com");
		await host.fixtures.plugin.setting("appPassword", "aaaa-bbbb-cccc-dddd");
	}
	return host;
}

async function respondOk(h: PluginRuntimeTestHost, { thumb = false } = {}) {
	await h.http.respond(`${API}/com.atproto.server.createSession`, json({ accessJwt: "jwt", did: "did:plc:me" }));
	if (thumb) await h.http.respond(`${API}/com.atproto.repo.uploadBlob`, json({ blob: BLOB }));
	await h.http.respond(`${API}/com.atproto.repo.createRecord`, json({ uri: POST_URI, cid: "c" }));
}

async function draft(h: PluginRuntimeTestHost, data: Record<string, unknown> = {}) {
	return h.fixtures.content("posts", {
		slug: "hello",
		status: "draft",
		locale: "ja",
		data: { title: "こんにちは", ...data },
	});
}

async function publish(h: PluginRuntimeTestHost, id: string) {
	const result = await h.actions.content.publish("posts", id);
	expect(result.success).toBe(true);
	await h.waitForDeferredTasks();
}

const sent = (h: PluginRuntimeTestHost, method: string) =>
	h.http.requests().filter((request) => request.url === `${API}/${method}`);
const created = (h: PluginRuntimeTestHost) => sent(h, "com.atproto.repo.createRecord");
const bodyOf = (request: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(request.body));

async function onlyShare(h: PluginRuntimeTestHost) {
	const shares = await h.inspect.storage.list<{ status: string; note?: string; uri?: string }>("shares");
	expect(shares).toHaveLength(1);
	return shares[0]!;
}

describe("content:afterPublish", () => {
	it("reads the post text and collections from one settings read", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("template", "New: {title} {url}");
		await h.fixtures.plugin.setting("collections", " Pages, POSTS ");
		await respondOk(h);
		const entry = await draft(h);
		await publish(h, entry.id);

		expect(bodyOf(created(h)[0]!).record.text).toBe(`New: こんにちは ${SITE}/posts/hello`);
	});

	it("leaves out a collection that isn't in the setting", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("collections", "pages");
		await respondOk(h);
		const entry = await draft(h);
		await publish(h, entry.id);

		expect(created(h)).toHaveLength(0);
		expect(await h.inspect.storage.list("shares")).toHaveLength(0);
	});

	it("posts a new article once, with a working link", async () => {
		const h = await setup();
		await respondOk(h);
		const entry = await draft(h);
		await publish(h, entry.id);

		expect(created(h)).toHaveLength(1);
		const { record, repo } = bodyOf(created(h)[0]!);
		const url = `${SITE}/posts/hello`;
		expect(repo).toBe("did:plc:me");
		expect(record.text).toBe(`こんにちは\n\n${url}`);
		expect(record.facets[0].features[0].uri).toBe(url);
		expect(record.embed.external.uri).toBe(url);
		expect(record.embed.external.thumb).toBeUndefined();
		const share = await onlyShare(h);
		expect(share.data.status).toBe("shared");
		expect(share.data.uri).toBe(POST_URI);

		// Publishing again must not post again.
		await publish(h, entry.id);
		expect(created(h)).toHaveLength(1);
	});

	it("attaches the featured image as the card thumbnail", async () => {
		const h = await setup();
		await respondOk(h, { thumb: true });
		const media = await h.fixtures.media({ filename: "t.png", mimeType: "image/png", bytes: PNG, width: 1200, height: 630 });
		const entry = await draft(h, { featured_image: { id: media.id, provider: "local" } });
		await publish(h, entry.id);

		const [upload] = sent(h, "com.atproto.repo.uploadBlob");
		expect(upload?.headers["content-type"] ?? upload?.headers["Content-Type"]).toBe("image/png");
		expect(bodyOf(created(h)[0]!).record.embed.external.thumb).toEqual(BLOB);
	});

	it("still posts when the thumbnail cannot be sent", async () => {
		const h = await setup();
		await h.http.respond(`${API}/com.atproto.server.createSession`, json({ accessJwt: "jwt", did: "did:plc:me" }));
		await h.http.respond(`${API}/com.atproto.repo.uploadBlob`, json({ error: "BlobTooLarge" }, 400));
		await h.http.respond(`${API}/com.atproto.repo.createRecord`, json({ uri: POST_URI, cid: "c" }));
		const media = await h.fixtures.media({ filename: "t.png", mimeType: "image/png", bytes: PNG, width: 1200, height: 630 });
		const entry = await draft(h, { featured_image: { id: media.id, provider: "local" } });
		await publish(h, entry.id);

		expect(bodyOf(created(h)[0]!).record.embed.external.thumb).toBeUndefined();
		const share = await onlyShare(h);
		expect(share.data.status).toBe("shared");
		expect(share.data.note).toContain("No thumbnail");
	});

	it("does not post an article that was published before the plugin started", async () => {
		const h = await setup();
		const old = await h.fixtures.content("posts", {
			slug: "old",
			status: "published",
			publishedAt: "2020-01-01T00:00:00.000Z",
			data: { title: "古い記事" },
		});
		await publish(h, old.id);
		expect(h.http.requests()).toHaveLength(0);
		expect(await h.inspect.storage.list("shares")).toHaveLength(0);
	});

	it("ignores collections that are not selected", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("collections", "works");
		const entry = await draft(h);
		await publish(h, entry.id);
		expect(h.http.requests()).toHaveLength(0);
		expect(await h.inspect.storage.list("shares")).toHaveLength(0);
	});

	it("records an unconfigured site as not sent, and sends nothing", async () => {
		const h = await setup({ configured: false });
		const entry = await draft(h);
		await publish(h, entry.id);
		expect(h.http.requests()).toHaveLength(0);
		expect((await onlyShare(h)).data.status).toBe("skipped");
	});

	it("records a failure, keeps the password out of it, and does not retry by itself", async () => {
		const h = await setup();
		await h.http.respond(
			`${API}/com.atproto.server.createSession`,
			json({ error: "AuthenticationRequired", message: "Invalid identifier or password" }, 401),
		);
		const entry = await draft(h);
		await publish(h, entry.id);

		const share = await onlyShare(h);
		expect(share.data.status).toBe("failed");
		expect(share.data.note).toContain("Invalid identifier or password");
		expect(JSON.stringify(share)).not.toContain("aaaa-bbbb");

		await publish(h, entry.id);
		expect(sent(h, "com.atproto.server.createSession")).toHaveLength(1);
	});
});

describe("translations", () => {
	it("posts once for an article and its translation", async () => {
		const h = await setup();
		await respondOk(h);
		const entry = await draft(h);
		await publish(h, entry.id);
		const english = await h.fixtures.content("posts", {
			slug: "hello",
			status: "draft",
			locale: "en",
			translationOf: entry.id,
			data: { title: "Hello" },
		});
		await publish(h, english.id);
		expect(created(h)).toHaveLength(1);
	});

	it("links to the English page when the English version is published first", async () => {
		const h = await setup();
		await respondOk(h);
		const entry = await h.fixtures.content("posts", {
			slug: "hello",
			status: "draft",
			locale: "en",
			data: { title: "Hello" },
		});
		await publish(h, entry.id);
		const { record } = bodyOf(created(h)[0]!);
		expect(record.embed.external.uri).toBe(`${SITE}/en/posts/hello`);
		expect(record.langs).toEqual(["en"]);
	});
});

describe("admin page", () => {
	it("sends a failed article again, and only once", async () => {
		const h = await setup();
		await h.http.respond(`${API}/com.atproto.server.createSession`, json({ error: "Oops" }, 500));
		const entry = await draft(h);
		await publish(h, entry.id);
		const share = await onlyShare(h);
		expect(share.data.status).toBe("failed");

		await respondOk(h);
		const page = await h.admin.act("/shares", "send", { value: share.id });
		expect(page.toast?.type).toBe("success");
		expect(created(h)).toHaveLength(1);
		expect((await onlyShare(h)).data.status).toBe("shared");

		await h.admin.act("/shares", "send", { value: share.id });
		expect(created(h)).toHaveLength(1);
	});

	it("shows the list with a link to the post", async () => {
		const h = await setup();
		await respondOk(h);
		const entry = await draft(h);
		await publish(h, entry.id);
		const page = await h.admin.loadPage("/shares");
		expect(JSON.stringify(page.blocks)).toContain("https://bsky.app/profile/did:plc:me/post/abc");
	});
});
