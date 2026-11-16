# EmDash To Bluesky

EmDash の記事を、最初に公開したときに 1 回だけ Bluesky に投稿するプラグインです。タイトルとリンクに、アイキャッチ画像付きのリンクカードを添えます。

[English](README.md)

## 特徴

- **アイキャッチ画像がカードに出ます。** 標準の `featured_image` をそのまま使います。
- **接続先は Bluesky だけです。** 通信できるのは `bsky.social` に限られるので、アプリパスワードがほかへ送られることはありません。
- **別のサービスのアカウントは不要です。** Bluesky のアプリパスワードだけで動きます。
- **二重に投稿しません。** 送信の前に記録を残すので、途中で止まっても自動で送り直しません。翻訳版は 1 つの投稿にまとめます。

Bluesky に共有するだけの、シンプルなプラグインです。[standard.site](https://standard.site/) にも記録したいときや、記事を消したときに投稿も消したいときは、公式の AT Protocol Syndication プラグインが向いています。

## 動作の決まり

- プラグインを入れる前に公開した記事は、更新しても投稿しません。
- 自動では送り直しません。管理画面の「Bluesky Share」に記事ごとの状態が出て、失敗や未送信の記事には「送る」のボタンがあります。
- 記事を消しても、Bluesky の投稿は消えません。
- 1 MB を超える画像は、カードの画像なしで投稿します。Bluesky の上限のためです。
- `bsky.social` から接続できるアカウントだけを使えます。

## インストール

入れ方は 2 通りあります。

| 入れる元 | 動く場所 | Cloudflare のプラン | 入れ方と更新 |
| --- | --- | --- | --- |
| EmDash のプラグイン レジストリ | サンドボックス | **Workers Paid**（サンドボックスに必要） | 管理画面から |
| GitHub | サイトと同じ場所 | **Workers Free で動きます** | `npm install` のあと**デプロイ** |

### レジストリから

管理画面の **Registry** で **EmDash To Bluesky** を探して入れます。

サンドボックスには、処理ごとに CPU 50 ms、通信 30 回（EmDash 1.5 より前は 10 回）の制限があります。公開 1 回の通信は 9 回、管理画面からの再送は 10 回になるように作りました。1.5 より前の制限にも収まります。**サンドボックスの実機では、まだ確かめていません。** 動かないときは [Issue](https://github.com/RieTamura/EmDash-To-Bluesky/issues) で教えてください。CPU の制限にかかった場合は、大きな画像で起きる可能性があります。

### GitHub から

```sh
npm install github:RieTamura/EmDash-To-Bluesky
```

`astro.config.mjs` に足します。

```js
import blueskyShare from "bluesky-share";

emdash({
	// ...
	plugins: [blueskyShare],
});
```

デプロイします。更新するときは、同じ `npm install` のあとにデプロイします。管理画面からは更新できません。

## 設定

### 1. 暗号化の鍵を用意する

アプリパスワードの暗号化に、サイトの `EMDASH_ENCRYPTION_KEY` を使います。まだなければ作って、Worker に保存します。

```sh
npx emdash secrets generate
npx wrangler secret put EMDASH_ENCRYPTION_KEY
```

**鍵は別の場所にも保管してください。** データベースのバックアップには含まれません。なくすと、保存したパスワードを読めなくなります。

### 2. アプリパスワードを作る

Bluesky の **設定 → プライバシーとセキュリティ → アプリパスワード**で、このプラグイン専用のものを作ります。ふだんのパスワードは使わないでください。

### 3. プラグインを設定する

| 設定 | 内容 |
| --- | --- |
| Bluesky のハンドル | `name.bsky.social` など。空にすると投稿しません |
| アプリパスワード | 手順 2 で作ったもの |
| 投稿するコレクション | カンマで区切ります。既定は `posts` |
| 投稿の文面 | `{title}`、`{url}`、`{excerpt}` が使えます。既定はタイトルと URL |

**投稿するコレクションに、Bluesky から取り込むコレクション（`bluesky` など）を入れないでください。** 取り込んだ投稿をまた投稿してしまいます。

## 開発

```sh
npm install
npm test
npm run build
```

テストは Worker Loader の上で動きますが、本番の CPU と通信回数の制限までは再現しません。

## ライセンス

[MIT](LICENSE)
