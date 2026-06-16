import { encode, encodeQuotedPrintable } from './utils'

/**
 * メールヘッダ用に文字列を RFC 2047（=?UTF-8?Q?...?=）でエンコードする。
 * 件名や表示名に日本語などの非 ASCII が含まれる場合に必要。
 * すべて ASCII ならそのまま返す。
 */
export function encodeHeader(text: string): string {
  // 非 ASCII 文字を含まなければエンコード不要。
  if (!/[^\x00-\x7F]/.test(text)) {
    return text
  }
  const bytes = encode(text)
  let encoded = ''

  for (const byte of bytes) {
    // RFC 2047 のヘッダ向けルール:
    // - ?, =, _, スペース を除く印字可能 ASCII はそのまま
    // - スペースは _ に置換
    if (
      byte >= 33 &&
      byte <= 126 &&
      byte !== 63 &&
      byte !== 61 &&
      byte !== 95
    ) {
      // 63 = '?', 61 = '=', 95 = '_'
      encoded += String.fromCharCode(byte)
    } else if (byte === 32) {
      // ヘッダ内ではスペースを _ に（RFC 2047）
      encoded += '_'
    } else {
      // それ以外はすべて =XX 形式でエンコード
      encoded += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }

  return `=?UTF-8?Q?${encoded}?=`
}

// 宛先・送信元を表す型。name は表示名（省略可）。
export type User = { name?: string; email: string }

// mailer.send() に渡す 1 通分のメール内容。
export type EmailOptions = {
  from: string | User // 送信元
  to: string | string[] | User | User[] // 宛先（To）
  reply?: string | User // 返信先（Reply-To）
  cc?: string | string[] | User | User[] // CC
  bcc?: string | string[] | User | User[] // BCC
  subject: string // 件名
  text?: string // プレーンテキスト本文（text か html のいずれかは必須）
  html?: string // HTML 本文
  headers?: Record<string, string> // 追加・上書きするカスタムヘッダ
  // 添付ファイル。content は base64 エンコード済み文字列。mimeType 省略時は拡張子から推測。
  attachments?: { filename: string; content: string; mimeType?: string }[]
  // この 1 通だけ DSN 設定を上書きする場合に指定（WorkerMailer の dsn より優先）。
  dsnOverride?: {
    envelopeId?: string
    RET?: {
      HEADERS?: boolean
      FULL?: boolean
    }
    NOTIFY?: {
      DELAY?: boolean
      FAILURE?: boolean
      SUCCESS?: boolean
    }
  }
}

/**
 * 1 通のメールを表すクラス。
 * 入力（EmailOptions）を正規化して保持し、getEmailData() で
 * SMTP の DATA で送る MIME 形式の文字列を組み立てる。
 */
export class Email {
  public readonly from: User
  public readonly to: User[]
  public readonly reply?: User
  public readonly cc?: User[]
  public readonly bcc?: User[]

  public readonly subject: string
  public readonly text?: string
  public readonly html?: string
  public readonly dsnOverride?: {
    envelopeId?: string
    RET?: {
      HEADERS?: boolean
      FULL?: boolean
    }
    NOTIFY?: {
      DELAY?: boolean
      FAILURE?: boolean
      SUCCESS?: boolean
    }
  }

  public readonly attachments?: {
    filename: string
    content: string
    mimeType?: string
  }[]

  public readonly headers: Record<string, string>

  // 送信完了/失敗を外部へ通知するための Promise とその resolve/reject。
  // mailer 側が送信結果に応じて setSent()/setSentError() を呼ぶ。
  public setSent!: () => void
  public setSentError!: (e: unknown) => void
  public sent = new Promise<void>((resolve, reject) => {
    this.setSent = resolve
    this.setSentError = reject
  })

  constructor(options: EmailOptions) {
    // text と html のどちらも無いメールは送れない。
    if (!options.text && !options.html) {
      throw new Error('At least one of text or html must be provided')
    }

    // from / reply は文字列指定なら { email } 形式へ正規化する。
    if (typeof options.from === 'string') {
      this.from = { email: options.from }
    } else {
      this.from = options.from
    }
    if (typeof options.reply === 'string') {
      this.reply = { email: options.reply }
    } else {
      this.reply = options.reply
    }
    // to/cc/bcc は文字列・配列・オブジェクトのいずれでも受け付け、User[] に正規化。
    this.to = Email.toUsers(options.to)!
    this.cc = Email.toUsers(options.cc)
    this.bcc = Email.toUsers(options.bcc)

    this.subject = options.subject
    this.text = options.text
    this.html = options.html
    this.attachments = options.attachments
    this.dsnOverride = options.dsnOverride
    this.headers = options.headers || {}
  }

  // 宛先の各種入力形式を User[] に揃えるヘルパー。
  private static toUsers(
    user: string | string[] | User | User[] | undefined,
  ): User[] | undefined {
    if (!user) {
      return
    }
    if (typeof user === 'string') {
      return [{ email: user }]
    } else if (Array.isArray(user)) {
      return user.map(user => {
        if (typeof user === 'string') {
          return { email: user }
        }
        return user
      })
    } else {
      return [user]
    }
  }

  /**
   * DATA コマンドで送る本文（ヘッダ＋MIME ボディ＋終端 "."）を組み立てて返す。
   * 構造は multipart/mixed（添付用）の中に multipart/alternative（text/html 切替）を入れる形。
   */
  public getEmailData() {
    this.resolveHeader()

    const headersArray: string[] = ['MIME-Version: 1.0']
    for (const [key, value] of Object.entries(this.headers)) {
      headersArray.push(`${key}: ${value}`)
    }
    // 本文の境界文字列。mixed は添付との区切り、alternative は text/html の区切り。
    const mixedBoundary = this.generateSafeBoundary('mixed_')
    const alternativeBoundary = this.generateSafeBoundary('alternative_')

    headersArray.push(
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    )
    const headers = headersArray.join('\r\n')

    let emailData = `${headers}\r\n\r\n`
    emailData += `--${mixedBoundary}\r\n`

    emailData += `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n\r\n`

    // プレーンテキスト本文（quoted-printable エンコード）。
    if (this.text) {
      emailData += `--${alternativeBoundary}\r\n`
      emailData += `Content-Type: text/plain; charset="UTF-8"\r\n`
      emailData += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`
      const encodedText = encodeQuotedPrintable(this.text)
      emailData += `${encodedText}\r\n\r\n`
    }

    // HTML 本文（quoted-printable エンコード）。
    if (this.html) {
      emailData += `--${alternativeBoundary}\r\n`
      emailData += `Content-Type: text/html; charset="UTF-8"\r\n`
      emailData += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`
      const encodedHtml = encodeQuotedPrintable(this.html)
      emailData += `${encodedHtml}\r\n\r\n`
    }

    emailData += `--${alternativeBoundary}--\r\n`

    // 添付ファイル（base64。1 行が長くなりすぎないよう 72 文字ごとに改行）。
    if (this.attachments) {
      for (const attachment of this.attachments) {
        const mimeType =
          attachment.mimeType || this.getMimeType(attachment.filename)
        emailData += `--${mixedBoundary}\r\n`
        emailData += `Content-Type: ${mimeType}; name="${attachment.filename}"\r\n`
        emailData += `Content-Description: ${attachment.filename}\r\n`
        emailData += `Content-Disposition: attachment; filename="${attachment.filename}";\r\n`
        emailData += `    creation-date="${new Date().toUTCString()}";\r\n`
        emailData += `Content-Transfer-Encoding: base64\r\n\r\n`

        // base64 を 72 文字ごとに改行（1 行 76 文字以下に収めるため）
        // https://en.wikipedia.org/wiki/Base64#Variants_summary_table
        const lines = attachment.content.match(/.{1,72}/g)
        if (lines) {
          emailData += `${lines.join('\r\n')}`
        } else {
          emailData += `${attachment.content}`
        }
        emailData += '\r\n\r\n'
      }
    }
    emailData += `--${mixedBoundary}--\r\n`

    // ドットスタッフィングを施し、末尾に終端 "." を付けて返す。
    const safeEmailData = this.applyDotStuffing(emailData)

    return `${safeEmailData}\r\n.\r\n`
  }

  /**
   * ドットスタッフィング（RFC 5321）。
   * SMTP では行頭の "." がメッセージ終端と衝突するため、本文中の行頭 "." を ".." に二重化する。
   */
  private applyDotStuffing(data: string): string {
    let result = data.replace(/\r\n\./g, '\r\n..')
    if (result.startsWith('.')) {
      result = `.${result}`
    }
    return result
  }

  // MIME の境界文字列を、本文と衝突しないようランダムかつ安全な文字だけで生成する。
  private generateSafeBoundary(prefix: string): string {
    const bytes = new Uint8Array(28)
    crypto.getRandomValues(bytes)
    const hex = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    let boundary = prefix + hex
    boundary = boundary.replace(/[<>@,;:\\/[\]?=" ]/g, '_') // 使えない文字は '_' に置換
    return boundary
  }

  // 添付ファイルの拡張子から MIME タイプを推測する。未知の拡張子は octet-stream。
  private getMimeType(filename: string): string {
    const extension = filename.split('.').pop()?.toLowerCase()

    const mimeTypes: { [key: string]: string } = {
      txt: 'text/plain',
      html: 'text/html',
      csv: 'text/csv',
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      zip: 'application/zip',
    }

    return mimeTypes[extension || 'txt'] || 'application/octet-stream' // 既定は 'application/octet-stream'
  }

  // 各ヘッダ（From/To/Reply-To/CC/BCC/Subject/Date/Message-ID）を組み立てる。
  // ユーザーが headers で明示指定したものは尊重し、未指定のものだけ補完する。
  private resolveHeader() {
    this.resolveFrom()
    this.resolveTo()
    this.resolveReply()
    this.resolveCC()
    this.resolveBCC()
    this.resolveSubject()
    this.headers['Date'] = this.headers['Date'] ?? new Date().toUTCString()
    this.headers['Message-ID'] =
      this.headers['Message-ID'] ??
      `<${crypto.randomUUID()}@${this.from.email.split('@').pop()}>`
  }

  private resolveFrom() {
    if (this.headers['From']) {
      return
    }
    let from = this.from.email
    if (this.from.name) {
      from = `"${encodeHeader(this.from.name)}" <${from}>`
    }
    this.headers['From'] = from
  }

  private resolveTo() {
    if (this.headers['To']) {
      return
    }
    const toAddresses = this.to.map(user => {
      if (user.name) {
        return `"${encodeHeader(user.name)}" <${user.email}>`
      }
      return user.email
    })
    this.headers['To'] = toAddresses.join(', ')
  }

  private resolveSubject() {
    if (this.headers['Subject']) {
      return
    }
    if (this.subject) {
      this.headers['Subject'] = encodeHeader(this.subject)
    }
  }

  private resolveReply() {
    if (this.headers['Reply-To']) {
      return
    }
    if (this.reply) {
      let replyAddress = this.reply.email
      if (this.reply.name) {
        replyAddress = `"${encodeHeader(this.reply.name)}" <${replyAddress}>`
      }
      this.headers['Reply-To'] = replyAddress
    }
  }

  private resolveCC() {
    if (this.headers['CC']) {
      return
    }
    if (this.cc) {
      const ccAddresses = this.cc.map(user => {
        if (user.name) {
          return `"${encodeHeader(user.name)}" <${user.email}>`
        }
        return user.email
      })
      this.headers['CC'] = ccAddresses.join(', ')
    }
  }

  private resolveBCC() {
    if (this.headers['BCC']) {
      return
    }
    if (this.bcc) {
      const bccAddresses = this.bcc.map(user => {
        if (user.name) {
          return `"${encodeHeader(user.name)}" <${user.email}>`
        }
        return user.email
      })
      this.headers['BCC'] = bccAddresses.join(', ')
    }
  }
}
