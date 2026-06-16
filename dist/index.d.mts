/**
 * メールヘッダ用に文字列を RFC 2047（=?UTF-8?Q?...?=）でエンコードする。
 * 件名や表示名に日本語などの非 ASCII が含まれる場合に必要。
 * すべて ASCII ならそのまま返す。
 */
declare function encodeHeader(text: string): string;
type User = {
    name?: string;
    email: string;
};
type EmailOptions = {
    from: string | User;
    to: string | string[] | User | User[];
    reply?: string | User;
    cc?: string | string[] | User | User[];
    bcc?: string | string[] | User | User[];
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    attachments?: {
        filename: string;
        content: string;
        mimeType?: string;
    }[];
    dsnOverride?: {
        envelopeId?: string;
        RET?: {
            HEADERS?: boolean;
            FULL?: boolean;
        };
        NOTIFY?: {
            DELAY?: boolean;
            FAILURE?: boolean;
            SUCCESS?: boolean;
        };
    };
};
/**
 * 1 通のメールを表すクラス。
 * 入力（EmailOptions）を正規化して保持し、getEmailData() で
 * SMTP の DATA で送る MIME 形式の文字列を組み立てる。
 */
declare class Email {
    readonly from: User;
    readonly to: User[];
    readonly reply?: User;
    readonly cc?: User[];
    readonly bcc?: User[];
    readonly subject: string;
    readonly text?: string;
    readonly html?: string;
    readonly dsnOverride?: {
        envelopeId?: string;
        RET?: {
            HEADERS?: boolean;
            FULL?: boolean;
        };
        NOTIFY?: {
            DELAY?: boolean;
            FAILURE?: boolean;
            SUCCESS?: boolean;
        };
    };
    readonly attachments?: {
        filename: string;
        content: string;
        mimeType?: string;
    }[];
    readonly headers: Record<string, string>;
    setSent: () => void;
    setSentError: (e: unknown) => void;
    sent: Promise<void>;
    constructor(options: EmailOptions);
    private static toUsers;
    /**
     * DATA コマンドで送る本文（ヘッダ＋MIME ボディ＋終端 "."）を組み立てて返す。
     * 構造は multipart/mixed（添付用）の中に multipart/alternative（text/html 切替）を入れる形。
     */
    getEmailData(): string;
    /**
     * ドットスタッフィング（RFC 5321）。
     * SMTP では行頭の "." がメッセージ終端と衝突するため、本文中の行頭 "." を ".." に二重化する。
     */
    private applyDotStuffing;
    private generateSafeBoundary;
    private getMimeType;
    private resolveHeader;
    private resolveFrom;
    private resolveTo;
    private resolveSubject;
    private resolveReply;
    private resolveCC;
    private resolveBCC;
}

declare enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NONE = 4
}

type AuthType = 'plain' | 'login' | 'cram-md5';
type Credentials = {
    username: string;
    password: string;
};
type WorkerMailerOptions = {
    host: string;
    port: number;
    secure?: boolean;
    startTls?: boolean;
    credentials?: Credentials;
    authType?: AuthType | AuthType[];
    logLevel?: LogLevel;
    dsn?: {
        RET?: {
            HEADERS?: boolean;
            FULL?: boolean;
        } | undefined;
        NOTIFY?: {
            DELAY?: boolean;
            FAILURE?: boolean;
            SUCCESS?: boolean;
        } | undefined;
    } | undefined;
    socketTimeoutMs?: number;
    responseTimeoutMs?: number;
};
/**
 * Cloudflare Workers 上で動作する SMTP クライアント。
 *
 * 1 本の TCP 接続を保持し、送信要求はキューに積んで 1 通ずつ順番に処理する。
 * SMTP の会話手順（接続 → EHLO → STARTTLS → 認証 → MAIL/RCPT/DATA）を
 * 上から順に読めるよう、あえて 1 クラスにまとめてある。
 */
declare class WorkerMailer {
    private socket;
    private readonly host;
    private readonly port;
    private readonly secure;
    private readonly startTls;
    private readonly authType;
    private readonly credentials?;
    private readonly socketTimeoutMs;
    private readonly responseTimeoutMs;
    private reader;
    private writer;
    private readonly logger;
    private readonly dsn;
    private readonly sendNotificationsTo;
    private active;
    private emailSending;
    private emailToBeSent;
    /** SMTP サーバーが対応している機能（EHLO 応答から判定） **/
    private supportsDSN;
    private allowAuth;
    private authTypeSupported;
    private supportsStartTls;
    private constructor();
    /**
     * SMTP サーバーに接続し、認証まで済ませた WorkerMailer を返す。
     * 接続を維持して複数通送りたい場合に使う（最後に close() を呼ぶこと）。
     */
    static connect(options: WorkerMailerOptions): Promise<WorkerMailer>;
    /**
     * メールをキューに積み、そのメールの送信完了/失敗を表す Promise を返す。
     * 実際の送信は start() ループが順番に行う。
     */
    send(options: EmailOptions): Promise<void>;
    /**
     * 接続を維持せず、1 通だけ送って閉じる使い切りの送信。
     * お問い合わせフォームのような「1 リクエストにつき 1 通」の用途に向く。
     */
    static send(options: WorkerMailerOptions, email: EmailOptions): Promise<void>;
    private readTimeout;
    private read;
    private writeLine;
    private write;
    private initializeSmtpSession;
    private start;
    /**
     * 接続を閉じる。送信中・キュー待ちのメールはすべてエラーで解決される。
     * connect() を使った場合は、用済み後に必ず呼んで TCP 接続を解放すること。
     */
    close(error?: Error): Promise<void>;
    private waitForSocketConnected;
    private greet;
    private ehlo;
    private helo;
    private tls;
    private parseCapabilities;
    private auth;
    private authWithPlain;
    private authWithLogin;
    private authWithCramMD5;
    private mail;
    private rcpt;
    private data;
    private body;
    private rset;
    /**
     * 送信中メールの dsnOverride を優先し、無ければ WorkerMailer 既定の dsn を採用する。
     * override のセクション（NOTIFY/RET）が存在する場合はそちらを全面採用する。
     */
    private effectiveDsn;
    private notificationBuilder;
    private retBuilder;
}

export { type AuthType, type Credentials, Email, type EmailOptions, LogLevel, type User, WorkerMailer, type WorkerMailerOptions, encodeHeader };
