// modules/multimodalSyntaxParser.js
// 多模态占位符语法解析引擎
// 统一解析 {{XX日记本::PresetName01::OverBase64:NoCaching:logo.png;bar.png}} 等参数

/**
 * 解析多模态日记本占位符参数
 * @param {string} rawPlaceholder - 捕获组内容，如 "XX日记本::PresetName01::OverBase64:NoCaching"
 * @returns {object} 解析结果
 */
function parseMultimodalParams(rawPlaceholder) {
    const diaryMatch = rawPlaceholder.match(/^(.+?)日记本(.*)$/);
    if (!diaryMatch) return { diaryName: rawPlaceholder, params: {}, hasMultimodal: false };

    const diaryName = diaryMatch[1];
    const rawModifiers = diaryMatch[2] || '';

    // 无修饰符 → 纯文本模式
    if (!rawModifiers.trim()) {
        return {
            diaryName,
            presetName: null,
            mode: null,
            specifiedFiles: [],
            flags: { noCaching: false, noText: false, tagOnly: false },
            resolveLevel: null,
            resolveDepth: 1,
            rawModifiers: '',
            hasMultimodal: false
        };
    }

    // 按 :: 分割参数
    const parts = rawModifiers.split('::').map(p => p.trim()).filter(Boolean);

    const result = {
        diaryName,
        presetNames: [],         // [PresetName01, PresetName02]
        mode: null,              // OverBase64 | ShowBase64 | ShowBase64+
        specifiedFiles: [],      // logo.png;bar.png
        flags: { noCaching: false, noText: false, tagOnly: false, hideFilePath: false },
        resolveLevel: null,      // AgentName | Tar | Var | Sar | MetaThought
        resolveDepth: 1,         // ::Tar:2 → depth=2
        rawModifiers: rawModifiers,
        hasMultimodal: false     // 是否包含多模态相关参数
    };

    // 已知的解析层级关键字
    const resolveLevels = ['tar', 'var', 'sar', 'metathought'];
    // 用于统计连续出现的同名层级
    const resolveLevelCounts = {};

    for (const part of parts) {
        const lower = part.toLowerCase();

        // 模式检测（顺序重要：ShowBase64+ 必须在 ShowBase64 之前）
        if (lower === 'overbase64') {
            result.mode = 'OverBase64';
            result.hasMultimodal = true;
            continue;
        }
        if (lower === 'showbase64+') {
            result.mode = 'ShowBase64+';
            result.hasMultimodal = true;
            continue;
        }
        if (lower === 'showbase64') {
            result.mode = 'ShowBase64';
            result.hasMultimodal = true;
            continue;
        }

        // 包含 : 的子参数（如 NoCaching:logo.png;bar.png 或 Tar:2）
        if (part.includes(':')) {
            const subs = part.split(':').filter(Boolean);
            for (const sub of subs) {
                const ls = sub.toLowerCase();
                if (ls === 'nocaching') {
                    result.flags.noCaching = true;
                } else if (ls === 'notext') {
                    result.flags.noText = true;
                } else if (ls === 'tagonly') {
                    result.flags.tagOnly = true;
                } else if (ls === 'hidefilepath') {
                    result.flags.hideFilePath = true;
                } else if (sub.includes(';') || sub.includes('.')) {
                    // 文件列表：logo.png;bar.png 或单个文件 logo.png
                    result.specifiedFiles.push(...sub.split(';').filter(Boolean));
                } else if (/^\d+$/.test(sub)) {
                    // 纯数字 → resolveDepth
                    result.resolveDepth = parseInt(sub, 10);
                } else if (resolveLevels.includes(ls)) {
                    // 解析层级关键字出现在 : 分隔中
                    resolveLevelCounts[ls] = (resolveLevelCounts[ls] || 0) + 1;
                    result.resolveLevel = sub;
                }
            }
            continue;
        }

        // 解析层级关键字（独立出现）
        if (resolveLevels.includes(lower)) {
            resolveLevelCounts[lower] = (resolveLevelCounts[lower] || 0) + 1;
            result.resolveLevel = part;
            continue;
        }

        // 标志检测（独立出现，无 : 前缀）
        if (lower === 'nocaching') {
            result.flags.noCaching = true;
            continue;
        }
        if (lower === 'notext') {
            result.flags.noText = true;
            continue;
        }
        if (lower === 'tagonly') {
            result.flags.tagOnly = true;
            continue;
        }
        if (lower === 'hidefilepath') {
            result.flags.hideFilePath = true;
            continue;
        }

        // 非已知关键字 → 预设名或 Agent 名
        if (result.presetNames.length === 0) {
            // 支持分号分隔的多个预设
            result.presetNames = part.split(';').map(p => p.trim()).filter(Boolean);
        } else if (!result.resolveLevel) {
            // 第二个未知名 → 视为 resolveLevel（AgentName）
            result.resolveLevel = part;
        }
    }

    // 叠加语法处理：::Tar::Tar 等价于 ::Tar:2
    if (result.resolveLevel) {
        const levelKey = result.resolveLevel.toLowerCase();
        if (resolveLevelCounts[levelKey] && resolveLevelCounts[levelKey] > 1) {
            result.resolveDepth = Math.max(result.resolveDepth, resolveLevelCounts[levelKey]);
        }
    }

    // 如果有多模态 mode 但没有指定预设，默认使用 All (返回所有段落)
    if (result.mode && result.presetNames.length === 0) {
        result.presetNames = ['All'];
    }

    return result;
}

/**
 * 检查解析结果是否包含多模态参数
 */
function hasMultimodalMode(parsed) {
    return parsed.mode !== null;
}

/**
 * 检查解析结果是否需要返回 ContentPart[] 格式
 */
function requiresContentParts(parsed) {
    return parsed.mode === 'ShowBase64' || parsed.mode === 'ShowBase64+';
}

module.exports = { parseMultimodalParams, hasMultimodalMode, requiresContentParts };