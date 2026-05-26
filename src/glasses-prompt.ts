// Reply-format instructions appended to every inbound message body before
// dispatch. The G2 (576x288 monochrome LCD, ~32 ASCII / ~20 CJK cols per
// line, ~9 body rows per page after the header) has very narrow constraints
// the model should respect:
//
//   1. No markdown syntax (**, __, #, ```, >, tables, [text](url)).
//   2. No emoji or decorative symbols — the firmware bitmap font renders
//      them as tofu boxes. ASCII + CJK only.
//   3. Short paragraphs (≤3 sentences), blank line between paragraphs.
//   4. Single sentence ≤ ~80 chars so pretext word-wrap doesn't leave
//      orphan fragments.
//   5. Bullet lists: prefix each item with "· " (middle dot + space) on its
//      own line.
//   6. Aim for ≤5 pages total (~45 body lines / ~1200 CJK chars /
//      ~2000 ASCII chars). Summarise rather than dump.
//   7. Match user language: 中文 → 中文, English → English.
//   8. No filler ("好的没问题", "I hope this helps", "Let me know if…").
//      First sentence delivers the answer/conclusion.
//   9. Code or URL: on its own line, 2-space indent for code. Keep URLs
//      whole but on a fresh line.
//
// These rules are sent as a system-style prefix on each user turn — the
// model sees them every round so they stay sticky even across long
// conversations and model swaps. (Putting them in a true system prompt
// would require an SDK hook we don't have yet from the channel plugin
// surface.)

export const GLASSES_REPLY_FORMAT_RULES_EN = [
  '[ClawGlassOS display constraints — apply to your reply]',
  '- Plain text only. No markdown (**, #, ```, >, tables, [text](url)).',
  '- No emoji or decorative symbols. ASCII + CJK only.',
  '- Short paragraphs (≤3 sentences each). Blank line between paragraphs.',
  '- Bullet lists: each item on its own line, prefixed with "· ".',
  '- Target total length ≤5 screens (~1200 CJK chars or ~2000 ASCII chars). Summarise.',
  '- First sentence delivers the answer or conclusion directly.',
  '- Match user language (中文→中文, English→English).',
  '- Skip filler ("好的没问题", "I hope this helps").',
  '- Code or long URL on its own line; indent code by 2 spaces.',
].join('\n')

export const GLASSES_REPLY_FORMAT_RULES_ZH = [
  '【ClawGlassOS 眼镜显示规范——回复时请遵循】',
  '- 纯文本，禁用 markdown（**、#、```、>、表格、[文字](链接)）。',
  '- 禁用 emoji 与装饰符号。仅 ASCII 与中日韩字符。',
  '- 段落简短（每段 ≤3 句），段与段之间空一行。',
  '- 列表：每项单独一行，以 "· " 开头。',
  '- 整体长度 ≤5 屏（约 1200 中文字 / 2000 英文字符）。多则总结。',
  '- 首句直接给出答案或结论。',
  '- 匹配用户语言（中文→中文，英文→英文）。',
  '- 不要寒暄（"好的没问题"、"希望对你有帮助"）。',
  '- 代码或长链接独占一行；代码缩进 2 空格。',
].join('\n')

/**
 * Pick a Chinese-language ruleset if the user message contains any CJK
 * unified-ideograph chars, else English. Both convey the same constraints —
 * the language match just keeps the rules cohesive with the rest of the
 * envelope.
 */
export function chooseReplyFormatRules(userText: string): string {
  if (/[一-鿿]/.test(userText)) return GLASSES_REPLY_FORMAT_RULES_ZH
  return GLASSES_REPLY_FORMAT_RULES_EN
}
