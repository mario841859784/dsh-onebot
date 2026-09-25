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
 *   - 面板注册：`ctx.slots.inject('settings.section', () => ctx.slots.register(
 *     {name,id,order,label,locale,icon}, render))`。
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
 *   - 方法集 = getSettings() / updateSettings(patch, expectedRevision)，
 *     全 positional（宿主网关 methodParameterNames 拒绝解构/默认值/rest）；
 *   - 快照结构 = T1 §3 OnebotSettingsSnapshot（revision/entryActive/config(19 键)/
 *     secrets/groups/effect='restart'），accessToken 恒 ''（脱敏，T1 §3）；
 *   - 三组 19 键分组与 schema 默认值 = T1 §4 表 = src/settings-remote.ts 常量。
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
		var SLOT_ID = "onebot-settings";
		var SLOT_ORDER = 18;
		//#endregion

		//#region 三组 19 键字段定义（T1 §4 表：分组/键集/类型/默认值；与
		//  src/settings-remote.ts SETTINGS_GROUPS / SCHEMA_DEFAULTS / 类型分组逐字对齐，
		//  tests/client-settings.spec.ts 断言一致性）
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
				],
			},
		];
		/** 全部 19 键扁平表（顺序 = 三组声明顺序，与 host ALL_KEYS 语义一致）。 */
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
		/** 19 键生效值（host buildSnapshot 的 effectiveConfig 全键返回；accessToken 恒 ''）。 */
		var configSchema = vObject({
			mode: vEnum(["reverse", "forward"]),
			host: vString(0, 256),
			port: vNumber(),
			url: vString(0, 512),
			accessToken: vString(0, 256),
			botQQ: vString(0, 64),
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
			}),
			effect: vEnum(["restart"]), // T1 §5：19 键统一插件级热重启
		});
		/** updateSettings 入参（T1 §4：19 键任意子集的扁平 JSON；accessToken 缺省=不改，''=清空）。 */
		var patchSchema = vObject({
			mode: vOptional(vEnum(["reverse", "forward"])),
			host: vOptional(vString(0, 256)),
			port: vOptional(vNumber(1, 65535)),
			url: vOptional(vString(0, 512)),
			accessToken: vOptional(vString(0, 256)),
			botQQ: vOptional(vString(0, 64)),
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
		});
		//#endregion

		//#region Typert Remote 严格 descriptor（与 host lib/settings-remote.js 服务方法面
		//  逐字对齐：getSettings() / updateSettings(patch, expectedRevision)，全 positional。
		//  host 侧未导出客户端 descriptor 数组——两侧各自持有一份，本数组为客户端真相源，
		//  变更须同步宿主侧并在 DEVLOG 记录；tests/client-settings.spec.ts 做契约核对。）
		function strictCodec(typeSymbol, schema) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
		}
		function jsonParameter(name, typeSymbol, schema) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function onebotMethod(method, parameters, resultSchema) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec("OnebotSettingsSnapshot", resultSchema || snapshotSchema),
			};
		}
		var ONEBOT_SETTINGS_DESCRIPTORS = [
			onebotMethod("getSettings", []),
			onebotMethod("updateSettings", [
				jsonParameter("patch", "OnebotSettingsPatch", patchSchema),
				jsonParameter("expectedRevision", "number", vOptional(vInt(0))),
			]),
		];
		var ONEBOT_SETTINGS_REMOTE = { package: PLUGIN_ID, descriptors: ONEBOT_SETTINGS_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式。
		//  分组标题与字段 label 是中文常量（T4 要求），不走词条。）
		var zh = {
			"settings.nav": "QQ Bot（OneBot）",
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
		};
		var en = {
			"settings.nav": "QQ Bot (OneBot)",
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
		var CSS = [
			".obx-panel{display:flex;flex-direction:column;gap:16px;font-size:14px;line-height:1.5}",
			".obx-title{font-size:16px;font-weight:600;margin:0}",
			".obx-desc{opacity:.72;margin:4px 0 0}",
			".obx-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".obx-spacer{flex:1}",
			".obx-meta{opacity:.72;font-size:12px}",
			".obx-error{border:1px solid #e5484d;background:rgba(229,72,77,.08);color:#e5484d;border-radius:8px;padding:8px 12px}",
			".obx-alert[role=alert]{white-space:pre-wrap}",
			".obx-notice{opacity:.85;min-height:1em}",
			".obx-effect{border:1px dashed rgba(128,128,128,.45);border-radius:8px;padding:8px 12px;opacity:.85}",
			".obx-warn{color:#d97706}",
			".obx-group{display:flex;flex-direction:column;gap:10px;border-top:1px solid rgba(128,128,128,.2);padding-top:12px}",
			".obx-group-title{font-weight:600;margin:0}",
			".obx-field{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}",
			".obx-label{font-size:12px;opacity:.8;min-width:180px}",
			".obx-control{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:1;min-width:240px}",
			".obx-input,.obx-select,.obx-textarea{flex:1;min-width:160px;max-width:420px;box-sizing:border-box;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;padding:6px 8px;font:inherit}",
			".obx-textarea{max-width:520px;min-height:56px;resize:vertical}",
			".obx-toggle{display:inline-flex;align-items:center;gap:6px}",
			".obx-hint{opacity:.65;font-size:12px;flex-basis:100%}",
			".obx-secret-badge{font-size:11px;border:1px solid rgba(128,128,128,.4);border-radius:999px;padding:0 8px;opacity:.8}",
			".obx-btn{cursor:pointer;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;padding:4px 10px}",
			".obx-btn:hover:not(:disabled){border-color:currentColor}",
			".obx-btn:disabled{opacity:.45;cursor:not-allowed}",
			".obx-btn.primary{border-color:currentColor;font-weight:600}",
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
		 * 计算保存 patch（T1 §4：19 键任意子集的扁平 JSON）。
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
		 * @param opts.draft 表单草稿（snapshotValueToDraft 形态）
		 */
		function renderGroup(ReactImpl, group, opts) {
			var options = opts == null ? {} : opts;
			var draft = options.draft == null ? {} : options.draft;
			var onChange = typeof options.onChange === "function" ? options.onChange : function () {};
			var onSecretChange = typeof options.onSecretChange === "function" ? options.onSecretChange : function () {};
			var onClearSecretChange = typeof options.onClearSecretChange === "function" ? options.onClearSecretChange : function () {};
			var fieldNodes = group.fields.map(function (field) {
				var value = draft[field.key];
				var control;
				if (field.type === "boolean") {
					control = h(ReactImpl, "label", { className: "obx-toggle" },
						h(ReactImpl, "input", {
							type: "checkbox", checked: value === true, disabled: options.disabled === true,
							onChange: function (event) { onChange(field, event.target.checked); },
						}),
						value === true ? "开" : "关");
				} else if (field.type === "enum") {
					control = h(ReactImpl, "select", {
						className: "obx-select", value: String(value == null ? "" : value), disabled: options.disabled === true,
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					}, field.options.map(function (option) {
						return h(ReactImpl, "option", { key: option, value: option }, field.optionLabels[option] != null ? field.optionLabels[option] : option);
					}));
				} else if (field.type === "stringArray") {
					control = h(ReactImpl, "textarea", {
						className: "obx-textarea", rows: 3, value: String(value == null ? "" : value), disabled: options.disabled === true,
						placeholder: "每行一个",
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					});
				} else if (field.type === "secret") {
					// 密码型输入且不明文回显：value 恒为用户本次输入（初始 ''），占位符提示留空不改；
					// 已配置状态只展示脱敏徽标，绝不渲染任何明文。
					control = h(ReactImpl, "span", { className: "obx-control" },
						h(ReactImpl, "input", {
							type: "password", className: "obx-input", value: String(value == null ? "" : value),
							placeholder: "留空 = 不修改", autoComplete: "new-password", disabled: options.disabled === true,
							onChange: function (event) { onSecretChange(event.target.value); },
							"aria-label": field.label,
						}),
						h(ReactImpl, "span", { className: "obx-secret-badge" }, options.secretSet === true ? "已配置（脱敏，不回显）" : "未配置"),
						h(ReactImpl, "label", { className: "obx-toggle" },
							h(ReactImpl, "input", {
								type: "checkbox", checked: options.clearSecret === true, disabled: options.disabled === true,
								onChange: function (event) { onClearSecretChange(event.target.checked); },
							}),
							"清除已保存的 AccessToken"));
				} else {
					control = h(ReactImpl, "input", {
						type: "text", className: "obx-input", value: String(value == null ? "" : value), disabled: options.disabled === true,
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					});
				}
				var nodes = [
					h(ReactImpl, "div", { className: "obx-field", key: field.key },
						h(ReactImpl, "span", { className: "obx-label" }, field.label),
						control,
						field.hint != null ? h(ReactImpl, "span", { className: "obx-hint" }, field.hint) : null),
				];
				return nodes;
			});
			return h(ReactImpl, "section", { className: "obx-group", "data-group": group.id },
				h(ReactImpl, "h3", { className: "obx-group-title" }, group.title),
				fieldNodes);
		}
		//#endregion

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

			/** 接受新快照：草稿按快照重置（accessToken 明文绝不进入草稿）。 */
			var accept = function (next) {
				setSnapshot(next);
				setDraft(draftFromSnapshot(next));
			};

			React.useEffect(function () {
				var alive = true;
				void remote.getSettings().then(function (result) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause) {
					if (alive) setError(messageOf(cause));
				});
				return function () { alive = false; };
			}, [remote]);

			var refetch = function () {
				void remote.getSettings().then(function (result) {
					accept(unwrap(result));
					setError(null);
					setNotice("");
				}).catch(function (cause) {
					setError(messageOf(cause));
				});
			};

			/** 保存统一通道：updateSettings(patch, expectedRevision)；冲突时提示并重拉快照。 */
			var save = function () {
				if (busy || snapshot == null || draft == null) return;
				setError(null);
				setNotice("");
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
						// T1 §3.1：revision 不一致 → 提示并重拉快照，用户核对后重放
						setError(t("conflict.title"));
						refetch();
					} else {
						setError(messageOf(cause));
					}
				}).finally(function () {
					setBusy(false);
				});
			};

			if (snapshot === null || draft === null) {
				return h(React, "div", { className: "obx-panel" },
					h(React, "p", { className: "obx-hint" }, t("settings.loading")),
					error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error));
			}

			var secretSet = false;
			if (Array.isArray(snapshot.secrets)) {
				for (var secretEntry of snapshot.secrets) {
					if (secretEntry != null && Array.isArray(secretEntry.path) && secretEntry.path.indexOf("accessToken") >= 0 && secretEntry.set === true) secretSet = true;
				}
			}
			if (clearSecret === true) secretSet = false; // 勾选清除后按“将清空”展示

			var changeHandlers = {
				disabled: busy,
				secretSet: secretSet,
				clearSecret: clearSecret,
				draft: draft,
				onChange: function (field, nextValue) {
					setDraft(Object.assign({}, draft, (function () { var next = {}; next[field.key] = nextValue; return next; })()));
				},
				onSecretChange: function (nextText) {
					setSecretDraft(nextText);
					setDraft(Object.assign({}, draft, (function () { var next = {}; next.accessToken = nextText; return next; })()));
				},
				onClearSecretChange: function (nextChecked) {
					setClearSecret(nextChecked);
				},
			};

			return h(React, "div", { className: "obx-panel" },
				h(React, "h2", { className: "obx-title" }, t("settings.title")),
				h(React, "p", { className: "obx-desc" }, t("settings.desc")),
				h(React, "div", { className: "obx-toolbar" },
					h(React, "span", { className: "obx-meta" }, t("revision.label") + " " + String(snapshot.revision)),
					snapshot.entryActive === true ? null : h(React, "span", { className: "obx-meta obx-warn" }, t("effect.entryInactive")),
					h(React, "span", { className: "obx-spacer" }),
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: refetch }, t("settings.reload")),
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: function () { setDraft(draftFromDefaults()); } }, t("settings.reset")),
					h(React, "button", { className: "obx-btn primary", type: "button", disabled: busy, onClick: save }, busy ? t("save.saving") : t("save.submit"))),
				h(React, "div", { className: "obx-effect" }, t("effect.hint")),
				GROUPS.map(function (group) {
					return renderGroup(React, group, changeHandlers);
				}),
				error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error),
				notice === "" ? null : h(React, "p", { className: "obx-notice" }, notice));
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

			ctx.slots.inject("settings.section", function () { return ctx.slots.register(
				// label 是 thunk：nav 行每次渲染读取，locale 切换后自动跟随。
				{ name: "settings.section", id: SLOT_ID, order: SLOT_ORDER, label: function () { return t("settings.nav"); }, locale: NS, icon: "settings" },
				function (props) { return React.createElement(OnebotSettingsPanel, Object.assign({}, props, { remote: remote })); },
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
		exports.coerceValue = coerceValue;
		exports.snapshotValueToDraft = snapshotValueToDraft;
		exports.draftFromSnapshot = draftFromSnapshot;
		exports.renderGroup = renderGroup;
		exports.OnebotSettingsPanel = OnebotSettingsPanel;

		return module.exports;
	}
});
