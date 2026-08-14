/** Minimal fontkit typings for Noto CJK ttc face extraction. */
declare module 'fontkit' {
  interface Subset {
    includeGlyph(glyph: unknown): void
    encode(): Buffer
  }
  interface FontFace {
    postscriptName?: string
    characterSet: Iterable<number>
    glyphForCodePoint(cp: number): unknown
    createSubset(): Subset
  }
  interface FontCollection {
    fonts?: FontFace[]
  }
  const fontkit: {
    openSync(path: string): FontFace | FontCollection
    create(buffer: Buffer, postscriptName?: string): FontFace
  }
  export default fontkit
}
