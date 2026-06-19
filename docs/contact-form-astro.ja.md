# お問い合わせフォーム実装ガイド（Astro + Cloudflare 版）

このガイドは、**Astro で制作したサイトを Cloudflare にデプロイする**前提で、`@fun-garage/worker-mailer` を使ったお問い合わせフォームを実装するためのベストプラクティスをまとめたものです。

Astro を使う場合、メール送信用の Worker を**別途立てる必要はなく**、Astro 自身の SSR（サーバーサイドレンダリング）の中で `worker-mailer` を呼べます。この「Astro アプリに内包する」構成を前提に解説します。

> 📌 **対象バージョン**: このガイドは **Astro 6（2026-03 stable）以降**を前提にしています。Astro 5 以前との違いは末尾の [Astro 5 以前を使う場合](#astro-5-以前を使う場合) を参照してください。
>
> 素の HTML や別ドメインの SPA など **Astro を使わない／フロントが別オリジン**の構成では、独立した送信用 Worker を立てる方が素直です。その場合は本ガイドの [代替案: サーバーエンドポイント](#代替案-サーバーエンドポイントaction-を使わない場合) と [CORS](#cors) を参考にしてください。

---

## なぜ Astro 6 + Cloudflare Workers なのか

`worker-mailer` は Cloudflare の [`cloudflare:sockets`](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) を使う、**workerd ランタイム専用**のライブラリです。ここが実装方針を決める一番のポイントになります。

Astro 6 で `@astrojs/cloudflare` アダプタが刷新され、**開発（dev）・プリレンダリング・本番のすべてが workerd で動く**ようになりました（Vite の Environment API を利用）。これにより:

- ✅ **ローカル開発でも `cloudflare:sockets` がそのまま動く** → 開発と本番のランタイムが一致し、「dev では動くのに本番で壊れる」が起きにくい
- ✅ **nodemailer などの開発用フォールバックが不要**（Next.js/Nuxt や Astro 5 以前で必要だった、dev 用に動的 import を出し分ける手間が要らない）
- ✅ Cloudflare のバインディング（KV / D1 / Secret など）にローカルから直接アクセスできる

> 💡 **デプロイ先は Pages ではなく Workers を推奨。** Cloudflare は新規プロジェクトについて、機能・最適化が集中している **Workers** の利用を推奨しています（[Static Assets](https://developers.cloudflare.com/workers/static-assets/) により静的アセットも Workers から配信可能）。

---

## 全体像

```
[Astro サイト（Cloudflare Workers 上で SSR）]
  ├─ 静的ページ（prerender = true）      … トップ・会社概要など。エッジから即配信
  └─ Astro Action / API エンドポイント   … フォーム送信を受ける（サーバー実行）
            │  @fun-garage/worker-mailer
            ▼  SMTP (587 / 465)
       [SMTP サーバー] → 運営者へ通知メール ＋ 問い合わせ者へ自動返信
```

ポイント:

- フォームを置く**ページ自体は静的（prerender）でよい**。送信を受ける Action/エンドポイントだけがサーバー実行になる。
- **認証情報（SMTP パスワード等）は Secret に保存**し、ブラウザには絶対に出さない。
- 入力検証・スパム対策はサーバー側（Action のハンドラ）で行う。

---

## 前提

- Cloudflare アカウントと [wrangler](https://developers.cloudflare.com/workers/wrangler/)。
- **Node.js 22 以降**（Astro 6 の要件）。
- 送信に使う **SMTP サーバーの情報**（ホスト・ポート・ユーザー名・パスワード）。
  - 例: Google Workspace、Amazon SES、SendGrid、Mailgun、さくらのメールボックス など。
- `@fun-garage/worker-mailer` は公開リポジトリから git でインストール（トークン不要。[README のインストール](../README.md#インストール)参照）。

> ⚠️ **ポート 25 は使えません。** Cloudflare Workers の制約で、必ず 587（STARTTLS）または 465（TLS）を使います。

### 主要 SMTP プロバイダの設定早見表

| プロバイダ | host | port | secure | authType |
| --- | --- | --- | --- | --- |
| Google Workspace | `smtp.gmail.com` | 587 | `false` | `login` |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | `false` | `login` |
| SendGrid | `smtp.sendgrid.net` | 587 | `false` | `login`（ユーザー名は `apikey`） |
| Mailgun | `smtp.mailgun.org` | 587 | `false` | `plain` |
| さくらのメールボックス | `<initial>.sakura.ne.jp` | 587 | `false` | `login` |

`port: 465` を使う場合は `secure: true`、`port: 587` を使う場合は `secure: false`（STARTTLS）が基本です。実際の対応方式は各プロバイダのドキュメントで確認してください。

---

## ステップ 1: Astro に Cloudflare アダプタを追加

既存の Astro プロジェクトで以下を実行します（新規なら先に `npm create astro@latest`）。

```powershell
# Cloudflare アダプタを追加（astro.config を自動で書き換えてくれる）
npx astro add cloudflare

# メール送信ライブラリをインストール（公開リポジトリから。トークン不要）
npm install github:fun-garage/worker-mailer
```

`astro.config.mjs` は次のようになります。フォーム送信のためにオンデマンドレンダリング（`output: 'server'`）を有効にし、環境変数のスキーマも定義しておきます。

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'

export default defineConfig({
  // 既定で全ページがサーバー実行になる。静的でよいページは各ファイルで
  // `export const prerender = true` を付けてプリレンダリングする。
  output: 'server',
  adapter: cloudflare(),
})
```

> 💡 環境変数は **Astro 6 の `cloudflare:workers` の `env`** から実行時に読みます（後述）。これは wrangler の `vars`（コミットしてよい設定）と `wrangler secret`（機密）の**両方**を透過的に取得できるため、設定の入れ場所だけで「機密／非機密」を分けられます。型付きで扱いたい場合は `npx wrangler types` で `Env` 型を生成しておくと補完が効きます。

---

## ステップ 2: wrangler の設定

`cloudflare:sockets` を使うには **`nodejs_compat` 互換フラグが必須**です（Astro の SSR 自体にも必要）。プロジェクト直下に `wrangler.jsonc` を用意します。

```jsonc
// wrangler.jsonc
{
  "name": "my-astro-site",
  // Astro アダプタが生成する Worker エントリ
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2026-06-18",
  // worker-mailer の cloudflare:sockets / Astro SSR に必要
  "compatibility_flags": ["nodejs_compat"],
  // 静的アセットを Workers から配信
  "assets": {
    "binding": "ASSETS",
    "directory": "./dist"
  },
  // 機密でない設定はここに直書きしてよい（コミットされる）。
  // パスワードなど機密値だけは vars に書かず、wrangler secret で登録する（ステップ 3）。
  "vars": {
    "SMTP_HOST": "smtp.acme.com",
    "SMTP_PORT": "587",
    "MAIL_TO": "info@your-client.com",   // 問い合わせの通知先（運営者）
    "MAIL_FROM": "noreply@your-client.com" // 送信元（SMTP で送信可能なもの）
  },
  // 本番のログ・トレースを有効化（運用上ほぼ必須）
  "observability": {
    "enabled": true
  }
}
```

> 📌 **どれを `vars`（直書き）に、どれを Secret にするか**
>
> | 値 | 置き場所 | 理由 |
> | --- | --- | --- |
> | `SMTP_HOST` / `SMTP_PORT` | `vars` | 単なる接続先。秘匿性なし |
> | `MAIL_TO` / `MAIL_FROM` | `vars` | アドレスだが秘密ではない（Worker 内なので露出しない） |
> | `SMTP_PASSWORD` | **Secret** | 唯一必ず守るべき値 |
> | `SMTP_USERNAME` | **プロバイダ次第** | SendGrid は固定文字列 `apikey`／Google Workspace は自分のアドレスなので `vars` で可。**Amazon SES** はユーザー名自体が資格情報（`AKIA…` 系）なので **Secret 推奨** |
>
> 迷ったら Secret に寄せれば安全側です。`vars` と Secret は実行時には同じ `env` から透過的に読めるので、コード側は気にせず `env.SMTP_HOST` のように書けます。

SSR ビルドでは、ビルド成果物がアセットとして二重配信されないよう、`public/.assetsignore` に以下を追加しておきます。

```
_worker.js
_routes.json
```

---

## ステップ 3: 機密値だけを Secret に登録

ステップ 2 で `vars` に書いた以外の**機密値だけ**を Secret として登録します。基本はパスワードのみ（SES など、ユーザー名が資格情報のときは `SMTP_USERNAME` も）。

```powershell
npx wrangler secret put SMTP_PASSWORD
# 例外: Amazon SES などユーザー名自体が資格情報の場合のみ
npx wrangler secret put SMTP_USERNAME
```

ローカル開発では機密値を `.dev.vars` に書きます（**`.gitignore` に入れること**）。`vars`（host/port/mail など）は `wrangler.jsonc` 側が dev でも読まれるので、`.dev.vars` には**機密値だけ**で十分です。Astro 6 の dev は workerd で動くため、これらがそのまま実行時の `env` から読めます。

```ini
# .dev.vars （コミットしない。機密値だけ書けばよい）
SMTP_PASSWORD=__local_password__
# SES などの場合のみ
# SMTP_USERNAME=AKIAxxxxxxxx
```

> 💡 SendGrid のようにユーザー名が固定文字列（`apikey`）／Google Workspace のように自分のアドレスのときは、`SMTP_USERNAME` も `wrangler.jsonc` の `vars` に入れてしまって構いません。

> 💡 オリジン制限（CORS）は、**同一 Astro サイト内**にフォームと送信先がある限り不要です（同一オリジンのため）。別ドメインのフロントから叩く構成にする場合のみ、後述の [CORS](#cors) を参照してください。

---

## ステップ 4: Astro Action でフォーム送信を受ける（推奨）

[Astro Actions](https://docs.astro.build/en/guides/actions/) は、型安全・Zod バリデーション・フォーム連携が組み込まれた仕組みで、お問い合わせフォームに最適です。

`src/actions/index.ts`:

```typescript
import { defineAction, ActionError } from 'astro:actions'
import { z } from 'astro:schema'
// vars（直書き）も secret も透過的にここから読める（Astro 6）
import { env } from 'cloudflare:workers'

export const server = {
  contact: defineAction({
    // HTML フォームの multipart/form-data を受け付ける
    accept: 'form',
    input: z.object({
      name: z.string().min(1, 'お名前を入力してください'),
      email: z.string().email('メールアドレスの形式が正しくありません'),
      message: z.string().min(1, 'お問い合わせ内容を入力してください').max(5000),
      // スパム対策のハニーポット（人間には見えない入力欄）
      company: z.string().optional(),
    }),
    handler: async input => {
      // ハニーポットに値が入っていたら bot。成功を装って静かに無視する。
      if (input.company) {
        return { ok: true }
      }

      // worker-mailer は cloudflare:sockets を使うため、ハンドラ内で
      // 動的 import するとプリレンダリング時の評価を確実に避けられる。
      const { WorkerMailer } = await import('@fun-garage/worker-mailer')

      // vars は文字列で入るため、ポートは数値化しておく
      const port = Number(env.SMTP_PORT)
      try {
        // 1 本の接続で 2 通（運営者への通知 ＋ 問い合わせ者への自動返信）を送る
        const mailer = await WorkerMailer.connect({
          host: env.SMTP_HOST,
          port,
          secure: port === 465, // 465 は TLS、587 は STARTTLS（false）
          credentials: { username: env.SMTP_USERNAME, password: env.SMTP_PASSWORD },
          authType: 'login',
        })

        // (1) 運営者への通知。Reply-To に問い合わせ者を入れておくと、
        //     そのまま「返信」で本人に返せる。
        await mailer.send({
          from: { name: 'お問い合わせフォーム', email: env.MAIL_FROM },
          to: env.MAIL_TO,
          reply: { name: input.name, email: input.email },
          subject: `【お問い合わせ】${input.name} 様より`,
          text:
            `お名前: ${input.name}\n` +
            `メール: ${input.email}\n` +
            `------------------------------\n` +
            `${input.message}\n`,
        })

        // (2) 問い合わせ者への自動返信
        await mailer.send({
          from: { name: 'Your Client', email: env.MAIL_FROM },
          to: { name: input.name, email: input.email },
          subject: 'お問い合わせを受け付けました',
          text:
            `${input.name} 様\n\n` +
            `お問い合わせいただきありがとうございます。\n` +
            `担当者より改めてご連絡いたします。\n\n` +
            `------------------------------\n` +
            `${input.message}\n` +
            `------------------------------\n`,
        })

        await mailer.close()
        return { ok: true }
      } catch (error) {
        // 失敗の詳細はログにだけ残し、利用者には汎用メッセージを返す
        console.error('Failed to send contact mail:', error)
        throw new ActionError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '送信に失敗しました。時間をおいて再度お試しください。',
        })
      }
    },
  }),
}
```

ポイント:

- **環境変数は `cloudflare:workers` の `env` から実行時に読みます**（`vars` も Secret も同じ `env` に入る）。Astro 6 では `Astro.locals.runtime.env` は廃止されました（[Astro 5 以前を使う場合](#astro-5-以前を使う場合)参照）。Zod で型付き・検証付きにしたい場合は `astro:env/server` も使えますが、その場合 `vars` の値も「実行時読み」のため `access: 'secret'`（＝機密という意味ではなく「実行時に読む」の意）で宣言する点に注意してください。
- `worker-mailer` を**ハンドラ内で動的 import** しているのは、`cloudflare:sockets` を含むモジュールがプリレンダリング経路で評価されるのを確実に避けるためです。静的に import しても多くの場合動きますが、動的 import が安全側です。

---

## ステップ 5: フォームを置く（フロント）

### A. クライアント JS で送る（フォームのページは静的のままでよい）

お問い合わせページを**プリレンダリング（静的）**したまま、`astro:actions` のクライアント関数で送信します。最も手軽で、トップページ等と同じくエッジから即配信できます。

```astro
---
// src/pages/contact.astro
export const prerender = true // このページは静的でよい（Action だけがサーバー実行）
---

<form id="contact-form">
  <label>お名前 <input name="name" required /></label>
  <label>メールアドレス <input type="email" name="email" required /></label>
  <label>お問い合わせ内容 <textarea name="message" required></textarea></label>

  <!-- ハニーポット: 画面に表示しない。bot だけが入力する -->
  <div aria-hidden="true" style="position:absolute;left:-9999px">
    <label>会社名 <input name="company" tabindex="-1" autocomplete="off" /></label>
  </div>

  <button type="submit">送信</button>
  <p id="form-status" role="status"></p>
</form>

<script>
  import { actions } from 'astro:actions'

  const form = document.getElementById('contact-form') as HTMLFormElement
  const status = document.getElementById('form-status')!

  form.addEventListener('submit', async e => {
    e.preventDefault()
    status.textContent = '送信中…'

    const { error } = await actions.contact(new FormData(form))

    if (error) {
      // Zod の検証エラーやハンドラのエラーがここに入る
      status.textContent = error.message ?? '送信に失敗しました。'
    } else {
      status.textContent = 'お問い合わせを送信しました。ありがとうございました。'
      form.reset()
    }
  })
</script>
```

### B. プログレッシブ・エンハンスメント（JS なしでも動く）

ページを SSR にすれば、`<form>` の `action` 属性に Action を直接渡せます。JavaScript が無効でも送信でき、`Astro.getActionResult()` でサーバー側の結果を受け取れます。

```astro
---
// src/pages/contact.astro
export const prerender = false // 結果をサーバーで受け取るため SSR にする
import { actions } from 'astro:actions'

const result = Astro.getActionResult(actions.contact)
---

{result && !result.error && <p>送信しました。ありがとうございました。</p>}

<form method="POST" action={actions.contact}>
  <input name="name" required />
  <input type="email" name="email" required />
  <textarea name="message" required></textarea>
  <div aria-hidden="true" style="position:absolute;left:-9999px">
    <input name="company" tabindex="-1" autocomplete="off" />
  </div>
  <button type="submit">送信</button>
</form>

{result?.error && <p role="alert">{result.error.message}</p>}
```

> どちらでも構いません。**静的配信を優先するなら A**、**JS 無効環境でも確実に動かしたいなら B** を選びます。

---

## ステップ 6: ローカル確認とデプロイ

```powershell
# ローカル開発（Astro 6 は workerd で動くので cloudflare:sockets もそのまま動く）
npm run dev

# ビルドしてデプロイ
npx astro build
npx wrangler deploy
```

ブラウザでフォームから実際に送信し、運営者宛て・問い合わせ者宛ての両方が届くことを確認してください。

---

## 代替案: サーバーエンドポイント（Action を使わない場合）

Action を使わず、素の REST 風エンドポイントで受けることもできます。外部（別ドメインの SPA、ネイティブアプリ等）から叩く API が欲しい場合はこちらが向きます。

`src/pages/api/contact.ts`:

```typescript
import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

export const prerender = false // 必ずサーバー実行にする

export const POST: APIRoute = async ({ request }) => {
  const data = await request.json()
  // …入力検証（メール形式チェックや message の長さ上限など。Action の Zod 相当を手書きする）…

  const { WorkerMailer } = await import('@fun-garage/worker-mailer')
  const port = Number(env.SMTP_PORT)
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST,
      port,
      secure: port === 465,
      credentials: { username: env.SMTP_USERNAME, password: env.SMTP_PASSWORD },
      authType: 'login',
    },
    {
      from: { name: 'お問い合わせフォーム', email: env.MAIL_FROM },
      to: env.MAIL_TO,
      reply: { name: data.name, email: data.email },
      subject: `【お問い合わせ】${data.name} 様より`,
      text: data.message,
    },
  )

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

別オリジンから叩く場合は、後述の [CORS](#cors) を参考に CORS ヘッダと `Origin` チェックを追加してください。

---

## Astro 5 以前を使う場合

Astro 5 系では仕様が異なります。主な差分:

| 項目 | Astro 6（本ガイド） | Astro 5 以前 |
| --- | --- | --- |
| dev のランタイム | workerd（`cloudflare:sockets` がそのまま動く） | Node.js（`cloudflare:sockets` は動かない） |
| 環境変数アクセス | `cloudflare:workers` の `env`（`astro:env/server` も可） | `context.locals.runtime.env`（`platformProxy.enabled: true` が必要） |
| ローカルでの送信確認 | `npm run dev` で完結 | `wrangler dev` 経由、または送信部分をモックする |

Astro 5 でローカル開発時に `cloudflare:sockets` が使えない問題は、[README の「フレームワークと併用する場合」](../README.md#4-nextjs--nuxt--sveltekit-などのフレームワークと併用する場合)のように、dev では nodemailer 等にフォールバックする動的 import で回避できます。**新規構築なら Astro 6 を使い、この出し分けを不要にすることを強く推奨します。**

---

## 運用のためのヒント

### 到達率（迷惑メール対策）
送信元ドメインに **SPF / DKIM / DMARC** を設定しておかないと、迷惑メール扱いされたり届かなかったりします。利用する SMTP プロバイダの案内に従って DNS を設定してください。**`MAIL_FROM` は必ず送信権限のある自社/クライアントのドメイン**にします（問い合わせ者のアドレスを From にしない。なりすまし扱いされます）。問い合わせ者に返信したい場合は、本ガイドの例のように `reply`（Reply-To）に入れます。

### Astro 特有の注意
送信を伴う **Action / エンドポイントは必ず `prerender = false`（SSR）** にします。プリレンダリングされると `cloudflare:sockets` も Secret も使えません。フォームを置くページ自体は静的（`prerender = true`）のままで構いません（送信処理だけがサーバー実行）。

### スパム・乱用対策
- ハニーポット（本ガイドの `company` フィールド）に加え、必要に応じて [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) を導入するとより堅牢です。フロントでトークンを取得し、**Action ハンドラ内でサーバー検証**します。
- 連続送信を抑えたい場合は、Cloudflare の [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) や WAF ルールを併用します。

### CORS
同一 Astro サイト内（同一オリジン）でフォームと Action を完結させる限り、CORS の設定は不要です。**別ドメインのフロントから [サーバーエンドポイント](#代替案-サーバーエンドポイントaction-を使わない場合) を叩く**場合のみ、エンドポイントで CORS ヘッダと `Origin` チェックを行います。

```typescript
// 許可するオリジン（複数サイトで使うなら配列で持って includes 判定に拡張）
const ALLOWED_ORIGIN = 'https://your-client.com'

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: corsHeaders(ALLOWED_ORIGIN) })

// POST 内では、設置元サイト以外からのリクエストを弾く
// const origin = request.headers.get('Origin')
// if (origin !== ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403 })
```

### エラーハンドリング
SMTP 送信失敗の詳細（パスワード誤り、宛先拒否など）は利用者に見せず、`console.error` でログに残します（`observability` を有効にしておけばダッシュボードで追えます）。デバッグ時は `connect()` の `logLevel: LogLevel.DEBUG` で SMTP のやり取りを確認できます。

### 添付ファイル
フォームにファイル添付が必要な場合は、フロントで base64 化して送り、Action 側で `attachments` に渡します。Workers のリクエストサイズ上限に注意してください。

```typescript
await mailer.send({
  // ...
  attachments: [
    { filename: 'document.pdf', content: base64String, mimeType: 'application/pdf' },
  ],
})
```

---

## チェックリスト

- [ ] Astro 6 以降 ＋ `@astrojs/cloudflare` アダプタを使っている
- [ ] `astro.config.mjs` で `output: 'server'` を設定した
- [ ] `wrangler.jsonc` に `compatibility_flags: ["nodejs_compat"]` を設定した
- [ ] `public/.assetsignore` に `_worker.js` / `_routes.json` を追加した
- [ ] 非機密の設定（host / port / mail）は `wrangler.jsonc` の `vars` に書いた
- [ ] `SMTP_PASSWORD`（と SES 等ではユーザー名）だけを `wrangler secret` / `.dev.vars` に登録し、`.dev.vars` を `.gitignore` に入れた
- [ ] 送信を受ける Action / エンドポイントは `prerender = false` になっている
- [ ] `MAIL_FROM` は送信権限のあるドメインのアドレスにした
- [ ] SPF / DKIM / DMARC を設定した
- [ ] ハニーポット等のスパム対策を入れた
- [ ] `npm run dev` と本番デプロイの両方で送信テストを行った
