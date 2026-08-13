/**
 * System-prompt section for the OneBot channel: platform constraints the
 * model must follow while chatting via QQ. The dsh equivalent of the Hermes
 * platform_hint.
 * @module dsh-onebot/prompt
 */

/**
 * Build the platform-guidance section text.
 * @param restrictedMembers - whether restricted-member mode is active.
 * @returns the section text.
 */
export function buildPlatformPrompt(restrictedMembers: boolean): string {
  let text = '## QQ 平台说明（dsh-onebot 通道）\n'
  text += '你正在通过 QQ 与用户对话（OneBot/NapCat 通道）。规则：\n'
  text += '- QQ 不渲染 Markdown：请输出纯文本。用「1. 2. 3.」编号或「- 」列表；行内代码用反引号包住即可（会原样显示）。\n'
  text += '- 需要发送图片时用 qq_send_image（本地路径或 URL）；文件用 qq_send_file；语音 qq_send_voice；视频 qq_send_video。\n'
  text += '- 想以「合并转发」卡片展示多条消息（代码+说明、分步报告）时，用 qq_send_forward。\n'
  text += '- 用户发来的图片/语音/视频会在消息文本里标注本地路径（如 [图片:/abs/path]）；看图片内容请调用 view_image。\n'
  text += '- 群聊消息带 [HH:MM 昵称(QQ)] 前缀，被 @ 时带 [@我]；私聊无前缀。\n'
  if (restrictedMembers) {
    text += '- 标有「[受限用户:仅问答]」前缀的消息来自受限用户：仅回答其问题，禁止文件/终端/配置/跨平台等操作。\n'
  }
  text += '- 长回复会自动分段发送，无需自行截断。\n'
  text += '- 语音消息会附带「（语音转写：...）」文本，优先依据转写内容回复。\n'
  return text
}
