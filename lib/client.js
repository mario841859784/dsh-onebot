/**
 * dsh-onebot — client bundle（QQ Bot 设置面板，T4 · T1 定案 B 路径）
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
 *   - 快照结构 = T1 §3 OnebotSettingsSnapshot（revision/entryActive/config(29 键)/
 *     secrets/groups/effect='restart'），accessToken 恒 ''（脱敏，T1 §3）；
 *   - 四组 29 键分组与 schema 默认值 = T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy
 *     = src/settings-remote.ts 常量。
 * 任一侧变更 descriptor/分组/键集/默认值时，必须同步本文件并在 DEVLOG 记录。
 *
 * 生效语义（T1 §5）：19 键统一「保存即热生效」——插件 fiber 秒级原地重启，
 * QQ 桥（NapCat ws-reverse/forward）自动重连；在途回合中断、频控窗口与中间
 * 消息缓冲清零；会话映射/历史不受影响。保存冲突（onebot-settings/conflict）
 * 时提示并重拉快照（revision 语义 = T1 §3.1，任何来源的已提交变更都 +1）。
 */

window.__ModuleLoader__.load({
	id: "dsh-onebot-qq",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region 外部模块（平台冻结表内：react）
		var reactModule = require("react");
		var React = reactModule != null && typeof reactModule.createElement === "function"
			? reactModule
			: reactModule.default;
		if (React == null || typeof React.createElement !== "function") {
			throw new Error("dsh-onebot client: react 不可用");
		}
		//#endregion

		//#region 常量
		var PLUGIN_ID = "dsh-onebot-qq";
		var REMOTE_NS = "onebotSettings"; // Typert Remote 命名空间（T1 §4，与 host 服务键一致）
		var NS = "dsh-onebot"; // locale 命名空间
		//#endregion

		//#region 四组 29 键字段定义（T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy：分组/键集/类型/默认值；与
		//  src/settings-remote.ts SETTINGS_GROUPS / SCHEMA_DEFAULTS / 类型分组逐字对齐，
		//  tests/client-settings.spec.ts 断言一致性。数值键 dedupWindowSeconds/
		//  actionRatePerMinute/actionRatePerDay/injectIntervalMs 与枚举键 traceLevel
		//  本期不上面板（host 白名单同样不含），仍走 patch config 手改——取舍见 DEVLOG W6。）
		/** 字段类型：enum（下拉）/ number / boolean / string / stringArray（多行文本）/ secret（密码型）。 */
		var GROUPS = [
			{
				id: "connection",
				title: "连接",
				fields: [
					{ key: "mode", label: "连接模式", type: "enum", options: ["reverse", "forward"], optionLabels: { reverse: "反向 WebSocket（NapCat 连接本插件）", forward: "正向 WebSocket（插件连接 NapCat）" }, hint: "reverse 时监听下方地址与端口；forward 时连接下方服务器地址。" },
					{ key: "host", label: "反向 WS 监听地址", type: "string", hint: "仅 reverse 模式生效。" },
					{ key: "port", label: "反向 WS 监听端口", type: "number", hint: "仅 reverse 模式生效。" },
					{ key: "url", label: "正向 WS 服务器地址", type: "string", hint: "仅 forward 模式生效，如 ws://127.0.0.1:3001。" },
					{ key: "accessToken", label: "访问令牌（AccessToken）", type: "secret", hint: "与 NapCat 侧一致的鉴权令牌；留空 = 不修改，勾选清除后保存 = 清空。" },
					{ key: "botQQ", label: "机器人 QQ 号", type: "string" },
					// W7：workspacePath 入面板（connection 组键序追加）。语义（对齐 README「会话工作区选择」）：
					// 修改只对新会话生效；已设 per-chat /workspace 覆盖的会话不受影响。
					{ key: "workspacePath", label: "会话默认工作区路径", type: "string", hint: "QQ 会话的工作区目录；保存后仅对新会话生效，已用 /workspace 设置 per-chat 覆盖的会话不受影响。留空 = 宿主进程工作目录。（配置键 workspacePath）" },
				],
			},
			{
				id: "permissions",
				title: "权限",
				fields: [
					{ key: "requireMention", label: "群聊必须 @ 机器人", type: "boolean" },
					{ key: "adminUsers", label: "管理员用户列表", type: "stringArray", hint: "每行一个 QQ 号。" },
					{ key: "dmPolicy", label: "私聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "groupPolicy", label: "群聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "allowAllUsers", label: "允许所有用户", type: "boolean", hint: "关闭时仅管理员可触发。" },
					{ key: "allowFrom", label: "私聊白名单", type: "stringArray", hint: "每行一个 QQ 号，仅白名单策略生效。" },
					{ key: "groupAllowFrom", label: "群聊白名单", type: "stringArray", hint: "每行一个群号，仅白名单策略生效。" },
				],
			},
			{
				id: "behavior",
				title: "行为",
				fields: [
					{ key: "interimMessages", label: "中间消息", type: "boolean", hint: "回合进行中发送流式中间消息。" },
					{ key: "interimRecall", label: "自动撤回中间消息", type: "boolean" },
					{ key: "interimRecallMs", label: "中间消息保留时长（毫秒）", type: "number" },
					{ key: "sendErrorNotice", label: "发送错误通知", type: "boolean" },
					{ key: "unknownCommand", label: "未知命令处理", type: "enum", options: ["intercept", "passthrough"], optionLabels: { intercept: "拦截", passthrough: "透传" } },
					{ key: "rateLimitPerMinute", label: "每分钟消息频率上限", type: "number" },
					{ key: "newMessagePolicy", label: "任务运行中的新消息", type: "enum", options: ["queue", "steer"], optionLabels: { queue: "排队", steer: "插话" }, hint: "任务运行中收到新普通消息：排队=当前任务结束后按序处理（每回合至多提示一次）；插话=作为补充指令加入当前任务。图片/文件/语音/引用消息与受限用户始终按排队处理。（配置键 newMessagePolicy）" },
					{ key: "autoSteerPolicy", label: "自动插话资格", type: "enum", options: ["admin", "all"], optionLabels: { admin: "仅管理员", all: "所有成员" }, hint: "插话模式下运行中收到的新普通纯文字消息谁可自动插话：仅管理员（默认）或所有成员。不具备资格的消息按排队处理；/steer 命令始终仅管理员；受限用户任何档都不自动插话。（配置键 autoSteerPolicy）" },
					{ key: "deferredTimeoutMs", label: "等待模型回复超时（毫秒）", type: "number", hint: "回合超过该时长无任何模型输出时提示超时并登记补发跟踪，任务完成后自动补发最终文字（超时补发）；发送失败最多重试 3 次，结果不确定时停止自动重试；/stop 终止该聊天的补发跟踪。0=关闭。（配置键 deferredTimeoutMs）" },
				],
			},
			{
				id: "diagnostics",
				title: "诊断",
				fields: [
					{ key: "actionAuditEnabled", label: "主动写审计", type: "boolean", hint: "每次主动发送/转发记一行审计到 qq-actions.log（含限额拦截）；关闭后拦截不再留审计痕迹。（配置键 actionAuditEnabled）" },
					{ key: "traceEnabled", label: "决策追踪（trace）", type: "boolean", hint: "把每个入站/出站决策事件写入 qq-trace.jsonl 便于排查；关闭后零文件、行为与关闭时完全一致。（配置键 traceEnabled）" },
					{ key: "recordInbound", label: "入站事件录制", type: "boolean", hint: "把收到的每条消息事件录制到 qq-inbox.jsonl（可离线回放）；关闭后不录制、无法回放。（配置键 recordInbound）" },
					{ key: "inboxRedact", label: "录制脱敏", type: "boolean", hint: "录制时把 QQ 号/群号等 6 位以上数字串打码；关闭后录制文件含明文号码，注意隐私。（配置键 inboxRedact）" },
					{ key: "injectEnabled", label: "事件注入（仅调试）", type: "boolean", hint: "轮询 qq-inject.jsonl 把文件里的消息喂进真实管线，离线调试用；生产环境勿开。（配置键 injectEnabled）" },
					{ key: "injectDryRun", label: "注入 dry-run", type: "boolean", hint: "拦截注入回合产生的所有出站发送（默认开）；关闭后注入消息会真实发出，仅限隔离环境。（配置键 injectDryRun）" },
				],
			},
		];
		/** 全部 29 键扁平表（顺序 = 四组声明顺序，与 host ALL_KEYS 语义一致；T2 起含 newMessagePolicy、T9 起含 autoSteerPolicy、T3 起含 deferredTimeoutMs）。 */
		var ALL_FIELDS = [];
		for (var groupIndex = 0; groupIndex < GROUPS.length; groupIndex++) {
			for (var fieldIndex = 0; fieldIndex < GROUPS[groupIndex].fields.length; fieldIndex++) {
				ALL_FIELDS.push(GROUPS[groupIndex].fields[fieldIndex]);
			}
		}
		/** schema 默认值（T1 §4 表；重置按钮与空快照兜底的唯一来源；与
		 *  src/settings-remote.ts SCHEMA_DEFAULTS 逐字对齐）。 */
		var DEFAULTS = {
			mode: "reverse",
			host: "127.0.0.1",
			port: 8643,
			url: "ws://127.0.0.1:3001",
			accessToken: "",
			botQQ: "",
			workspacePath: "",
			requireMention: true,
			adminUsers: [],
			dmPolicy: "open",
			groupPolicy: "open",
			allowAllUsers: false,
			allowFrom: [],
			groupAllowFrom: [],
			interimMessages: true,
			interimRecall: true,
			interimRecallMs: 90000,
			sendErrorNotice: true,
			unknownCommand: "intercept",
			rateLimitPerMinute: 30,
			newMessagePolicy: "queue",
			autoSteerPolicy: "admin",
			deferredTimeoutMs: 600000,
			actionAuditEnabled: true,
			traceEnabled: false,
			recordInbound: false,
			inboxRedact: false,
			injectEnabled: false,
			injectDryRun: true,
		};
		/** 分组 → 键数组（与 host SETTINGS_GROUPS 同构；供契约核对与快照渲染兜底）。 */
		var GROUP_KEYS = {};
		for (var gk = 0; gk < GROUPS.length; gk++) {
			GROUP_KEYS[GROUPS[gk].id] = GROUPS[gk].fields.map(function (field) { return field.key; });
		}
		//#endregion

		//#region 极简 schema 校验（替代 zod，供 Typert 严格 codec 使用；与模板同款）
		function vString(min, max) {
			return {
				parse(value) {
					if (typeof value !== "string" || value.length < min || value.length > max) {
						throw new TypeError("expected string(" + min + ".." + max + ")");
					}
					return value;
				},
			};
		}
		function vInt(min) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
						throw new TypeError("expected int>=" + min);
					}
					return value;
				},
			};
		}
		function vNumber(min, max) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("expected finite number");
					if (min !== undefined && value < min) throw new TypeError("expected number >= " + min);
					if (max !== undefined && value > max) throw new TypeError("expected number <= " + max);
					return value;
				},
			};
		}
		function vBoolean() {
			return {
				parse(value) {
					if (typeof value !== "boolean") throw new TypeError("expected boolean");
					return value;
				},
			};
		}
		function vArray(item) {
			return {
				parse(value) {
					if (!Array.isArray(value)) throw new TypeError("expected array");
					return value.map((entry) => item.parse(entry));
				},
			};
		}
		/** 可选字段：缺席（undefined/null）时保持缺席，不参与 parse。 */
		function vOptional(inner) {
			return {
				parse(value) {
					if (value === undefined || value === null) return undefined;
					return inner.parse(value);
				},
			};
		}
		/** 与 zod object 默认行为一致：声明外字段剥离，声明内字段逐个 parse。 */
		function vObject(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out = {};
					for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
					return out;
				},
			};
		}
		function vEnum(values) {
			return {
				parse(value) {
					if (typeof value !== "string" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		//#endregion

		//#region Remote 契约 schema（与 host lib/settings-remote.js 快照/校验逐字对齐）
		/** 29 键生效值（host buildSnapshot 的 effectiveConfig 全键返回；accessToken 恒 ''）。 */
		var configSchema = vObject({
			mode: vEnum(["reverse", "forward"]),
			host: vString(0, 256),
			port: vNumber(),
			url: vString(0, 512),
			accessToken: vString(0, 256),
			botQQ: vString(0, 64),
			workspacePath: vString(0, 1024),
			requireMention: vBoolean(),
			adminUsers: vArray(vString(0, 64)),
			dmPolicy: vEnum(["open", "allowlist", "disabled"]),
			groupPolicy: vEnum(["open", "allowlist", "disabled"]),
			allowAllUsers: vBoolean(),
			allowFrom: vArray(vString(0, 64)),
			groupAllowFrom: vArray(vString(0, 64)),
			interimMessages: vBoolean(),
			interimRecall: vBoolean(),
			interimRecallMs: vNumber(),
			sendErrorNotice: vBoolean(),
			unknownCommand: vEnum(["intercept", "passthrough"]),
			rateLimitPerMinute: vNumber(),
			newMessagePolicy: vEnum(["queue", "steer"]),
			autoSteerPolicy: vEnum(["admin", "all"]),
			deferredTimeoutMs: vNumber(),
			actionAuditEnabled: vBoolean(),
			traceEnabled: vBoolean(),
			recordInbound: vBoolean(),
			inboxRedact: vBoolean(),
			injectEnabled: vBoolean(),
			injectDryRun: vBoolean(),
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
				diagnostics: vArray(vString(1, 64)),
			}),
			effect: vEnum(["restart"]), // T1 §5：19 键统一插件级热重启
		});
		/** updateSettings 入参（T1 §4 + W6 + W7：29 键任意子集的扁平 JSON；accessToken 缺省=不改，''=清空）。 */
		var patchSchema = vObject({
			mode: vOptional(vEnum(["reverse", "forward"])),
			host: vOptional(vString(0, 256)),
			port: vOptional(vNumber(1, 65535)),
			url: vOptional(vString(0, 512)),
			accessToken: vOptional(vString(0, 256)),
			botQQ: vOptional(vString(0, 64)),
			workspacePath: vOptional(vString(0, 1024)),
			requireMention: vOptional(vBoolean()),
			adminUsers: vOptional(vArray(vString(0, 64))),
			dmPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			groupPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			allowAllUsers: vOptional(vBoolean()),
			allowFrom: vOptional(vArray(vString(0, 64))),
			groupAllowFrom: vOptional(vArray(vString(0, 64))),
			interimMessages: vOptional(vBoolean()),
			interimRecall: vOptional(vBoolean()),
			interimRecallMs: vOptional(vNumber(0)),
			sendErrorNotice: vOptional(vBoolean()),
			unknownCommand: vOptional(vEnum(["intercept", "passthrough"])),
			rateLimitPerMinute: vOptional(vNumber(0)),
			newMessagePolicy: vOptional(vEnum(["queue", "steer"])),
			autoSteerPolicy: vOptional(vEnum(["admin", "all"])),
			deferredTimeoutMs: vOptional(vNumber(0)),
			actionAuditEnabled: vOptional(vBoolean()),
			traceEnabled: vOptional(vBoolean()),
			recordInbound: vOptional(vBoolean()),
			inboxRedact: vOptional(vBoolean()),
			injectEnabled: vOptional(vBoolean()),
			injectDryRun: vOptional(vBoolean()),
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
		function strictCodec(typeSymbol, schema) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
		}
		function jsonParameter(name, typeSymbol, schema) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function onebotMethod(method, parameters, resultSchema, typeSymbol) {
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
		var zh = {
			"settings.title": "QQ Bot（OneBot）设置",
			"settings.desc": "配置持久化为 profile 层 cordis.patch.yml 中 dsh-onebot 条目的 config 覆盖行，与手改 patch、宿主原生设置页同源。",
			"settings.loading": "正在加载设置…",
			"settings.reload": "重新加载",
			"settings.reset": "恢复默认值",
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
			"diagnostics.summary": "{total} 项 · {enabled} 项默认开",
			"diagnostics.dirtyMark": "● 含未保存修改",
			"group.connection.desc": "NapCat/QQ 桥接参数",
			"group.permissions.desc": "谁能触发与使用",
			"group.behavior.desc": "回复与限流",
			"group.diagnostics.desc": "观测与调试开关",
			// 批 3 词条（UX §5.4/§5.6 + integration §3：冲突合并保留 + 数字行内校验，
			// zh/en 同批齐平；既有键文案不改）。
			"conflict.kept": "已保留 {count} 项未冲突的修改，请核对后重新保存。",
			"conflict.secretCleared": "accessToken 输入已清空，如需修改请重新输入。",
			"field.numberInvalid": "必须是 {range} 的有限数字",
			"field.remoteOverwritten": "已被其他来源修改，已同步为最新值",
		};
		var en = {
			"settings.title": "QQ Bot (OneBot) settings",
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
			"diagnostics.summary": "{total} items · {enabled} on by default",
			"diagnostics.dirtyMark": "● Unsaved changes",
			"group.connection.desc": "NapCat/QQ bridge settings",
			"group.permissions.desc": "Who can trigger and use the bot",
			"group.behavior.desc": "Replies and rate limiting",
			"group.diagnostics.desc": "Observability and debugging switches",
			// 批 3（UX §5.4/§5.6）：与 zh 同批新增的 4 键（冲突合并保留 + 数字行内校验）。
			"conflict.kept": "Kept {count} non-conflicting change(s) — review and save again.",
			"conflict.secretCleared": "The accessToken input has been cleared; re-enter it if you still want to change it.",
			"field.numberInvalid": "Must be a finite number {range}",
			"field.remoteOverwritten": "Changed by another source — synced to the latest value",
		};
		/** 双语 key 集一致性自检：缺漏仅告警不致崩溃。 */
		function assertSameKeys(a, b) {
			var missing = Object.keys(a).filter((key) => !(key in b));
			var extra = Object.keys(b).filter((key) => !(key in a));
			if (missing.length > 0 || extra.length > 0) {
				console.warn("[dsh-onebot] 双语词条 key 不齐 zh缺:" + missing.join(",") + " en缺:" + extra.join(","));
			}
		}
		assertSameKeys(zh, en);
		//#endregion

		//#region 面板样式（一次注入，随插件卸载移除；类名前缀 obx-）
		// 批 1 视觉基线（docs/design/settings-page-visual-proposal.md §1–§6）：
		// §5.1 token 表色值逐字采用（WCAG AA 实测校准），不自创/不改值；
		// 附加的 -bg / --obx-card-border / --obx-error-ring 为方案正文（§2/§3.1/§4.2）
		// 点名引用而 §5.1 未列值的衍生位——卡片描边延续现状组分隔发丝线色值，
		// 横幅浅底取同 hue alpha 淡化（延续原 error 浅底 .08 同族）。
		var CSS = [
			".obx-panel{--obx-fg:inherit;--obx-fg-muted:#6b7280;--obx-border:rgba(128,128,128,.75);--obx-border-strong:rgba(128,128,128,1);--obx-card-bg:rgba(128,128,128,.06);--obx-card-border:rgba(128,128,128,.2);--obx-input-bg:transparent;--obx-accent:var(--dsh-accent,#2563eb);--obx-focus-ring:rgba(37,99,235,.45);--obx-error:#e5484d;--obx-error-text:#d93036;--obx-error-bg:rgba(229,72,77,.10);--obx-error-ring:rgba(229,72,77,.45);--obx-warning:#d97706;--obx-warning-text:#92400e;--obx-warning-bg:rgba(217,119,6,.12);--obx-success:#2f9e63;--obx-success-text:#1a7f4b;--obx-success-bg:rgba(47,158,99,.10);--obx-switch-off:rgba(128,128,128,.7);--obx-switch-knob:#ffffff;--obx-radius-sm:6px;--obx-radius-md:8px;--obx-radius-lg:10px;--obx-fs-xs:11px;--obx-fs-sm:12px;--obx-fs-base:13px;--obx-fs-md:14px;--obx-fs-lg:16px;--obx-space-1:4px;--obx-space-2:8px;--obx-space-3:12px;--obx-space-4:16px;--obx-space-5:20px;--obx-space-6:24px;--obx-dur-fast:150ms ease;display:flex;flex-direction:column;gap:16px;font-size:var(--obx-fs-md);line-height:1.5;max-width:720px;container-type:inline-size;container-name:obx}",
			"@media (prefers-color-scheme: dark){.obx-panel{--obx-fg-muted:#9ca3af;--obx-border:rgba(255,255,255,.35);--obx-border-strong:rgba(255,255,255,.5);--obx-card-bg:rgba(128,128,128,.10);--obx-card-border:rgba(128,128,128,.2);--obx-accent:var(--dsh-accent,#60a5fa);--obx-focus-ring:rgba(96,165,250,.55);--obx-error-text:#ff8a8a;--obx-warning-text:#fbbf24;--obx-success-text:#4ade80;--obx-switch-off:rgba(128,128,128,.55);--obx-switch-knob:#e8e8e8}}",
			// §1 结构：720px 内容上限（左对齐不居中，由块级布局天然实现）
			".obx-title{font-size:var(--obx-fs-lg);font-weight:600;margin:0}",
			".obx-desc{color:var(--obx-fg-muted);font-size:var(--obx-fs-sm);margin:4px 0 0}",
			".obx-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".obx-spacer{flex:1}",
			// §4.2：revision 徽章 / entryInactive 升级 pill（badge 族 11px）
			".obx-meta{color:var(--obx-fg-muted);font-size:var(--obx-fs-xs);border:1px solid var(--obx-border);border-radius:999px;padding:1px 8px}",
			".obx-warn{color:var(--obx-warning-text);background:var(--obx-warning-bg);border-color:var(--obx-warning)}",
			// §4.2 反馈三态：左 3px 实色条 + 浅底 + 前置图标（CSS ::before 字形，DOM 零增节点；
			// 冲突态 obx-error--conflict 批 3 起由面板显式冲突状态挂载，见 OnebotSettingsPanel）
			".obx-error{border:1px solid var(--obx-error);border-left-width:3px;background:var(--obx-error-bg);color:var(--obx-error-text);border-radius:var(--obx-radius-md);padding:10px 12px;white-space:pre-wrap}",
			".obx-alert[role=alert]{white-space:pre-wrap}",
			".obx-error::before{content:'!';font-weight:700;margin-right:6px}",
			".obx-error--conflict::before{content:'↻'}",
			".obx-notice{border:1px solid var(--obx-success);border-left-width:3px;background:var(--obx-success-bg);color:var(--obx-success-text);border-radius:var(--obx-radius-md);padding:10px 12px;white-space:pre-wrap}",
			".obx-notice::before{content:'✓';font-weight:700;margin-right:6px}",
			// §4.1 热生效提示条：保留虚线框语义，升级为提示条样式（ⓘ 前缀同为 ::before 字形）
			".obx-effect{border:1px dashed var(--obx-border);border-radius:var(--obx-radius-md);padding:8px 12px;color:var(--obx-fg-muted);background:var(--obx-card-bg);font-size:var(--obx-fs-sm)}",
			".obx-effect::before{content:'ⓘ';margin-right:6px}",
			// §2 组卡片：r10、卡间距 16（.obx-panel gap）、组内字段行间 12
			".obx-group{display:flex;flex-direction:column;gap:12px;background:var(--obx-card-bg);border:1px solid var(--obx-card-border);border-radius:var(--obx-radius-lg);padding:14px 16px 16px}",
			".obx-group-title{font-size:var(--obx-fs-md);font-weight:600;margin:0}",
			// §6 旧内核兜底：字段行保留现状 flex-wrap；容器查询三档见末尾 @container 块
			".obx-field{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}",
			// §3.1/§5.1：字段 label 13px/400 + fg-muted（原 opacity 灰度不达 AA）
			".obx-label{font-size:var(--obx-fs-base);color:var(--obx-fg-muted);min-width:180px}",
			".obx-control{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:1;min-width:240px}",
			".obx-input,.obx-select,.obx-textarea{flex:1;min-width:160px;max-width:420px;box-sizing:border-box;border:1px solid var(--obx-border);border-radius:var(--obx-radius-md);background:var(--obx-input-bg);color:inherit;padding:5px 10px;font-family:inherit;font-size:var(--obx-fs-base)}",
			".obx-input,.obx-select{height:32px}",
			".obx-textarea{max-width:520px;min-height:88px;resize:vertical}",
			".obx-input:hover:not(:disabled),.obx-select:hover:not(:disabled),.obx-textarea:hover:not(:disabled){border-color:var(--obx-border-strong)}",
			".obx-input:focus-visible,.obx-select:focus-visible,.obx-textarea:focus-visible,.obx-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--obx-focus-ring);border-color:var(--obx-accent)}",
			".obx-input:disabled,.obx-select:disabled,.obx-textarea:disabled{opacity:.45;cursor:not-allowed;background:var(--obx-card-bg)}",
			// §3.1 数字输入收窄至 160px（渲染层经 obx-input--number 挂载）
			".obx-input--number{max-width:160px}",
			// §3.1 invalid 描红——批 2 预铺样式，批 3（UX §5.6 数字行内校验）挂载
			".obx-input--invalid{border-color:var(--obx-error);box-shadow:0 0 0 2px var(--obx-error-ring)}",
			// §3.2 纯 CSS 开关：36×20 轨道 + 16 滑块，checkbox 语义保留（视觉隐藏 +
			// 24×24 命中区覆盖轨道；track 为紧随 input 的兄弟节点，由兄弟选择器驱动）
			".obx-toggle{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--obx-fs-base)}",
			".obx-switch-input{position:absolute;left:6px;top:50%;width:24px;height:24px;margin:0;transform:translateY(-50%);opacity:0;cursor:pointer}",
			".obx-switch-track{position:relative;display:inline-block;flex:none;width:36px;height:20px;border-radius:999px;background:var(--obx-switch-off);transition:background var(--obx-dur-fast)}",
			".obx-switch-track::before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--obx-switch-knob);transition:transform var(--obx-dur-fast)}",
			".obx-switch-input:checked + .obx-switch-track{background:var(--obx-accent)}",
			".obx-switch-input:checked + .obx-switch-track::before{transform:translateX(16px)}",
			".obx-switch-input:disabled + .obx-switch-track{opacity:.45;cursor:not-allowed}",
			".obx-switch-input:focus-visible + .obx-switch-track{box-shadow:0 0 0 2px var(--obx-focus-ring)}",
			"@media (prefers-reduced-motion: reduce){.obx-switch-track,.obx-switch-track::before{transition:none}}",
			".obx-hint{color:var(--obx-fg-muted);font-size:var(--obx-fs-sm);flex-basis:100%}",
			// §3.4 密文徽章 + 8px 状态点（已配置=accent / 未配置=border-strong）
			".obx-secret-badge{font-size:var(--obx-fs-xs);border:1px solid var(--obx-border);border-radius:999px;padding:0 8px;color:var(--obx-fg-muted)}",
			".obx-secret-badge::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--obx-border-strong);margin-right:6px;vertical-align:middle}",
			".obx-secret-badge--set::before{background:var(--obx-accent)}",
			".obx-badge{font-size:var(--obx-fs-xs);border:1px solid var(--obx-border);border-radius:999px;padding:0 8px;color:var(--obx-fg-muted)}",
			// §3.5 按钮规格：primary 实底 accent / 次级描边（底色 card-bg，hover 描边 currentColor 保留）
			".obx-btn{cursor:pointer;border:1px solid var(--obx-border);border-radius:var(--obx-radius-md);background:var(--obx-card-bg);color:inherit;padding:6px 12px;height:32px;box-sizing:border-box;font-family:inherit;font-size:var(--obx-fs-base)}",
			".obx-btn:hover:not(:disabled){border-color:currentColor}",
			".obx-btn:disabled{opacity:.45;cursor:not-allowed}",
			".obx-btn.primary{background:var(--obx-accent);color:#fff;border:none;font-weight:600}",
			".obx-btn.primary:hover:not(:disabled){filter:brightness(1.06)}",
			// §3.6 workspace 选择器：卡片内嵌次级行
			".obx-workspace-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--obx-card-bg);border-radius:var(--obx-radius-md);padding:8px 12px}",
			// §6 容器查询三档（面板自身为查询源；旧内核不识别 @container → 回落上方 flex-wrap 兜底）
			"@container obx (min-width:720px){.obx-field{display:grid;grid-template-columns:176px minmax(240px,1fr) auto;column-gap:12px;row-gap:4px;align-items:center}.obx-field>.obx-label{grid-column:1;grid-row:1}.obx-field>.obx-input,.obx-field>.obx-select,.obx-field>.obx-textarea,.obx-field>.obx-control,.obx-field>.obx-toggle{grid-column:2;grid-row:1}.obx-field>.obx-badge{grid-column:3;grid-row:1}.obx-field>.obx-hint{grid-column:2/-1;grid-row:2}}",
			"@container obx (max-width:719px){.obx-field{display:grid;grid-template-columns:1fr;row-gap:4px}.obx-field>.obx-label{grid-column:1}.obx-field>.obx-badge{grid-column:1;justify-self:start}}",
			"@container obx (max-width:479px){.obx-toolbar .obx-btn{flex:1 1 auto}.obx-toolbar .obx-btn.primary{order:-1}.obx-input,.obx-select,.obx-textarea{max-width:none}.obx-group{padding:12px}.obx-secret-badge{flex-basis:100%}}",
			// 批 2 交互逻辑（UX §3.1/§3.2/§5.1/§6/§7 + integration §2.4）：
			// 诊断组 details/summary 折叠——summary 行 = 组标题 + 组描述 + meta pill
			//（「N 项 · M 项默认开」复用 .obx-meta）+ 脏标记；details 即组卡片本体。
			".obx-group-desc{color:var(--obx-fg-muted);font-size:var(--obx-fs-sm);margin:0}",
			".obx-group>.obx-group-desc{margin-top:-8px}",
			".obx-group-summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;cursor:pointer;list-style:none}",
			".obx-group-summary::-webkit-details-marker{display:none}",
			".obx-group-summary::before{content:'▸';flex:none;color:var(--obx-fg-muted);transition:transform var(--obx-dur-fast)}",
			".obx-group--collapsible[open]>.obx-group-summary::before{transform:rotate(90deg)}",
			"@media (prefers-reduced-motion: reduce){.obx-group-summary::before{transition:none}}",
			// 折叠 summary 脏标记 / mode 联动与密文清除的行内强调 hint（warning 文本色）
			".obx-group-dirty{color:var(--obx-warning-text);font-size:var(--obx-fs-xs);font-weight:600}",
			".obx-hint--warn{color:var(--obx-warning-text)}",
			// 批 3（UX §5.6）：数字行内校验红字 hint（错误文本色，与冲突横幅同族 token）
			".obx-hint--invalid{color:var(--obx-error-text)}",
			// UX §6 勾选清除：输入框描边 + 徽标转 warning（token 复用批 1 §5.1 色值）
			".obx-input--warn{border-color:var(--obx-warning)}",
			".obx-secret-badge--clear{color:var(--obx-warning-text);background:var(--obx-warning-bg);border-color:var(--obx-warning)}",
			".obx-secret-badge--clear::before{background:var(--obx-warning)}",
			// UX §4 workspace 拉取失败重试入口（行内链接式按钮）
			".obx-link-btn{cursor:pointer;border:none;background:none;color:var(--obx-accent);padding:0 0 0 4px;font:inherit;font-size:var(--obx-fs-sm);text-decoration:underline}",
			".obx-link-btn:disabled{opacity:.45;cursor:not-allowed;text-decoration:none}",
		].join("\n");
		//#endregion

		//#region 工具（纯函数，模块级可测）
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
		}
		function messageOf(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** RemoteResult 解包：{ok:true,value}|{ok:false,error:{message}}。 */
		function unwrap(result) {
			if (result != null && result.ok === true) return result.value;
			var detail = result != null && result.error != null ? result.error.message : "unknown remote error";
			var error = new Error(detail);
			if (result != null && result.error != null && result.error.code != null) error.code = result.error.code;
			throw error;
		}
		/** 保存冲突判定（T1 §3.1：expectedRevision ≠ 当前 revision 拒写，
		 *  host 抛 RemoteError('onebot-settings/conflict')；message 兜底只匹配该
		 *  错误路径本身——不过宽匹配含 "revision" 的无关错误（评审 B5）。 */
		var CONFLICT_RE = /onebot-settings\/conflict/i;
		function isConflictError(cause) {
			if (cause == null) return false;
			return cause.code === "onebot-settings/conflict" || CONFLICT_RE.test(String(cause.message || ""));
		}
		/** 快照生效值 → 表单草稿（展示形态：number/stringArray/secret 均为可编辑文本；
		 *  accessToken 恒 ''，明文绝不进入草稿——host 快照已脱敏）。 */
		function snapshotValueToDraft(field, value) {
			if (field.type === "secret") return ""; // 脱敏回显：密码框恒空（T1 §3 敏感字段行）
			if (field.type === "stringArray") return Array.isArray(value) ? value.join("\n") : "";
			if (field.type === "number") return value === undefined || value === null ? "" : String(value);
			if (field.type === "boolean") return value === true;
			return value === undefined || value === null ? "" : String(value);
		}
		function draftFromSnapshot(snapshot) {
			var config = snapshot != null && snapshot.config != null ? snapshot.config : {};
			var draft = {};
			for (var field of ALL_FIELDS) draft[field.key] = snapshotValueToDraft(field, config[field.key]);
			return draft;
		}
		function draftFromDefaults() {
			return draftFromSnapshot({ config: DEFAULTS });
		}
		/** 草稿展示值 → patch 值（stringArray 文本 → 行数组；number 文本 → 数字）。 */
		function coerceValue(field, raw) {
			if (field.type === "number") {
				var n = typeof raw === "number" ? raw : Number(String(raw).trim());
				return Number.isFinite(n) ? n : NaN;
			}
			if (field.type === "boolean") return raw === true;
			if (field.type === "stringArray") {
				return String(raw == null ? "" : raw).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
			}
			return String(raw == null ? "" : raw);
		}
		function valueEquals(a, b) {
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
		function computePatch(draft, config, opts) {
			var options = opts == null ? {} : opts;
			var config_ = config == null ? {} : config;
			var patch = {};
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
			var secretDraft = options.secretDraft;
			if (options.clearSecret === true) patch.accessToken = ""; // host 语义：'' = 清空
			else if (typeof secretDraft === "string" && secretDraft !== "") patch.accessToken = secretDraft;
			// secretDraft 为空且未勾选清除 → 不含 accessToken 键 = 不修改（host 缺省语义）
			return { patch: patch, invalidKeys: invalidKeys };
		}

		/**
		 * 批 3（UX §5.6）：数字键行内校验合法范围——逐字抄自 host NUMBER_RANGE
		 * （src/settings-remote.ts L129-134；前端字面量副本，host 常量不改）。
		 * port 1–65535，时长/频控类 ≥0（max undefined = 无上限）。
		 */
		var NUMBER_RANGE = {
			port: [1, 65535],
			interimRecallMs: [0, undefined],
			rateLimitPerMinute: [0, undefined],
			deferredTimeoutMs: [0, undefined],
		};

		/**
		 * 批 3（UX §5.6）：数字行内校验——判定语义与 host validatePatch 逐字对齐
		 * （src/settings-remote.ts L351-353：Number.isFinite && >= min &&
		 * (max === undefined || <= max)）。'' 经 Number('')=0 入范围判定（与
		 * computePatch→coerceValue 同口径）；非数字文本（NaN）同样判非法。
		 * @returns null = 合法；string = 合法范围文案（"1–65535"/"≥0"），供
		 *          format(t("field.numberInvalid"), { range }) 组装行内红字。
		 */
		function numberRangeInvalid(field, raw) {
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
		function mergeOnConflict(draft, oldCfg, nextCfg) {
			var sourceDraft = draft == null ? {} : draft;
			var oldConfig = oldCfg == null ? {} : oldCfg;
			var nextConfig = nextCfg == null ? {} : nextCfg;
			var merged = {};
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
		function fillWorkspacePath(draft, path) {
			var next = Object.assign({}, draft == null ? {} : draft);
			next.workspacePath = String(path == null ? "" : path);
			return next;
		}

		/**
		 * 批 2（UX §5.1）：脏状态派生——与保存流共用同一 computePatch 口径，键集 =
		 * 与快照生效值有差异的键 + 密文通道（secretDraft 非空 / clearSecret）。纯
		 * 客户端计算，不依赖冲突合并（mergeOnConflict 为批 3 范围）；数字非法键不进
		 * patch 故不入 dirtyKeys（badNumber 反馈仍走 save() 通道）。
		 */
		function computeDirtyKeys(draft, config, opts) {
			return Object.keys(computePatch(draft, config, opts).patch);
		}

		/**
		 * 批 2（UX §3.2）：mode 联动变暗禁用——反向连接只走 url、正向只走 host/port。
		 * 禁用≠清空：值保留在草稿，computePatch 值比较语义不变（patch 仍按原值比较）。
		 */
		function deriveModeInactiveKeys(mode) {
			if (mode === "reverse") return ["url"];
			if (mode === "forward") return ["host", "port"];
			return [];
		}

		/** 批 2（UX §3.1）：诊断组折叠态 sessionStorage 键（"1" = 展开；缺省 = 默认折叠）。 */
		var DIAGNOSTICS_EXPANDED_KEY = PLUGIN_ID + ".diagnosticsExpanded";
		/** 批 2（UX §4）：workspace 拉取失败后的重试冷却（10s 内不重复请求）。 */
		var WORKSPACE_RETRY_COOLDOWN_MS = 10000;
		//#endregion

		//#region 渲染（模块级可测的纯渲染函数：renderGroup 不依赖 hooks/副作用）
		function h(ReactImpl, tag, props) {
			var children = Array.prototype.slice.call(arguments, 3);
			return ReactImpl.createElement.apply(ReactImpl, [tag, props].concat(children));
		}
		/**
		 * 渲染一个设置分组（纯函数；值全部经 snapshotValueToDraft 脱敏形态传入，
		 * accessToken 明文按契约绝不进入本函数——host 快照侧已脱敏为 ''）。
		 * @param opts.onChange (field, nextDisplayValue) => void
		 * @param opts.onSecretChange (nextText) => void
		 * @param opts.onClearSecretChange (nextBoolean) => void
		 * @param opts.secretSet boolean（快照 secrets 标记：明文是否已配置）
		 * @param opts.clearSecret boolean（清除勾选态）
		 * @param opts.nonDefaultKeys 与 schema 默认值不同的键数组（W6「非默认」徽标；
		 *        以快照生效值为准而非草稿——徽标描述已保存状态，不是未保存编辑）
		 * @param opts.draft 表单草稿（snapshotValueToDraft 形态）
		 * @param opts.groupDesc 组描述文案（批 2 UX §2.2；缺省不渲染描述行）
		 * @param opts.modeInactiveKeys 当前连接模式下不生效的键（批 2 UX §3.2：命中
		 *        字段禁用变暗 + hint 追加「当前模式不生效」；值保留不清空）
		 * @param opts.texts 交互文案（批 2 locale 第二档经面板传入；缺省回退 zh 字面
		 *        量，模块级可测行为不变）：modeInactive/secretSet/secretUnset/
		 *        secretClearPending/secretClearHint/secretClear/remoteOverwritten
		 * @param opts.collapsible 折叠配置（批 2 UX §3.1：仅诊断组传入）——
		 *        {open, onToggle, summaryMeta, dirtyMark}；缺省保持 section 常开形态
		 * @param opts.invalidNumbers 数字行内校验标红（批 3 UX §5.6）：map key →
		 *        已本地化提示文案；命中字段输入框挂 obx-input--invalid（批 1 预铺
		 *        样式）+ aria-invalid，hint 行内嵌红字（.obx-hint--invalid）
		 * @param opts.remoteOverwrittenKeys 冲突合并被远端覆盖的键（批 3 UX §5.4）：
		 *        命中字段 hint 行内嵌橙标「已被其他来源修改，已同步为最新值」
		 * @param opts.onNumberBlur (field, rawText) => void——number 字段 blur 回调
		 *        （行内校验入口：面板侧记态标红/清除；stringArray/enum 不加校验）
		 */
		function renderGroup(ReactImpl, group, opts) {
			var options = opts == null ? {} : opts;
			var draft = options.draft == null ? {} : options.draft;
			var nonDefaultKeys = Array.isArray(options.nonDefaultKeys) ? options.nonDefaultKeys : [];
			var modeInactiveKeys = Array.isArray(options.modeInactiveKeys) ? options.modeInactiveKeys : [];
			var invalidNumbers = options.invalidNumbers != null ? options.invalidNumbers : {};
			var remoteOverwrittenKeys = Array.isArray(options.remoteOverwrittenKeys) ? options.remoteOverwrittenKeys : [];
			var groupDesc = options.groupDesc != null ? options.groupDesc : null;
			var collapsible = options.collapsible != null ? options.collapsible : null;
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
			var onNumberBlur = typeof options.onNumberBlur === "function" ? options.onNumberBlur : function () {};
			var fieldNodes = group.fields.map(function (field) {
				var value = draft[field.key];
				// 批 2（UX §3.2）：mode 联动——非当前模式的连接字段禁用变暗（值保留在
				// 草稿，computePatch 值比较语义不变；hint 行追加「当前模式不生效」）。
				var fieldInactive = modeInactiveKeys.indexOf(field.key) >= 0;
				// 批 3（UX §5.4/§5.6）：冲突橙标命中 + 数字行内校验标红命中。
				var overwritten = remoteOverwrittenKeys.indexOf(field.key) >= 0;
				var fieldInvalidMessage = field.type === "number" && invalidNumbers[field.key] != null
					? String(invalidNumbers[field.key])
					: null;
				var control;
				if (field.type === "boolean") {
					// §3.2 纯 CSS 开关：checkbox 语义保留（视觉隐藏 + 24×24 命中区覆盖轨道），
					// track 为紧随 input 的兄弟节点（兄弟选择器驱动轨道底色/滑块位移），开/关文本保留。
					control = h(ReactImpl, "label", { className: "obx-toggle" },
						h(ReactImpl, "input", {
							type: "checkbox", className: "obx-switch-input", checked: value === true, disabled: options.disabled === true || fieldInactive,
							onChange: function (event) { onChange(field, event.target.checked); },
						}),
						h(ReactImpl, "span", { className: "obx-switch-track", "aria-hidden": "true" }),
						value === true ? "开" : "关");
				} else if (field.type === "enum") {
					control = h(ReactImpl, "select", {
						className: "obx-select", value: String(value == null ? "" : value), disabled: options.disabled === true || fieldInactive,
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					}, field.options.map(function (option) {
						return h(ReactImpl, "option", { key: option, value: option }, field.optionLabels[option] != null ? field.optionLabels[option] : option);
					}));
				} else if (field.type === "stringArray") {
					control = h(ReactImpl, "textarea", {
						className: "obx-textarea", rows: 3, value: String(value == null ? "" : value), disabled: options.disabled === true || fieldInactive,
						placeholder: "每行一个",
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					});
				} else if (field.type === "secret") {
					// 密码型输入且不明文回显：value 恒为用户本次输入（初始 ''），占位符提示留空不改；
					// 已配置状态只展示脱敏徽标，绝不渲染任何明文。
					// 批 2（UX §6 + integration §2.4）徽标三态：已配置（accent 点）/ 未配置 /
					// 保存后清空（橙，仅「确有已保存值 + 勾选清除」时——secretSet:false +
					// 勾清除仍显「未配置」，保持既有渲染契约）；互斥由面板 onSecretChange
					// 实现（输入新值即取消清除勾选）。勾选清除时输入框描边转 --obx-warning
					// 并追加行内提示「将清除已保存的值」。
					var clearActive = options.clearSecret === true;
					var secretBadgeClassName = "obx-secret-badge";
					var secretBadgeText;
					if (clearActive && options.secretSet === true) {
						secretBadgeClassName += " obx-secret-badge--clear";
						secretBadgeText = secretClearPendingText;
					} else if (options.secretSet === true) {
						secretBadgeClassName += " obx-secret-badge--set";
						secretBadgeText = secretSetText;
					} else {
						secretBadgeText = secretUnsetText;
					}
					control = h(ReactImpl, "span", { className: "obx-control" },
						h(ReactImpl, "input", {
							type: "password", className: clearActive ? "obx-input obx-input--warn" : "obx-input", value: String(value == null ? "" : value),
							placeholder: "留空 = 不修改", autoComplete: "new-password", disabled: options.disabled === true || fieldInactive,
							onChange: function (event) { onSecretChange(event.target.value); },
							"aria-label": field.label,
						}),
						// §3.4 徽章加 8px 状态点：已配置=accent / 未配置=border-strong /
						// 保存后清空=warning（纯视觉状态点）
						h(ReactImpl, "span", { className: secretBadgeClassName }, secretBadgeText),
						h(ReactImpl, "label", { className: "obx-toggle" },
							h(ReactImpl, "input", {
								type: "checkbox", checked: clearActive, disabled: options.disabled === true || fieldInactive,
								onChange: function (event) { onClearSecretChange(event.target.checked); },
							}),
							secretClearLabelText),
						clearActive ? h(ReactImpl, "span", { className: "obx-hint obx-hint--warn" }, secretClearHintText) : null);
				} else {
					// §3.1 数字输入 160px：number 字段仍以 type=text 渲染（既有渲染形态不变），
					// 仅按类型加 obx-input--number 收窄 max-width。
					// 批 3（UX §5.6）：行内校验标红——非法命中挂 obx-input--invalid（批 1
					// 预铺样式）+ aria-invalid="true"；number 键 blur 触发面板侧校验
					//（标红不阻断输入，保存按钮禁用由面板层落位）。
					var isNumberField = field.type === "number";
					control = h(ReactImpl, "input", {
						type: "text",
						className: (isNumberField ? "obx-input obx-input--number" : "obx-input")
							+ (fieldInvalidMessage != null ? " obx-input--invalid" : ""),
						value: String(value == null ? "" : value), disabled: options.disabled === true || fieldInactive,
						onChange: function (event) { onChange(field, event.target.value); },
						onBlur: isNumberField ? function (event) { onNumberBlur(field, event.target.value); } : undefined,
						"aria-invalid": fieldInvalidMessage != null ? "true" : undefined,
						"aria-label": field.label,
					});
				}
				// 批 2（UX §3.2）：mode 不生效 hint 与既有字段 hint 合并为同一 hint 行
				//（@container grid 布局下 .obx-field>.obx-hint 固定占 row 2，双节点会
				// 重叠），不生效部分以 warning 色内嵌强调。
				var hintChildren = [];
				if (field.hint != null) hintChildren.push(field.hint);
				if (fieldInactive) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(h(ReactImpl, "span", { className: "obx-hint--warn" }, modeInactiveText));
				}
				// 批 3（UX §5.4）：冲突合并后本地编辑被远端覆盖的键——行内橙标提示。
				if (overwritten) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(h(ReactImpl, "span", { className: "obx-hint--warn" }, remoteOverwrittenText));
				}
				// 批 3（UX §5.6）：数字行内校验非法——行内红字提示合法范围。
				if (fieldInvalidMessage != null) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(h(ReactImpl, "span", { className: "obx-hint--invalid" }, fieldInvalidMessage));
				}
				var nodes = [
					h(ReactImpl, "div", { className: "obx-field", key: field.key },
						h(ReactImpl, "span", { className: "obx-label" }, field.label),
						// W6「非默认」徽标（对齐竞品 v0.6.0 行话术）：快照生效值 ≠ schema 默认值
						// 时标注，帮助一眼识别改过哪些开关；「待重启」徽标不适用本插件——
						// 保存经宿主 configEditor.edit 热生效（整条 fiber 秒级原地重启，
						// docs/settings-page-design.md §5），不存在键级「配置文件值≠生效值」稳态。
						nonDefaultKeys.indexOf(field.key) >= 0
							? h(ReactImpl, "span", { className: "obx-badge", title: "与默认值不同" }, "非默认")
							: null,
						control,
						hintChildren.length > 0
							? h.apply(null, [ReactImpl, "span", { className: "obx-hint" }].concat(hintChildren))
							: null),
				];
				// W7：可选扩展点——字段行后追加组内附加行（connection 组 workspacePath
				// 下方的「快速填入 workspace」行由此注入；独立 class 不计入 obx-field 行数）。
				if (typeof options.renderExtraRow === "function") {
					var extra = options.renderExtraRow(field);
					if (extra != null) nodes.push(extra);
				}
				return nodes;
			});
			// 批 2（UX §2.2）：组描述行——标题下的一句人话（integration §2.5 裁定取
			// UX §2.2 版文案，经 opts.groupDesc 传入；缺省不渲染）。
			if (collapsible != null) {
				// 批 2（UX §3.1 + visual §2）：details/summary 原生折叠——键盘可达、零
				// JS 依赖；summary 行 = 组标题 + 组描述 + meta pill（「N 项 · M 项默认
				// 开」复用 .obx-meta）+ 脏标记（「● 含未保存修改」）。折叠不隐藏变更：
				// patch/保存与折叠无关，提交计数仍含诊断字段；aria-expanded/aria-controls 齐备。
				var summaryChildren = [h(ReactImpl, "h3", { className: "obx-group-title" }, group.title)];
				if (groupDesc != null) summaryChildren.push(h(ReactImpl, "span", { className: "obx-group-desc" }, groupDesc));
				if (collapsible.summaryMeta != null) summaryChildren.push(h(ReactImpl, "span", { className: "obx-meta" }, collapsible.summaryMeta));
				if (collapsible.dirtyMark != null) summaryChildren.push(h(ReactImpl, "span", { className: "obx-group-dirty" }, collapsible.dirtyMark));
				return h(ReactImpl, "details", {
					className: "obx-group obx-group--collapsible", "data-group": group.id,
					open: collapsible.open === true,
					onToggle: typeof collapsible.onToggle === "function" ? collapsible.onToggle : undefined,
				},
					h.apply(null, [ReactImpl, "summary",
						{ className: "obx-group-summary", "aria-expanded": collapsible.open === true, "aria-controls": "obx-group-body-" + group.id }]
						.concat(summaryChildren)),
					h(ReactImpl, "div", { className: "obx-group-body", id: "obx-group-body-" + group.id },
						fieldNodes));
			}
			var sectionChildren = [h(ReactImpl, "h3", { className: "obx-group-title" }, group.title)];
			if (groupDesc != null) sectionChildren.push(h(ReactImpl, "p", { className: "obx-group-desc" }, groupDesc));
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
		function renderWorkspacePicker(ReactImpl, opts) {
			var options = opts == null ? {} : opts;
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
						? "暂无 workspace 记录，可直接输入路径。"
						: "无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。");
			}
			var selectedId = typeof options.selectedId === "string" ? options.selectedId : "";
			var selected = null;
			for (var workspace of workspaces) {
				if (workspace != null && String(workspace.id) === selectedId) selected = workspace;
			}
			var disabled = options.disabled === true;
			return h(ReactImpl, "div", { className: "obx-workspace-row", "data-role": "workspace-picker" },
				h(ReactImpl, "span", { className: "obx-label" }, "快速填入 workspace"),
				h(ReactImpl, "select", {
					className: "obx-select", value: selectedId, disabled: disabled,
					"aria-label": "快速填入 workspace",
					title: "列出宿主 workspace 注册表中的工作区；选中后点「填入」写入上方路径输入框（只填值，保存仍走「保存设置」按钮）",
					onChange: function (event) {
						var onSelectedChange = options.onSelectedChange;
						if (typeof onSelectedChange === "function") onSelectedChange(event.target.value);
					},
				},
					h(ReactImpl, "option", { key: "", value: "" }, "选择 workspace…"),
					workspaces.map(function (workspace) {
						var label = String(workspace.path == null ? "" : workspace.path) + "（" + String(workspace.sessionCount == null ? 0 : workspace.sessionCount) + " 会话）";
						return h(ReactImpl, "option", { key: String(workspace.id), value: String(workspace.id) }, label);
					})),
				h(ReactImpl, "button", {
					className: "obx-btn", type: "button", disabled: disabled || selected == null,
					onClick: function () {
						var onApply = options.onApply;
						if (selected != null && typeof onApply === "function") onApply(selected.path);
					},
				}, "填入"),
				h(ReactImpl, "span", { className: "obx-hint" }, "选中后点「填入」仅写入上方输入框；需点「保存设置」才会保存（对新会话生效，已设 /workspace 覆盖的会话不受影响）。"));
		}

		//#region 面板组件
		/**
		 * QQ Bot 设置面板。
		 * @param props t 为宿主注入的翻译函数（locale: NS，语言切换自动重渲染）；
		 *        remote 为挂载后的 `remote.onebotSettings` API。
		 */
		function OnebotSettingsPanel(props) {
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
			// 批 2（UX §3.1）：诊断组折叠态——sessionStorage 持久化（键
			// dsh-onebot-qq.diagnosticsExpanded，"1" = 展开），默认折叠；读写均容错
			//（隐私模式/非浏览器环境静默降级为默认折叠）。
			var diagnosticsExpandedState = React.useState(function () {
				try {
					return window.sessionStorage.getItem(DIAGNOSTICS_EXPANDED_KEY) === "1";
				} catch (error) {
					return false;
				}
			});
			var diagnosticsExpanded = diagnosticsExpandedState[0];
			var setDiagnosticsExpanded = diagnosticsExpandedState[1];
			var toggleDiagnostics = function (event) {
				var nextOpen = event != null && event.target != null && event.target.open === true;
				setDiagnosticsExpanded(nextOpen);
				try {
					window.sessionStorage.setItem(DIAGNOSTICS_EXPANDED_KEY, nextOpen ? "1" : "0");
				} catch (error) { /* 持久化不可用时仅内存态生效 */ }
			};
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

			/** 接受新快照：草稿按快照重置（accessToken 明文绝不进入草稿）。 */
			var accept = function (next) {
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
				void remote.getSettings().then(function (result) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause) {
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
						setWorkspace(function (previous) {
							return Object.assign({}, previous, { retryBlocked: false });
						});
					}, WORKSPACE_RETRY_COOLDOWN_MS);
				});
			};

			var refetch = function () {
				void remote.getSettings().then(function (result) {
					accept(unwrap(result));
					setError(null);
					setNotice("");
				}).catch(function (cause) {
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
				void remote.getSettings().then(function (result) {
					var next = unwrap(result);
					var merged = mergeOnConflict(draft, snapshot == null ? null : snapshot.config, next.config);
					setSnapshot(next);
					setDraft(merged.draft);
					setConflictKeys(merged.conflictKeys);
					setConflictActive(true);
					setInvalidNumbers(function (previous) {
						var pruned = {};
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
				}).catch(function (cause) {
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

			// 批 3（UX §5.6）：数字行内校验——blur 记态（非法 → 合法范围文案），修正
			// 自动消除（onChange 对已标红键即时重校验）。标红不阻断输入；保存按钮禁用
			// 由渲染层按标红键数落位（§5.6 原文「保存按钮禁用并 title 说明」），
			// computePatch 的 NaN invalidKeys 拦截保留为 save() 内最后防线。
			var handleNumberBlur = function (field, rawText) {
				var range = numberRangeInvalid(field, rawText); // null = 合法；string = 合法范围文案
				setInvalidNumbers(function (previous) {
					if (range == null) {
						if (previous[field.key] == null) return previous;
						var cleared = Object.assign({}, previous);
						delete cleared[field.key];
						return cleared;
					}
					if (previous[field.key] === range) return previous;
					return Object.assign({}, previous, (function () { var marked = {}; marked[field.key] = range; return marked; })());
				});
			};

			// 批 2（UX §5.7）：有未保存修改时注册 beforeunload 离开防护（浏览器原生
			// 确认框，文案由浏览器决定、不可定制）。已知限制（UX 方案 A3/§10.3）：
			// beforeunload 只能拦截页面级离开/刷新；宿主 SPA 内路由切换时面板随路由
			// 卸载、页面本身不重载，原生不触发该事件，宿主亦未提供未保存更改离开守卫
			// 扩展点——如实不拦截，不做 history 劫持等过界方案。
			React.useEffect(function () {
				if (dirtyCount === 0) return undefined;
				var handler = function (event) {
					event.preventDefault();
					event.returnValue = ""; // Chrome/Edge 需显式 returnValue 才弹原生确认
					return "";
				};
				window.addEventListener("beforeunload", handler);
				return function () { window.removeEventListener("beforeunload", handler); };
			}, [dirtyCount > 0]);

			if (snapshot === null || draft === null) {
				// 批 2（UX §7）：加载失败停留当前面板——错误横幅 + 重试按钮走既有
				// refetch（不新增请求方法）；成功后快照落位回到完整面板。
				return h(React, "div", { className: "obx-panel" },
					h(React, "p", { className: "obx-hint" }, t("settings.loading")),
					error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error),
					error === null ? null : h(React, "button", { className: "obx-btn", type: "button", onClick: refetch }, t("common.retry")));
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

			// 批 2（UX §3.1）：诊断组折叠 summary 数据——「N 项 · M 项默认开」按
			// GROUPS/DEFAULTS 派生（M = 默认 true 的 actionAuditEnabled/injectDryRun）；
			// 脏标记只看诊断键是否落入 dirtyKeys——折叠不隐藏变更（patch/保存与折叠
			// 无关，工具栏 badge 与提交计数仍含诊断字段）。
			var diagnosticsGroup = GROUPS.find(function (group) { return group.id === "diagnostics"; });
			var diagnosticsTotal = diagnosticsGroup != null ? diagnosticsGroup.fields.length : 0;
			var diagnosticsDefaultOnCount = diagnosticsGroup == null
				? 0
				: diagnosticsGroup.fields.filter(function (field) { return DEFAULTS[field.key] === true; }).length;
			var diagnosticsKeys = GROUP_KEYS.diagnostics != null ? GROUP_KEYS.diagnostics : [];
			var diagnosticsDirty = dirtyKeys.some(function (key) { return diagnosticsKeys.indexOf(key) >= 0; });

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
			var invalidNumberMessages = {};
			var invalidNumberLabels = [];
			Object.keys(invalidNumbers).forEach(function (key) {
				var field = ALL_FIELDS.find(function (item) { return item.key === key; });
				if (field != null) invalidNumberLabels.push(field.label);
				invalidNumberMessages[key] = format(t("field.numberInvalid"), { range: invalidNumbers[key] });
			});
			var invalidNumberCount = Object.keys(invalidNumbers).length;

			var changeHandlers = {
				disabled: busy,
				secretSet: secretSet,
				clearSecret: clearSecret,
				nonDefaultKeys: nonDefaultKeys,
				draft: draft,
				// 批 3（UX §5.6/§5.4）：行内校验标红数据源 + blur 校验入口 + 冲突橙标键
				invalidNumbers: invalidNumberMessages,
				onNumberBlur: handleNumberBlur,
				remoteOverwrittenKeys: conflictKeys,
				// W7：workspacePath 字段行下方的「快速填入 workspace」行（独立于
				// obx-field 行；onApply 只写草稿不保存——保存仍走 save() 显式通道）。
				renderExtraRow: function (field) {
					if (field.key !== "workspacePath") return null;
					return renderWorkspacePicker(React, {
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
						onSelectedChange: function (nextId) {
							setWorkspace(Object.assign({}, workspace, { selectedId: nextId }));
						},
						onApply: function (path) {
							setDraft(fillWorkspacePath(draft, path));
						},
					});
				},
				onChange: function (field, nextValue) {
					setDraft(Object.assign({}, draft, (function () { var next = {}; next[field.key] = nextValue; return next; })()));
					// 批 3（UX §5.6）：已标红的数字键随输入重校验，修正后自动消除标红
					if (field.type === "number" && invalidNumbers[field.key] != null) handleNumberBlur(field, nextValue);
					// 批 3（UX §5.4）：冲突键被再次编辑后撤销行内橙标（该提示描述的是被
					// 覆盖时刻的状态，用户改值后不再成立）
					if (conflictKeys.indexOf(field.key) >= 0) setConflictKeys(conflictKeys.filter(function (key) { return key !== field.key; }));
				},
				onSecretChange: function (nextText) {
					setSecretDraft(nextText);
					setDraft(Object.assign({}, draft, (function () { var next = {}; next.accessToken = nextText; return next; })()));
					setClearSecret(false); // 批 2（UX §6）互斥：输入新值即取消「清除已保存」勾选
				},
				onClearSecretChange: function (nextChecked) {
					setClearSecret(nextChecked);
				},
			};

			// 批 3（UX §5.4）：冲突横幅改显式状态——refetchMerged 置位 conflictActive，
			// save() 开场/失败分支与 refetch()/accept() 复位（替换批 1 的文案恒等派生）。

			return h(React, "div", { className: "obx-panel" },
				h(React, "h2", { className: "obx-title" }, t("settings.title")),
				h(React, "p", { className: "obx-desc" }, t("settings.desc")),
				h(React, "div", { className: "obx-toolbar" },
					h(React, "span", { className: "obx-meta" }, t("revision.label") + " " + String(snapshot.revision)),
					snapshot.entryActive === true ? null : h(React, "span", { className: "obx-meta obx-warn", title: t("effect.entryInactiveTitle") }, t("effect.entryInactive")),
					h(React, "span", { className: "obx-spacer" }),
					// 批 2（UX §5.1）：脏状态 badge——「N 项未保存」（含诊断组：折叠不隐藏变更）
					dirtyCount > 0 ? h(React, "span", { className: "obx-badge obx-warn" }, format(t("save.dirtyBadge"), { count: dirtyCount })) : null,
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: handleReload }, t("settings.reload")),
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: handleReset }, t("settings.reset")),
					// 批 2（UX §5.1）：无未保存修改时保存禁用（title 说明）；批 3（UX §5.6）
					// 数字行内校验非法时同样禁用（title 优先说明非法键——「保存按钮禁用并
					// title 说明」；noChanges 兜底文案保留在 save() 内）
					h(React, "button", {
						className: "obx-btn primary", type: "button",
						disabled: busy || dirtyCount === 0 || invalidNumberCount > 0,
						title: invalidNumberCount > 0
							? format(t("save.badNumber"), { keys: invalidNumberLabels.join("、") })
							: dirtyCount === 0 ? t("save.noChangesTitle") : undefined,
						onClick: save,
					}, busy ? t("save.saving") : t("save.submit"))),
				// UX §5.5 / UI §4.1：反馈结果条上移至工具栏之后、热生效提示条之前
				// （纯 DOM 移动，role/文案/逻辑全保留——本批唯一 createElement 结构调整）。
				error === null ? null : h(React, "div", { className: "obx-error" + (conflictActive ? " obx-error--conflict" : ""), role: "alert" }, t("status.error") + "：" + error),
				notice === "" ? null : h(React, "p", { className: "obx-notice" }, notice),
				h(React, "div", { className: "obx-effect" }, t("effect.hint")),
				GROUPS.map(function (group) {
					// 批 2：交互 opts（texts/groupDesc/modeInactiveKeys）+ 诊断组折叠配置
					//（UX §3.1：仅诊断组可折叠，默认收起，开合持久化 sessionStorage）。
					return renderGroup(React, group, Object.assign({}, changeHandlers, {
						texts: texts,
						groupDesc: t("group." + group.id + ".desc"),
						modeInactiveKeys: modeInactiveKeys,
						collapsible: group.id === "diagnostics" ? {
							open: diagnosticsExpanded,
							onToggle: toggleDiagnostics,
							summaryMeta: format(t("diagnostics.summary"), { total: diagnosticsTotal, enabled: diagnosticsDefaultOnCount }),
							dirtyMark: diagnosticsDirty ? t("diagnostics.dirtyMark") : null,
						} : undefined,
					}));
				}));
		}
		//#endregion

		//#region 客户端入口
		var inject = ["slots", "locale", "remote"];
		/**
		 * 客户端入口：注入样式与词条、挂载 Typert Remote、注册设置面板。
		 * @returns {() => void} 卸载函数（对照先例：只回收 Remote 挂载；
		 *          样式/词条/slot 注册由宿主 ctx.effect 与 slot 生命周期回收）。
		 */
		async function apply(ctx) {
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
				function (props) { if (props && props.view === "summary") return t("settings.desc"); return React.createElement(OnebotSettingsPanel, Object.assign({}, props, { remote: remote })); },
			); });

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
		// 批 3（UX §5.4/§5.6）：冲突合并保留 + 数字行内校验（纯函数，单测护航）
		exports.NUMBER_RANGE = NUMBER_RANGE;
		exports.numberRangeInvalid = numberRangeInvalid;
		exports.mergeOnConflict = mergeOnConflict;

		return module.exports;
	}
});
