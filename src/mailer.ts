import { connect } from 'cloudflare:sockets'
import { BlockingQueue, decode, encode, execTimeout } from './utils'
import { Email, EmailOptions } from './email'
import Logger, { LogLevel } from './logger'

// SMTP の認証方式。サーバーが対応していて、かつここで許可した方式の中から実際に使うものが選ばれる。
export type AuthType = 'plain' | 'login' | 'cram-md5'

// SMTP サーバーへのログイン情報。
export type Credentials = {
  username: string
  password: string
}

// WorkerMailer.connect() / WorkerMailer.send() に渡す接続オプション。
export type WorkerMailerOptions = {
  host: string // SMTP サーバーのホスト名
  port: number // ポート番号（通常は 587 または 465。Cloudflare Workers では 25 は使用不可）
  secure?: boolean // 最初から TLS で接続するか（465 のとき true。既定: false）
  startTls?: boolean // サーバーが対応していれば STARTTLS で TLS に昇格するか（587 向け。既定: true）
  credentials?: Credentials // 認証情報。サーバーが認証必須なら必要
  // 使用を許可する認証方式。配列で複数指定すると、サーバー対応状況に応じてこの順で選ばれる。
  authType?: AuthType | AuthType[]
  logLevel?: LogLevel // ログ出力レベル（既定: LogLevel.INFO）
  // DSN（配信状況通知）の既定設定。RCPT/MAIL コマンドに付与される。
  dsn?:
    | {
        // RET: 配信失敗時に元メールをどこまで返送させるか
        RET?:
          | {
              HEADERS?: boolean // ヘッダのみ返送
              FULL?: boolean // 本文を含めて全文返送
            }
          | undefined
        // NOTIFY: どのタイミングで通知を受け取るか
        NOTIFY?:
          | {
              DELAY?: boolean // 配信遅延時
              FAILURE?: boolean // 配信失敗時
              SUCCESS?: boolean // 配信成功時
            }
          | undefined
      }
    | undefined
  socketTimeoutMs?: number // ソケット接続のタイムアウト（ミリ秒）
  responseTimeoutMs?: number // サーバー応答待ちのタイムアウト（ミリ秒）
}

/**
 * Cloudflare Workers 上で動作する SMTP クライアント。
 *
 * 1 本の TCP 接続を保持し、送信要求はキューに積んで 1 通ずつ順番に処理する。
 * SMTP の会話手順（接続 → EHLO → STARTTLS → 認証 → MAIL/RCPT/DATA）を
 * 上から順に読めるよう、あえて 1 クラスにまとめてある。
 */
export class WorkerMailer {
  private socket: Socket

  private readonly host: string
  private readonly port: number
  private readonly secure: boolean
  private readonly startTls: boolean
  private readonly authType: AuthType[]
  private readonly credentials?: Credentials

  private readonly socketTimeoutMs: number
  private readonly responseTimeoutMs: number

  // ソケットの読み書きストリーム。STARTTLS 昇格時に取り直す。
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>

  private readonly logger: Logger

  // DSN の既定設定（送信時に email 側で上書き可能）。
  private readonly dsn:
    | {
        envelopeId?: string | undefined
        RET?:
          | {
              HEADERS?: boolean
              FULL?: boolean
            }
          | undefined
        NOTIFY?:
          | {
              DELAY?: boolean
              FAILURE?: boolean
              SUCCESS?: boolean
            }
          | undefined
      }
    | undefined

  private readonly sendNotificationsTo: string | undefined

  // セッションが確立し送信可能な状態か。close 時に false になりループが止まる。
  private active = false

  // 送信中のメールと、送信待ちキュー。
  private emailSending: Email | null = null
  private emailToBeSent = new BlockingQueue<Email>()

  /** SMTP サーバーが対応している機能（EHLO 応答から判定） **/
  private supportsDSN = false
  private allowAuth = false
  private authTypeSupported: AuthType[] = []
  private supportsStartTls = false

  // 直接 new せず、必ず static の connect()/send() 経由で生成する。
  private constructor(options: WorkerMailerOptions) {
    this.port = options.port
    this.host = options.host
    this.secure = !!options.secure
    // authType は文字列・配列どちらでも受け付け、内部では配列に正規化する。
    if (Array.isArray(options.authType)) {
      this.authType = options.authType
    } else if (typeof options.authType === 'string') {
      this.authType = [options.authType]
    } else {
      this.authType = []
    }
    this.startTls = options.startTls === undefined ? true : options.startTls
    this.credentials = options.credentials
    this.dsn = options.dsn || {}

    this.socketTimeoutMs = options.socketTimeoutMs || 60_000
    this.responseTimeoutMs = options.responseTimeoutMs || 30_000

    // secure=true なら最初から TLS、startTls=true なら STARTTLS 待ち、どちらも無ければ平文。
    this.socket = connect(
      {
        hostname: this.host,
        port: this.port,
      },
      {
        secureTransport: this.secure
          ? 'on'
          : this.startTls
            ? 'starttls'
            : 'off',
        allowHalfOpen: false,
      },
    )
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()

    this.logger = new Logger(
      options.logLevel,
      `[WorkerMailer:${this.host}:${this.port}]`,
    )
  }

  /**
   * SMTP サーバーに接続し、認証まで済ませた WorkerMailer を返す。
   * 接続を維持して複数通送りたい場合に使う（最後に close() を呼ぶこと）。
   */
  static async connect(options: WorkerMailerOptions): Promise<WorkerMailer> {
    const mailer = new WorkerMailer(options)
    await mailer.initializeSmtpSession()
    // 送信ループはバックグラウンドで回し続ける（await しない）。
    mailer.start().catch(console.error)
    return mailer
  }

  /**
   * メールをキューに積み、そのメールの送信完了/失敗を表す Promise を返す。
   * 実際の送信は start() ループが順番に行う。
   */
  public send(options: EmailOptions): Promise<void> {
    const email = new Email(options)
    this.emailToBeSent.enqueue(email)
    return email.sent
  }

  /**
   * 接続を維持せず、1 通だけ送って閉じる使い切りの送信。
   * お問い合わせフォームのような「1 リクエストにつき 1 通」の用途に向く。
   */
  static async send(
    options: WorkerMailerOptions,
    email: EmailOptions,
  ): Promise<void> {
    const mailer = await WorkerMailer.connect(options)
    await mailer.send(email)
    await mailer.close()
  }

  // サーバー応答の読み取りにタイムアウトを掛けたもの。
  private async readTimeout(): Promise<string> {
    return execTimeout(
      this.read(),
      this.responseTimeoutMs,
      new Error('Timeout while waiting for smtp server response'),
    )
  }

  // SMTP の応答を 1 件分（複数行応答も含めて）読み切るまで待つ。
  private async read(): Promise<string> {
    let response = ''
    while (true) {
      const { value } = await this.reader.read()
      if (!value) {
        continue
      }
      const data = decode(value).toString()
      this.logger.debug('SMTP server response:\n' + data)
      response = response + data
      if (!response.endsWith('\n')) {
        continue
      }
      // 複数行応答は「コード-」（ハイフン）で続き、最終行は「コード␣」（スペース）。
      // 最終行がまだハイフン区切りなら続きがあるので読み続ける。
      const lines = response.split(/\r?\n/)
      const lastLine = lines[lines.length - 2]
      if (/^\d+-/.test(lastLine)) {
        continue
      }
      return response
    }
  }

  // 1 行（末尾に CRLF を付与）をソケットへ書き込む。
  private async writeLine(line: string) {
    await this.write(`${line}\r\n`)
  }

  private async write(data: string) {
    this.logger.debug('Write to socket:\n' + data)
    await this.writer.write(encode(data))
  }

  // 接続から認証までの一連のハンドシェイクを行う。
  private async initializeSmtpSession() {
    await this.waitForSocketConnected()
    await this.greet()
    await this.ehlo()

    // STARTTLS が必要かつサーバーが対応していれば TLS に昇格する。
    if (this.startTls && !this.secure && this.supportsStartTls) {
      await this.tls()
      // RFC 3207 に従い、STARTTLS 後は EHLO を再送する。
      await this.ehlo()
    }

    await this.auth()
    this.active = true
  }

  // 送信キューを監視し、積まれたメールを 1 通ずつ送るバックグラウンドループ。
  private async start() {
    while (this.active) {
      this.emailSending = await this.emailToBeSent.dequeue()
      try {
        await this.mail()
        await this.rcpt()
        await this.data()
        await this.body()
        this.emailSending!.setSent()
      } catch (e: any) {
        this.logger.error('Failed to send email: ' + e.message)
        if (!this.active) {
          return
        }
        this.emailSending.setSentError(e)
        try {
          // RSET でセッションを初期化し、次のメールの送信に備える。
          await this.rset()
        } catch (e: any) {
          await this.close(e)
        }
        // RSET 成功なら次のメールへ。失敗時は close() 内で active=false となりループ終了。
      }
      this.emailSending = null
    }
  }

  /**
   * 接続を閉じる。送信中・キュー待ちのメールはすべてエラーで解決される。
   * connect() を使った場合は、用済み後に必ず呼んで TCP 接続を解放すること。
   */
  public async close(error?: Error) {
    this.active = false
    this.logger.info('WorkerMailer is closed', error?.message || '')
    this.emailSending?.setSentError?.(
      error || new Error('WorkerMailer is shutting down'),
    )
    // キューに残ったメールもすべて失敗として解決しておく。
    while (this.emailToBeSent.length) {
      const email = await this.emailToBeSent.dequeue()
      email.setSentError(error || new Error('WorkerMailer is shutting down'))
    }

    try {
      await this.writeLine('QUIT')
      await this.readTimeout()
      this.socket
        .close()
        .catch(() => this.logger.error('Failed to close socket')) // サーバー側が先に閉じると解決しないので投げっぱなしにする
    } catch (ignore) {
      // すでにソケットが閉じている可能性がある。ここでは単純に握りつぶす。
    }
  }

  // ソケットの接続完了を（タイムアウト付きで）待つ。
  private async waitForSocketConnected() {
    this.logger.info(`Connecting to SMTP server`)
    await execTimeout(
      this.socket.opened,
      this.socketTimeoutMs,
      new Error('Socket timeout!'),
    )
    this.logger.info('SMTP server connected')
  }

  // 接続直後にサーバーから返る挨拶（220）を受け取る。
  private async greet() {
    const response = await this.readTimeout()
    if (!response.startsWith('220')) {
      throw new Error('Failed to connect to SMTP server: ' + response)
    }
  }

  // EHLO を送りサーバーの対応機能を取得する。失敗時は HELO にフォールバック。
  private async ehlo() {
    await this.writeLine(`EHLO 127.0.0.1`)
    const response = await this.readTimeout()
    if (response.startsWith('421')) {
      throw new Error(`Failed to EHLO. ${response}`)
    }
    if (!response.startsWith('2')) {
      // EHLO 非対応の古いサーバー向けに HELO へフォールバック。
      await this.helo()
      return
    }
    this.parseCapabilities(response)
  }

  // EHLO が使えないサーバー向けの簡易挨拶。
  private async helo() {
    await this.writeLine(`HELO 127.0.0.1`)
    const response = await this.readTimeout()
    if (response.startsWith('2')) {
      return
    }
    throw new Error(`Failed to HELO. ${response}`)
  }

  // STARTTLS を発行し、ソケットを TLS に昇格させる。
  private async tls() {
    await this.writeLine('STARTTLS')
    const response = await this.readTimeout()
    if (!response.startsWith('220')) {
      throw new Error('Failed to start TLS: ' + response)
    }

    // 既存のストリームを解放し、TLS 化したソケットから取り直す。
    this.reader.releaseLock()
    this.writer.releaseLock()
    this.socket = this.socket.startTls()
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()
  }

  // EHLO 応答の本文から、対応する認証方式・STARTTLS・DSN を判定する。
  private parseCapabilities(response: string) {
    if (/[ -]AUTH\b/i.test(response)) {
      this.allowAuth = true
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)PLAIN/i.test(response)) {
      this.authTypeSupported.push('plain')
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)LOGIN/i.test(response)) {
      this.authTypeSupported.push('login')
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)CRAM-MD5/i.test(response)) {
      this.authTypeSupported.push('cram-md5')
    }
    if (/[ -]STARTTLS\b/i.test(response)) {
      this.supportsStartTls = true
    }
    if (/[ -]DSN\b/i.test(response)) {
      this.supportsDSN = true
    }
  }

  // サーバーが認証を要求する場合、対応 × 許可された方式の中から 1 つで認証する。
  private async auth() {
    if (!this.allowAuth) {
      return
    }
    if (!this.credentials) {
      throw new Error(
        'smtp server requires authentication, but no credentials found',
      )
    }
    if (
      this.authTypeSupported.includes('plain') &&
      this.authType.includes('plain')
    ) {
      await this.authWithPlain()
    } else if (
      this.authTypeSupported.includes('login') &&
      this.authType.includes('login')
    ) {
      await this.authWithLogin()
    } else if (
      this.authTypeSupported.includes('cram-md5') &&
      this.authType.includes('cram-md5')
    ) {
      await this.authWithCramMD5()
    } else {
      throw new Error('No supported auth method found.')
    }
  }

  // AUTH PLAIN: \0username\0password を base64 で 1 度に送る。
  private async authWithPlain() {
    const userPassBase64 = btoa(
      `\u0000${this.credentials!.username}\u0000${this.credentials!.password}`,
    )
    await this.writeLine(`AUTH PLAIN ${userPassBase64}`)
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error(`Failed to plain authentication: ${authResult}`)
    }
  }

  // AUTH LOGIN: ユーザー名・パスワードを base64 で 1 つずつ対話的に送る。
  private async authWithLogin() {
    await this.writeLine(`AUTH LOGIN`)
    const startLoginResponse = await this.readTimeout()
    if (!startLoginResponse.startsWith('3')) {
      throw new Error('Invalid login: ' + startLoginResponse)
    }

    const usernameBase64 = btoa(this.credentials!.username)
    await this.writeLine(usernameBase64)
    const userResponse = await this.readTimeout()
    if (!userResponse.startsWith('3')) {
      throw new Error('Failed to login authentication: ' + userResponse)
    }

    const passwordBase64 = btoa(this.credentials!.password)
    await this.writeLine(passwordBase64)
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error('Failed to login authentication: ' + authResult)
    }
  }

  // AUTH CRAM-MD5: サーバーのチャレンジを HMAC-MD5 で署名して返す。
  private async authWithCramMD5() {
    await this.writeLine('AUTH CRAM-MD5')
    const challengeResponse = await this.readTimeout()
    const challengeWithBase64Encoded = challengeResponse
      .match(/^334\s+(.+)$/)
      ?.pop()
    if (!challengeWithBase64Encoded) {
      throw new Error('Invalid CRAM-MD5 challenge: ' + challengeResponse)
    }

    // チャレンジ（base64）をデコード。
    const challenge = atob(challengeWithBase64Encoded)

    // パスワードを HMAC の鍵としてインポート。
    const keyData = encode(this.credentials!.password)
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'MD5' },
      false,
      ['sign'],
    )

    // チャレンジに署名する。
    const challengeData = encode(challenge)
    const signature = await crypto.subtle.sign('HMAC', key, challengeData)

    // 署名を 16 進文字列に変換。
    const challengeSolved = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    // 「username 16進署名」を base64 にして返送。
    await this.writeLine(
      btoa(`${this.credentials!.username} ${challengeSolved}`),
    )
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error('Failed to cram-md5 authentication: ' + authResult)
    }
  }

  // MAIL FROM: 送信元エンベロープを指定。DSN 対応なら RET/ENVID も付与。
  private async mail() {
    let message = `MAIL FROM: <${this.emailSending!.from.email}>`
    if (this.supportsDSN) {
      message += ` ${this.retBuilder()}`
      if (this.emailSending?.dsnOverride?.envelopeId) {
        message += ` ENVID=${this.emailSending?.dsnOverride?.envelopeId}`
      }
    }

    await this.writeLine(message)
    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error(`Invalid ${message} ${response}`)
    }
  }

  // RCPT TO: to/cc/bcc すべての宛先を 1 件ずつ登録。DSN 対応なら NOTIFY を付与。
  private async rcpt() {
    const allRecipients = [
      ...this.emailSending!.to,
      ...(this.emailSending!.cc || []),
      ...(this.emailSending!.bcc || []),
    ]

    for (let user of allRecipients) {
      let message = `RCPT TO: <${user.email}>`
      if (this.supportsDSN) {
        message += this.notificationBuilder()
      }
      await this.writeLine(message)
      const rcptResponse = await this.readTimeout()
      if (!rcptResponse.startsWith('2')) {
        throw new Error(`Invalid ${message} ${rcptResponse}`)
      }
    }
  }

  // DATA: 本文送信の開始を宣言（354 が返る）。
  private async data() {
    await this.writeLine('DATA')
    const response = await this.readTimeout()
    if (!response.startsWith('3')) {
      throw new Error(`Failed to send DATA: ${response}`)
    }
  }

  // 本文（ヘッダ＋MIME ボディ＋終端の "."）を送信する。
  private async body() {
    await this.write(this.emailSending!.getEmailData())
    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error('Failed send email body: ' + response)
    }
  }

  // RSET: 進行中のトランザクションを破棄してセッションを初期状態に戻す。
  private async rset() {
    await this.writeLine('RSET')
    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error(`Failed to reset: ${response}`)
    }
  }

  /**
   * 送信中メールの dsnOverride を優先し、無ければ WorkerMailer 既定の dsn を採用する。
   * override のセクション（NOTIFY/RET）が存在する場合はそちらを全面採用する。
   */
  private effectiveDsn<K extends 'NOTIFY' | 'RET'>(section: K) {
    const override = this.emailSending?.dsnOverride?.[section]
    return (override ?? this.dsn?.[section]) as
      | NonNullable<WorkerMailerOptions['dsn']>[K]
      | undefined
  }

  // RCPT TO に付与する NOTIFY パラメータを組み立てる。何も指定が無ければ NEVER。
  private notificationBuilder() {
    const notify = this.effectiveDsn('NOTIFY')
    const flags = (['SUCCESS', 'FAILURE', 'DELAY'] as const).filter(
      flag => notify?.[flag],
    )
    return flags.length > 0 ? ` NOTIFY=${flags.join(',')}` : ' NOTIFY=NEVER'
  }

  // MAIL FROM に付与する RET パラメータを組み立てる。
  private retBuilder() {
    const ret = this.effectiveDsn('RET')
    const flags: string[] = []
    if (ret?.HEADERS) {
      flags.push('HDRS')
    }
    if (ret?.FULL) {
      flags.push('FULL')
    }
    return flags.length > 0 ? `RET=${flags.join(',')}` : ''
  }
}
