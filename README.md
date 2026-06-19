# @fun-garage/worker-mailer

日本語 | [English (original)](./README.en.md) | [简体中文](./README_zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Cloudflare Workers 上で動作する、依存ゼロの SMTP クライアント（メール送信ライブラリ）です。**

[zou-yu/worker-mailer](https://github.com/zou-yu/worker-mailer) を fun-garage 組織用にフォークしたものです。Cloudflare の [TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) を使い、外部ライブラリに一切依存せずに SMTP サーバーへメールを送信します。

> 💡 主な用途はクライアントワークで制作した Web サイトの **お問い合わせフォーム** からのメール送信です。
> フォームへの具体的な実装手順は **[お問い合わせフォーム実装ガイド（Astro + Cloudflare 版）](./docs/contact-form-astro.ja.md)** にまとめています（Astro 6 / Astro Actions / workerd ランタイム前提。Astro を使わない構成向けの補足も同ガイド内に記載）。

## 特徴

- 🚀 Cloudflare Workers ランタイムだけで完結（外部依存なし）
- 📝 TypeScript の型定義を完備
- 📧 プレーンテキスト / HTML / 添付ファイルに対応
- 🔒 複数の SMTP 認証方式に対応: `plain` / `login` / `cram-md5`
- 📅 DSN（配信状況通知）に対応
- 🈂️ 件名・表示名の日本語（非 ASCII）を自動でエンコード（RFC 2047）

## 目次

- [インストール](#インストール)
- [クイックスタート](#クイックスタート)
- [API リファレンス](#api-リファレンス)
- [制約事項](#制約事項)
- [このフォークについて](#このフォークについて)
- [開発](#開発)
- [ライセンス](#ライセンス)

## インストール

公開 GitHub リポジトリから直接インストールします。**トークンやレジストリ設定は不要**です。

```bash
npm install github:fun-garage/worker-mailer
```

バージョンを固定したい場合は、タグやコミットを指定します。

```bash
# タグを指定
npm install github:fun-garage/worker-mailer#v1.2.1

# package.json に直接書く場合
# "dependencies": {
#   "@fun-garage/worker-mailer": "github:fun-garage/worker-mailer#v1.2.1"
# }
```

> 💡 このリポジトリにはビルド済みの `dist/` がコミットされているため、インストール時のビルドは不要です。
> import 名はパッケージ名の `@fun-garage/worker-mailer` のままです。

## クイックスタート

### 1. `wrangler.toml` で Node.js 互換フラグを有効化

`cloudflare:sockets` を使うために必要です。

```toml
compatibility_flags = ["nodejs_compat"]
# または compatibility_flags = ["nodejs_compat_v2"]
```

### 2. コードから利用

接続を維持して複数通送る場合:

```typescript
import { WorkerMailer } from '@fun-garage/worker-mailer'

// SMTP サーバーに接続
const mailer = await WorkerMailer.connect({
  host: 'smtp.acme.com',
  port: 587,
  secure: false, // 587 は STARTTLS を使うので false。465 のときは true
  credentials: {
    username: 'bob@acme.com',
    password: 'password',
  },
  authType: 'plain',
})

// 送信
await mailer.send({
  from: { name: 'Bob', email: 'bob@acme.com' },
  to: { name: 'Alice', email: 'alice@acme.com' },
  subject: 'Worker Mailer からこんにちは',
  text: 'これはプレーンテキストの本文です',
  html: '<h1>こんにちは</h1><p>これは HTML の本文です</p>',
})

// 使い終わったら必ず閉じる（TCP 接続を解放するため）
await mailer.close()
```

### 3. 1 通だけ送る（使い切り）

お問い合わせフォームのような「1 リクエストで 1 通」の用途では、接続〜送信〜切断を一括で行う静的メソッドが便利です。

```typescript
import { WorkerMailer } from '@fun-garage/worker-mailer'

await WorkerMailer.send(
  {
    host: 'smtp.acme.com',
    port: 587,
    credentials: { username: 'user', password: 'pass' },
    authType: 'plain',
  },
  {
    from: 'sender@acme.com',
    to: 'recipient@acme.com',
    subject: 'お問い合わせを受け付けました',
    text: 'お問い合わせありがとうございます。',
  },
)
```

### 4. Next.js / Nuxt / SvelteKit などのフレームワークと併用する場合

開発時は Node.js ランタイムで動くため、`cloudflare:sockets` が使えません。動的 import で本番（Workers）と開発（nodemailer 等）を切り替えます。

```typescript
export default defineEventHandler(async event => {
  if (import.meta.dev) {
    // 開発: nodemailer など Node.js 対応のライブラリを使う
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.default.createTransport(/* ... */)
    return await transporter.sendMail(/* ... */)
  } else {
    // 本番: Cloudflare Workers 上で worker-mailer を使う
    const { WorkerMailer } = await import('@fun-garage/worker-mailer')
    await WorkerMailer.send(/* config */, /* email */)
  }
})
```

## API リファレンス

### `WorkerMailer.connect(options)`

SMTP 接続を確立し、認証まで済ませた `WorkerMailer` を返します。

```typescript
type WorkerMailerOptions = {
  host: string // SMTP サーバーのホスト名
  port: number // ポート（通常 587 または 465）
  secure?: boolean // 最初から TLS で接続するか（既定: false）
  startTls?: boolean // STARTTLS で TLS に昇格するか（既定: true）
  credentials?: {
    username: string
    password: string
  }
  authType?:
    | 'plain'
    | 'login'
    | 'cram-md5'
    | Array<'plain' | 'login' | 'cram-md5'>
  logLevel?: LogLevel // ログレベル（既定: LogLevel.INFO）
  socketTimeoutMs?: number // ソケット接続のタイムアウト（ミリ秒。既定: 60000）
  responseTimeoutMs?: number // サーバー応答待ちのタイムアウト（ミリ秒。既定: 30000）
  dsn?: {
    RET?: { HEADERS?: boolean; FULL?: boolean }
    NOTIFY?: { DELAY?: boolean; FAILURE?: boolean; SUCCESS?: boolean }
  }
}
```

### `mailer.send(options)`

メールを送信します（内部のキューに積まれ、順番に送信されます）。

```typescript
type EmailOptions = {
  from: string | { name?: string; email: string } // 送信元
  to:
    | string
    | string[]
    | { name?: string; email: string }
    | Array<{ name?: string; email: string }> // 宛先（To）
  reply?: string | { name?: string; email: string } // 返信先（Reply-To）
  cc?: /* to と同じ型 */ // CC
  bcc?: /* to と同じ型 */ // BCC
  subject: string // 件名
  text?: string // プレーンテキスト本文
  html?: string // HTML 本文
  headers?: Record<string, string> // 追加・上書きするヘッダ
  // 添付。content は base64 エンコード済み。mimeType 省略時は拡張子から推測。
  attachments?: { filename: string; content: string; mimeType?: string }[]
  // この 1 通だけ DSN 設定を上書き
  dsnOverride?: {
    envelopeId?: string
    RET?: { HEADERS?: boolean; FULL?: boolean }
    NOTIFY?: { DELAY?: boolean; FAILURE?: boolean; SUCCESS?: boolean }
  }
}
```

> `text` と `html` の少なくとも一方は必須です。両方指定すると、受信側の環境に応じて表示が切り替わります（`multipart/alternative`）。

### `mailer.close()`

接続を閉じ、TCP 接続を解放します。`connect()` を使った場合は必ず呼んでください。

### `WorkerMailer.send(options, email)`（静的メソッド）

接続を維持せず、1 通だけ送って閉じます。第 1 引数が接続設定、第 2 引数がメール内容です。

## 制約事項

- **ポート制限:** Cloudflare Workers はポート 25 への外向き接続ができません。25 番は使えませんが、587 / 465 は利用可能です。
- **同時接続数:** Worker インスタンスごとに同時 TCP 接続数の上限があります。送信後は必ず `close()` で接続を閉じてください。

## このフォークについて

- 上流は [zou-yu/worker-mailer](https://github.com/zou-yu/worker-mailer)（MIT ライセンス）です。
- fun-garage 組織向けに以下を変更しています。
  - パッケージ名を `@fun-garage/worker-mailer` に変更し、公開 GitHub リポジトリから git でインストールする方式に（`dist/` をコミット）
  - ソースコード全体に日本語の解説コメントを追加
  - 軽微な整理: `responseTimeoutMs` が効かなかった不具合を修正、DSN パラメータ生成の重複を整理
  - 日本語 README とお問い合わせフォーム実装ガイドを追加

## 開発

```bash
# 依存関係のインストール（pnpm 推奨）
pnpm install

# ユニットテスト
npm test

# 結合テスト（ローカルで Worker を起動して実際に送信）
pnpm dlx wrangler dev ./test/worker.ts
# 起動後、http://127.0.0.1:8787 へ POST する（test/worker.ts 参照）

# ビルド（dist/ に CJS / ESM / 型定義を出力）
npm run build
```

## ライセンス

MIT License. 上流プロジェクトの著作権表示を継承します。
