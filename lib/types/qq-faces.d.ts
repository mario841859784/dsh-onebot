/**
 * T6（PR port 官方表情名表）：QQ 官方表情 id → 官方名称（NapCat 自带名表，
 * 源自贡献者 qq-faces.json，随包内置）。faceStyle='name'（默认）时
 * [CQ:face] 按「[名称]」呈现文本；表外 id 降级「[表情id]」。
 * 以 TS 模块内置（本批 scope 不含 tsconfig/build.sh 变更，故不经
 * resolveJsonModule/资源拷贝管线，直接随 tsc 编译进 lib）。
 */
export declare const QQ_FACES: Readonly<Record<string, string>>;
