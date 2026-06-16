# お問い合わせフォーム実装ガイド

このガイドでは、クライアントワークで制作した Web サイトの **お問い合わせフォーム** を、`@fun-garage/worker-mailer` を使って Cloudflare Workers でメール送信する手順をまとめます。

静的サイト（HTML / Next.js / Astro など、配信形態は問わない）からフォーム送信を受け取り、Worker が SMTP サーバー経由でメールを送る構成を想定しています。

## 全体像

```
[ブラウザのフォーム]
      │  fetch で JSON を POST
      ▼
[Cloudflare Worker]  ← @fun-garage/worker-mailer
      │  SMTP (587/465)
      ▼
[SMTP サーバー]  → 運営者へ通知メール ＋ 問い合わせ者へ自動返信
```

ポイント:

- **認証情報は Worker 側の Secret に保存**し、フロント（ブラウザ）には絶対に出さない。
- Worker で **入力検証・スパム対策・CORS** を行う。
- 1 リクエストにつき接続を使い切る `WorkerMailer.send()` を基本にする。

---

## 前提

- Cloudflare アカウントと [wrangler](https://developers.cloudflare.com/workers/wrangler/) がインストール済み。
- 送信に使う **SMTP サーバーの情報**（ホスト・ポート・ユーザー名・パスワード）。
  - 例: Google Workspace、Amazon SES、SendGrid、Mailgun、さくらのメールボックス など。
- `@fun-garage/worker-mailer` は公開リポジトリから git でインストールします（トークン不要。[README のインストール](../README.md#インストール)参照）。

> ⚠️ **ポート 25 は使えません。** Cloudflare Workers の制約により、必ず 587（STARTTLS）または 465（TLS）を使います。

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

## ステップ 1: プロジェクト作成とインストール

```powershell
# Worker 用のディレクトリを作成して初期化
npm create cloudflare@latest contact-form-worker
cd contact-form-worker

# パッケージをインストール（公開リポジトリから直接。トークン不要）
npm install github:fun-garage/worker-mailer
```

`wrangler.toml` に Node.js 互換フラグを追加します。

```toml
name = "contact-form-worker"
main = "src/index.ts"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]
```

---

## ステップ 2: 認証情報を Secret に登録

SMTP のパスワードなどはコードに書かず、Secret として登録します。

```powershell
npx wrangler secret put SMTP_HOST
npx wrangler secret put SMTP_PORT
npx wrangler secret put SMTP_USERNAME
npx wrangler secret put SMTP_PASSWORD
npx wrangler secret put MAIL_TO        # 問い合わせの通知先（運営者のアドレス）
npx wrangler secret put MAIL_FROM      # 送信元アドレス（SMTP で送信可能なもの）
npx wrangler secret put ALLOWED_ORIGIN # フォームを設置するサイトのオリジン
```

ローカル開発では `.dev.vars` に同じキーを書きます（このファイルは `.gitignore` に入れること）。

```ini
# .dev.vars （コミットしない）
SMTP_HOST=smtp.acme.com
SMTP_PORT=587
SMTP_USERNAME=bob@acme.com
SMTP_PASSWORD=__local_password__
MAIL_TO=info@your-client.com
MAIL_FROM=noreply@your-client.com
ALLOWED_ORIGIN=https://your-client.com
```

---

## ステップ 3: Worker 本体

`src/index.ts`:

```typescript
import { WorkerMailer } from '@fun-garage/worker-mailer'

interface Env {
  SMTP_HOST: string
  SMTP_PORT: string
  SMTP_USERNAME: string
  SMTP_PASSWORD: string
  MAIL_TO: string
  MAIL_FROM: string
  ALLOWED_ORIGIN: string
}

// フォームから送られてくる JSON の型
interface ContactPayload {
  name?: string
  email?: string
  message?: string
  // スパム対策のハニーポット（人間には見えない入力欄）。値が入っていたら bot とみなす。
  company?: string
}

// メールアドレスの簡易チェック
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

// CORS ヘッダを組み立てる
function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(
  data: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env.ALLOWED_ORIGIN)

    // プリフライト（OPTIONS）への応答
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors)
    }

    // 設置元サイト以外からのリクエストは拒否
    const origin = request.headers.get('Origin')
    if (origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Forbidden' }, 403, cors)
    }

    // 入力の取得と検証
    let payload: ContactPayload
    try {
      payload = await request.json()
    } catch {
      return json({ error: 'Invalid JSON' }, 400, cors)
    }

    // ハニーポットに値が入っていたら bot。成功を装って静かに無視する。
    if (payload.company) {
      return json({ ok: true }, 200, cors)
    }

    const name = payload.name?.trim()
    const email = payload.email?.trim()
    const message = payload.message?.trim()

    if (!name || !email || !message) {
      return json({ error: '必須項目が入力されていません' }, 400, cors)
    }
    if (!isValidEmail(email)) {
      return json({ error: 'メールアドレスの形式が正しくありません' }, 400, cors)
    }
    if (message.length > 5000) {
      return json({ error: 'お問い合わせ内容が長すぎます' }, 400, cors)
    }

    const smtpConfig = {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT),
      secure: Number(env.SMTP_PORT) === 465,
      credentials: {
        username: env.SMTP_USERNAME,
        password: env.SMTP_PASSWORD,
      },
      authType: 'login' as const,
    }

    try {
      // 1 本の接続で 2 通（運営者への通知 ＋ 問い合わせ者への自動返信）を送る
      const mailer = await WorkerMailer.connect(smtpConfig)

      // (1) 運営者への通知メール。Reply-To に問い合わせ者を入れておくと、
      //     そのまま「返信」するだけで本人に返信できる。
      await mailer.send({
        from: { name: 'お問い合わせフォーム', email: env.MAIL_FROM },
        to: env.MAIL_TO,
        reply: { name, email },
        subject: `【お問い合わせ】${name} 様より`,
        text:
          `お名前: ${name}\n` +
          `メール: ${email}\n` +
          `------------------------------\n` +
          `${message}\n`,
      })

      // (2) 問い合わせ者への自動返信メール
      await mailer.send({
        from: { name: 'Your Client', email: env.MAIL_FROM },
        to: { name, email },
        subject: 'お問い合わせを受け付けました',
        text:
          `${name} 様\n\n` +
          `お問い合わせいただきありがとうございます。\n` +
          `以下の内容で受け付けました。担当者より改めてご連絡いたします。\n\n` +
          `------------------------------\n` +
          `${message}\n` +
          `------------------------------\n`,
      })

      await mailer.close()

      return json({ ok: true }, 200, cors)
    } catch (error) {
      // 送信失敗の詳細はログにだけ残し、利用者には汎用メッセージを返す
      console.error('Failed to send contact mail:', error)
      return json(
        { error: '送信に失敗しました。時間をおいて再度お試しください。' },
        502,
        cors,
      )
    }
  },
}
```

> 💡 通知と自動返信の 2 通を送るので、ここでは接続を維持できる `WorkerMailer.connect()` を使っています。1 通だけで十分なら `WorkerMailer.send(config, email)` の方が簡潔です。

---

## ステップ 4: フロント側のフォーム

HTML の例（バニラ JS）。`company` フィールドが **ハニーポット**で、CSS で隠して人間には入力させません。

```html
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
  const form = document.getElementById('contact-form')
  const status = document.getElementById('form-status')

  form.addEventListener('submit', async e => {
    e.preventDefault()
    status.textContent = '送信中…'

    const data = Object.fromEntries(new FormData(form))

    try {
      const res = await fetch('https://contact-form-worker.<your-subdomain>.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (res.ok) {
        status.textContent = 'お問い合わせを送信しました。ありがとうございました。'
        form.reset()
      } else {
        const body = await res.json().catch(() => ({}))
        status.textContent = body.error ?? '送信に失敗しました。'
      }
    } catch {
      status.textContent = 'ネットワークエラーが発生しました。'
    }
  })
</script>
```

---

## ステップ 5: ローカル確認とデプロイ

```powershell
# ローカルで起動（.dev.vars が読み込まれる）
npx wrangler dev

# 別のターミナルから動作確認
curl.exe -X POST http://127.0.0.1:8787 `
  -H "Content-Type: application/json" `
  -H "Origin: https://your-client.com" `
  -d '{\"name\":\"テスト\",\"email\":\"test@example.com\",\"message\":\"テスト送信\"}'

# 本番へデプロイ
npx wrangler deploy
```

デプロイ後に表示される Worker の URL を、フォームの `fetch` 先に設定します。

---

## 運用のためのヒント

### 到達率（迷惑メール対策）
送信元ドメインに **SPF / DKIM / DMARC** を設定しておかないと、迷惑メール扱いされたり届かなかったりします。利用する SMTP プロバイダの案内に従って DNS を設定してください。`MAIL_FROM` は必ず**送信権限のある自社/クライアントのドメイン**にします（問い合わせ者のアドレスを From にしない。なりすまし扱いされます）。

### スパム・乱用対策
- ハニーポットに加え、必要に応じて [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) を導入するとより堅牢です（フロントでトークンを取得し、Worker 側で検証）。
- 連続送信を抑えたい場合は、Cloudflare の [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) や WAF ルールを併用します。

### CORS
`ALLOWED_ORIGIN` は設置サイトのオリジンに限定します。複数サイトに同じ Worker を使う場合は、許可オリジンの配列を持ち、リクエストの `Origin` が含まれるか判定する形に拡張してください。

### エラーハンドリング
SMTP 送信失敗の詳細（パスワード誤り、宛先拒否など）は利用者に見せず、`console.error` でログに残します。デバッグ時は `connect()` のオプションに `logLevel: LogLevel.DEBUG` を渡すと SMTP のやり取りが確認できます。

### 添付ファイル
フォームにファイル添付が必要な場合は、フロントで base64 化して送り、Worker 側で `attachments` に渡します。Workers のリクエストサイズ上限に注意してください。

```typescript
await mailer.send({
  // ...
  attachments: [
    {
      filename: 'document.pdf',
      content: base64String, // base64 エンコード済み
      mimeType: 'application/pdf',
    },
  ],
})
```

---

## チェックリスト

- [ ] `wrangler.toml` に `compatibility_flags = ["nodejs_compat"]` を設定した
- [ ] SMTP 情報を Secret（本番）と `.dev.vars`（ローカル）に登録した
- [ ] `.dev.vars` を `.gitignore` に追加した
- [ ] `MAIL_FROM` は送信権限のあるドメインのアドレスにした
- [ ] SPF / DKIM / DMARC を設定した
- [ ] `ALLOWED_ORIGIN` を設置サイトに限定した
- [ ] ハニーポット等のスパム対策を入れた
- [ ] ローカルと本番の両方で送信テストを行った
