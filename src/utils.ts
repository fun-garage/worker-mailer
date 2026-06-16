/**
 * Promise ベースの非同期キュー。
 * dequeue() は要素が無ければ「次に enqueue されるまで待つ」Promise を返す。
 * mailer の送信ループが、送信要求を待ち受けるために使う。
 */
export class BlockingQueue<T> {
  private values: Promise<T>[] = []
  private resolvers: ((value: T) => void)[] = []

  public enqueue(value: T) {
    // 待っている dequeue が無ければ、先に空き枠（Promise）を用意する。
    if (!this.resolvers.length) {
      this.addWrapper()
    }
    this.resolvers.shift()!(value)
  }

  public async dequeue(): Promise<T> {
    // 値がまだ無ければ、enqueue 時に解決される Promise を先に積んで待つ。
    if (!this.values.length) {
      this.addWrapper()
    }
    return this.values.shift()!
  }

  public get length(): number {
    return this.values.length
  }

  public clear() {
    this.values = []
    this.resolvers = []
  }

  // 値の Promise とその resolver を 1 組ぶん用意して両配列に積む。
  private addWrapper() {
    this.values.push(
      new Promise<T>(resolve => {
        this.resolvers.push(resolve)
      }),
    )
  }
}

/**
 * promise が ms ミリ秒以内に解決しなければ、エラー e で reject する。
 * ソケット接続やサーバー応答のハングを防ぐためのタイムアウト。
 */
export async function execTimeout<T>(
  promise: Promise<T>,
  ms: number,
  e: Error,
) {
  return Promise.race<T>([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(e), ms)),
  ])
}

// 文字列 ⇄ バイト列の相互変換（UTF-8）。ソケットの送受信で使う。
const encoder = new TextEncoder()
export function encode(data: string): Uint8Array {
  return encoder.encode(data)
}
const decoder = new TextDecoder('utf-8')
export function decode(data: Uint8Array): string {
  return decoder.decode(data)
}

/**
 * Quoted-Printable エンコード（RFC 2045）。本文の text/html に使う。
 * - 非 ASCII・制御文字・"=" は =XX 形式に
 * - 行末の空白・タブも =XX に（送信中に削られて壊れるのを防ぐ）
 * - 1 行が lineLength を超えないよう "=" のソフト改行を挿入
 */
export function encodeQuotedPrintable(text: string, lineLength = 76): string {
  const bytes = encode(text)
  let result = ''
  let currentLineLength = 0
  let i = 0

  while (i < bytes.length) {
    const byte = bytes[i]
    let encoded: string | undefined

    // 改行（LF / CR / CRLF）はすべて CRLF に正規化する。
    if (byte === 0x0a) {
      // LF
      result += '\r\n'
      currentLineLength = 0
      i++
      continue
    } else if (byte === 0x0d) {
      // CR
      if (i + 1 < bytes.length && bytes[i + 1] === 0x0a) {
        // CRLF
        result += '\r\n'
        currentLineLength = 0
        i += 2
        continue
      } else {
        // 単独の CR はエンコードする
        encoded = '=0D'
      }
    }

    // まだエンコードが確定していなければ（単独 CR 以外）、必要かどうか判定する。
    if (encoded === undefined) {
      // 行末の空白・タブかどうか（行末空白は送信途中で削られるのでエンコードが必要）
      const isWhitespace = byte === 0x20 || byte === 0x09
      const nextIsLineBreak =
        i + 1 >= bytes.length || bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d

      // エンコードが必要なケース:
      // 1. 制御文字（< 32。ただし空白・タブは除く）
      // 2. 非 ASCII（> 126）
      // 3. "="（61）
      // 4. 行末の空白・タブ
      const needsEncoding =
        (byte < 32 && !isWhitespace) || // 制御文字（空白/タブを除く）
        byte > 126 || // 非 ASCII
        byte === 61 || // "="
        (isWhitespace && nextIsLineBreak) // 行末の空白

      if (needsEncoding) {
        encoded = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
      } else {
        encoded = String.fromCharCode(byte)
      }
    }

    // 行長を超えそうならソフト改行（"=" + CRLF）を入れる。
    // 末尾で "=XX" を書く余地として 3 文字を予約しておく。
    if (currentLineLength + encoded.length > lineLength - 3) {
      result += '=\r\n'
      currentLineLength = 0
    }

    result += encoded
    currentLineLength += encoded.length
    i++
  }

  return result
}
