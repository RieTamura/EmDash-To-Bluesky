import type { StorageCollection } from "emdash";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { buildPost, DEFAULT_TEMPLATE, type BlobRef } from "./post";

/**
 * Posts an article to Bluesky the first time it is published.
 *
 * It posts at most once per article. The record is claimed before anything is
 * sent, so a crash can leave a post unsent (shown in the admin, with a button
 * to send it) but can never send it twice by itself.
 *
 * A sandbox allows 10 subrequests per run, and every storage, settings, content
 * and media call counts as well as every fetch. A publish makes 9: settings,
 * kv, claim, public URL, session, image bytes, image upload, post, record. A
 * resend from the admin makes 10. Count again before adding a call.
 */

type ShareStatus = "pending" | "shared" | "failed" | "skipped";

/** One record per article, keyed "<collection>:<translation group or id>". */
interface ShareRecord {
	collection: string;
	id: string;
	title: string;
	status: ShareStatus;
	uri?: string;
	/** Why the post failed, or why the thumbnail was left off. */
	note?: string;
	updatedAt: string;
}

interface Entry {
	id: string;
	slug?: string | null;
	status?: string;
	locale?: string | null;
	publishedAt?: string | null;
	translationGroup?: string | null;
	data?: Record<string, unknown>;
}

interface Settings {
	handle?: string;
	appPassword?: string;
	collections: string;
	template: string;
	/** Why the settings could not be read, such as a missing encryption key. */
	readError?: string;
}

const API = "https://bsky.social/xrpc";
/** Bluesky's limit for a link card's thumbnail. */
const MAX_THUMB_BYTES = 1_000_000;
const DEFAULT_COLLECTIONS = "posts";
const SINCE_KEY = "state:since";
const ADMIN_LIMIT = 50;
/** A Worker's after-response work ends at 30 s. Stop before that. */
const HOOK_TIMEOUT = 25_000;

function sharesOf(ctx: PluginContext) {
	return ctx.storage.shares as StorageCollection<ShareRecord>;
}

function shareKey(collection: string, entry: Entry) {
	return `${collection}:${entry.translationGroup || entry.id}`;
}

function titleOf(entry: Entry) {
	const title = entry.data?.title;
	return typeof title === "string" && title ? title : (entry.slug ?? entry.id);
}

/** All settings in one call, to stay within the subrequest limit. */
async function readSettings(ctx: PluginContext): Promise<Settings> {
	try {
		const values = new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
		const text = (key: string) => {
			const value = values.get(key);
			return typeof value === "string" ? value : undefined;
		};
		return {
			handle: text("handle")?.trim().replace(/^@/, ""),
			appPassword: text("appPassword")?.trim(),
			collections: text("collections") ?? DEFAULT_COLLECTIONS,
			template: text("template") || DEFAULT_TEMPLATE,
		};
	} catch (error) {
		return {
			collections: DEFAULT_COLLECTIONS,
			template: DEFAULT_TEMPLATE,
			readError: `The settings could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function isCollectionAllowed(settings: Settings, collection: string) {
	return settings.collections
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.includes(collection.toLowerCase());
}

/** Only Bluesky's error code and message: never the request, which holds the password. */
async function apiError(step: string, response: Response) {
	let detail = "";
	try {
		const body = (await response.json()) as { error?: unknown; message?: unknown };
		detail = [body.error, body.message].filter((part) => typeof part === "string").join(": ");
	} catch {
		// Not JSON: the status is all there is.
	}
	return new Error(`${step}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
}

async function sendJson<T>(ctx: PluginContext, method: string, body: unknown, jwt?: string) {
	const response = await ctx.http!.fetch(`${API}/${method}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw await apiError(method, response);
	return (await response.json()) as T;
}

/** The featured image as a card thumbnail. A missing thumbnail must not stop the post. */
async function uploadThumb(
	ctx: PluginContext,
	entry: Entry,
	jwt: string,
): Promise<{ thumb?: BlobRef; note?: string }> {
	const image = entry.data?.featured_image as { id?: unknown; provider?: unknown } | null | undefined;
	if (typeof image?.id !== "string" || !image.id) return {};
	if (image.provider && image.provider !== "local") return {};
	try {
		const media = await ctx.media!.readBytes!(image.id, { maxBytes: MAX_THUMB_BYTES });
		const response = await ctx.http!.fetch(`${API}/com.atproto.repo.uploadBlob`, {
			method: "POST",
			headers: { "Content-Type": media.mimeType, Authorization: `Bearer ${jwt}` },
			body: media.bytes as unknown as BodyInit,
		});
		if (!response.ok) throw await apiError("uploadBlob", response);
		const { blob } = (await response.json()) as { blob: BlobRef };
		return { thumb: blob };
	} catch (error) {
		ctx.log.warn(`bluesky-share: posting without a thumbnail: ${String(error)}`);
		return { note: "No thumbnail: the image could not be sent (it may be over 1 MB). / サムネイルなし：画像を送れませんでした（1 MB を超えている可能性があります）。" };
	}
}

/** Sends the post and returns its AT URI. Throws on failure. */
async function send(
	ctx: PluginContext,
	collection: string,
	entry: Entry,
	credentials: { handle: string; appPassword: string; template: string },
) {
	const url = await ctx.content!.getPublicUrl!(collection, entry.id);
	if (!url) throw new Error("The entry has no public URL.");
	const session = await sendJson<{ accessJwt: string; did: string }>(
		ctx,
		"com.atproto.server.createSession",
		{ identifier: credentials.handle, password: credentials.appPassword },
	);
	const { thumb, note } = await uploadThumb(ctx, entry, session.accessJwt);
	const excerpt = entry.data?.excerpt;
	const record = buildPost(credentials.template, {
		title: titleOf(entry),
		url,
		excerpt: typeof excerpt === "string" ? excerpt : undefined,
		locale: entry.locale,
		thumb,
		now: new Date().toISOString(),
	});
	const created = await sendJson<{ uri: string }>(
		ctx,
		"com.atproto.repo.createRecord",
		{ repo: session.did, collection: "app.bsky.feed.post", record },
		session.accessJwt,
	);
	return { uri: created.uri, note };
}

/** Sends a claimed record and saves how it went. Never throws: publishing must not depend on this. */
async function sendAndRecord(
	ctx: PluginContext,
	key: string,
	collection: string,
	entry: Entry,
	settings: Settings,
): Promise<ShareRecord> {
	const base = { collection, id: entry.id, title: titleOf(entry) };
	const now = () => new Date().toISOString();
	let record: ShareRecord;
	try {
		if (settings.readError) throw new Error(settings.readError);
		const { handle, appPassword, template } = settings;
		if (!handle || !appPassword) {
			record = {
				...base,
				status: "skipped",
				note: "The handle or app password is not set. / ハンドルかアプリパスワードが未設定です。",
				updatedAt: now(),
			};
		} else {
			const { uri, note } = await send(ctx, collection, entry, { handle, appPassword, template });
			record = { ...base, status: "shared", uri, note, updatedAt: now() };
		}
	} catch (error) {
		const note = error instanceof Error ? error.message : String(error);
		ctx.log.error(`bluesky-share: could not post ${collection}/${entry.id}: ${note}`);
		record = { ...base, status: "failed", note, updatedAt: now() };
	}
	await sharesOf(ctx).put(key, record);
	return record;
}

async function shareOnPublish(ctx: PluginContext, collection: string, entry: Entry) {
	if (entry.status !== "published") return;
	const settings = await readSettings(ctx);
	if (!isCollectionAllowed(settings, collection)) return;

	// Republishing keeps publishedAt, so an article from before the plugin was
	// installed is still old when it is edited and republished.
	const since = await ctx.kv.get<string>(SINCE_KEY);
	if (!since || !entry.publishedAt || Date.parse(entry.publishedAt) < Date.parse(since)) return;

	const key = shareKey(collection, entry);
	const claim = await sharesOf(ctx).compareAndSet(key, null, {
		collection,
		id: entry.id,
		title: titleOf(entry),
		status: "pending",
		updatedAt: new Date().toISOString(),
	});
	if (!claim.applied) return;
	await sendAndRecord(ctx, key, collection, entry, settings);
}

/** The start line for "new". Kept when the plugin is switched off and on again. */
async function markStart(ctx: PluginContext) {
	await ctx.kv.compareAndSet(SINCE_KEY, null, new Date().toISOString());
}

// ── Admin page ──────────────────────────────────────────────────

const STATUS_LABEL: Record<ShareStatus, string> = {
	pending: "Interrupted? / 中断の可能性",
	shared: "Shared / 投稿済み",
	failed: "Failed / 失敗",
	skipped: "Not sent / 未送信",
};

function postLink(uri: string | undefined) {
	const match = uri?.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
	return match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : undefined;
}

async function sharesPage(
	ctx: PluginContext,
	toast?: { type: "success" | "error"; message: string },
	/** Rows to show without reading them again, when a run has used up its subrequests. */
	known?: Array<{ id: string; data: ShareRecord }>,
) {
	const items =
		known ?? (await sharesOf(ctx).query({ orderBy: { updatedAt: "desc" }, limit: ADMIN_LIMIT })).items;
	return {
		blocks: [
			{ type: "header", text: "Bluesky Share" },
			{
				type: "context",
				text: "New articles are posted once, when first published. Before sending an “Interrupted?” row, check Bluesky: it may have arrived already. / 新しい記事を、最初の公開時に 1 回だけ投稿します。「中断の可能性」の行を送る前に、すでに届いていないか Bluesky を確認してください。",
			},
			{
				type: "table",
				page_action_id: "shares_page",
				columns: [
					{ key: "title", label: "Article / 記事" },
					{ key: "status", label: "Status / 状態", format: "badge" },
					{ key: "note", label: "Note / メモ" },
					{ key: "updatedAt", label: "Updated / 更新", format: "relative_time" },
					{ key: "action", label: "Action / 操作", format: "element" },
				],
				rows: items.map(({ id, data }) => {
					const link = postLink(data.uri);
					return {
						title: data.title,
						status: STATUS_LABEL[data.status],
						note: data.note ?? "",
						updatedAt: data.updatedAt,
						action: link
							? { type: "link", label: "Open / 開く", target: { kind: "external", url: link } }
							: { type: "button", action_id: "send", label: "Send / 送る", value: id },
					};
				}),
				empty_text: "Nothing yet. / まだありません。",
			},
		],
		...(toast ? { toast } : {}),
	};
}

async function resend(ctx: PluginContext, key: string) {
	const current = await sharesOf(ctx).getVersioned(key);
	if (!current || current.value.status === "shared") return sharesPage(ctx);
	const entry = (await ctx.content!.get(current.value.collection, current.value.id)) as Entry | null;
	if (!entry || entry.status !== "published") {
		return sharesPage(ctx, { type: "error", message: "This article is not published. / この記事は公開されていません。" });
	}
	// Two presses (or two admins) must not post twice.
	const claim = await sharesOf(ctx).compareAndSet(key, current.revision, {
		...current.value,
		status: "pending",
		updatedAt: new Date().toISOString(),
	});
	if (!claim.applied) return sharesPage(ctx);
	const settings = await readSettings(ctx);
	const after = await sendAndRecord(ctx, key, current.value.collection, entry, settings);
	// Only this row: reading the whole list would pass the subrequest limit.
	// Opening the page again shows the rest.
	return sharesPage(
		ctx,
		after.status === "shared"
			? { type: "success", message: "Posted. / 投稿しました。" }
			: { type: "error", message: after.note ?? "Could not post. / 投稿できませんでした。" },
		[{ id: key, data: after }],
	);
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => markStart(ctx),
		"plugin:activate": async (_event, ctx) => markStart(ctx),
		"content:afterPublish": {
			timeout: HOOK_TIMEOUT,
			handler: async (event, ctx) => {
				await shareOnPublish(ctx, event.collection, event.content as unknown as Entry);
			},
		},
	},
	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const input = routeCtx.input as { type?: unknown; action_id?: unknown; value?: unknown } | null;
				if (input?.type === "block_action" && input.action_id === "send" && typeof input.value === "string") {
					return resend(ctx, input.value);
				}
				return sharesPage(ctx);
			},
		},
	},
};

export default plugin;
