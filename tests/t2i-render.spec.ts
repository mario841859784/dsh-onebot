import { describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderTextImage, CARD_WIDTH } from '../src/t2i/index.js'
import { FontManager } from '../src/t2i/fonts.js'
import { parseBlocks } from '../src/t2i/parser.js'
import { elementHeight, FontWidthSource } from '../src/t2i/elements.js'
import type { LayoutCtx } from '../src/t2i/elements.js'
import { BODY_FONT_SIZE } from '../src/t2i/index.js'

const font = FontManager.create()
const hasFonts = font.usable
const describeFont = hasFonts ? describe : describe.skip

/** Non-white check per the dev doc: not (r>245 && g>245 && b>245). */
function isInk(r: number, g: number, b: number): boolean {
  return !(r > 245 && g > 245 && b > 245)
}

/** Scan every row for the rightmost non-white pixel. */
async function scanRightEdge(png: Buffer): Promise<{ width: number; height: number; maxX: number; violations: number }> {
  const img = await loadImage(png)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  let maxX = -1
  let violations = 0
  for (let y = 0; y < img.height; y += 1) {
    const row = ctx.getImageData(0, y, img.width, 1).data
    for (let x = img.width - 1; x >= 0; x -= 1) {
      if (isInk(row[x * 4], row[x * 4 + 1], row[x * 4 + 2])) {
        if (x > maxX) maxX = x
        if (x > 791) violations += 1
        break
      }
    }
  }
  return { width: img.width, height: img.height, maxX, violations }
}

/** The dev-doc pressure fixture: long title + text + quote + lists + 4-col table + code. */
const PRESSURE = [
  '# 这是一个非常非常长的标题用来测试标题换行与右缘表现标题换行与右缘',
  '',
  '正文段落：这是一段足够长的正文，用来验证**粗体**与*斜体*以及`inline code`在换行时的表现，同时检查中文标点，不会落在行首的问题。',
  '',
  '> 引用块内容：引用文本也会换行，并且左侧有灰色竖线，宽度预算与正文不同，需要单独验证。',
  '',
  '- 无序列表项：列表文本换行宽度预算为 image_width-45，右侧不能越界。',
  '- 第二项：继续填充内容让列表换行。',
  '',
  '1. 有序列表：编号加内容换行预算为 image_width-55。',
  '2. 第二项：继续填充内容让有序列表换行以验证右缘。',
  '',
  '| 列一 | 列二 | 列三 | 列四 |',
  '|---|---|---|---|',
  '| 单元格甲 | 单元格乙 | 单元格丙 | 单元格丁 |',
  '| 内容稍长一些的单元格 | 二号 | 三号 | 四号 |',
  '| 三号行 | 乙 | 丙 | 丁 |',
  '',
  '```ts',
  'const longCodeLine = someFunction(withArguments, thatKeepsGoing, andGoing);',
  'console.log(longCodeLine); // 注释也会等宽显示',
  '```',
  '',
  '结尾文本：😀 emoji 混排测试。',
].join('\n')

describeFont('renderTextImage', () => {
  it('produces a PNG with the right magic bytes', () => {
    const png = renderTextImage('简单文本')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('passes the full-image right-edge scan on the pressure fixture', async () => {
    const png = renderTextImage(PRESSURE, { title: 'To 压力测试' })
    const scan = await scanRightEdge(png)
    expect(scan.width).toBe(CARD_WIDTH)
    expect(scan.maxX).toBeLessThanOrEqual(790)
    expect(scan.violations).toBe(0)
  }, 30_000)

  it('paints the blue top bar when a title is given', async () => {
    const png = renderTextImage('内容', { title: 'To 某用户' })
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(400, 40, 1, 1).data
    // #2196f3 = rgb(33, 150, 243)
    expect(Math.abs(px[0] - 33)).toBeLessThanOrEqual(30)
    expect(Math.abs(px[1] - 150)).toBeLessThanOrEqual(30)
    expect(Math.abs(px[2] - 243)).toBeLessThanOrEqual(30)
  })

  it('omits the top bar without a title', async () => {
    const png = renderTextImage('内容')
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(400, 40, 1, 1).data
    expect(px[0]).toBeGreaterThan(245)
    expect(px[1]).toBeGreaterThan(245)
    expect(px[2]).toBeGreaterThan(245)
  })

  it('renders color emoji (yellowish pixels present)', async () => {
    const png = renderTextImage('表情 😀 测试')
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    let colored = 0
    const row = ctx.getImageData(0, 0, img.width, img.height).data
    for (let i = 0; i < row.length; i += 4) {
      const r = row[i], g = row[i + 1], b = row[i + 2]
      if (r > 200 && g > 100 && g < 240 && b < 140) colored += 1
    }
    expect(colored).toBeGreaterThan(50)
  }, 30_000)

  it('draws the footer brand in klein blue', async () => {
    const png = renderTextImage('内容', { footerBrand: 'dsh' })
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    let found = false
    // Scan the bottom 60px band for #002fa7-ish pixels.
    const row = ctx.getImageData(0, img.height - 60, img.width, 60).data
    for (let i = 0; i < row.length; i += 4) {
      const r = row[i], g = row[i + 1], b = row[i + 2]
      if (Math.abs(r - 0) <= 40 && Math.abs(g - 47) <= 40 && Math.abs(b - 167) <= 40) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  }, 30_000)

  it('heights are consistent between the two passes (no negative y drift)', () => {
    const ctx: LayoutCtx = { width: 800, size: BODY_FONT_SIZE, widthSource: new FontWidthSource(font) }
    let total = 0
    for (const el of parseBlocks(PRESSURE)) total += elementHeight(el, ctx)
    expect(total).toBeGreaterThan(100)
  })
})
