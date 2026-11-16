# EmDash To Bluesky

An EmDash plugin that posts an article to Bluesky once, the first time it is published, with its title, link and a link card showing the featured image.

[日本語の説明はこちら](README_JA.md)

## Why this plugin

- **The featured image shows on the card.** It uses the standard `featured_image` field as it is.
- **It connects only to Bluesky.** It can reach `bsky.social` and nothing else, so your app password can't go anywhere else.
- **No other service or account.** All it needs is a Bluesky app password.
- **It doesn't post twice.** It records each article before sending and never resends by itself, even if it stops partway. Translations of an article share one post.

It does one thing: share to Bluesky. If you also want [standard.site](https://standard.site/) records, or want a post removed when its article is deleted, the official AT Protocol Syndication plugin is a better fit.

## How it behaves

- Articles published before you installed the plugin aren't posted, even when they're updated.
- Nothing is resent automatically. The admin page "Bluesky Share" lists each article, and a failed or unsent one has a Send button.
- Deleting an article doesn't delete its post.
- An image over 1 MB, Bluesky's limit, is left off the card and the post still goes out.
- Accounts must be reachable through `bsky.social`.

## Install

There are two ways to install it.

| From | Runs | Cloudflare plan | Install and update |
| --- | --- | --- | --- |
| The EmDash plugin registry | In the plugin sandbox | **Workers Paid** (the sandbox needs it) | From the admin |
| GitHub | In-process, with your site | **Workers Free is fine** | `npm install`, then **deploy** |

### From the registry

In the admin, open **Registry**, search for **EmDash To Bluesky** and install it.

The sandbox limits each run to 50 ms of CPU and 30 subrequests (10 before EmDash 1.5). The plugin is written to use 9 for a publish and 10 for a resend from the admin, so it stays within the older limit too. **It hasn't been tried on a real sandbox yet.** If it doesn't work, please [open an issue](https://github.com/RieTamura/EmDash-To-Bluesky/issues). A large image is the most likely thing to hit the CPU limit.

### From GitHub

```sh
npm install github:RieTamura/EmDash-To-Bluesky
```

Add it to `astro.config.mjs`:

```js
import blueskyShare from "bluesky-share";

emdash({
	// ...
	plugins: [blueskyShare],
});
```

Then deploy. To update, run the same `npm install` and deploy again; the admin can't update a plugin installed this way.

## Setup

### 1. Set an encryption key

The app password is encrypted with your site's `EMDASH_ENCRYPTION_KEY`. If you don't have one, generate it and save it to your Worker.

```sh
npx emdash secrets generate
npx wrangler secret put EMDASH_ENCRYPTION_KEY
```

**Keep a copy of the key somewhere else.** Database backups don't include it, and without it the saved password can't be read.

### 2. Make an app password

In Bluesky, open **Settings → Privacy and Security → App Passwords** and make one just for this plugin. Don't use your main password.

### 3. Fill in the plugin's settings

| Setting | What to enter |
| --- | --- |
| Bluesky handle | Such as `name.bsky.social`. Leave it empty to stop sharing |
| App password | The one from step 2 |
| Collections | Separated by commas. The default is `posts` |
| Post text | You can use `{title}`, `{url}` and `{excerpt}`. The default is the title and URL |

**Don't add a collection that imports from Bluesky, such as `bluesky`, to Collections.** Imported posts would be posted again.

## Development

```sh
npm install
npm test
npm run build
```

Tests run on Worker Loader, but they don't reproduce the CPU and subrequest limits of a deployed site.

## License

[MIT](LICENSE)
