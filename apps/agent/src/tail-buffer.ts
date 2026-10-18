/**
 * 末尾 max バイトだけを残すバッファ。ストリームを読み続けながら使い、全量をメモリに載せない。
 * 先頭が UTF-8 の途中で切れたら、その文字を落とす。
 */
export class TailBuffer {
  private chunks: Uint8Array[] = [];
  private held = 0;
  private total = 0;
  private cut = false;

  constructor(private readonly max: number) {}

  append(chunk: Uint8Array): void {
    this.total += chunk.byteLength;
    // 1 チャンクが上限より大きいなら、末尾だけ残す
    const piece = chunk.byteLength > this.max ? chunk.subarray(chunk.byteLength - this.max) : chunk;
    if (piece.byteLength < chunk.byteLength) this.cut = true;
    this.chunks.push(piece);
    this.held += piece.byteLength;
    while (this.chunks.length > 1 && this.held - (this.chunks[0]?.byteLength ?? 0) >= this.max) {
      this.held -= this.chunks.shift()?.byteLength ?? 0;
      this.cut = true;
    }
  }

  /** 現在メモリに保持しているバイト数 */
  heldBytes(): number {
    return this.held;
  }

  result(): { text: string; truncated: boolean; totalBytes: number } {
    const all = new Uint8Array(this.held);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.byteLength;
    }
    let bytes = all;
    let truncated = this.cut;
    if (bytes.byteLength > this.max) {
      bytes = bytes.subarray(bytes.byteLength - this.max);
      truncated = true;
    }
    if (truncated) {
      // 先頭の継続バイト（10xxxxxx）は文字の途中なので落とす
      let i = 0;
      while (i < bytes.byteLength && i < 4 && ((bytes[i] ?? 0) & 0xc0) === 0x80) i++;
      bytes = bytes.subarray(i);
    }
    return { text: new TextDecoder().decode(bytes), truncated, totalBytes: this.total };
  }
}
