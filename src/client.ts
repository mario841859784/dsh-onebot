declare const window: any;
declare const document: any;
/**
 * dsh-onebot — client bundle（QQ Bot 设置面板，T8 · 贡献者 0.9.19 版重写）
 *
 * 结构模板：dsh-expert-orchestrator/lib/client.js（CJS 包裹 + slots/remote 挂载模式），
 * 业务与契约全部对齐本仓库 docs/settings-page-design.md（T1 定案）与宿主侧
 * lib/settings-remote.js（T3 实现）。契约唯一来源：T1 §3 / §3.1 / §4 / §5。
 *
 * 宿主装载契约（对照 0.1.7-alpha.2 dsh-client-modules 校验与 expert-orchestrator 先例）：
 *   - CJS 包裹：banner `window.__ModuleLoader__.load({ id, factory: (require) => {`，
 *     footer `return module.exports; } });`；externals 仅 react（平台冻结模块表）。
 *   - 入口导出 `inject`（宿主客户端服务名数组）与 `apply(ctx) => disposer`。
 *   - 面板注册：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
 *     {name, key, locale}, render))`（keyed，key = 组合包 npm 包名）。
 *   - 数据通道：Typert Remote（`ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE)` 后
 *     `ctx.get('remote.onebotSettings')`）；所有读写经 Remote 调 host 侧，host 经
 *     configEditor.edit 写 profile patch 中 dsh-onebot 条目的 config 覆盖行
 *     （T1 §3：设置页/手改 patch/宿主原生设置页三方同源）。
 *
 * descriptor 同步说明（重要）：宿主侧 lib/settings-remote.js（T3）导出的是
 * SETTINGS_GROUPS / SCHEMA_DEFAULTS / SECRET_KEYS / 服务实现，**未导出客户端
 * Typert descriptor 数组**（descriptor 是浏览器侧 client bundle 的挂载清单，
 * host 侧服务经原型发现注册，两侧各持一份）。因此本文件内联定义
 * ONEBOT_SETTINGS_DESCRIPTORS，并以下述不变量与宿主侧逐字对齐（由
 * tests/client-settings.spec.ts 对 src/settings-remote.js 的导出常量断言）：
 *   - namespace/service = `onebotSettings`（T1 §4）；
 *   - 方法集 = getSettings() / updateSettings(patch, expectedRevision) /
 *     listWorkspaces()（W7：只读查询宿主 workspace 注册表，{available, workspaces:
 *     [{id,path,sessionCount}]}；registry 缺席降级 available:false 不抛错），
 *     全 positional（宿主网关 methodParameterNames 拒绝解构/默认值/rest）；
 *   - 快照结构 = T1 §3 OnebotSettingsSnapshot（revision/entryActive/config(71 键，
 *     含 notices 对象)/secrets/groups(6 组)/effect='restart'），accessToken 恒 ''（脱敏）；
 *   - 六组 69 键面板分组与 schema 默认值 = src/settings-remote.ts 常量（T8 口径：
 *     SETTINGS_GROUPS 69 面板键 + chatIdleEvictDays 只在 config 不上面板）。
 *
 * T8 相对贡献者版的差异（编排者评审硬要求 + 本仓裁决）：
 *   1. 补回上游缺口①：W6「非默认」徽标（值≠默认值的键一律挂标，title=与默认值不同）；
 *   2. 补回上游缺口②：诊断组折叠记忆（sessionStorage，details/summary 原生折叠）；
 *      （0.10.0 起诊断组改独立页签，组内折叠取消，sessionStorage 记忆随之移除）
 *   3. 键表对齐 src/settings-remote.ts：+forceSessionId/gifFramesEnabled/
 *      inboxQueueEnabled/inboxQueueDelayMs，DEFAULTS 取本仓拍板值
 *      （dmPromptFile/groupPromptFile/memoryFilesEnabled 关）；
 *   4. notices 面板改 5 真键（本仓 schema 无 newSession）；
 *   5. patchSchema/configSchema 覆盖全部 71 键（防网关按 schema 剥键丢编辑）；
 *   6. T11：首页左侧边栏「QQ Bot」入口（sidebarEntryEnabled 开关，main 与
 *      sidebar.panellist 同 id "qq-bot" 成对注册；false 时两者均不注册）。
 * 任一侧变更 descriptor/分组/键集/默认值时，必须同步本文件并在 DEVLOG 记录。
 *
 * 0.10.0 视觉对齐（宿主原生风格重写）：
 *   - 控件层改用宿主前端静态 seed 模块 @deepseek-ai/dsh-client-ui-primitives
 *     （Switch/SegmentedControl/SegmentedTabs/Tag/Checkbox/SettingsValueField/
 *     SettingsSecretField 等；require 走宿主 seed 表，非 npm 依赖，manifest 零改动），
 *     组件 CSS 随宿主全局样式表加载，主题/明暗跟随宿主，不再自造视觉体系；
 *   - 宿主 seed 表缺席（旧宿主）时回落到本文件极简 shim（同 props 契约，视觉
 *     经本文件 CSS 以 --dsw-* token + 字面回落值渲染）；
 *   - renderGroup/renderWorkspacePicker 经 opts.ui 依赖注入取组件（模块级纯函数
 *     与单测桩注入契约不变）；页面骨架对齐宿主原生页：居中 960px 内容列、
 *     20px/500 标题、SegmentedTabs 页签、SettingsForm 式底部保存条。
 *
 * 生效语义（T1 §5）：19 键统一「保存即热生效」——插件 fiber 秒级原地重启，
 * QQ 桥（NapCat ws-reverse/forward）自动重连；在途回合中断、频控窗口与中间
 * 消息缓冲清零；会话映射/历史不受影响。保存冲突（onebot-settings/conflict）
 * 时提示并重拉快照（revision 语义 = T1 §3.1，任何来源的已提交变更都 +1）。
 */

window.__ModuleLoader__.load({
	id: "dsh-onebot-qq",
	factory: (require: any) => {
		var module: any = { exports: {} };
		var exports = module.exports;

		//#region 外部模块（平台冻结表内：react + 宿主 UI 原语 seed 模块）
		var reactModule = require("react");
		var React = reactModule != null && typeof reactModule.createElement === "function"
			? reactModule
			: reactModule.default;
		if (React == null || typeof React.createElement !== "function") {
			throw new Error("dsh-onebot client: react 不可用");
		}
		/**
		 * 宿主 UI 原语（0.10.0 视觉对齐）。@deepseek-ai/dsh-client-ui-primitives 是
		 * 宿主前端启动时注入的静态 seed 模块（dsh-web-app staticModules 表，与 react
		 * 同级），require 即得；其组件 CSS 已随宿主全局样式表加载，无需本插件注入。
		 * seed 表缺席（引擎下限的旧宿主）时 require 抛错 → 回落 fallbackUi shim：
		 * 同 props 契约的极简实现，视觉经本文件 CSS（--dsw-* token + 字面回落值）。
		 */
		var HOST_PRIMITIVES_ID = "@deepseek-ai/dsh-client-ui-primitives";
		var hostPrimitives = null;
		try {
			var primitiveModule = require(HOST_PRIMITIVES_ID);
			hostPrimitives = primitiveModule != null && typeof primitiveModule.Switch === "function"
				? primitiveModule
				: primitiveModule != null && primitiveModule.default != null && typeof primitiveModule.default.Switch === "function"
					? primitiveModule.default
					: null;
		} catch (error) {
			hostPrimitives = null; // 旧宿主无 seed 表：走回落 shim
		}
		//#endregion

		//#region 常量
		var PLUGIN_ID = "dsh-onebot-qq";
		var REMOTE_NS = "onebotSettings"; // Typert Remote 命名空间（T1 §4，与 host 服务键一致）
		var NS = "dsh-onebot"; // locale 命名空间
		// T11：侧边栏入口与 main 面板共用 id（宿主 layout.selectPanel 按 main keyed
		// slot 的 key 校验，sidebar.panellist 的 id 必须与之一致，缺面板抛错）。
		var SIDEBAR_PANEL_ID = "qq-bot";
		//#endregion

		//#region 六组 69 键字段定义（T8 重写、0.10.0 重排：分组/键集/类型与
		//  src/settings-remote.ts SETTINGS_GROUPS 逐字对齐，DEFAULTS 与 SCHEMA_DEFAULTS
		//  逐字对齐，tests/client-settings.spec.ts 断言一致性。0.10.0 分组口径：连接=通道
		//  配置 6 键（mode/host/port/url/accessToken/botQQ）；工作区/强制会话/提示词文件
		//  归会话组，allowPrivateHosts 归媒体组，ignoreSelf/sidebarEntryEnabled 归行为组。
		//  chatIdleEvictDays 不上面板（host SETTINGS_GROUPS 同样不含），仍走 patch config 手改。）
		/** 字段类型：enum（下拉）/ number / boolean / string / stringArray（多行文本）/ secret（密码型）。 */
		var GROUPS = [
			{
				id: "connection",
				title: "连接",
				fields: [
					{ key: "mode", label: "连接模式", type: "enum", options: ["reverse", "forward"], optionLabels: { reverse: "反向 WebSocket（NapCat 连接本插件）", forward: "正向 WebSocket（插件连接 NapCat）" }, hint: "反向=它连我，正向=我连它" },
					{ key: "host", label: "反向 WS 监听地址",  showIf: { key: "mode", value: "reverse" }, type: "string", hint: "反向模式监听地址" },
					{ key: "port", label: "反向 WS 监听端口",  showIf: { key: "mode", value: "reverse" }, type: "number", hint: "反向模式监听端口" },
					{ key: "url", label: "正向 WS 服务器地址",  showIf: { key: "mode", value: "forward" }, type: "string", hint: "正向模式服务器地址" },
					{ key: "accessToken", label: "访问令牌（AccessToken）", type: "secret" },
					{ key: "botQQ", label: "机器人 QQ 号", type: "string" },
				],
			},
			{
				id: "permissions",
				title: "权限",
				// 本地加：权限分「私聊 / 群聊」两块展示（id = 分区词条键尾段；客户端展示结构，host 契约不涉）。
				sections: [
					{ id: "dm", title: "私聊", keys: ["dmPolicy", "allowFrom", "allowAllUsers", "adminUsers"] },
					{ id: "group", title: "群聊", keys: ["requireMention", "memberTools", "groupPolicy", "groupAllowFrom", "wakeNamesAdmin", "wakeNamesMember", "replyCountsAsMention", "atAllCountsAsMention", "faceStyle", "pokeEnabled", "restrictedMemberPrefix"] },
					{ id: "common", title: "通用", keys: ["sensitivePatterns"] },
				],
				fields: [
					{ key: "requireMention", label: "群聊必须 @ 机器人", type: "boolean" },
					{ key: "memberTools", label: "成员工具权限", type: "enum", options: ["none", "send", "all"], optionLabels: { none: "禁用全部", send: "仅发送类", all: "不限" }, hint: "非管理员回合可用的 qq_* 工具：仅发送类=可分条/发图（含工作区图库）" },
					{ key: "adminUsers", label: "管理员用户列表", type: "stringArray" },
					{ key: "dmPolicy", label: "私聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "groupPolicy", label: "群聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "allowAllUsers", label: "允许所有用户", type: "boolean" },
					{ key: "allowFrom", label: "私聊白名单", type: "stringArray" },
					{ key: "groupAllowFrom", label: "群聊白名单", type: "stringArray" },
					{ key: "wakeNamesAdmin", label: "用户唤醒词", type: "stringArray" },
					{ key: "wakeNamesMember", label: "他人唤醒词", type: "stringArray" },
					{ key: "replyCountsAsMention", label: "被引用唤醒", type: "boolean", hint: "引用别人的消息也算叫我" },
					{ key: "atAllCountsAsMention", label: "@全体唤醒", type: "boolean", hint: "@全体成员也算叫我" },
					{ key: "faceStyle", label: "QQ 表情呈现方式", type: "enum", options: ["name", "emoji"], optionLabels: { name: "官方表情表", emoji: "emoji 近似（旧观感）" }, hint: "表情名或 emoji 近似" },
				{ key: "pokeEnabled", label: "戳一戳叫醒", type: "boolean" },
					{ key: "restrictedMemberPrefix", label: "群聊非管理员加受限前缀", type: "boolean", hint: "打开后非管理员的消息带 [受限用户:仅问答] 标记：只答问题，可以要图片和表情包；关掉一视同仁" },
					{ key: "sensitivePatterns", label: "出站敏感词正则", type: "stringArray", placeholder: "正则，一行一个；留空用内置" },
				],
			},
			{
				id: "behavior",
				title: "行为",
				fields: [
					{ key: "interimMessages", label: "中间消息", type: "boolean", hint: "回合中发中间消息" },
					{ key: "interimRecall", label: "自动撤回中间消息",  showIf: { key: "interimMessages", value: true }, type: "boolean" },
					{ key: "interimRecallMs", label: "中间消息保留时长（毫秒）",  showIf: { key: "interimRecall", value: true }, type: "number" },
					{ key: "sendErrorNotice", label: "发送错误通知", type: "boolean" },
					{ key: "unknownCommand", label: "未知命令处理", type: "enum", options: ["intercept", "passthrough"], optionLabels: { intercept: "拦截", passthrough: "透传" } },
					{ key: "rateLimitPerMinute", label: "每分钟消息频率上限", type: "number" },
					{ key: "newMessagePolicy", label: "任务运行中的新消息", type: "enum", options: ["queue", "steer"], optionLabels: { queue: "排队", steer: "插话" } },
					{ key: "autoSteerPolicy", label: "自动插话资格",  showIf: { key: "newMessagePolicy", value: "steer" }, type: "enum", options: ["admin", "all"], optionLabels: { admin: "仅管理员", all: "所有成员" } },
					{ key: "deferredTimeoutMs", label: "等待模型回复超时（毫秒）", type: "number" },
					// T7 转正：入站连发合并（开关默认关；合并窗口 600ms，首条起最多 3000ms 封顶）。
					{ key: "inboxQueueEnabled", label: "入站连发合并", type: "boolean", hint: "同会话连发的多条消息合成一条投递" },
					{ key: "inboxQueueDelayMs", label: "合并等待窗口（毫秒）", type: "number", hint: "每条消息先等一个窗口再投递；0 = 立即", showIf: { key: "inboxQueueEnabled", value: true } },
					// T24：会话标题同步（开关默认关；用户在宿主里钉住的标题永不覆盖）。
					{ key: "titleSyncEnabled", label: "QQ 会话标题同步", type: "boolean", hint: "每条消息后让宿主刷新会话标题（一次小 LLM 调用）；宿主里手动命名的标题不会被覆盖" },
					{ key: "ignoreSelf", label: "忽略自己发的消息", type: "boolean", hint: "机器人自己的回声不处理" },
					// T11：DSH 首页左侧边栏入口开关（关=不注册侧边栏入口与配对面板；
					// 插件菜单下的设置页入口保留。客户端按启动时快照决定，改完刷新生效）。
					{ key: "sidebarEntryEnabled", label: "首页侧边栏入口", type: "boolean", hint: "在 DSH 首页左侧边栏显示「QQ Bot」入口；改动需刷新页面生效" },
														],
			},
			{
				id: "session",
				title: "会话",
				fields: [
										{ key: "newSessionGreeting", label: "新会话主动开口", type: "boolean", hint: "/new 后我先说一句" },
					{ key: "firstMessageAsUser", label: "首条按 User 注入", type: "boolean", hint: "开了宿主才会按第一条消息自动命名（默认关）" },
					{ key: "memoryFilesEnabled", label: "新会话读记忆文件", type: "boolean" },
					{ key: "memoryFiles", label: "记忆文件路径", type: "stringArray", placeholder: "文件绝对路径；分割方式：逗号、顿号、换行", showIf: { key: "memoryFilesEnabled", value: true } },
					{ key: "agentPreset", label: "新会话智能体预设（填预设 id，如 standard；留空用宿主默认）", type: "string", placeholder: "standard" },
					// W7：workspacePath 入面板（0.10.0 重排入会话组）。语义（对齐 README「会话工作区选择」）：
					// 修改只对新会话生效；已设 per-chat /workspace 覆盖的会话不受影响。
					{ key: "workspacePath", label: "私聊默认工作区路径", type: "string", hint: "私聊新会话的默认目录" },
					{ key: "groupWorkspacePath", label: "群聊默认工作区路径", type: "string", hint: "群聊新会话的默认目录；留空则同私聊" },
				// T8：forceSessionId 入面板（host SETTINGS_GROUPS session 组列出，默认 ''）。
				{ key: "forceSessionId", label: "强制会话 ID", type: "string", hint: "填了就固定用这个会话 id（高级用法，一般留空）" },
					// 本地加（2026-10-30）：提示词走文件，不塞进 yml——两段各一万多字，块写法容易被手改花。
					// 语义：路径填了且读得到就用文件内容当 dmPrompt/groupPrompt（每行左侧空白全删），
					// 读不到或留空就退回 yml 里的内联文本；改完文件要保存一次让插件重启才生效。
					{ key: "dmPromptFile", label: "私聊提示词文件（txt 路径）", type: "string", placeholder: "~/.dsh/onebot/prompts/dm.txt" },
					{ key: "groupPromptFile", label: "群聊提示词文件（txt 路径）", type: "string", placeholder: "~/.dsh/onebot/prompts/group.txt" },
				],
			},
			{
				id: "media",
				title: "媒体",
				fields: [
					{ key: "sttEnabled", label: "语音转写", type: "boolean", hint: "语音消息先转成文字" },
					{ key: "sttEngine", label: "语音转写引擎", type: "enum", options: ["auto", "openai", "whisper-cpp", "custom"], optionLabels: { auto: "自动探测", openai: "openai", "whisper-cpp": "whisper-cpp", custom: "自定义命令" } },
					{ key: "sttCommand", label: "自定义转写程序", type: "string", hint: "程序名或绝对路径", showIf: { key: "sttEngine", value: "custom" } },
					{ key: "sttArgs", label: "转写参数模板", type: "stringArray", placeholder: "一行一个；{file} 和 {out} 会被替换", showIf: { key: "sttEngine", value: "custom" } },
					{ key: "sttModel", label: "转写模型", type: "string", hint: "openai: small/base/medium…；whisper.cpp: 模型名或 .bin 路径", showIf: { key: "sttEngine", value: "openai" } },
					{ key: "textImageEnabled", label: "长文转图片卡片", type: "boolean" },
					{ key: "textImageThreshold", label: "转卡片的字数阈值",  showIf: { key: "textImageEnabled", value: true }, type: "number", placeholder: "0–10000；0 = 不转卡片" },
					{ key: "cardFooter", label: "卡片页脚角标", type: "string", placeholder: "OneBot" },
					{ key: "fontFiles", label: "卡片字体文件", type: "stringArray", placeholder: "一行一个字体文件路径（ttf/otf）；留空用系统字体" },
					{ key: "fontFamilies", label: "卡片字体家族名", type: "stringArray", placeholder: "一行一个字体家族名；留空用平台默认" },
					{ key: "outboundImageMaxBytes", label: "出站图片大小上限（字节）", type: "number", placeholder: "默认 8388608（8MB）；最高 104857600（100MB）" },
					{ key: "maxVoiceBytes", label: "出站语音大小上限（字节）", type: "number", placeholder: "默认 15728640（15MB）；最高 52428800（50MB）" },
					{ key: "maxFileBytes", label: "出站文件/视频大小上限（字节）", type: "number", placeholder: "默认 20971520（20MB）；最高 4294967296（4G）" },
					{ key: "inboundImageMaxPx", label: "入站图片长边上限（像素）", type: "number", placeholder: "默认 2048；推荐 1440 以上" },
					{ key: "inboundFileMaxBytes", label: "入站文件大小上限（字节）", type: "number", placeholder: "默认 20971520（20MB）；0 = 不限" },
					// T6 转正：GIF 分帧（默认关；关闭时不装依赖也不触碰 FS）。
					{ key: "gifFramesEnabled", label: "GIF 动图分帧", type: "boolean", hint: "收到 GIF 时在消息旁附一张抽 4 帧的纵向长图，让模型看懂动画过程（默认关）" },
					// 本地加（2026-11-01）：NapCat 文件服务/反代在本机或内网时，下载检查得放行。
					{ key: "allowPrivateHosts", label: "允许下载本机/内网地址", type: "boolean", hint: "默认拦内网链接防伪造；NapCat 文件服务在本机时开" },
				],
			},
			{
				id: "diagnostics",
				title: "诊断",
				fields: [
					{ key: "actionAuditEnabled", label: "主动写审计", type: "boolean", hint: "发送动作记一行审计" },
					{ key: "traceEnabled", label: "决策追踪（trace）", type: "boolean", hint: "写决策日志，排查用" },
					{ key: "recordInbound", label: "入站事件录制", type: "boolean", hint: "录制收到的消息" },
					{ key: "inboxRedact", label: "录制脱敏", type: "boolean", hint: "录制时给号码打码" },
					{ key: "injectEnabled", label: "事件注入（仅调试）", type: "boolean", hint: "离线注入消息，调试用" },
					{ key: "injectDryRun", label: "注入 dry-run", type: "boolean", hint: "注入不真发，仅测试" },
					{ key: "logLevel", label: "日志级别", type: "enum", options: ["debug", "info", "warn", "error"], optionLabels: { debug: "debug 全量", info: "info 常规", warn: "warn 警告", error: "error 仅错误" } },
				],
			},
		];
		/** 全部 67 键扁平表（顺序 = 六组声明顺序，与 host SETTINGS_GROUPS 逐字对齐）。 */
		var ALL_FIELDS: any[] = [];
		for (var groupIndex = 0; groupIndex < GROUPS.length; groupIndex++) {
			for (var fieldIndex = 0; fieldIndex < GROUPS[groupIndex].fields.length; fieldIndex++) {
				ALL_FIELDS.push(GROUPS[groupIndex].fields[fieldIndex]);
			}
		}
		/** schema 默认值（T1 §4 表；重置按钮与空快照兜底的唯一来源；与
		 *  src/settings-remote.ts SCHEMA_DEFAULTS 逐字对齐）。 */
		var DEFAULTS: any = {
			mode: "forward",
			host: "127.0.0.1",
			port: 8643,
			url: "ws://127.0.0.1:3001",
			accessToken: "",
			botQQ: "",
			workspacePath: "",
			groupWorkspacePath: "",
			forceSessionId: "",
			dmPromptFile: "", // T4 拍板默认关（贡献者默认 ~/.dsh 路径不收）
			groupPromptFile: "", // 同上
			requireMention: true,
			memberTools: "none",
			adminUsers: [],
			dmPolicy: "open",
			groupPolicy: "open",
			allowAllUsers: false,
			allowFrom: [],
			groupAllowFrom: [],
			wakeNamesAdmin: [],
			wakeNamesMember: [],
			replyCountsAsMention: false,
			atAllCountsAsMention: false,
			faceStyle: "name",
			pokeEnabled: true,
			interimMessages: true,
			interimRecall: false,
			interimRecallMs: 90000,
			sendErrorNotice: false,
			unknownCommand: "intercept",
			rateLimitPerMinute: 30,
			newMessagePolicy: "steer",
			autoSteerPolicy: "admin",
			deferredTimeoutMs: 600000,
			newSessionGreeting: true,
			firstMessageAsUser: true,
			memoryFilesEnabled: false, // T4 拍板默认关（贡献者 true）
			memoryFiles: [],
			ignoreSelf: true,
			// T11：侧边栏入口开关（用户裁定默认开）。
			sidebarEntryEnabled: true,
			sttEnabled: true,
			agentPreset: "",
			chatIdleEvictDays: 7,
			logLevel: "info",
			textImageEnabled: true,
			textImageThreshold: 350,
			cardFooter: "OneBot",
			allowPrivateHosts: true,
			restrictedMemberPrefix: true,
			sensitivePatterns: [],
			outboundImageMaxBytes: 8388608,
			maxVoiceBytes: 15728640,
			maxFileBytes: 20971520,
			inboundImageMaxPx: 2048,
			inboundFileMaxBytes: 20971520,
			fontFiles: [],
			fontFamilies: [],
			sttEngine: "auto",
			sttCommand: "",
			sttArgs: [],
			sttModel: "small",
			actionAuditEnabled: true,
			traceEnabled: false,
			recordInbound: false,
			inboxRedact: true,
			injectEnabled: true,
			injectDryRun: false,
			// T6/T7 转正键（T8 入面板）。
			gifFramesEnabled: false,
			inboxQueueEnabled: false,
			inboxQueueDelayMs: 600,
			// T24：QQ 会话标题同步开关（默认关）。
			titleSyncEnabled: false,
		};
		// T8：notices 通知开关补上面板。值可以是 false=不发 / true=默认文案 /
		// 字符串=自定义文案。5 键对齐 src/settings-remote.ts NOTICE_KEYS（本仓
		// schema 无贡献者的 newSession）；默认文案抄自 src/ 各调用点：
		// steerAccepted=src/commands.ts STEER_ACCEPTED_NOTICE、queue/answerAccepted=
		// src/bridge.ts、deferredTimeout=src/deferred.ts（X 为运行时秒数占位）、
		// rateLimited=src/inbound.ts。
		var NOTICE_KEYS = [
			{ key: "steerAccepted", label: "插话提示", def: "✅ 已作为补充指令提交给当前任务，模型将在下一步读取。" },
			{ key: "queue", label: "排队提示", def: "⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。" },
			{ key: "answerAccepted", label: "回答回执", def: "✔ 已提交回答" },
			{ key: "deferredTimeout", label: "超时补发提示", def: "⏳ 等待模型回复超时（已静默等待约 X 秒），任务仍在后台运行；完成后将自动补发最终结果。如需停止请发送 /stop。" },
			{ key: "rateLimited", label: "限流提示", def: "⏳ 消息太频繁，请稍后再试。" },
		];
		/** notices 某个值 → {on, text}：false/空串=关；true/缺省=默认文案；字符串=自定义。 */
		function noticeToDraft(value: any, def: any) {
			if (value === false || value === "") return { on: false, text: def };
			if (typeof value === "string") return { on: true, text: value };
			return { on: true, text: def };
		}
		/** {on, text} → notices 值：关=不发；文案等于默认 → true（跟随上游默认）；否则存字面量。 */
		function draftToNotice(state: any, def: any) {
			if (state == null || state.on !== true) return false;
			var text = typeof state.text === "string" ? state.text : def;
			return text === def ? true : text;
		}
		/** 分组 → 键数组（与 host SETTINGS_GROUPS 同构；供契约核对与快照渲染兜底）。 */
		var GROUP_KEYS: any = {};
		for (var gk = 0; gk < GROUPS.length; gk++) {
			GROUP_KEYS[GROUPS[gk].id] = GROUPS[gk].fields.map(function (field) { return field.key; });
		}
		//#endregion

		//#region 极简 schema 校验（替代 zod，供 Typert 严格 codec 使用；与模板同款）
		function vString(min?: any, max?: any) {
			return {
				parse(value: any) {
					if (typeof value !== "string" || value.length < min || value.length > max) {
						throw new TypeError("expected string(" + min + ".." + max + ")");
					}
					return value;
				},
			};
		}
		function vInt(min?: any) {
			return {
				parse(value: any) {
					if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
						throw new TypeError("expected int>=" + min);
					}
					return value;
				},
			};
		}
		function vNumber(min?: any, max?: any) {
			return {
				parse(value: any) {
					if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("expected finite number");
					if (min !== undefined && value < min) throw new TypeError("expected number >= " + min);
					if (max !== undefined && value > max) throw new TypeError("expected number <= " + max);
					return value;
				},
			};
		}
		function vBoolean() {
			return {
				parse(value: any) {
					if (typeof value !== "boolean") throw new TypeError("expected boolean");
					return value;
				},
			};
		}
		function vArray(item: any) {
			return {
				parse(value: any) {
					if (!Array.isArray(value)) throw new TypeError("expected array");
					return value.map((entry) => item.parse(entry));
				},
			};
		}
		/** 可选字段：缺席（undefined/null）时保持缺席，不参与 parse。 */
		function vOptional(inner: any) {
			return {
				parse(value: any) {
					if (value === undefined || value === null) return undefined;
					return inner.parse(value);
				},
			};
		}
		/** notices 子值：false=不发 / true=默认文案 / string=自定义文案；缺省跟随默认。 */
		function vNoticeValue() {
			return {
				parse(value: any) {
					if (value === undefined || value === null) return undefined;
					if (typeof value !== "boolean" && typeof value !== "string") {
						throw new TypeError("expected boolean|string");
					}
					return value;
				},
			};
		}
		/** 与 zod object 默认行为一致：声明外字段剥离，声明内字段逐个 parse。 */
		function vObject(shape: any) {
			return {
				parse(value: any) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out: any = {};
					for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
					return out;
				},
			};
		}
		function vEnum(values: any) {
			return {
				parse(value: any) {
					if (typeof value !== "string" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		//#endregion

		//#region Remote 契约 schema（与 host lib/settings-remote.js 快照/校验逐字对齐）
		/** 71 键生效值（host buildSnapshot 的 effectiveConfig 全键返回；accessToken 恒 ''；
		 *  notices 为 5 子键对象）。声明外键会被 vObject 剥离，故必须逐键列出。 */
		var configSchema = vObject({
			mode: vEnum(["reverse", "forward"]),
			host: vString(0, 256),
			port: vNumber(),
			url: vString(0, 512),
			accessToken: vString(0, 256),
			botQQ: vString(0, 64),
			workspacePath: vString(0, 1024),
			groupWorkspacePath: vString(0, 1024),
			forceSessionId: vString(0, 256),
			dmPromptFile: vString(0, 1024),
			groupPromptFile: vString(0, 1024),
			requireMention: vBoolean(),
			memberTools: vEnum(["none", "send", "all"]),
			adminUsers: vArray(vString(0, 64)),
			dmPolicy: vEnum(["open", "allowlist", "disabled"]),
			groupPolicy: vEnum(["open", "allowlist", "disabled"]),
			allowAllUsers: vBoolean(),
			allowFrom: vArray(vString(0, 64)),
			groupAllowFrom: vArray(vString(0, 64)),
			wakeNamesAdmin: vArray(vString(0, 64)),
			wakeNamesMember: vArray(vString(0, 64)),
			replyCountsAsMention: vBoolean(),
			atAllCountsAsMention: vBoolean(),
			faceStyle: vEnum(["name", "emoji"]),
			pokeEnabled: vBoolean(),
			interimMessages: vBoolean(),
			interimRecall: vBoolean(),
			interimRecallMs: vNumber(),
			sendErrorNotice: vBoolean(),
			unknownCommand: vEnum(["intercept", "passthrough"]),
			rateLimitPerMinute: vNumber(),
			newMessagePolicy: vEnum(["queue", "steer"]),
			autoSteerPolicy: vEnum(["admin", "all"]),
			deferredTimeoutMs: vNumber(),
			newSessionGreeting: vBoolean(),
			firstMessageAsUser: vBoolean(),
			memoryFilesEnabled: vBoolean(),
			memoryFiles: vArray(vString(0, 1024)),
			ignoreSelf: vBoolean(),
			sidebarEntryEnabled: vBoolean(),
			sttEnabled: vBoolean(),
			agentPreset: vString(0, 128),
			chatIdleEvictDays: vNumber(),
			logLevel: vEnum(["debug", "info", "warn", "error"]),
			textImageEnabled: vBoolean(),
			textImageThreshold: vNumber(),
			cardFooter: vString(0, 128),
			allowPrivateHosts: vBoolean(),
			restrictedMemberPrefix: vBoolean(),
			sensitivePatterns: vArray(vString(0, 512)),
			outboundImageMaxBytes: vNumber(),
			maxVoiceBytes: vNumber(),
			maxFileBytes: vNumber(),
			inboundImageMaxPx: vNumber(),
			inboundFileMaxBytes: vNumber(),
			fontFiles: vArray(vString(0, 1024)),
			fontFamilies: vArray(vString(0, 256)),
			sttEngine: vEnum(["auto", "openai", "whisper-cpp", "custom"]),
			sttCommand: vString(0, 1024),
			sttArgs: vArray(vString(0, 512)),
			sttModel: vString(0, 512),
			actionAuditEnabled: vBoolean(),
			traceEnabled: vBoolean(),
			recordInbound: vBoolean(),
			inboxRedact: vBoolean(),
			injectEnabled: vBoolean(),
			injectDryRun: vBoolean(),
			// T6/T7 转正键（T8 入面板）。
			gifFramesEnabled: vBoolean(),
			inboxQueueEnabled: vBoolean(),
			inboxQueueDelayMs: vNumber(),
			// T24：QQ 会话标题同步开关。
			titleSyncEnabled: vBoolean(),
			notices: vObject({
				steerAccepted: vNoticeValue(),
				queue: vNoticeValue(),
				answerAccepted: vNoticeValue(),
				deferredTimeout: vNoticeValue(),
				rateLimited: vNoticeValue(),
			}),
		});
		var snapshotSchema = vObject({
			revision: vInt(0),
			entryActive: vBoolean(),
			config: configSchema,
			secrets: vArray(vObject({ path: vArray(vString(1, 64)), set: vBoolean() })),
			groups: vObject({
				connection: vArray(vString(1, 64)),
				permissions: vArray(vString(1, 64)),
				behavior: vArray(vString(1, 64)),
				session: vArray(vString(1, 64)),
				media: vArray(vString(1, 64)),
				diagnostics: vArray(vString(1, 64)),
			}),
			effect: vEnum(["restart"]), // T1 §5：19 键统一插件级热重启
		});
		/** updateSettings 入参（T8：71 键任意子集的扁平 JSON；accessToken 缺省=不改，''=清空；
		 *  notices 为 5 子键对象任意子集。客户端网关可能按本 schema 剥键，缺键=编辑被静默
		 *  丢弃，故全键逐字列出——数字界与 src/settings-remote.ts NUMBER_RANGE 对齐）。 */
		var patchSchema = vObject({
			mode: vOptional(vEnum(["reverse", "forward"])),
			host: vOptional(vString(0, 256)),
			port: vOptional(vNumber(1, 65535)),
			url: vOptional(vString(0, 512)),
			accessToken: vOptional(vString(0, 256)),
			botQQ: vOptional(vString(0, 64)),
			workspacePath: vOptional(vString(0, 1024)),
			groupWorkspacePath: vOptional(vString(0, 1024)),
			forceSessionId: vOptional(vString(0, 256)),
			dmPromptFile: vOptional(vString(0, 1024)),
			groupPromptFile: vOptional(vString(0, 1024)),
			allowPrivateHosts: vOptional(vBoolean()),
			ignoreSelf: vOptional(vBoolean()),
			sidebarEntryEnabled: vOptional(vBoolean()),
			requireMention: vOptional(vBoolean()),
			memberTools: vOptional(vEnum(["none", "send", "all"])),
			adminUsers: vOptional(vArray(vString(0, 64))),
			dmPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			groupPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			allowAllUsers: vOptional(vBoolean()),
			allowFrom: vOptional(vArray(vString(0, 64))),
			groupAllowFrom: vOptional(vArray(vString(0, 64))),
			wakeNamesAdmin: vOptional(vArray(vString(0, 64))),
			wakeNamesMember: vOptional(vArray(vString(0, 64))),
			replyCountsAsMention: vOptional(vBoolean()),
			atAllCountsAsMention: vOptional(vBoolean()),
			faceStyle: vOptional(vEnum(["name", "emoji"])),
			pokeEnabled: vOptional(vBoolean()),
			restrictedMemberPrefix: vOptional(vBoolean()),
			sensitivePatterns: vOptional(vArray(vString(0, 512))),
			interimMessages: vOptional(vBoolean()),
			interimRecall: vOptional(vBoolean()),
			interimRecallMs: vOptional(vNumber(0)),
			sendErrorNotice: vOptional(vBoolean()),
			unknownCommand: vOptional(vEnum(["intercept", "passthrough"])),
			rateLimitPerMinute: vOptional(vNumber(0)),
			newMessagePolicy: vOptional(vEnum(["queue", "steer"])),
			autoSteerPolicy: vOptional(vEnum(["admin", "all"])),
			deferredTimeoutMs: vOptional(vNumber(0)),
			inboxQueueEnabled: vOptional(vBoolean()),
			inboxQueueDelayMs: vOptional(vNumber(0)),
			// T24：QQ 会话标题同步开关。
			titleSyncEnabled: vOptional(vBoolean()),
			newSessionGreeting: vOptional(vBoolean()),
			firstMessageAsUser: vOptional(vBoolean()),
			memoryFilesEnabled: vOptional(vBoolean()),
			memoryFiles: vOptional(vArray(vString(0, 1024))),
			agentPreset: vOptional(vString(0, 128)),
			sttEnabled: vOptional(vBoolean()),
			sttEngine: vOptional(vEnum(["auto", "openai", "whisper-cpp", "custom"])),
			sttCommand: vOptional(vString(0, 1024)),
			sttArgs: vOptional(vArray(vString(0, 512))),
			sttModel: vOptional(vString(0, 512)),
			textImageEnabled: vOptional(vBoolean()),
			textImageThreshold: vOptional(vNumber(0)),
			cardFooter: vOptional(vString(0, 128)),
			fontFiles: vOptional(vArray(vString(0, 1024))),
			fontFamilies: vOptional(vArray(vString(0, 256))),
			outboundImageMaxBytes: vOptional(vNumber(1, 104857600)),
			maxVoiceBytes: vOptional(vNumber(1, 52428800)),
			maxFileBytes: vOptional(vNumber(1, 4294967296)),
			inboundImageMaxPx: vOptional(vNumber(0)),
			inboundFileMaxBytes: vOptional(vNumber(0)),
			gifFramesEnabled: vOptional(vBoolean()),
			chatIdleEvictDays: vOptional(vNumber(0)),
			logLevel: vOptional(vEnum(["debug", "info", "warn", "error"])),
			actionAuditEnabled: vOptional(vBoolean()),
			traceEnabled: vOptional(vBoolean()),
			recordInbound: vOptional(vBoolean()),
			inboxRedact: vOptional(vBoolean()),
			injectEnabled: vOptional(vBoolean()),
			injectDryRun: vOptional(vBoolean()),
			notices: vOptional(vObject({
				steerAccepted: vNoticeValue(),
				queue: vNoticeValue(),
				answerAccepted: vNoticeValue(),
				deferredTimeout: vNoticeValue(),
				rateLimited: vNoticeValue(),
			})),
		});
		//#endregion

		//#region Typert Remote 严格 descriptor（与 host lib/settings-remote.js 服务方法面
		//  逐字对齐：getSettings() / updateSettings(patch, expectedRevision) /
		//  listWorkspaces()（W7），全 positional。
		//  host 侧未导出客户端 descriptor 数组——两侧各自持有一份，本数组为客户端真相源，
		//  变更须同步宿主侧并在 DEVLOG 记录；tests/client-settings.spec.ts 做契约核对。）
		/** W7：listWorkspaces 返回值（host WorkspaceListResult 同构）。 */
		var workspaceListSchema = vObject({
			available: vBoolean(),
			workspaces: vArray(vObject({ id: vString(1, 256), path: vString(0, 1024), sessionCount: vInt(0) })),
		});
		function strictCodec(typeSymbol: any, schema: any) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
		}
		function jsonParameter(name: any, typeSymbol: any, schema: any) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function onebotMethod(method: any, parameters: any, resultSchema?: any, typeSymbol?: any) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec(typeSymbol != null ? typeSymbol : "OnebotSettingsSnapshot", resultSchema || snapshotSchema),
			};
		}
		var ONEBOT_SETTINGS_DESCRIPTORS = [
			onebotMethod("getSettings", []),
			onebotMethod("updateSettings", [
				jsonParameter("patch", "OnebotSettingsPatch", patchSchema),
				jsonParameter("expectedRevision", "number", vOptional(vInt(0))),
			]),
			onebotMethod("listWorkspaces", [], workspaceListSchema, "WorkspaceListResult"),
		];
		var ONEBOT_SETTINGS_REMOTE = { package: PLUGIN_ID, descriptors: ONEBOT_SETTINGS_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式。
		//  分组标题与字段 label 是中文常量（T4 要求），不走词条。）
		var zh: any = {
			"settings.title": "QQ Bot 设置",
			"settings.desc": "配置持久化为 profile 层 cordis.patch.yml 中 dsh-onebot 条目的 config 覆盖行，与手改 patch、宿主原生设置页同源。",
			"settings.loading": "正在加载设置…",
			"settings.reload": "重新加载",
			"settings.reset": "恢复默认",
			"save.submit": "保存设置",
			"save.saving": "正在保存…",
			"save.done": "设置已保存。保存即热生效：插件秒级重启，QQ 桥会自动重连。",
			"save.noChanges": "没有需要保存的变更。",
			"save.badNumber": "数字字段不合法：{keys}",
			"effect.hint": "保存即热生效（无需重启宿主）：插件秒级原地重启，QQ 桥会自动重连；在途回合中断、频控窗口与中间消息缓冲清零，会话映射/历史不受影响。",
			"effect.entryInactive": "dsh-onebot 条目当前未激活，保存后可能无法生效，请检查插件加载状态。",
			"secret.set": "已配置（脱敏，不回显）",
			"secret.unset": "未配置",
			"secret.placeholder": "留空 = 不修改",
			"secret.clear": "清除已保存的 AccessToken",
			"conflict.title": "保存冲突：设置已被其他来源修改（revision 不一致），已重新拉取最新配置，请检查后重试。",
			"status.error": "出错",
			"revision.label": "revision",
			// 批 2 第二档词条（integration §2.4/§2.5：交互文案 zh/en 同批新增，既有键
			// 文案不改）——脏状态 badge/保存禁用 title/危险操作确认框/密文清除三态
			// 提示/mode 联动 hint/加载与 workspace 重试/诊断折叠 summary/组描述（UX §2.2 版）。
			"common.retry": "重试",
			"save.dirtyBadge": "{count} 项未保存",
			"save.noChangesTitle": "没有未保存的修改",
			"confirm.discardChanges": "将丢弃 {count} 项未保存修改，确定继续吗？",
			"effect.entryInactiveTitle": "插件条目未激活，修改可能无法生效。",
			"secret.clearPending": "保存后清空",
			"secret.clearHint": "将清除已保存的值",
			"field.modeInactive": "当前模式不生效",
			"workspace.fetchFailed": "本次拉取 workspace 列表失败，可直接输入路径。",
			"group.connection.desc": "连 NapCat 的通道",
			"group.permissions.desc": "谁能触发与使用",
			"group.behavior.desc": "回复、限流与消息处理",
			"group.session.desc": "新会话与工作区",
			"group.media.desc": "语音、图片与媒体限额",
			"group.diagnostics.desc": "日志与调试",
			// 批 3 词条（UX §5.4/§5.6 + integration §3：冲突合并保留 + 数字行内校验，
			// zh/en 同批齐平；既有键文案不改）。
			"conflict.kept": "已保留 {count} 项未冲突的修改，请核对后重新保存。",
			"conflict.secretCleared": "accessToken 输入已清空，如需修改请重新输入。",
			"field.numberInvalid": "必须是 {range} 的有限数字",
			"field.remoteOverwritten": "已被其他来源修改，已同步为最新值",
			// T11：首页左侧边栏入口词条（sidebar.panellist 的 label；en 同批齐平）。
			"sidebar.panel": "QQ Bot",
			// 0.10.0 字段文案词条化：面板自有 UI 串（非 GROUPS 内联的）双词齐平。
			"settings.groupsLabel": "设置分组",
			"settings.buildMarker": "面板构建标记",
			"field.nonDefault": "非默认",
			"field.nonDefaultTitle": "与默认值不同",
			"field.accessToken.securityHint": "出于安全实际令牌不回传页面，只显占位圆点，输入新值即替换（令牌：NapCat 的 WebUI → 网络配置→Token）",
			"workspace.pick": "快速填入 workspace",
			"workspace.pickPlaceholder": "选择 workspace…",
			"workspace.pickTitle": "列出宿主 workspace 注册表中的工作区；选中后点「填入」写入上方路径输入框（只填值，保存仍走「保存设置」按钮）",
			"workspace.apply": "填入",
			"workspace.pickHint": "选中后点「填入」仅写入上方输入框；需点「保存设置」才会保存（对新会话生效，已设 /workspace 覆盖的会话不受影响）。",
			"workspace.emptyAvailable": "暂无 workspace 记录，可直接输入路径。",
			"workspace.emptyUnavailable": "无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。",
			"notice.textAria": "{label}文案",
		};
		var en: any = {
			"settings.title": "QQ Bot settings",
			"settings.desc": "Settings persist as the config override row of the dsh-onebot entry in the profile-layer cordis.patch.yml — same source as hand-edited patches and the host's native settings page.",
			"settings.loading": "Loading settings…",
			"settings.reload": "Reload",
			"settings.reset": "Reset to defaults",
			"save.submit": "Save settings",
			"save.saving": "Saving…",
			"save.done": "Settings saved. Hot-applied on save: the plugin restarts within seconds and the QQ bridge reconnects automatically.",
			"save.noChanges": "Nothing to save.",
			"save.badNumber": "Invalid number fields: {keys}",
			"effect.hint": "Hot-applied on save (no host restart): the plugin fiber restarts in place within seconds; the QQ bridge reconnects automatically. In-flight turns are interrupted and rate-limit windows/interim buffers reset; session mappings and history are unaffected.",
			"effect.entryInactive": "The dsh-onebot entry is currently inactive; saving may not take effect. Check the plugin's load state.",
			"secret.set": "Configured (redacted, never echoed)",
			"secret.unset": "Not configured",
			"secret.placeholder": "Leave empty = keep current",
			"secret.clear": "Clear the saved AccessToken",
			"conflict.title": "Save conflict: settings were changed by another source (revision mismatch). The latest snapshot has been re-fetched — review and retry.",
			"status.error": "Error",
			"revision.label": "revision",
			"common.retry": "Retry",
			"save.dirtyBadge": "{count} unsaved",
			"save.noChangesTitle": "No unsaved changes",
			"confirm.discardChanges": "Discard {count} unsaved change(s)?",
			"effect.entryInactiveTitle": "The plugin entry is inactive; changes may not take effect.",
			"secret.clearPending": "Clears on save",
			"secret.clearHint": "The saved value will be cleared",
			"field.modeInactive": "Not active in the current mode",
			"workspace.fetchFailed": "Couldn't fetch the workspace list this time — you can type a path directly.",
			"group.connection.desc": "How it links to NapCat",
			"group.permissions.desc": "Who can trigger it",
			"group.behavior.desc": "Replies, limits and message handling",
			"group.session.desc": "New sessions and workspace",
			"group.media.desc": "Voice, images and media caps",
			"group.diagnostics.desc": "Logs and debugging",
			// 批 3（UX §5.4/§5.6）：与 zh 同批新增的 4 键（冲突合并保留 + 数字行内校验）。
			"conflict.kept": "Kept {count} non-conflicting change(s) — review and save again.",
			"conflict.secretCleared": "The accessToken input has been cleared; re-enter it if you still want to change it.",
			"field.numberInvalid": "Must be a finite number {range}",
			"field.remoteOverwritten": "Changed by another source — synced to the latest value",
			"sidebar.panel": "QQ Bot",
			// 0.10.0 字段文案词条化：与 zh 同批的面板自有 UI 串。
			"settings.groupsLabel": "Setting groups",
			"settings.buildMarker": "Panel build marker",
			"field.nonDefault": "Non-default",
			"field.nonDefaultTitle": "Differs from the default value",
			"field.accessToken.securityHint": "For security the actual token is never sent back to the page — only placeholder dots are shown; typing a new value replaces it (token: NapCat WebUI → Network → Token)",
			"workspace.pick": "Quick fill from workspaces",
			"workspace.pickPlaceholder": "Choose a workspace…",
			"workspace.pickTitle": "Workspaces from the host registry; pick one and press Fill in to write it into the path field above (fills the value only — saving still goes through Save settings)",
			"workspace.apply": "Fill in",
			"workspace.pickHint": "Fill in only writes the field above; press Save settings to persist (applies to new sessions; sessions with a /workspace override are unaffected).",
			"workspace.emptyAvailable": "No workspace records yet — type a path directly.",
			"workspace.emptyUnavailable": "Workspace list unavailable (the host provides no workspace registry) — type a path directly.",
			"notice.textAria": "{label} text",
		};
		//#region 字段文案词条化（0.10.0）：zh 以 GROUPS/NOTICE_KEYS 为唯一源自动灌入，
		// en 走下方显式对照表（EN_GROUPS/EN_SECTIONS/EN_NOTICES）。新键纪律「新键必须
		// 双词」的机械护栏 = assertSameKeys（zh 自动含全部字段键，en 缺即逐键告警）
		// + 下方 EN_MISSING 显式告警（en 回落 zh 时点名，防止静默英文缺失）。
		for (var zg = 0; zg < GROUPS.length; zg++) {
			var groupDef: any = GROUPS[zg];
			zh["group." + groupDef.id + ".title"] = groupDef.title;
			if (Array.isArray(groupDef.sections)) {
				for (var sectionDef of groupDef.sections) {
					zh["group." + groupDef.id + ".section." + sectionDef.id] = sectionDef.title;
				}
			}
			for (var zf = 0; zf < groupDef.fields.length; zf++) {
				var fieldDef: any = groupDef.fields[zf];
				zh["field." + fieldDef.key + ".label"] = fieldDef.label;
				if (typeof fieldDef.hint === "string" && fieldDef.hint !== "") zh["field." + fieldDef.key + ".hint"] = fieldDef.hint;
				if (typeof fieldDef.placeholder === "string" && fieldDef.placeholder !== "") zh["field." + fieldDef.key + ".placeholder"] = fieldDef.placeholder;
				if (fieldDef.optionLabels != null) {
					for (var optionValue in fieldDef.optionLabels) {
						zh["field." + fieldDef.key + ".option." + optionValue] = fieldDef.optionLabels[optionValue];
					}
				}
			}
		}
		zh["field.stringArray.placeholder.default"] = "分割方式：逗号、顿号、换行";
		for (var zn = 0; zn < NOTICE_KEYS.length; zn++) {
			zh["notice." + NOTICE_KEYS[zn].key + ".label"] = NOTICE_KEYS[zn].label;
		}
		/** en 字段文案对照表（label/hint/placeholder/options；缺项回落 zh 并告警）。 */
		var EN_GROUPS: any = {
			connection: {
				title: "Connection",
				fields: {
					mode: { label: "Connection mode", hint: "Reverse = it connects to us; forward = we connect to it", options: { reverse: "Reverse WebSocket (NapCat connects to this plugin)", forward: "Forward WebSocket (plugin connects to NapCat)" } },
					host: { label: "Reverse WS listen address", hint: "Listen address in reverse mode" },
					port: { label: "Reverse WS listen port", hint: "Listen port in reverse mode" },
					url: { label: "Forward WS server address", hint: "Server address in forward mode" },
					accessToken: { label: "Access token (AccessToken)" },
					botQQ: { label: "Bot QQ id" },
					workspacePath: { label: "Default DM workspace path", hint: "Default directory for new DM sessions" },
					groupWorkspacePath: { label: "Default group workspace path", hint: "Default directory for new group sessions; empty = same as DM" },
					forceSessionId: { label: "Force session id", hint: "When set, always use this session id (advanced; usually left empty)" },
					dmPromptFile: { label: "DM prompt file (txt path)" },
					groupPromptFile: { label: "Group prompt file (txt path)" },
					allowPrivateHosts: { label: "Allow localhost/private-network downloads", hint: "Private-network links are blocked by default; enable when NapCat's file service runs locally" },
					ignoreSelf: { label: "Ignore own messages", hint: "Do not process the bot's own echo messages" },
					sidebarEntryEnabled: { label: "Home sidebar entry", hint: "Show a \"QQ Bot\" entry in the DSH home sidebar; changes apply after a page reload" },
				},
			},
			permissions: {
				title: "Permissions",
				fields: {
					requireMention: { label: "Require @ in group chats" },
				memberTools: { label: "Member tool access", options: { none: "All disabled", send: "Send-only", all: "Unrestricted" }, hint: "Which qq_* tools non-admin turns may use: send-only = split messages / send images (workspace galleries included)" },
				adminUsers: { label: "Admin user list" },
					dmPolicy: { label: "DM policy", options: { open: "Open", allowlist: "Allowlist", disabled: "Disabled" } },
					groupPolicy: { label: "Group policy", options: { open: "Open", allowlist: "Allowlist", disabled: "Disabled" } },
					allowAllUsers: { label: "Allow all users" },
					allowFrom: { label: "DM allowlist" },
					groupAllowFrom: { label: "Group allowlist" },
					wakeNamesAdmin: { label: "User wake names" },
					wakeNamesMember: { label: "Member wake names" },
					replyCountsAsMention: { label: "Quoted-message wakes", hint: "Quoting someone else's message also wakes me" },
					atAllCountsAsMention: { label: "@-all wakes", hint: "@-ing everyone also counts as a wake" },
					faceStyle: { label: "QQ face rendering", hint: "Face names or emoji approximation", options: { name: "Official face table", emoji: "Emoji approximation (legacy look)" } },
					pokeEnabled: { label: "Poke wakes" },
					restrictedMemberPrefix: { label: "Restricted prefix for non-admins", hint: "When on, non-admin group messages carry a [restricted user: Q&A only] marker: answers questions only, may still request images and stickers; off = treat everyone the same" },
					sensitivePatterns: { label: "Outbound sensitive-word regexes", placeholder: "One regex per line; empty = built-in list" },
				},
			},
			behavior: {
				title: "Behavior",
				fields: {
					interimMessages: { label: "Interim messages", hint: "Send interim messages during a turn" },
					interimRecall: { label: "Auto-recall interim messages" },
					interimRecallMs: { label: "Interim message retention (ms)" },
					sendErrorNotice: { label: "Send error notices" },
					unknownCommand: { label: "Unknown command handling", options: { intercept: "Intercept", passthrough: "Pass through" } },
					rateLimitPerMinute: { label: "Per-minute message rate cap" },
					newMessagePolicy: { label: "New messages while a task runs", options: { queue: "Queue", steer: "Steer" } },
					autoSteerPolicy: { label: "Auto-steer eligibility", options: { admin: "Admins only", all: "All members" } },
					deferredTimeoutMs: { label: "Model reply wait timeout (ms)" },
					inboxQueueEnabled: { label: "Inbound burst merging", hint: "Merge several messages burst-sent to one session into a single delivery" },
					inboxQueueDelayMs: { label: "Merge wait window (ms)", hint: "Each message waits one window before delivery; 0 = immediately" },
					titleSyncEnabled: { label: "QQ session title sync", hint: "Let the host refresh session titles after each message (one small LLM call); titles you named manually in the host are never overwritten" },
				},
			},
			session: {
				title: "Session",
				fields: {
					newSessionGreeting: { label: "Greet on new sessions", hint: "After /new I say hello first" },
					firstMessageAsUser: { label: "Inject first message as User", hint: "The host auto-names the session from the first message only when this is on (default off)" },
					memoryFilesEnabled: { label: "Read memory files on new sessions" },
					memoryFiles: { label: "Memory file paths", placeholder: "Absolute file paths; split by comma, enumeration comma, or newline" },
					agentPreset: { label: "Agent preset for new sessions (preset id, e.g. standard; empty = host default)", placeholder: "standard" },
				},
			},
			media: {
				title: "Media",
				fields: {
					sttEnabled: { label: "Speech-to-text", hint: "Transcribe voice messages to text first" },
					sttEngine: { label: "Speech-to-text engine", options: { auto: "Auto-detect", openai: "openai", "whisper-cpp": "whisper-cpp", custom: "Custom command" } },
					sttCommand: { label: "Custom transcription program", hint: "Program name or absolute path" },
					sttArgs: { label: "Transcription argument template", placeholder: "One per line; {file} and {out} are substituted" },
					sttModel: { label: "Transcription model", hint: "openai: small/base/medium…; whisper.cpp: model name or .bin path" },
					textImageEnabled: { label: "Long text as image card" },
					textImageThreshold: { label: "Text-length threshold for cards", placeholder: "0–10000; 0 = never card" },
					cardFooter: { label: "Card footer badge", placeholder: "OneBot" },
					fontFiles: { label: "Card font files", placeholder: "One font file path (ttf/otf) per line; empty = system fonts" },
					fontFamilies: { label: "Card font family names", placeholder: "One family name per line; empty = platform default" },
					outboundImageMaxBytes: { label: "Outbound image size cap (bytes)", placeholder: "Default 8388608 (8MB); max 104857600 (100MB)" },
					maxVoiceBytes: { label: "Outbound voice size cap (bytes)", placeholder: "Default 15728640 (15MB); max 52428800 (50MB)" },
					maxFileBytes: { label: "Outbound file/video size cap (bytes)", placeholder: "Default 20971520 (20MB); max 4294967296 (4G)" },
					inboundImageMaxPx: { label: "Inbound image max long edge (px)", placeholder: "Default 2048; 1440+ recommended" },
					inboundFileMaxBytes: { label: "Inbound file size cap (bytes)", placeholder: "Default 20971520 (20MB); 0 = unlimited" },
					gifFramesEnabled: { label: "GIF frame splitting", hint: "Attach a 4-frame vertical strip next to received GIFs so the model can follow the motion (default off)" },
				},
			},
			diagnostics: {
				title: "Diagnostics",
				fields: {
					actionAuditEnabled: { label: "Action audit", hint: "Log one audit line per send action" },
					traceEnabled: { label: "Decision trace (trace)", hint: "Write decision logs for troubleshooting" },
					recordInbound: { label: "Record inbound events", hint: "Record received messages" },
					inboxRedact: { label: "Redact recordings", hint: "Mask ids when recording" },
					injectEnabled: { label: "Event injection (debug only)", hint: "Inject messages offline for debugging" },
					injectDryRun: { label: "Injection dry-run", hint: "Injection does not really send; testing only" },
					logLevel: { label: "Log level", options: { debug: "debug (full)", info: "info (normal)", warn: "warn (warnings)", error: "error (errors only)" } },
				},
			},
		};
		var EN_SECTIONS: any = {
			permissions: { dm: "Direct messages", group: "Group chats", common: "Common" },
		};
		var EN_NOTICES: any = {
			steerAccepted: "Steer notice",
			queue: "Queue notice",
			answerAccepted: "Answer receipt",
			deferredTimeout: "Timeout notice",
			rateLimited: "Rate-limit notice",
		};
		var enMissing: string[] = [];
		for (var eg = 0; eg < GROUPS.length; eg++) {
			var groupEn = EN_GROUPS[GROUPS[eg].id];
			var groupSrc: any = GROUPS[eg];
			en["group." + groupSrc.id + ".title"] = groupEn != null ? groupEn.title : groupSrc.title;
			if (Array.isArray(groupSrc.sections)) {
				for (var sectionEn of groupSrc.sections) {
					var sectionTitleEn = groupEn != null && EN_SECTIONS[groupSrc.id] != null ? EN_SECTIONS[groupSrc.id][sectionEn.id] : null;
					en["group." + groupSrc.id + ".section." + sectionEn.id] = sectionTitleEn != null ? sectionTitleEn : sectionEn.title;
				}
			}
			for (var ef = 0; ef < groupSrc.fields.length; ef++) {
				var fieldDef2: any = groupSrc.fields[ef];
				var fieldEn = groupEn != null && groupEn.fields[fieldDef2.key] != null ? groupEn.fields[fieldDef2.key] : null;
				if (fieldEn == null || typeof fieldEn.label !== "string" || fieldEn.label === "") enMissing.push(fieldDef2.key);
				en["field." + fieldDef2.key + ".label"] = fieldEn != null && fieldEn.label != null ? fieldEn.label : fieldDef2.label;
				if (zh["field." + fieldDef2.key + ".hint"] != null) en["field." + fieldDef2.key + ".hint"] = fieldEn != null && fieldEn.hint != null ? fieldEn.hint : fieldDef2.hint;
				if (zh["field." + fieldDef2.key + ".placeholder"] != null) en["field." + fieldDef2.key + ".placeholder"] = fieldEn != null && fieldEn.placeholder != null ? fieldEn.placeholder : fieldDef2.placeholder;
				if (fieldDef2.optionLabels != null) {
					for (var optionValue2 in fieldDef2.optionLabels) {
						var optionEn = fieldEn != null && fieldEn.options != null ? fieldEn.options[optionValue2] : null;
						en["field." + fieldDef2.key + ".option." + optionValue2] = optionEn != null ? optionEn : fieldDef2.optionLabels[optionValue2];
					}
				}
			}
		}
		en["field.stringArray.placeholder.default"] = "Split by commas or newlines";
		for (var eni = 0; eni < NOTICE_KEYS.length; eni++) {
			en["notice." + NOTICE_KEYS[eni].key + ".label"] = EN_NOTICES[NOTICE_KEYS[eni].key] != null ? EN_NOTICES[NOTICE_KEYS[eni].key] : NOTICE_KEYS[eni].label;
		}
		if (enMissing.length > 0) {
			console.warn("[dsh-onebot] 新键必须双词：以下字段缺 en 词条（已回落 zh）：" + enMissing.join(","));
		}
		/** 双语 key 集一致性自检（0.10.0 起覆盖自动灌入的字段文案）：缺漏仅告警不致崩溃。 */
		function assertSameKeys(a: any, b: any) {
			var missing = Object.keys(a).filter((key) => !(key in b));
			var extra = Object.keys(b).filter((key) => !(key in a));
			if (missing.length > 0 || extra.length > 0) {
				console.warn("[dsh-onebot] 双语词条 key 不齐 zh缺:" + missing.join(",") + " en缺:" + extra.join(","));
			}
		}
		assertSameKeys(zh, en);
		//#endregion

		//#region 面板样式（一次注入，随插件卸载移除；类名前缀 obx-）
		// 0.10.0 视觉对齐：token 全部引用宿主 --dsw-*（明暗/主题跟随宿主，不自造色值）；
		// 每个引用带字面回落值——仅在宿主 token 缺席的极端环境兜底。控件本体（开关/
		// 分段/按钮/徽标/输入框）在宿主 primitives 在位时由宿主 CSS 渲染，下列控件
		// 规格仅为回落 shim 与 textarea/select（宿主无表单级 textarea/select 原语）服务，
		// 度量对齐宿主原生控件（Input 32px/.5px l4 边/radius-md、开关 36×20、分段 26px）。
		var CSS = [
			// token 映射（别名层：--dsw-alias-* / --dsw-radius-*）
			".obx-panel{--obx-fg:var(--dsw-alias-label-primary,#17181a);--obx-fg-secondary:var(--dsw-alias-label-secondary,#4b4f58);--obx-fg-tertiary:var(--dsw-alias-label-tertiary,#7f8287);--obx-hairline:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--obx-input-border:var(--dsw-alias-border-l4,rgba(0,0,0,.16));--obx-input-bg:var(--dsw-alias-bg-layer-1,#fff);--obx-well-bg:var(--dsw-alias-bg-module-platform,#f5f6f7);--obx-focus:var(--dsw-alias-state-business-primary,#4176e6);--obx-error:var(--dsw-alias-state-error-primary,#ec1313);--obx-warn:var(--dsw-alias-state-warn-label,#dd8629);--obx-radius-md:var(--dsw-radius-md,12px);--obx-radius-sm:var(--dsw-radius-sm,8px);box-sizing:border-box;width:100%;max-width:960px;margin-inline:auto;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--obx-fg);font-size:13px;line-height:1.5}",
			// 回落值明暗切换（宿主 token 在位时此块不产生任何效果）
			"@media (prefers-color-scheme: dark){.obx-panel{--obx-fg:#eceef2;--obx-fg-secondary:#b6bac4;--obx-fg-tertiary:#81858c;--obx-hairline:rgba(255,255,255,.12);--obx-input-border:rgba(255,255,255,.2);--obx-input-bg:#232324;--obx-well-bg:#2c2c2e;--obx-focus:#7aaaff;--obx-error:#f25a5a;--obx-warn:#f59e0b}}",
			// 页骨架（对齐宿主原生页：居中 960 内容列、20px/500 标题、页签行、滚动主体）
			".obx-head{flex:none;display:flex;flex-direction:column;gap:12px;padding:28px 24px 0}",
			".obx-head-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}",
			".obx-title{margin:0;font-size:20px;font-weight:500;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".obx-head-spacer{flex:1 1 auto}",
			".obx-status-warn{color:var(--obx-warn);font-size:12px;line-height:18px;white-space:nowrap}",
			".obx-meta{color:var(--obx-fg-tertiary);font-size:11px;line-height:16px;white-space:nowrap}",
			".obx-tabs{display:flex;min-width:0;max-width:100%}",
			".obx-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:16px;padding:20px 24px 32px;-webkit-overflow-scrolling:touch}",
			// 反馈行（原生表单语义：错误/成功为彩色文本行，不再是描边横幅）
			".obx-effect{margin:0;color:var(--obx-fg-tertiary);font-size:12px;line-height:18px}",
			".obx-error{margin:0;color:var(--obx-error);font-size:12px;line-height:18px;white-space:pre-wrap}",
			".obx-notice{margin:0;color:var(--obx-fg-secondary);font-size:12px;line-height:18px;white-space:pre-wrap}",
			".obx-toast-wrap{position:sticky;top:0;z-index:20;display:flex;flex-direction:column;gap:4px}",
			// 分组（平铺文档流；字段行间发丝分隔 = 原生表单形态）
			".obx-group{display:flex;flex-direction:column}",
			".obx-group-head{display:flex;align-items:baseline;gap:8px;padding-bottom:4px;flex-wrap:wrap}",
			".obx-group-title{margin:0;font-size:14px;font-weight:500;line-height:20px}",
			".obx-group-desc{margin:0;color:var(--obx-fg-tertiary);font-size:12px;line-height:18px}",
			".obx-subgroup-title{margin:14px 0 2px;font-size:13px;font-weight:600;line-height:20px}",
			".obx-subgroup-title:first-child{margin-top:0}",
			// 字段行：值/枚举/多行为纵向（label 上、控件下、hint 再下），布尔/通知为左右行
			".obx-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:.5px solid var(--obx-hairline)}",
			".obx-group-head+.obx-field,.obx-subgroup-title+.obx-field{border-top:none}",
			".obx-field--row{flex-direction:row;align-items:center;justify-content:space-between;gap:16px}",
			".obx-field-text{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}",
			".obx-field-head{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}",
			".obx-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--obx-fg)}",
			".obx-hint{margin:0;color:var(--obx-fg-tertiary);font-size:12px;line-height:1.5;min-width:0}",
			".obx-hint--warn{color:var(--obx-warn)}",
			".obx-hint--invalid{color:var(--obx-error)}",
			// 控件容器（原生 Input 为 inline-flex 包裹，经容器限宽；数字收窄=原生无此概念，沿用旧口径）
			".obx-control{display:flex;max-width:520px}",
			".obx-control--narrow{display:flex;max-width:160px}",
			".obx-control>*{flex:1;min-width:0}",
			// 控件规格（回落 shim 与 textarea/select 用；宿主 primitives 在位时由宿主 CSS 渲染）
			".obx-input{box-sizing:border-box;height:32px;padding:0 8px;border:.5px solid var(--obx-input-border);border-radius:var(--obx-radius-md);background:var(--obx-input-bg);color:var(--obx-fg);font:inherit;font-size:13px;line-height:1.5}",
			".obx-input:focus-visible{outline:none;border-color:var(--obx-focus)}",
			".obx-input:disabled{color:var(--obx-fg-tertiary);cursor:default}",
			".obx-textarea{box-sizing:border-box;min-height:60px;resize:vertical;padding:7px 8px;border:.5px solid var(--obx-input-border);border-radius:var(--obx-radius-md);background:var(--obx-input-bg);color:var(--obx-fg);font:inherit;font-size:13px;line-height:1.5}",
			".obx-textarea:focus-visible{outline:none;border-color:var(--obx-focus)}",
			".obx-textarea:disabled{color:var(--obx-fg-tertiary)}",
			".obx-select{box-sizing:border-box;height:32px;max-width:420px;padding:0 8px;border:.5px solid var(--obx-input-border);border-radius:var(--obx-radius-md);background:var(--obx-input-bg);color:var(--obx-fg);font:inherit;font-size:13px}",
			".obx-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(128,128,128,.4));cursor:pointer}",
			".obx-switch:disabled{cursor:default;opacity:.5}",
			".obx-switch[aria-checked=true]{background:var(--dsw-alias-label-secondary,#65676b)}",
			".obx-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .12s ease}",
			".obx-switch[aria-checked=true] .obx-switch-thumb{transform:translate(16px)}",
			"@media (prefers-color-scheme: dark){.obx-switch[aria-checked=true] .obx-switch-thumb{background:#17181a}}",
			".obx-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--obx-fg);cursor:pointer}",
			".obx-checkbox input:disabled{cursor:default}",
			".obx-secret-row{display:flex;align-items:center;min-height:32px;margin-top:-6px}",
			".obx-badge{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:999px;padding:0 8px;font-size:11px;line-height:18px;color:var(--obx-fg-secondary);white-space:nowrap}",
			".obx-badge--strong{background:var(--obx-well-bg);border-color:transparent;color:var(--obx-fg)}",
			".obx-btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:32px;padding:0 12px;border:0;border-radius:var(--obx-radius-md);background:transparent;color:var(--obx-fg);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}",
			".obx-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
			".obx-btn:disabled{cursor:not-allowed;opacity:.4}",
			".obx-btn--primary{background:var(--dsw-alias-label-primary,#17181a);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}",
			".obx-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3c3c3d)}",
			"@media (prefers-color-scheme: dark){.obx-btn--primary{background:var(--dsw-alias-label-primary,#eceef2);color:var(--dsw-alias-label-primary-foreground,#17181a)}}",
			".obx-segmented{display:inline-flex;gap:2px;padding:3px;border-radius:var(--obx-radius-md);background:var(--obx-well-bg);max-width:100%}",
			".obx-segmented-tab{box-sizing:border-box;height:26px;padding:0 12px;border:0;border-radius:var(--obx-radius-sm);background:transparent;color:var(--obx-fg-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap}",
			".obx-segmented-tab[aria-selected=true]{background:var(--obx-input-bg);color:var(--obx-fg);box-shadow:0 1px 2px rgba(0,0,0,.08)}",
			".obx-segmented-tab:disabled{cursor:default;opacity:.4}",
			// workspace 快速填入行（卡内嵌次级行；说明独占一行）
			".obx-workspace-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-radius:var(--obx-radius-md);background:var(--obx-well-bg)}",
			".obx-workspace-row .obx-hint{flex-basis:100%}",
			".obx-link-btn{cursor:pointer;border:none;background:none;color:var(--obx-focus);padding:0 0 0 4px;font:inherit;font-size:12px;text-decoration:underline}",
			".obx-link-btn:disabled{opacity:.45;cursor:not-allowed;text-decoration:none}",
			// 底部保存条（原生 SettingsForm 式：发丝线上方 + 右侧实心保存钮）
			".obx-foot{display:flex;align-items:center;gap:12px;margin-top:8px;padding-top:16px;border-top:.5px solid var(--obx-hairline)}",
			// 窄容器：内边距收窄，页签可横向滚动
			"@media (max-width: 560px){.obx-head{padding:20px 16px 0}.obx-body{padding:16px 16px 24px}.obx-tabs{overflow-x:auto}}",
		].join("\n");
		//#endregion

		//#region 工具（纯函数，模块级可测）
		function format(template: any, params: any) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
		}
		function messageOf(cause: any) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** RemoteResult 解包：{ok:true,value}|{ok:false,error:{message}}。 */
		function unwrap(result: any) {
			if (result != null && result.ok === true) return result.value;
			var detail = result != null && result.error != null ? result.error.message : "unknown remote error";
			var error: any = new Error(detail);
			if (result != null && result.error != null && result.error.code != null) error.code = result.error.code;
			throw error;
		}
		/** 保存冲突判定（T1 §3.1：expectedRevision ≠ 当前 revision 拒写，
		 *  host 抛 RemoteError('onebot-settings/conflict')；message 兜底只匹配该
		 *  错误路径本身——不过宽匹配含 "revision" 的无关错误（评审 B5）。 */
		var CONFLICT_RE = /onebot-settings\/conflict/i;
		function isConflictError(cause: any) {
			if (cause == null) return false;
			return cause.code === "onebot-settings/conflict" || CONFLICT_RE.test(String(cause.message || ""));
		}
		/** 快照生效值 → 表单草稿（展示形态：number/stringArray/secret 均为可编辑文本；
		 *  accessToken 恒 ''，明文绝不进入草稿——host 快照已脱敏）。 */
		function snapshotValueToDraft(field: any, value: any) {
			if (field.type === "secret") return ""; // 脱敏回显：密码框恒空（T1 §3 敏感字段行）
			if (field.type === "stringArray") return Array.isArray(value) ? value.join(", ") : "";
			if (field.type === "number") return value === undefined || value === null ? "" : String(value);
			if (field.type === "boolean") return value === true;
			return value === undefined || value === null ? "" : String(value);
		}
		function draftFromSnapshot(snapshot: any) {
			var config = snapshot != null && snapshot.config != null ? snapshot.config : {};
			var draft: any = {};
			for (var field of ALL_FIELDS) draft[field.key] = snapshotValueToDraft(field, config[field.key]);
			// T8：notices 通知开关的草稿形态 {on, text}
			var noticesCfg = config.notices != null && typeof config.notices === "object" ? config.notices : {} as any;
			for (var nk of NOTICE_KEYS) draft["notices." + nk.key] = noticeToDraft(noticesCfg[nk.key], nk.def);
			return draft;
		}
		function draftFromDefaults() {
			return draftFromSnapshot({ config: DEFAULTS });
		}
		/** 草稿展示值 → patch 值（stringArray 文本 → 行数组；number 文本 → 数字）。 */
		function coerceValue(field: any, raw: any) {
			if (field.type === "number") {
				var n = typeof raw === "number" ? raw : Number(String(raw).trim());
				return Number.isFinite(n) ? n : NaN;
			}
			if (field.type === "boolean") return raw === true;
			if (field.type === "stringArray") {
				// 本地加：只认逗号（中英文）、顿号、换行。空格不当分隔符——
				// 字体家族名（Noto Sans CJK SC）、正则、转写参数、带空格的路径都会被拆坏。
				return String(raw == null ? "" : raw).split(/[,\uFF0C\u3001\r\n]+/).map((item) => item.trim()).filter((item) => item !== "");
			}
			return String(raw == null ? "" : raw);
		}
		function valueEquals(a: any, b: any) {
			return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
		}
		/**
		 * 计算保存 patch（T1 §4 + W6 + W7：29 键任意子集的扁平 JSON）。
		 * @param draft 表单草稿（snapshotValueToDraft 形态）
		 * @param config 快照生效值（snapshot.config）
		 * @param opts.secretDraft 密码框输入（'' = 不修改 accessToken）
		 * @param opts.clearSecret true = 显式下发 accessToken: ''（host 语义：'' = 清空）
		 * @returns {patch, invalidKeys} 与生效值有差异的键集合；invalidKeys 为未通过
		 *          客户端数字校验的键（host validatePatch 仍会二次校验）。
		 */
		function computePatch(draft: any, config: any, opts: any) {
			var options = opts == null ? {} : opts;
			var config_ = config == null ? {} : config;
			var patch: any = {};
			var invalidKeys = [];
			for (var field of ALL_FIELDS) {
				if (field.type === "secret") continue; // accessToken 走 secretDraft/clearSecret 专用通道
				var next = coerceValue(field, draft[field.key]);
				if (field.type === "number" && Number.isNaN(next)) {
					invalidKeys.push(field.key);
					continue;
				}
				if (!valueEquals(next, config_[field.key])) patch[field.key] = next;
			}
			// T8：notices 通知开关——上游一个键都不过面板，这里补上。
			var noticesCfg = config_.notices != null && typeof config_.notices === "object" ? config_.notices : {} as any;
			var noticesPatch: any = {};
			var noticesDirty = false;
			for (var nk of NOTICE_KEYS) {
				var nState = draft["notices." + nk.key];
				if (nState == null) continue;
				var nNext = draftToNotice(nState, nk.def);
				var nCur = noticeToDraft(noticesCfg[nk.key], nk.def);
				if (!valueEquals(nNext, draftToNotice(nCur, nk.def)) && nNext !== (noticesCfg[nk.key] === undefined ? true : noticesCfg[nk.key])) {
					noticesPatch[nk.key] = nNext;
					noticesDirty = true;
				}
			}
			if (noticesDirty) patch.notices = Object.assign({}, noticesCfg, noticesPatch);
			var secretDraft = options.secretDraft;
			if (options.clearSecret === true) patch.accessToken = ""; // host 语义：'' = 清空
			else if (typeof secretDraft === "string" && secretDraft !== "") patch.accessToken = secretDraft;
			// secretDraft 为空且未勾选清除 → 不含 accessToken 键 = 不修改（host 缺省语义）
			return { patch: patch, invalidKeys: invalidKeys };
		}

		/**
		 * 批 3（UX §5.6）：数字键行内校验合法范围——逐字抄自 host NUMBER_RANGE
		 * （src/settings-remote.ts L204-218；前端字面量副本，host 常量不改）。
		 * port 1–65535，时长/频控类 ≥0（max undefined = 无上限）。
		 */
		var NUMBER_RANGE: any = {
			port: [1, 65535],
			interimRecallMs: [0, undefined],
			rateLimitPerMinute: [0, undefined],
			deferredTimeoutMs: [0, undefined],
			inboxQueueDelayMs: [0, undefined],
			textImageThreshold: [0, undefined],
			// 本地加（2026-11-01）：媒体上限都做防呆——多打一位数当场标红。
			// 键序与 ALL_FIELDS（媒体组字段序）一致，便于测试逐位对齐。
			outboundImageMaxBytes: [1, 104857600],
			maxVoiceBytes: [1, 52428800],
			maxFileBytes: [1, 4294967296],
			inboundImageMaxPx: [0, undefined],
			inboundFileMaxBytes: [0, undefined],
		};

		/**
		 * 批 3（UX §5.6）：数字行内校验——判定语义与 host validatePatch 逐字对齐
		 * （src/settings-remote.ts L351-353：Number.isFinite && >= min &&
		 * (max === undefined || <= max)）。'' 经 Number('')=0 入范围判定（与
		 * computePatch→coerceValue 同口径）；非数字文本（NaN）同样判非法。
		 * @returns null = 合法；string = 合法范围文案（"1–65535"/"≥0"），供
		 *          format(t("field.numberInvalid"), { range }) 组装行内红字。
		 */
		function numberRangeInvalid(field: any, raw: any) {
			if (field == null || field.type !== "number") return null;
			var range = Object.prototype.hasOwnProperty.call(NUMBER_RANGE, field.key) && Array.isArray(NUMBER_RANGE[field.key])
				? NUMBER_RANGE[field.key]
				: [0, undefined];
			var n = coerceValue(field, raw);
			if (Number.isFinite(n) && n >= range[0] && (range[1] === undefined || n <= range[1])) return null;
			return range[1] === undefined ? "≥" + range[0] : range[0] + "–" + range[1];
		}

		/**
		 * 批 3（UX §5.4）：冲突合并保留——保存遇 revision 冲突重拉快照后，不再
		 * 全量重建草稿（旧路径静默丢弃全部未保存编辑），改为逐键比较新旧快照值
		 *（旧 = 发起保存时 snapshot.config，新 = refetch 结果，复用 valueEquals）：
		 *   - 新旧快照值一致的键：保留草稿编辑（大概率可原样重提）；
		 *   - 新旧快照值不一致的键：跟随新快照（草稿按新值重写为展示形态）；其中
		 *     本地也改过的键记入 conflictKeys（本地编辑被丢弃，调用方行内橙标
		 *     「已被其他来源修改，已同步为最新值」）；
		 *   - 密文例外：secret 键不参与合并（脱敏值无法比对）——草稿恒 ''，明文
		 *     通道（secretDraft/clearSecret）由调用方一律清空并提示。
		 * 纯函数：不改任何入参。脏判定与 computePatch 同口径（coerceValue 后比较，
		 * 未编辑键不计脏）。
		 * @param draft 冲突前的表单草稿（snapshotValueToDraft 展示形态）
		 * @param oldCfg 发起保存时的 snapshot.config
		 * @param nextCfg 冲突重拉的新 snapshot.config
		 * @returns {draft, conflictKeys, keptCount} keptCount = 脏键数（draft 与
		 *          oldCfg 有差异的非 secret 键）− conflictKeys.length，即 UX §5.4
		 *          「已保留 N 项未冲突的修改」的 N；全部脏键被外部修改时为 0
		 *         （调用方退化为现状提示——此时 draft 与全量重建结果同值）。
		 */
		function mergeOnConflict(draft: any, oldCfg: any, nextCfg: any) {
			var sourceDraft = draft == null ? {} : draft;
			var oldConfig = oldCfg == null ? {} : oldCfg;
			var nextConfig = nextCfg == null ? {} : nextCfg;
			var merged: any = {};
			var conflictKeys = [];
			var dirtyCount = 0;
			for (var field of ALL_FIELDS) {
				if (field.type === "secret") {
					merged[field.key] = ""; // 密文例外（UX §5.4）：明文通道由调用方清空
					continue;
				}
				var remoteChanged = !valueEquals(oldConfig[field.key], nextConfig[field.key]);
				var dirty = Object.prototype.hasOwnProperty.call(sourceDraft, field.key)
					&& !valueEquals(coerceValue(field, sourceDraft[field.key]), oldConfig[field.key]);
				if (dirty) dirtyCount += 1;
				if (remoteChanged) {
					merged[field.key] = snapshotValueToDraft(field, nextConfig[field.key]);
					if (dirty) conflictKeys.push(field.key);
				} else {
					// 远端未变：保留草稿（含未编辑键——缺键防御经 snapshotValueToDraft
					// 重写为展示形态，与 draftFromSnapshot 同构）
					merged[field.key] = Object.prototype.hasOwnProperty.call(sourceDraft, field.key)
						? sourceDraft[field.key]
						: snapshotValueToDraft(field, nextConfig[field.key]);
				}
			}
			return { draft: merged, conflictKeys: conflictKeys, keptCount: dirtyCount - conflictKeys.length };
		}

		/**
		 * W7：把选中的 workspace path 填入草稿（「快速填入」的唯一写入口）。
		 * 纯函数、只返回新草稿对象——绝不触达 remote.updateSettings；保存仍走
		 * 「保存设置」显式通道（computePatch → updateSettings）。
		 */
		function fillWorkspacePath(draft: any, path: any, key: any) {
			var next = Object.assign({}, draft == null ? {} : draft);
			next[key === undefined || key === "" ? "workspacePath" : key] = String(path == null ? "" : path);
			return next;
		}

		/**
		 * 批 2（UX §5.1）：脏状态派生——与保存流共用同一 computePatch 口径，键集 =
		 * 与快照生效值有差异的键 + 密文通道（secretDraft 非空 / clearSecret）。纯
		 * 客户端计算，不依赖冲突合并（mergeOnConflict 为批 3 范围）；数字非法键不进
		 * patch 故不入 dirtyKeys（badNumber 反馈仍走 save() 通道）。
		 */
		function computeDirtyKeys(draft: any, config: any, opts: any) {
			return Object.keys(computePatch(draft, config, opts).patch);
		}

		/**
		 * 批 2（UX §3.2）：mode 联动变暗禁用——反向连接只走 url、正向只走 host/port。
		 * 禁用≠清空：值保留在草稿，computePatch 值比较语义不变（patch 仍按原值比较）。
		 */
		function deriveModeInactiveKeys(mode: any) {
			if (mode === "reverse") return ["url"];
			if (mode === "forward") return ["host", "port"];
			return [];
		}

		// 0.10.0：诊断组折叠记忆（展开态持久化读写）随折叠交互一并移除——诊断组
		// 自本版起为独立页签，组内折叠失去意义。

		/** 批 2（UX §4）：workspace 拉取失败后的重试冷却（10s 内不重复请求）。 */
		var WORKSPACE_RETRY_COOLDOWN_MS = 10000;
		//#endregion

		//#region 渲染（模块级可测的纯渲染函数：renderGroup 不依赖 hooks/副作用）
		function h(ReactImpl?: any, tag?: any, props?: any, ...children: any[]) {
			var children = Array.prototype.slice.call(arguments, 3);
			return ReactImpl.createElement.apply(ReactImpl, [tag, props].concat(children));
		}
		//#region 宿主 UI 原语回落 shim（旧宿主 seed 表缺席时使用；同 props 契约）
		// ui 组件契约（宿主 primitives 与本 shim、测试桩三方一致）：
		//   Switch({checked, onChange(next:boolean), label, disabled, title?})
		//   Checkbox({checked, onChange(next:boolean), label, disabled})
		//   Tag({tone:'neutral'|'quiet', children})            —— 徽标 pill
		//   Button({variant?:'ghost'|'primary', disabled?, onClick, title?, children})
		//   SegmentedControl({value, options:[{value,label}], onChange(value), label, disabled?})
		//   SegmentedTabs({items:[{value,label}], value, onChange(value), label})
		//   Input({type?, value, onChange(event), placeholder?, disabled?, 'aria-label'?, autoComplete?})
		function fallbackUi(ReactImpl: any) {
			var tag = function (props: any) {
				return h(ReactImpl, "span", {
					className: "obx-badge" + (props.tone === "neutral" ? " obx-badge--strong" : ""),
				}, props.children);
			};
			var button = function (props: any) {
				return h(ReactImpl, "button", {
					type: "button",
					className: "obx-btn" + (props.variant === "primary" ? " obx-btn--primary" : ""),
					disabled: props.disabled === true, title: props.title, onClick: props.onClick,
				}, props.children);
			};
			var switchControl = function (props: any) {
				var checked = props.checked === true;
				return h(ReactImpl, "button", {
					type: "button", role: "switch", "aria-checked": checked, "aria-label": props.label,
					title: props.title, disabled: props.disabled === true, className: "obx-switch",
					onClick: function () { props.onChange(!checked); },
				}, h(ReactImpl, "span", { className: "obx-switch-thumb" }));
			};
			var checkbox = function (props: any) {
				return h(ReactImpl, "label", { className: "obx-checkbox" },
					h(ReactImpl, "input", {
						type: "checkbox", checked: props.checked === true, disabled: props.disabled === true,
						onChange: function (event: any) { props.onChange(event.target.checked); },
					}), props.label);
			};
			var segmentedItem = function (props: any, role: any, option: any) {
				var active = option.value === props.value;
				return h(ReactImpl, "button", {
					key: option.value, type: "button", role: role, "aria-selected": active,
					className: "obx-segmented-tab" + (active ? " obx-segmented-tab--active" : ""),
					disabled: props.disabled === true,
					onClick: function () { if (!active) props.onChange(option.value); },
				}, option.label);
			};
			var segmentedControl = function (props: any) {
				return h(ReactImpl, "div", { className: "obx-segmented", role: "tablist", "aria-label": props.label },
					props.options.map(function (option: any) { return segmentedItem(props, "tab", option); }));
			};
			var segmentedTabs = function (props: any) {
				return h(ReactImpl, "div", { className: "obx-segmented obx-tabs", role: "tablist", "aria-label": props.label },
					props.items.map(function (item: any) { return segmentedItem(props, "tab", item); }));
			};
			var input = function (props: any) {
				var rest: any = Object.assign({}, props);
				delete rest.onChange;
				return h(ReactImpl, "input", Object.assign({}, rest, {
					className: "obx-input",
					onChange: function (event: any) { props.onChange(event); },
				}));
			};
			return { Switch: switchControl, Checkbox: checkbox, Tag: tag, Button: button, SegmentedControl: segmentedControl, SegmentedTabs: segmentedTabs, Input: input };
		}
		/**
		 * 面板统一 UI 组件表：宿主 primitives 在位时直用（组件 CSS 随宿主全局样式表
		 * 加载，明暗/主题跟随宿主）；seed 表缺席时用回落 shim（视觉走本文件 CSS）。
		 */
		var UI: any = hostPrimitives != null
			? {
				Switch: hostPrimitives.Switch,
				Checkbox: hostPrimitives.Checkbox,
				Tag: hostPrimitives.Tag,
				Button: hostPrimitives.Button,
				SegmentedControl: hostPrimitives.SegmentedControl,
				SegmentedTabs: hostPrimitives.SegmentedTabs,
				Input: hostPrimitives.Input,
			}
			: fallbackUi(React);
		//#endregion
		/**
		 * 渲染一个设置分组（纯函数；值全部经 snapshotValueToDraft 脱敏形态传入，
		 * accessToken 明文按契约绝不进入本函数——host 快照侧已脱敏为 ''）。
		 * 0.10.0：控件经 opts.ui 依赖注入（宿主 primitives / 回落 shim / 测试桩，
		 * 契约见 fallbackUi 上方注释）；字段行 = 平铺文档流 + 发丝分隔（原生表单形态）：
		 * 值/枚举/多行为纵向行（label 上、控件下、hint 下），布尔/通知为左右行
		 * （label 左、Switch 右）。
		 * @param opts.ui 组件表（必传；面板注入 UI，测试注入桩）
		 * @param opts.onChange (field, nextDisplayValue) => void
		 * @param opts.onSecretChange (nextText) => void
		 * @param opts.onClearSecretChange (nextBoolean) => void
		 * @param opts.secretSet boolean（快照 secrets 标记：明文是否已配置）
		 * @param opts.clearSecret boolean（清除勾选态）
		 * @param opts.nonDefaultKeys 与 schema 默认值不同的键数组（W6「非默认」徽标；
		 *        以快照生效值为准而非草稿——徽标描述已保存状态，不是未保存编辑）
		 * @param opts.draft 表单草稿（snapshotValueToDraft 形态）
		 * @param opts.groupDesc 组描述文案（缺省不渲染描述行）
		 * @param opts.modeInactiveKeys 当前连接模式下不生效的键（命中字段禁用变暗 +
		 *        hint 追加「当前模式不生效」；值保留不清空）
		 * @param opts.texts 交互文案（locale 第二档经面板传入；缺省回退 zh 字面量，
		 *        模块级可测行为不变）：modeInactive/secretSet/secretUnset/
		 *        secretClearPending/secretClearHint/secretClear/remoteOverwritten
		 * @param opts.invalidNumbers 数字行内校验标红：map key → 已本地化提示文案；
		 *        命中字段控件容器挂 obx-control--narrow（number）并经 hint 行内嵌红字
		 *        （.obx-hint--invalid）；校验时机 = 面板 onChange 每次数字编辑（原 blur
		 *        校验随旧布局移除，改即时校验）
		 * @param opts.remoteOverwrittenKeys 冲突合并被远端覆盖的键：命中字段 hint 行内
		 *        嵌橙标「已被其他来源修改，已同步为最新值」
		 * @param opts.renderExtraRow (field) => 节点|null——字段行后追加组内附加行
		 *        （connection 组 workspacePath 下方的「快速填入 workspace」行由此注入）
		 */
		function renderGroup(ReactImpl: any, group: any, opts: any) {
			var options = opts == null ? {} : opts;
			var ui = options.ui;
			var draft = options.draft == null ? {} : options.draft;
			var nonDefaultKeys = Array.isArray(options.nonDefaultKeys) ? options.nonDefaultKeys : [];
			var modeInactiveKeys = Array.isArray(options.modeInactiveKeys) ? options.modeInactiveKeys : [];
			var invalidNumbers = options.invalidNumbers != null ? options.invalidNumbers : {};
			var remoteOverwrittenKeys = Array.isArray(options.remoteOverwrittenKeys) ? options.remoteOverwrittenKeys : [];
			var groupDesc = options.groupDesc != null ? options.groupDesc : null;
			var texts = options.texts != null ? options.texts : {};
			var modeInactiveText = texts.modeInactive != null ? texts.modeInactive : "当前模式不生效";
			var secretSetText = texts.secretSet != null ? texts.secretSet : "已配置（脱敏，不回显）";
			var secretUnsetText = texts.secretUnset != null ? texts.secretUnset : "未配置";
			var secretClearPendingText = texts.secretClearPending != null ? texts.secretClearPending : "保存后清空";
			var secretClearHintText = texts.secretClearHint != null ? texts.secretClearHint : "将清除已保存的值";
			var secretClearLabelText = texts.secretClear != null ? texts.secretClear : "清除已保存的 AccessToken";
			var remoteOverwrittenText = texts.remoteOverwritten != null ? texts.remoteOverwritten : "已被其他来源修改，已同步为最新值";
			var onChange = typeof options.onChange === "function" ? options.onChange : function () {};
			var onSecretChange = typeof options.onSecretChange === "function" ? options.onSecretChange : function () {};
			var onClearSecretChange = typeof options.onClearSecretChange === "function" ? options.onClearSecretChange : function () {};
			// 0.10.0 字段文案词条化：t 经 opts 注入（面板传 ctx.locale.bind 的 t；测试传
			// LOCALE_ZH 解析桩）。回退值 = GROUPS/NOTICE_KEYS 内联 zh 常量（纯函数无 t 仍可测）。
			var tr = function (key: any, fallback: any) {
				return typeof options.t === "function" ? options.t(key) : fallback;
			};
			// hint 行组装：字段 hint（12px tertiary）+ mode 联动/冲突覆盖（warn 色）+
			// 数字校验（error 色）内嵌彩色片段——同一行文案，不再有「短提示内联标题右侧」
			// 与容器查询网格的布局分支（0.10.0 统一为 label 上/hint 下的纵向结构）。
			var warnSpan = function (text: any) {
				return h(ReactImpl, "span", { className: "obx-hint--warn" }, text);
			};
			var invalidSpan = function (text: any) {
				return h(ReactImpl, "span", { className: "obx-hint--invalid" }, text);
			};
			// W6「非默认」徽标：快照生效值 ≠ schema 默认值的键一律挂标（title=与默认值
			// 不同；title 挂在 children span 上——宿主 Tag 不透传多余 props）。
			var nonDefaultBadge = function (fieldKey: any) {
				if (nonDefaultKeys.indexOf(fieldKey) < 0) return null;
				return h(ReactImpl, ui.Tag, { tone: "neutral", children: h(ReactImpl, "span", { title: tr("field.nonDefaultTitle", "与默认值不同") }, tr("field.nonDefault", "非默认")) });
			};
			// 字段 label/hint/占位符经词条解析（zh 源 = GROUPS 内联常量自动灌入的词典）。
			var fieldLabelOf = function (field: any) {
				return tr("field." + field.key + ".label", field.label);
			};
			var fieldHintOf = function (field: any) {
				var hintKey = "field." + field.key + ".hint";
				return zh[hintKey] != null ? tr(hintKey, field.hint) : null;
			};
			var fieldPlaceholderOf = function (field: any) {
				var placeholderKey = "field." + field.key + ".placeholder";
				if (zh[placeholderKey] != null) return tr(placeholderKey, field.placeholder);
				// stringArray 无显式占位符时用共享默认句（分割方式说明）
				if (field.type === "stringArray") return tr("field.stringArray.placeholder.default", "分割方式：逗号、顿号、换行");
				return undefined;
			};
			var fieldNodes = group.fields.map(function (field: any) {
				// 本地加（11.1）：showIf 条件不满足就整行不渲染（索引保持对齐，按 key 取节点仍有效）。
				if (field.showIf && draft[field.showIf.key] !== field.showIf.value)
					return null;
				var value = draft[field.key];
				// 批 2（UX §3.2）：mode 联动——非当前模式的连接字段禁用变暗（值保留在
				// 草稿，computePatch 值比较语义不变；hint 行追加「当前模式不生效」）。
				var fieldInactive = modeInactiveKeys.indexOf(field.key) >= 0;
				// 批 3（UX §5.4/§5.6）：冲突橙标命中 + 数字行内校验标红命中。
				var overwritten = remoteOverwrittenKeys.indexOf(field.key) >= 0;
				var fieldInvalidMessage = field.type === "number" && invalidNumbers[field.key] != null
					? String(invalidNumbers[field.key])
					: null;
				var disabled = options.disabled === true || fieldInactive;
				var fieldLabel = fieldLabelOf(field);
				var hintText = fieldHintOf(field);
				var hintChildren = [];
				if (hintText != null && String(hintText).trim() !== "") hintChildren.push(hintText);
				if (fieldInactive) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(warnSpan(modeInactiveText));
				}
				if (overwritten) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(warnSpan(remoteOverwrittenText));
				}
				if (fieldInvalidMessage != null) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(invalidSpan(fieldInvalidMessage));
				}
				var hintNode = hintChildren.length > 0
					? h.apply(null, [ReactImpl, "p", { className: "obx-hint" }].concat(hintChildren))
					: null;
				var badge = nonDefaultBadge(field.key);
				var headNode = h(ReactImpl, "div", { className: "obx-field-head" },
					h(ReactImpl, "span", { className: "obx-label" }, fieldLabel), badge);
				// 布尔行：说明在左（label + hint 纵排）、原生 Switch 在右——DSH 设置页同款
				//（不再整行可点：开关本身即命中区，与宿主原生行为一致）。
				if (field.type === "boolean") {
					return h(ReactImpl, "div", { className: "obx-field obx-field--row", key: field.key },
						h(ReactImpl, "div", { className: "obx-field-text" }, headNode, hintNode),
						h(ReactImpl, ui.Switch, {
							checked: value === true,
							onChange: function (next: any) { onChange(field, next === true); },
							label: fieldLabel, disabled: disabled,
						}));
				}
				var control: any;
				if (field.type === "enum") {
					// 0.10.0：下拉改原生 SegmentedControl——全部 9 个枚举 ≤4 档，分段控件
					// 一屏可读，且即宿主原生选择控件（连接模式/策略档位同款）。档位文案走词条。
					control = h(ReactImpl, ui.SegmentedControl, {
						value: String(value == null ? "" : value),
						options: field.options.map(function (option: any) {
							var fallbackLabel = field.optionLabels[option] != null ? field.optionLabels[option] : option;
							return { value: option, label: tr("field." + field.key + ".option." + option, fallbackLabel) };
						}),
						onChange: function (next: any) { onChange(field, next); },
						label: fieldLabel, disabled: disabled,
					});
				} else if (field.type === "stringArray") {
					control = h(ReactImpl, "div", { className: "obx-control" },
						h(ReactImpl, "textarea", {
							className: "obx-textarea", rows: 2, value: String(value == null ? "" : value), disabled: disabled,
							placeholder: fieldPlaceholderOf(field),
							onChange: function (event: any) { onChange(field, event.target.value); },
							"aria-label": fieldLabel,
						}));
				} else if (field.type === "secret") {
					// 密码型输入且不明文回显：value 恒为用户本次输入（初始 ''）；
					// 状态徽标三态：已配置（neutral）/ 未配置（quiet）/ 保存后清空（neutral，
					// 仅「确有已保存值 + 勾选清除」时——secretSet:false + 勾清除仍显「未配置」，
					// 保持既有渲染契约）；清除勾选行独立在输入行下方，互斥由面板 onSecretChange
					// 实现（输入新值即取消清除勾选）。
					var clearActive = options.clearSecret === true;
					var secretStateText = clearActive && options.secretSet === true ? secretClearPendingText
						: options.secretSet === true ? secretSetText : secretUnsetText;
					var secretHintChildren = [
						tr("field.accessToken.securityHint", "出于安全实际令牌不回传页面，只显占位圆点，输入新值即替换（令牌：NapCat 的 WebUI → 网络配置→Token）"),
					];
					if (clearActive) secretHintChildren.push(warnSpan(secretClearHintText));
					return [
						h(ReactImpl, "div", { className: "obx-field", key: field.key },
							h(ReactImpl, "div", { className: "obx-field-head" },
								h(ReactImpl, "span", { className: "obx-label" }, fieldLabel),
								h(ReactImpl, ui.Tag, { tone: options.secretSet === true ? "neutral" : "quiet", children: secretStateText })),
							h(ReactImpl, "div", { className: "obx-control" },
								h(ReactImpl, ui.Input, {
									type: "password", autoComplete: "new-password",
									value: String(value == null ? "" : value), disabled: disabled,
									placeholder: (options.secretSet === true && !clearActive) ? "••••••••••••••••" : tr("secret.placeholder", "留空 = 不修改"),
									"aria-label": fieldLabel,
									onChange: function (event: any) { onSecretChange(event.target.value); },
								})),
							h.apply(null, [ReactImpl, "p", { className: "obx-hint" }].concat(secretHintChildren))),
						h(ReactImpl, "div", { className: "obx-secret-row", key: field.key + "-clear" },
							h(ReactImpl, ui.Checkbox, {
								checked: clearActive, disabled: disabled, label: secretClearLabelText,
								onChange: function (next: any) { onClearSecretChange(next === true); },
							})),
					];
				} else {
					// string/number：原生 Input；number 经窄容器收窄（原 obx-input--number
					// 的 160px 口径移到容器上，宿主 Input 的 className 落在 wrap 上不落 input）。
					control = h(ReactImpl, "div", { className: field.type === "number" ? "obx-control--narrow" : "obx-control" },
						h(ReactImpl, ui.Input, {
							type: "text",
							value: String(value == null ? "" : value), disabled: disabled,
							placeholder: fieldPlaceholderOf(field),
							onChange: function (event: any) { onChange(field, event.target.value); },
							"aria-invalid": fieldInvalidMessage != null ? true : undefined,
							"aria-label": fieldLabel,
						}));
				}
				var nodes = [
					h(ReactImpl, "div", { className: "obx-field", key: field.key }, headNode, control, hintNode),
				];
				// W7：可选扩展点——字段行后追加组内附加行（connection 组 workspacePath
				// 下方的「快速填入 workspace」行由此注入；独立 class 不计入 obx-field 行数）。
				if (typeof options.renderExtraRow === "function") {
					var extra = options.renderExtraRow(field);
					if (extra != null) nodes.push(extra);
				}
				return nodes;
			});
			// T8：notices 通知开关——每条一行开关 + 一个文案框（开关关着就不显示）。
			// 文案框默认显示上游原文；改成别的就发改后的那句；改回原文等于跟随默认。
			var renderNoticeRows = function (group: any) {
				if (group.id !== "behavior" && group.id !== "session") return [];
				var rows: any[] = [];
				// T8：回答回执/超时补发/限流恒显；排队/插话两条按「任务运行中的新消息」
				// 当前档位只显示对应那一条——选了插话就只留插话提示，排队提示那条
				// 压根不生效，别摆那儿误导。
				var policy = draft["newMessagePolicy"];
				var wanted = NOTICE_KEYS.filter(function (nk) {
					if (group.id !== "behavior") return false;
					if (nk.key === "queue") return policy === "queue";
					if (nk.key === "steerAccepted") return policy !== "queue";
					return true;
				});
				// 用 forEach 而不是 for-of：var 在循环里只有一个变量，回调全指到最后一项，
				// 点「排队提示」会改成「插话提示」——串味的根儿在这儿。
				wanted.forEach(function (nk) {
					var nState = draft["notices." + nk.key] || { on: true, text: nk.def };
					var nOn = nState.on === true;
					var notifyKey = "notices." + nk.key;
					var defText = nk.def;
					var noticeLabel = tr("notice." + nk.key + ".label", nk.label);
					var setNoticeState = function (patchObj: any) {
						if (typeof options.onNoticeChange !== "function") return;
						options.onNoticeChange(notifyKey, function (cur: any) {
							var base = cur != null && typeof cur === "object" ? cur : { on: true, text: defText };
							return Object.assign({}, base, patchObj);
						});
					};
					var rowNodes = [
						h(ReactImpl, "div", { className: "obx-field obx-field--row", key: "nt-" + nk.key },
							h(ReactImpl, "div", { className: "obx-field-text" },
								h(ReactImpl, "div", { className: "obx-field-head" },
									h(ReactImpl, "span", { className: "obx-label" }, noticeLabel))),
							h(ReactImpl, ui.Switch, {
								checked: nOn, label: noticeLabel, disabled: options.disabled === true,
								onChange: function () { if (options.disabled !== true) setNoticeState({ on: !nOn }); },
							})),
					];
					if (nOn) {
						rowNodes.push(h(ReactImpl, "div", { className: "obx-field", key: "ntx-" + nk.key },
							h(ReactImpl, "textarea", {
								className: "obx-textarea", rows: 2,
								value: String(nState.text == null ? "" : nState.text),
								disabled: options.disabled === true,
								placeholder: nk.def,
								onChange: function (event: any) { setNoticeState({ text: event.target.value }); },
								"aria-label": format(tr("notice.textAria", "{label}文案"), { label: noticeLabel }),
							})));
					}
					rows = rows.concat(rowNodes);
				});
				return rows;
			};
			fieldNodes = fieldNodes.concat(renderNoticeRows(group));
			// 本地加：组内分区（如权限的私聊/群聊）——按 keys 顺序取已渲染的字段节点，
			// 每块前面插一个小标题（标题走词条，zh 源 = GROUPS.sections.title 自动灌入）。
			if (Array.isArray(group.sections) && group.sections.length > 0) {
				var byKey: any = {};
				group.fields.forEach(function (field: any, index: any) { byKey[field.key] = fieldNodes[index]; });
				var sectioned = [];
				for (var section of group.sections) {
					sectioned.push(h(ReactImpl, "h4", { className: "obx-subgroup-title", key: "sec-" + section.id },
						tr("group." + group.id + ".section." + section.id, section.title)));
					for (var sectionKey of section.keys) {
						if (byKey[sectionKey] != null) sectioned.push(byKey[sectionKey]);
					}
				}
				fieldNodes = sectioned;
			}
			// 组标题 + 一句人话描述（经 opts.groupDesc 传入；缺省不渲染）。标题走词条
			//（zh 源 = GROUPS.title 自动灌入）。
			var sectionChildren = [h(ReactImpl, "div", { className: "obx-group-head" },
				h(ReactImpl, "h3", { className: "obx-group-title" }, tr("group." + group.id + ".title", group.title)),
				groupDesc != null ? h(ReactImpl, "span", { className: "obx-group-desc" }, groupDesc) : null)];
			return h.apply(null, [ReactImpl, "section", { className: "obx-group", "data-group": group.id }]
				.concat(sectionChildren, [fieldNodes]));
		}
		//#endregion

		/**
		 * W7：渲染 workspacePath 字段下方的「快速填入 workspace」行（纯函数）。
		 * 数据来自面板打开时对 remote.listWorkspaces() 的一次现拉（不缓存陈旧列表）。
		 * 三态：
		 *   - loaded !== true（拉取中/未拉取）→ 不渲染；
		 *   - available !== true 或列表为空 → 隐藏下拉与按钮，仅渲染一行说明
		 *     （可直接输入路径，不阻塞手输）；
		 *   - 正常 → select（选项 = path（N 会话），value = id，避免同名 path 冲突）
		 *     + 「填入」按钮：仅把选中 path 写进输入框当前值（onApply → fillWorkspacePath），
		 *     不自动保存。
		 * @param opts.workspaces host listWorkspaces().workspaces
		 * @param opts.available host listWorkspaces().available
		 * @param opts.loaded 面板打开后拉取是否已完成
		 * @param opts.selectedId 当前选中的 workspace id（'' = 未选）
		 * @param opts.onApply (path: string) => void（填入回调；本函数绝不调用保存）
		 * @param opts.fetchFailed true = 本次拉取失败（批 2 UX §4：与「宿主未提供注册表」
		 *        降级态文案区分，并提供重试入口）
		 * @param opts.retryBlocked true = 失败后 10s 冷却内，重试入口禁用（不重复请求）
		 * @param opts.onRetry 重试回调（面板侧重跑 listWorkspaces 拉取，不新增请求方法）
		 * @param opts.fetchFailedText / opts.retryText 文案（locale 第二档；缺省回退 zh）
		 */
		function renderWorkspacePicker(ReactImpl: any, opts: any) {
			var options = opts == null ? {} : opts;
			var ui = options.ui;
			// 0.10.0：文案走词条（t 经 opts 注入；回退 = 内联 zh 常量，纯函数可测不变）。
			var tr = function (key: any, fallback: any) {
				return typeof options.t === "function" ? options.t(key) : fallback;
			};
			if (options.loaded !== true) return null;
			var workspaces = Array.isArray(options.workspaces) ? options.workspaces : [];
			if (options.available !== true || workspaces.length === 0) {
				// 批 2（UX §4）：失败态（fetchFailed=true）与宿主未提供注册表（available=false）
				// 文案区分；失败态追加重试入口，10s 冷却内禁用。既有降级态结构不变
				//（无 select/button，可直接输入路径）。
				if (options.fetchFailed === true) {
					return h(ReactImpl, "p", { className: "obx-hint obx-workspace-empty" },
						typeof options.fetchFailedText === "string" ? options.fetchFailedText : "本次拉取 workspace 列表失败，可直接输入路径。",
						h(ReactImpl, "button", {
							className: "obx-link-btn", type: "button", disabled: options.retryBlocked === true,
							onClick: function () {
								var onRetry = options.onRetry;
								if (typeof onRetry === "function") onRetry();
							},
						}, typeof options.retryText === "string" ? options.retryText : "重试"));
				}
				return h(ReactImpl, "p", { className: "obx-hint obx-workspace-empty" },
					options.available === true
						? tr("workspace.emptyAvailable", "暂无 workspace 记录，可直接输入路径。")
						: tr("workspace.emptyUnavailable", "无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。"));
			}
			var selectedId = typeof options.selectedId === "string" ? options.selectedId : "";
			var selected: any = null;
			for (var workspace of workspaces) {
				if (workspace != null && String(workspace.id) === selectedId) selected = workspace;
			}
			var disabled = options.disabled === true;
			var pickLabel = tr("workspace.pick", "快速填入 workspace");
			return h(ReactImpl, "div", { className: "obx-workspace-row", "data-role": "workspace-picker" },
				h(ReactImpl, "span", { className: "obx-label" }, pickLabel),
				h(ReactImpl, "select", {
					className: "obx-select", value: selectedId, disabled: disabled,
					"aria-label": pickLabel,
					title: tr("workspace.pickTitle", "列出宿主 workspace 注册表中的工作区；选中后点「填入」写入上方路径输入框（只填值，保存仍走「保存设置」按钮）"),
					onChange: function (event: any) {
						var onSelectedChange = options.onSelectedChange;
						if (typeof onSelectedChange === "function") onSelectedChange(event.target.value);
					},
				},
					h(ReactImpl, "option", { key: "", value: "" }, tr("workspace.pickPlaceholder", "选择 workspace…")),
					workspaces.map(function (workspace: any) {
						var label = String(workspace.path == null ? "" : workspace.path) + "（" + String(workspace.sessionCount == null ? 0 : workspace.sessionCount) + " 会话）";
						return h(ReactImpl, "option", { key: String(workspace.id), value: String(workspace.id) }, label);
					})),
				h(ReactImpl, ui.Button, {
					disabled: disabled || selected == null,
					onClick: function () {
						var onApply = options.onApply;
						if (selected != null && typeof onApply === "function") onApply(selected.path);
					},
				}, tr("workspace.apply", "填入")),
				h(ReactImpl, "span", { className: "obx-hint" }, tr("workspace.pickHint", "选中后点「填入」仅写入上方输入框；需点「保存设置」才会保存（对新会话生效，已设 /workspace 覆盖的会话不受影响）。")));
		}

		//#region 面板组件
		/**
		 * QQ Bot 设置面板。
		 * @param props t 为宿主注入的翻译函数（locale: NS，语言切换自动重渲染）；
		 *        remote 为挂载后的 `remote.onebotSettings` API。
		 */
		function OnebotSettingsPanel(props: any) {
			var t = props.t;
			var remote = props.remote;
			var snapshotState = React.useState(null);
			var snapshot = snapshotState[0];
			var setSnapshot = snapshotState[1];
			var draftState = React.useState(null);
			var draft = draftState[0];
			var setDraft = draftState[1];
			var secretState = React.useState("");
			var secretDraft = secretState[0];
			var setSecretDraft = secretState[1];
			var clearSecretState = React.useState(false);
			var clearSecret = clearSecretState[0];
			var setClearSecret = clearSecretState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var noticeState = React.useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			// 本地加：整页版按「分节」显示，一次只渲染当前节。
			var activeTabState = React.useState(GROUPS[0].id);
			var activeTab = activeTabState[0];
			var setActiveTab = activeTabState[1];
			// 批 3（UX §5.6）：数字行内校验标红态——map key → 合法范围文案（"1–65535"/
			// "≥0"）；number 键 blur 记入、输入修正自动消除，accept()/reset 全量重建清空。
			var invalidNumbersState = React.useState({});
			var invalidNumbers = invalidNumbersState[0];
			var setInvalidNumbers = invalidNumbersState[1];
			// 批 3（UX §5.4）：冲突合并结果态——被远端覆盖的键（行内橙标）+ 显式冲突
			// 横幅标记（替换批 1 的文案恒等派生；refetchMerged 置位，其余错误路径复位）。
			var conflictKeysState = React.useState([]);
			var conflictKeys = conflictKeysState[0];
			var setConflictKeys = conflictKeysState[1];
			var conflictActiveState = React.useState(false);
			var conflictActive = conflictActiveState[0];
			var setConflictActive = conflictActiveState[1];
			// W7：「快速填入 workspace」数据态——面板打开时（挂载 effect）对
			// remote.listWorkspaces() 现拉一次，不缓存跨会话的陈旧列表。
			var workspaceState = React.useState({ loaded: false, available: false, workspaces: [], selectedId: "" });
			var workspace = workspaceState[0];
			var setWorkspace = workspaceState[1];
			// 批 2（UX §4）：重试冷却计时器 + 卸载哨兵——计时器/在途 Promise 不在卸载
			// 之后写 state（沿用本面板 alive 守卫纪律）。
			var workspaceRetryTimerRef = React.useRef(null);
			var workspaceMountedRef = React.useRef(true);
			React.useEffect(function () {
				workspaceMountedRef.current = true;
				return function () {
					workspaceMountedRef.current = false;
					if (workspaceRetryTimerRef.current != null) {
						clearTimeout(workspaceRetryTimerRef.current);
						workspaceRetryTimerRef.current = null;
					}
				};
			}, []);

			// 0.10.0：诊断组折叠态（sessionStorage 记忆）随折叠交互移除——诊断组为
			// 独立页签，组内折叠失去意义（常量与工具区注释同步）。

			// 本地加：保存/报错提示改成顶部浮窗，5 秒后自动消失。
			React.useEffect(function () {
				if (error === null && notice === "") return undefined;
				var toastTimer = setTimeout(function () {
					setError(null);
					setNotice("");
				}, 5000);
				return function () { clearTimeout(toastTimer); };
			}, [error, notice]);

			// T8：notices 通知开关的草稿写在 "notices.<key>" 名下，
			// 这一层在写回时顺手接住带点的键（值就是整个 {on, text} 对象）。
			var applyDraftChange = function (field: any, value: any) {
				var key = field != null && field.key != null ? String(field.key) : "";
				if (key.indexOf("notices.") === 0) {
					setDraft(function (prev: any) {
						var copy = Object.assign({}, prev);
						copy[key] = value;
						return copy;
					});
					return true;
				}
				return false;
			};

			/** 接受新快照：草稿按快照重置（accessToken 明文绝不进入草稿）。 */
			var accept = function (next: any) {
				setSnapshot(next);
				setDraft(draftFromSnapshot(next));
				// 批 3（UX §5.6）：全量重建后草稿均为快照展示形态（合法值），清除行内标红；
				// 冲突横幅/橙标一并复位（本函数即「回到与快照一致」的统一入口）。
				setInvalidNumbers({});
				setConflictKeys([]);
				setConflictActive(false);
			};

			React.useEffect(function () {
				var alive = true;
				void remote.getSettings().then(function (result: any) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause: any) {
					if (alive) setError(messageOf(cause));
				});
				// W7：辅助查询独立拉取（挂载与「重试」共用 fetchWorkspaces，见下）——
				// 失败降级为 fetch-failed 提示行 + 重试入口，绝不阻塞/污染 getSettings
				// 主链路与错误横幅。
				fetchWorkspaces();
				return function () { alive = false; };
			}, [remote]);

			/** 批 2（UX §4）：workspace 列表现拉（挂载与「重试」唯一入口，不缓存陈旧列表）。 */
			var fetchWorkspaces = function () {
				void Promise.resolve().then(function () {
					return remote.listWorkspaces();
				}).then(function (result) {
					if (workspaceMountedRef.current !== true) return;
					var value = unwrap(result);
					if (workspaceRetryTimerRef.current != null) {
						clearTimeout(workspaceRetryTimerRef.current);
						workspaceRetryTimerRef.current = null;
					}
					setWorkspace({
						loaded: true,
						available: value != null && value.available === true,
						workspaces: value != null && Array.isArray(value.workspaces) ? value.workspaces : [],
						selectedId: "",
						fetchFailed: false,
						retryBlocked: false,
					});
				}).catch(function () {
					// 失败态与「宿主未提供注册表」降级态区分（fetchFailed 标记）；重试
					// 入口在 10s 冷却内禁用（retryBlocked），防止失败风暴下重复请求。
					if (workspaceMountedRef.current !== true) return;
					setWorkspace({ loaded: true, available: false, workspaces: [], selectedId: "", fetchFailed: true, retryBlocked: true });
					if (workspaceRetryTimerRef.current != null) clearTimeout(workspaceRetryTimerRef.current);
					workspaceRetryTimerRef.current = setTimeout(function () {
						workspaceRetryTimerRef.current = null;
						if (workspaceMountedRef.current !== true) return;
						setWorkspace(function (previous: any) {
							return Object.assign({}, previous, { retryBlocked: false });
						});
					}, WORKSPACE_RETRY_COOLDOWN_MS);
				});
			};

			var refetch = function () {
				void remote.getSettings().then(function (result: any) {
					accept(unwrap(result));
					setError(null);
					setNotice("");
				}).catch(function (cause: any) {
					setConflictActive(false);
					setError(messageOf(cause));
				});
			};

			/**
			 * 批 3（UX §5.4）：冲突合并保留——保存遇 revision 冲突时重拉快照并逐键
			 * 合并（mergeOnConflict），不再全量重建丢弃未保存编辑：
			 *   - 远端未变的键保留草稿编辑；keptCount > 0 → 结果条在 conflict.title
			 *     后追加「已保留 N 项未冲突的修改，请核对后重新保存」；
			 *   - 远端已变的键跟随新快照，本地同改的键记入 conflictKeys 行内橙标；
			 *   - 密文例外：secretDraft/clearSecret 一律清空（脱敏值无法比对），
			 *     确有明文输入时以 notice 提示「accessToken 输入已清空…」。
			 * revision 取新快照，用户核对后可直接重放保存；行内标红按合并结果修剪
			 *（跟随远端的键已合法，保留的本地编辑仍非法则继续标红）。
			 */
			var refetchMerged = function () {
				void remote.getSettings().then(function (result: any) {
					var next = unwrap(result);
					var merged = mergeOnConflict(draft, snapshot == null ? null : snapshot.config, next.config);
					setSnapshot(next);
					setDraft(merged.draft);
					setConflictKeys(merged.conflictKeys);
					setConflictActive(true);
					setInvalidNumbers(function (previous: any) {
						var pruned: any = {};
						Object.keys(previous).forEach(function (key) {
							var field = ALL_FIELDS.find(function (item) { return item.key === key; });
							if (field != null && numberRangeInvalid(field, merged.draft[key]) != null) pruned[key] = previous[key];
						});
						return pruned;
					});
					var hadSecretChannel = secretDraft !== "" || clearSecret === true;
					setSecretDraft("");
					setClearSecret(false);
					setError(merged.keptCount > 0
						? t("conflict.title") + format(t("conflict.kept"), { count: merged.keptCount })
						: t("conflict.title"));
					setNotice(hadSecretChannel ? t("conflict.secretCleared") : "");
				}).catch(function (cause: any) {
					setConflictActive(false);
					setError(messageOf(cause));
				});
			};

			/** 保存统一通道：updateSettings(patch, expectedRevision)；冲突时合并保留并重拉快照。 */
			var save = function () {
				if (busy || snapshot == null || draft == null) return;
				setError(null);
				setNotice("");
				setConflictActive(false); // 批 3：新一轮保存开始即撤销上一轮冲突横幅（若再次冲突由 refetchMerged 重新置位）
				var computed = computePatch(draft, snapshot.config, { secretDraft: secretDraft, clearSecret: clearSecret });
				if (computed.invalidKeys.length > 0) {
					var labels = computed.invalidKeys.map(function (key) {
						var field = ALL_FIELDS.find(function (item) { return item.key === key; });
						return field != null ? field.label : key;
					});
					setError(format(t("save.badNumber"), { keys: labels.join("、") }));
					return;
				}
				if (Object.keys(computed.patch).length === 0) {
					setNotice(t("save.noChanges"));
					return;
				}
				setBusy(true);
				void Promise.resolve().then(function () {
					return remote.updateSettings(computed.patch, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(t("save.done")); // 生效方式提示（T1 §5）：热生效、插件秒级重启、桥重连
					setClearSecret(false);
					setSecretDraft("");
				}).catch(function (cause) {
					if (isConflictError(cause)) {
						// 批 3（UX §5.4）：冲突合并保留——重拉快照后逐键合并，保留未冲突的
						// 本地编辑（不再全量重建丢弃）；结果条/行内橙标/密文清空见 refetchMerged。
						refetchMerged();
					} else {
						setError(messageOf(cause));
					}
				}).finally(function () {
					setBusy(false);
				});
			};

			// 批 2（UX §5.1）：脏状态渲染期派生——无新增 state，与保存流共用同一
			// computePatch 口径（draft vs 快照生效值 + secretDraft/clearSecret 密文通道）；
			// 批 3 冲突合并后草稿已随 mergeOnConflict 更新，本派生自动与新草稿一致
			//（合并保留的本地编辑仍计入 badge，跟随远端的键不再计入）；数字非法键不进
			// patch 故不入 dirtyKeys（badNumber 反馈仍走 save() 通道）。
			var dirtyKeys = snapshot === null || draft === null
				? []
				: computeDirtyKeys(draft, snapshot.config, { secretDraft: secretDraft, clearSecret: clearSecret });
			var dirtyCount = dirtyKeys.length;

			// 批 3（UX §5.6）：数字行内校验——0.10.0 起改为「每次编辑即时校验」（原
			// blur 校验随旧布局移除）：非法 → 合法范围文案记入标红，修正自动消除；
			// computePatch 的 NaN invalidKeys 拦截保留为 save() 内最后防线。
			var validateNumberField = function (field: any, rawText: any) {
				var range = numberRangeInvalid(field, rawText); // null = 合法；string = 合法范围文案
				setInvalidNumbers(function (previous: any) {
					if (range == null) {
						if (previous[field.key] == null) return previous;
						var cleared = Object.assign({}, previous);
						delete cleared[field.key];
						return cleared;
					}
					if (previous[field.key] === range) return previous;
					return Object.assign({}, previous, (function () { var marked: any = {}; marked[field.key] = range; return marked; })());
				});
			};

			// 批 2（UX §5.7）：有未保存修改时注册 beforeunload 离开防护（浏览器原生
			// 确认框，文案由浏览器决定、不可定制）。已知限制（UX 方案 A3/§10.3）：
			// beforeunload 只能拦截页面级离开/刷新；宿主 SPA 内路由切换时面板随路由
			// 卸载、页面本身不重载，原生不触发该事件，宿主亦未提供未保存更改离开守卫
			// 扩展点——如实不拦截，不做 history 劫持等过界方案。
			React.useEffect(function () {
				if (dirtyCount === 0) return undefined;
				var handler = function (event: any) {
					event.preventDefault();
					event.returnValue = ""; // Chrome/Edge 需显式 returnValue 才弹原生确认
					return "";
				};
				window.addEventListener("beforeunload", handler);
				return function () { window.removeEventListener("beforeunload", handler); };
			}, [dirtyCount > 0]);

			if (snapshot === null || draft === null) {
				// 批 2（UX §7）：加载失败停留当前面板——错误行 + 重试按钮走既有
				// refetch（不新增请求方法）；成功后快照落位回到完整面板。
				return h(React, "div", { className: "obx-panel" },
					h(React, "p", { className: "obx-hint" }, t("settings.loading")),
					error === null ? null : h(React, "p", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error),
					error === null ? null : h(React, UI.Button, { variant: "ghost", onClick: refetch }, t("common.retry")));
			}

			var secretSet = false;
			if (Array.isArray(snapshot.secrets)) {
				for (var secretEntry of snapshot.secrets) {
					if (secretEntry != null && Array.isArray(secretEntry.path) && secretEntry.path.indexOf("accessToken") >= 0 && secretEntry.set === true) secretSet = true;
				}
			}
			// 批 2（UX §6）：secretSet 保持「宿主侧确有已保存值」语义不变——勾选清除
			// 的「保存后清空」三态徽标在 renderGroup 内按 secretSet+clearSecret 派生
			//（旧版此处把勾选压成「未配置」的行已移除：secretSet:false + 勾清除仍显
			// 「未配置」，与既有渲染契约一致）。

			// W6「非默认」徽标数据源：快照生效值 vs schema 默认值（DEFAULTS），
			// 反映已保存状态；草稿未保存的改动不打徽标。
			var nonDefaultKeys = [];
			if (snapshot.config != null) {
				for (var field of ALL_FIELDS) {
					if (valueEquals(snapshot.config[field.key], DEFAULTS[field.key]) === false) nonDefaultKeys.push(field.key);
				}
			}

			// 批 2（UX §3.2）：mode 联动变暗禁用——reverse→url、forward→host/port；
			// 禁用≠清空（值保留在草稿，computePatch 值比较语义不变）。
			var modeInactiveKeys = deriveModeInactiveKeys(draft.mode);

			// 0.10.0：诊断组折叠 summary 派生（N 项/M 项默认开/脏标记）随折叠交互移除；
			// 诊断字段照常计入 dirtyKeys 与保存流，页签切换不隐藏变更。

			// 批 2（UX §5.7）：危险操作确认——有未保存修改时，「重新加载」「恢复默认值」
			// 先经浏览器原生 confirm（「将丢弃 N 项未保存修改」）；无脏改动直接执行。
			var confirmDiscard = function () {
				if (dirtyCount === 0) return true;
				return window.confirm(format(t("confirm.discardChanges"), { count: dirtyCount }));
			};
			var handleReload = function () {
				if (confirmDiscard()) refetch();
			};
			var handleReset = function () {
				if (!confirmDiscard()) return;
				setDraft(draftFromDefaults());
				setSecretDraft(""); // UX §5.7 补重置项：恢复默认值同时清空密文草稿…
				setClearSecret(false); // …与「清除已保存」勾选
				setInvalidNumbers({}); // 批 3（UX §5.6）：默认值均合法，一并清除行内标红
			};

			// 批 2（integration §2.4/§2.5）：交互文案走 locale 第二档（zh/en 同批），
			// 经 opts.texts 传入纯渲染函数（渲染函数对缺省回退 zh 字面量，模块级
			// 可测行为不变）。
			var texts = {
				modeInactive: t("field.modeInactive"),
				secretSet: t("secret.set"),
				secretUnset: t("secret.unset"),
				secretClearPending: t("secret.clearPending"),
				secretClearHint: t("secret.clearHint"),
				secretClear: t("secret.clear"),
				remoteOverwritten: t("field.remoteOverwritten"),
			};

			// 批 3（UX §5.6）：标红键的行内红字文案（范围文案 → 本地化句式）+ 键 label
			//（保存按钮禁用 title 与字段行内提示共用一份标红数据源）。
			var invalidNumberMessages: any = {};
			var invalidNumberLabels: any[] = [];
			Object.keys(invalidNumbers).forEach(function (key) {
				var field = ALL_FIELDS.find(function (item) { return item.key === key; });
				if (field != null) invalidNumberLabels.push(field.label);
				invalidNumberMessages[key] = format(t("field.numberInvalid"), { range: invalidNumbers[key] });
			});
			var invalidNumberCount = Object.keys(invalidNumbers).length;

			var changeHandlers = {
				t: t,
				disabled: busy,
				secretSet: secretSet,
				clearSecret: clearSecret,
				nonDefaultKeys: nonDefaultKeys,
				draft: draft,
				// 批 3（UX §5.6/§5.4）：行内校验标红数据源 + 冲突橙标键（校验时机 =
				// onChange 即时校验，见 validateNumberField）
				invalidNumbers: invalidNumberMessages,
				remoteOverwrittenKeys: conflictKeys,
				// W7：workspacePath 字段行下方的「快速填入 workspace」行（独立于
				// obx-field 行；onApply 只写草稿不保存——保存仍走 save() 显式通道）。
				renderExtraRow: function (field: any) {
					if (field.key !== "workspacePath" && field.key !== "groupWorkspacePath") return null;
					return renderWorkspacePicker(React, {
						ui: UI,
						t: t,
						loaded: workspace.loaded,
						available: workspace.available,
						workspaces: workspace.workspaces,
						selectedId: workspace.selectedId,
						disabled: busy,
						fetchFailed: workspace.fetchFailed === true,
						retryBlocked: workspace.retryBlocked === true,
						onRetry: fetchWorkspaces,
						fetchFailedText: t("workspace.fetchFailed"),
						retryText: t("common.retry"),
						onSelectedChange: function (nextId: any) {
							setWorkspace(Object.assign({}, workspace, { selectedId: nextId }));
						},
						onApply: function (path: any) {
							setDraft(fillWorkspacePath(draft, path, field.key));
						},
					});
				},
				onChange: function (field: any, nextValue: any) {
					// T8：notices 通知开关走带点键，值整个替换。
					if (field != null && String(field.key).indexOf("notices.") === 0) {
						setDraft(Object.assign({}, draft, (function () { var next: any = {}; next[field.key] = nextValue; return next; })()));
						return;
					}
					setDraft(Object.assign({}, draft, (function () { var next: any = {}; next[field.key] = nextValue; return next; })()));
					// 批 3（UX §5.6）：数字键每次编辑即时校验——标红随输入消除/落位
					if (field.type === "number") { validateNumberField(field, nextValue); }
					// 批 3（UX §5.4）：冲突键被再次编辑后撤销行内橙标（该提示描述的是被
					// 覆盖时刻的状态，用户改值后不再成立）
					if (conflictKeys.indexOf(field.key) >= 0) setConflictKeys(conflictKeys.filter(function (key: any) { return key !== field.key; }));
				},
				// T8：notices 通知开关专用写入——函数式 setDraft，
				// 不依赖渲染时捕获的 draft 快照（否则连点两下会互相覆盖）。
				onNoticeChange: function (key: any, updater: any) {
					setDraft(function (prev: any) {
						var copy = Object.assign({}, prev);
						copy[key] = typeof updater === "function" ? updater(prev[key]) : updater;
						return copy;
					});
				},
				onSecretChange: function (nextText: any) {
					setSecretDraft(nextText);
					setDraft(Object.assign({}, draft, (function () { var next: any = {}; next.accessToken = nextText; return next; })()));
					setClearSecret(false); // 批 2（UX §6）互斥：输入新值即取消「清除已保存」勾选
				},
				onClearSecretChange: function (nextChecked: any) {
					setClearSecret(nextChecked);
				},
			};

			// 0.10.0 页面骨架（对齐宿主原生页）：头部（20px/500 标题 + 状态 + ghost 工具栏
			// + SegmentedTabs 页签行）→ 滚动主体（反馈行 + 热生效提示 + 当前分组）→ 底部
			// 保存条（原生 SettingsForm 式）。分组内容经 renderGroup 纯函数产出（ui 注入）。
			return h(React, "div", { className: "obx-panel" },
				h(React, "div", { className: "obx-head" },
					h(React, "div", { className: "obx-head-row" },
						h(React, "h2", { className: "obx-title" }, t("settings.title")),
						dirtyCount > 0 ? h(React, "span", { className: "obx-status-warn" }, format(t("save.dirtyBadge"), { count: dirtyCount })) : null,
						snapshot.entryActive === true ? null : h(React, "span", { className: "obx-status-warn", title: t("effect.entryInactiveTitle") }, t("effect.entryInactive")),
						h(React, "span", { className: "obx-head-spacer" }),
						h(React, UI.Button, { variant: "ghost", disabled: busy, onClick: handleReset }, t("settings.reset")),
						h(React, UI.Button, { variant: "ghost", disabled: busy, onClick: handleReload }, t("settings.reload"))),
					h(React, "div", { className: "obx-head-row" },
						h(React, UI.SegmentedTabs, {
							items: GROUPS.map(function (group: any) { return { value: group.id, label: t("group." + group.id + ".title", group.title) }; }),
							value: activeTab,
							onChange: function (next: any) { setActiveTab(next); },
							label: t("settings.groupsLabel", "设置分组"),
						}),
						h(React, "span", { className: "obx-head-spacer" }),
						h(React, "span", { className: "obx-meta", title: t("settings.buildMarker", "面板构建标记") }, "ui-native"),
						h(React, "span", { className: "obx-meta" }, t("revision.label") + " " + String(snapshot.revision)))),
				h(React, "div", { className: "obx-body" },
					(error !== null || notice !== "") ? h(React, "div", { className: "obx-toast-wrap", "aria-live": "polite" },
						error !== null ? h(React, "p", { className: "obx-error" + (conflictActive ? " obx-error--conflict" : ""), role: "alert" }, t("status.error") + "：" + error) : null,
						notice !== "" ? h(React, "p", { className: "obx-notice" }, notice) : null) : null,
					h(React, "p", { className: "obx-effect" }, t("effect.hint")),
					GROUPS.filter(function (group) { return group.id === activeTab; }).map(function (group) {
						return renderGroup(React, group, Object.assign({}, changeHandlers, {
							ui: UI,
							texts: texts,
							// 词条缺失（新组忘配 desc）时传 null，不把原始 key 当描述渲染
							groupDesc: zh["group." + group.id + ".desc"] != null ? t("group." + group.id + ".desc") : null,
							modeInactiveKeys: modeInactiveKeys,
						}));
					}),
					h(React, "div", { className: "obx-foot" },
						h(React, "span", { className: "obx-head-spacer" }),
						h(React, UI.Button, {
							variant: "primary",
							disabled: busy || dirtyCount === 0 || invalidNumberCount > 0,
							title: invalidNumberCount > 0
								? format(t("save.badNumber"), { keys: invalidNumberLabels.join("、") })
								: dirtyCount === 0 ? t("save.noChangesTitle") : undefined,
							onClick: save,
						}, busy ? t("save.saving") : t("save.submit")))));
		}
		//#endregion

		//#region T11 侧边栏图标
		/**
		 * 首页左侧边栏入口图标。宿主 sidebar 以 {size, active} 渲染注册的图标组件
		 * （对照 dsh-client-ui-sidebar panelGlyph：size=16/18）；client bundle externals
		 * 冻结为 react，不能 require 宿主 primitives 图标表，故自绘内联 SVG。
		 */
		function OnebotSidebarIcon(props: any) {
			var size = props && typeof props.size === "number" ? props.size : 18;
			return React.createElement("svg", {
				viewBox: "0 0 24 24", width: size, height: size,
				fill: "none", stroke: "currentColor", strokeWidth: 1.8,
				strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true", focusable: "false",
			}, [
				React.createElement("rect", { key: "head", x: 4, y: 7, width: 16, height: 11, rx: 3 }),
				React.createElement("path", { key: "antenna", d: "M12 3.5v3.5" }),
				React.createElement("circle", { key: "antennaDot", cx: 12, cy: 3, r: 1, fill: "currentColor", stroke: "none" }),
				React.createElement("circle", { key: "eyeL", cx: 9, cy: 12.5, r: 1.1, fill: "currentColor", stroke: "none" }),
				React.createElement("circle", { key: "eyeR", cx: 15, cy: 12.5, r: 1.1, fill: "currentColor", stroke: "none" }),
				React.createElement("path", { key: "mouth", d: "M9.5 15.5h5" }),
			]);
		}
		//#endregion

		//#region 客户端入口
		var inject = ["slots", "locale", "remote"];
		/**
		 * 客户端入口：注入样式与词条、挂载 Typert Remote、注册设置面板。
		 * @returns {() => void} 卸载函数（对照先例：只回收 Remote 挂载；
		 *          样式/词条/slot 注册由宿主 ctx.effect 与 slot 生命周期回收）。
		 */
		async function apply(ctx: any) {
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			}, "onebot-settings: style");

			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "onebot-settings: dictionaries");
			var t = ctx.locale.bind(NS);

			// namespace 是独立 Cordis 服务：必须挂载后 ctx.get() 获取，
			// 直接读 ctx.remote.onebotSettings 会要求预先注入并死锁（先例同款注释）。
			var disposeRemote = await ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE);
			var remote = ctx.get("remote." + REMOTE_NS);
			if (remote === undefined) throw new Error("onebot-settings Remote 挂载后不可用");

			ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register(
				{ name: "plugins.bundle.config", key: "dsh-onebot-qq", locale: NS },
				function (props: any) { if (props && props.view === "summary") return t("settings.desc"); return React.createElement(OnebotSettingsPanel, Object.assign({}, props, { remote: remote })); },
			); });

			// T11：首页左侧边栏「QQ Bot」入口（可开关）。宿主合同：main keyed slot
			// 与 sidebar.panellist 列表条目必须同 id 成对注册（宿主 dsh-client-ui-layout
			// selectPanel 校验 main key 缺失即抛错；先例 dsh-client-ui-plugin-manager /
			// dsh-client-ui-schedule 同款）。开关按当前快照一次读取：false 时两侧都不
			// 注册（避免不成对状态）；插件菜单下的 plugins.bundle.config 设置页入口
			// 无条件保留。改动需刷新页面生效（Typert Remote 仅请求/响应，无推送通道）。
			var sidebarEnabled = true;
			try {
				var sidebarSnapshot = await remote.getSettings();
				sidebarEnabled = sidebarSnapshot.config.sidebarEntryEnabled !== false;
			} catch (error) {
				sidebarEnabled = true; // 快照读取失败按 schema 默认值（开）兜底
			}
			if (sidebarEnabled) {
				ctx.slots.inject("main", function () { return ctx.slots.register(
					{ name: "main", key: SIDEBAR_PANEL_ID, locale: NS },
					function (props: any) { return React.createElement(OnebotSettingsPanel, Object.assign({}, props, { remote: remote })); },
				); });
				ctx.slots.inject("sidebar.panellist", function () { return ctx.slots.register(
					{ name: "sidebar.panellist", id: SIDEBAR_PANEL_ID, order: 20, locale: NS, label: function () { return t("sidebar.panel"); } },
					OnebotSidebarIcon,
				); });
			}

			return function () { void disposeRemote(); };
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.ONEBOT_SETTINGS_REMOTE = ONEBOT_SETTINGS_REMOTE;
		exports.ONEBOT_SETTINGS_DESCRIPTORS = ONEBOT_SETTINGS_DESCRIPTORS;
		exports.GROUPS = GROUPS;
		exports.ALL_FIELDS = ALL_FIELDS;
		exports.DEFAULTS = DEFAULTS;
		exports.GROUP_KEYS = GROUP_KEYS;
		exports.computePatch = computePatch;
		exports.computeDirtyKeys = computeDirtyKeys;
		exports.deriveModeInactiveKeys = deriveModeInactiveKeys;
		exports.coerceValue = coerceValue;
		exports.snapshotValueToDraft = snapshotValueToDraft;
		exports.draftFromSnapshot = draftFromSnapshot;
		exports.fillWorkspacePath = fillWorkspacePath;
		exports.renderWorkspacePicker = renderWorkspacePicker;
		exports.isConflictError = isConflictError;
		exports.unwrap = unwrap;
		exports.renderGroup = renderGroup;
		exports.OnebotSettingsPanel = OnebotSettingsPanel;
		exports.OnebotSidebarIcon = OnebotSidebarIcon;
		exports.SIDEBAR_PANEL_ID = SIDEBAR_PANEL_ID;
		// 0.10.0：词条表导出（测试桩 t 从 LOCALE_ZH 解析；en 覆盖率用例读 LOCALE_EN）。
		exports.LOCALE_ZH = zh;
		exports.LOCALE_EN = en;
		// 批 3（UX §5.4/§5.6）：冲突合并保留 + 数字行内校验（纯函数，单测护航）
		exports.NUMBER_RANGE = NUMBER_RANGE;
		exports.numberRangeInvalid = numberRangeInvalid;
		exports.mergeOnConflict = mergeOnConflict;

		return module.exports;
	}
});
