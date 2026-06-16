// ログ出力レベル。数値が小さいほど詳細。NONE で完全に無効化。
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

/**
 * レベル付きの簡易ロガー。設定レベル以上のログだけを console に出力する。
 * prefix（例: [WorkerMailer:smtp.example.com:587]）を各行の先頭に付ける。
 */
export default class Logger {
  private readonly prefix: string

  constructor(
    private readonly level: LogLevel = LogLevel.INFO,
    prefix: string,
  ) {
    this.prefix = prefix
  }

  debug(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(this.prefix + message, ...args)
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.INFO) {
      console.info(this.prefix + message, ...args)
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.prefix + message, ...args)
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(this.prefix + message, ...args)
    }
  }
}
