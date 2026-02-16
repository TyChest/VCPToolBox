// modules/messageProcessor.js
const fs = require('fs').promises;
const path = require('path');
const lunarCalendar = require('chinese-lunar-calendar');
const agentManager = require('./agentManager.js'); // 引入新的Agent管理器
const tvsManager = require('./tvsManager.js'); // 引入新的TVS管理器
const { parseMultimodalParams, hasMultimodalMode, requiresContentParts } = require('./multimodalSyntaxParser.js');
const mediaDescriptionManager = require('./mediaDescriptionManager.js');
const multimediaRecognizer = require('./multimediaRecognizer.js');

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Shanghai'; // 新增：用于控制 AI 报告的时间，默认回退到中国时区
const AGENT_DIR = path.join(__dirname, '..', 'Agent');
const TVS_DIR = path.join(__dirname, '..', 'TVStxt');
const VCP_ASYNC_RESULTS_DIR = path.join(__dirname, '..', 'VCPAsyncResults');

async function resolveAllVariables(text, model, role, context, processingStack = new Set()) {
    if (text == null) return '';
    let processedText = String(text);

    // 通用正则表达式，匹配所有 {{...}} 格式的占位符
    const placeholderRegex = /\{\{([a-zA-Z0-9_:]+)\}\}/g;
    const matches = [...processedText.matchAll(placeholderRegex)];
    
    // 提取所有潜在的别名（去除 "agent:" 前缀）
    const allAliases = new Set(matches.map(match => match[1].replace(/^agent:/, '')));

    for (const alias of allAliases) {
        // 关键：使用 agentManager 来判断这是否是一个真正的Agent
        if (agentManager.isAgent(alias)) {
            if (processingStack.has(alias)) {
                console.error(`[AgentManager] Circular dependency detected! Stack: [${[...processingStack].join(' -> ')} -> ${alias}]`);
                const errorMessage = `[Error: Circular agent reference detected for '${alias}']`;
                processedText = processedText.replaceAll(`{{${alias}}}`, errorMessage).replaceAll(`{{agent:${alias}}}`, errorMessage);
                continue;
            }

            const agentContent = await agentManager.getAgentPrompt(alias);
            
            processingStack.add(alias);
            const resolvedAgentContent = await resolveAllVariables(agentContent, model, role, context, processingStack);
            processingStack.delete(alias);

            // 替换两种可能的Agent占位符格式
            processedText = processedText.replaceAll(`{{${alias}}}`, resolvedAgentContent);
            processedText = processedText.replaceAll(`{{agent:${alias}}}`, resolvedAgentContent);
        }
    }

    // 在所有Agent都被递归展开后，处理剩余的非Agent占位符
    processedText = await replacePriorityVariables(processedText, context, role);
    processedText = await replaceOtherVariables(processedText, model, role, context);

    return processedText;
}

async function replaceOtherVariables(text, model, role, context) {
    const { pluginManager, cachedEmojiLists, detectors, superDetectors, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    // SarModel 高级预设注入，对 system 角色或 VCPTavern 注入的 user 角色生效
    if (role === 'system' || (role === 'user' && processedText.startsWith('[系统'))) {
        // 查找所有独特的 SarPrompt 占位符，例如 {{SarPrompt1}}, {{SarPrompt2}}
        const sarPlaceholderRegex = /\{\{(SarPrompt\d+)\}\}/g;
        const matches = [...processedText.matchAll(sarPlaceholderRegex)];
        const uniquePlaceholders = [...new Set(matches.map(match => match[0]))];

        for (const placeholder of uniquePlaceholders) {
            // 从 {{SarPrompt4}} 中提取 SarPrompt4
            const promptKey = placeholder.substring(2, placeholder.length - 2);
            // 从 SarPrompt4 中提取数字 4
            const numberMatch = promptKey.match(/\d+$/);
            if (!numberMatch) continue;

            const index = numberMatch[0];
            const modelKey = `SarModel${index}`;

            const models = process.env[modelKey];
            let promptValue = process.env[promptKey];
            let replacementText = ''; // 默认替换为空字符串

            // 检查模型和提示是否存在
            if (models && promptValue) {
                const modelList = models.split(',').map(m => m.trim().toLowerCase());
                // 检查当前模型是否在列表中
                if (model && modelList.includes(model.toLowerCase())) {
                    // 模型匹配，准备注入的文本
                    if (typeof promptValue === 'string' && promptValue.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(promptValue);
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            promptValue = fileContent;
                        } else {
                            // 递归解析文件内容中的变量
                            promptValue = await replaceOtherVariables(fileContent, model, role, context);
                        }
                    }
                    replacementText = promptValue;
                }
            }
            
            // 对当前文本中所有匹配的占位符进行替换
            const placeholderRegExp = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
            processedText = processedText.replace(placeholderRegExp, replacementText);
        }
    }

    if (role === 'system') {
        for (const envKey in process.env) {
            if (envKey.startsWith('Tar') || envKey.startsWith('Var')) {
                const placeholder = `{{${envKey}}}`;
                if (processedText.includes(placeholder)) {
                    const value = process.env[envKey];
                    if (value && typeof value === 'string' && value.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(value);
                        // 检查内容是否表示错误
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            processedText = processedText.replaceAll(placeholder, fileContent);
                        } else {
                            const resolvedContent = await replaceOtherVariables(fileContent, model, role, context);
                            processedText = processedText.replaceAll(placeholder, resolvedContent);
                        }
                    } else {
                        processedText = processedText.replaceAll(placeholder, value || `[未配置 ${envKey}]`);
                    }
                }
            }
        }

        const now = new Date();
        if (DEBUG_MODE) {
            console.log(`[TimeVar] Raw Date: ${now.toISOString()}`);
            console.log(`[TimeVar] Default Timezone (for internal use): ${DEFAULT_TIMEZONE}`);
            console.log(`[TimeVar] Report Timezone (for AI prompt): ${REPORT_TIMEZONE}`);
        }
        // 使用 REPORT_TIMEZONE 替换时间占位符
        const date = now.toLocaleDateString('zh-CN', { timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Date\}\}/g, date);
        const time = now.toLocaleTimeString('zh-CN', { timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Time\}\}/g, time);
        const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Today\}\}/g, today);
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const lunarDate = lunarCalendar.getLunar(year, month, day);
        let yearName = lunarDate.lunarYear.replace('年', '');
        let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`;
        if (lunarDate.solarTerm) festivalInfo += ` ${lunarDate.solarTerm}`;
        processedText = processedText.replace(/\{\{Festival\}\}/g, festivalInfo);
        
        const staticPlaceholderValues = pluginManager.getAllPlaceholderValues(); // Use the getter
        if (staticPlaceholderValues && staticPlaceholderValues.size > 0) {
            for (const [placeholder, value] of staticPlaceholderValues.entries()) {
                const placeholderRegex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
                // The getter now returns the correct string value
                processedText = processedText.replace(placeholderRegex, value || `[${placeholder} 信息不可用]`);
            }
        }

        const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions();
        if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
            for (const [placeholderKey, description] of individualPluginDescriptions) {
                processedText = processedText.replaceAll(`{{${placeholderKey}}}`, description || `[${placeholderKey} 信息不可用]`);
            }
        }

        if (processedText.includes('{{VCPAllTools}}')) {
            const vcpDescriptionsList = [];
            if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
                for (const description of individualPluginDescriptions.values()) {
                    vcpDescriptionsList.push(description);
                }
            }
            const allVcpToolsString = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
            processedText = processedText.replaceAll('{{VCPAllTools}}', allVcpToolsString);
        }

        if (process.env.PORT) {
            processedText = processedText.replaceAll('{{Port}}', process.env.PORT);
        }
        const effectiveImageKey = pluginManager.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
        if (processedText && typeof processedText === 'string' && effectiveImageKey) {
            processedText = processedText.replaceAll('{{Image_Key}}', effectiveImageKey);
        } else if (processedText && typeof processedText === 'string' && processedText.includes('{{Image_Key}}')) {
            if (DEBUG_MODE) console.warn('[replaceOtherVariables] {{Image_Key}} placeholder found in text, but ImageServer plugin or its Image_Key is not resolved. Placeholder will not be replaced.');
        }
        for (const rule of detectors) {
            if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
                processedText = processedText.replaceAll(rule.detector, rule.output);
            }
        }
    }
    
    for (const rule of superDetectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
            processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }

    const asyncResultPlaceholderRegex = /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g;
    let asyncMatch;
    let tempAsyncProcessedText = processedText;
    const promises = [];

    while ((asyncMatch = asyncResultPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = asyncMatch[0];
        const pluginName = asyncMatch[1];
        const requestId = asyncMatch[2];
        
        promises.push(
            (async () => {
                const resultFilePath = path.join(VCP_ASYNC_RESULTS_DIR, `${pluginName}-${requestId}.json`);
                try {
                    const fileContent = await fs.readFile(resultFilePath, 'utf-8');
                    const callbackData = JSON.parse(fileContent);
                    let replacementText = `[任务 ${pluginName} (ID: ${requestId}) 已完成]`;
                    if (callbackData && callbackData.message) {
                        replacementText = callbackData.message;
                    } else if (callbackData && callbackData.status === 'Succeed') {
                         replacementText = `任务 ${pluginName} (ID: ${requestId}) 已成功完成。详情: ${JSON.stringify(callbackData.data || callbackData.result || callbackData)}`;
                    } else if (callbackData && callbackData.status === 'Failed') {
                        replacementText = `任务 ${pluginName} (ID: ${requestId}) 处理失败。原因: ${callbackData.reason || JSON.stringify(callbackData.data || callbackData.error || callbackData)}`;
                    }
                    tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, replacementText);
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[任务 ${pluginName} (ID: ${requestId}) 结果待更新...]`);
                    } else {
                        console.error(`[replaceOtherVariables] Error processing async placeholder ${placeholder}:`, error);
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[获取任务 ${pluginName} (ID: ${requestId}) 结果时出错]`);
                    }
                }
            })()
        );
    }
    
    await Promise.all(promises);
    processedText = tempAsyncProcessedText;

    return processedText;
}

async function replacePriorityVariables(text, context, role) {
    const { pluginManager, cachedEmojiLists, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    // 只在 system role 中处理
    if (role !== 'system') {
        return processedText;
    }

    // --- 表情包处理 ---
    const emojiPlaceholderRegex = /\{\{([^{}]+?表情包)\}\}/g;
    let emojiMatch;
    while ((emojiMatch = emojiPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = emojiMatch[0];
        const emojiName = emojiMatch[1];
        const emojiList = cachedEmojiLists.get(emojiName);
        processedText = processedText.replaceAll(placeholder, emojiList || `[${emojiName}列表不可用]`);
    }

    // --- 日记本处理（支持多模态参数 ::OverBase64 等） ---
    // 改造后的正则：支持 {{XX日记本}} 和 {{XX日记本::参数}} 两种格式
    const diaryPlaceholderRegex = /\{\{([^{}]+?日记本(?:::[^{}]*)?)\}\}/g;
    let allDiariesData = {};
    const allDiariesDataString = pluginManager.getPlaceholderValue("{{AllCharacterDiariesData}}");

    if (allDiariesDataString && !allDiariesDataString.startsWith("[Placeholder")) {
        try {
            allDiariesData = JSON.parse(allDiariesDataString);
        } catch (e) {
            console.error(`[replacePriorityVariables] Failed to parse AllCharacterDiariesData JSON: ${e.message}. Data: ${allDiariesDataString.substring(0, 100)}...`);
        }
    } else if (allDiariesDataString && allDiariesDataString.startsWith("[Placeholder")) {
        if (DEBUG_MODE) console.warn(`[replacePriorityVariables] Placeholder {{AllCharacterDiariesData}} not found or not yet populated. Value: ${allDiariesDataString}`);
    }

    // Step 1: Find all unique diary placeholders in the original text to avoid loops.
    const matches = [...processedText.matchAll(diaryPlaceholderRegex)];
    const uniquePlaceholders = [...new Set(matches.map(match => match[0]))];

    // Step 2: Iterate through the unique placeholders and replace them.
    for (const placeholder of uniquePlaceholders) {
        // 提取捕获组内容
        const captureMatch = placeholder.match(/\{\{([^{}]+?日记本(?:::[^{}]*)?)\}\}/);
        if (!captureMatch || !captureMatch[1]) continue;

        const captured = captureMatch[1];
        const parsed = parseMultimodalParams(captured);
        const characterName = parsed.diaryName;

        // 获取文本日记内容
        let diaryContent = `[${characterName}日记本内容为空或未从插件获取]`;
        if (allDiariesData.hasOwnProperty(characterName)) {
            diaryContent = allDiariesData[characterName];
        }

        // 检查是否有多模态参数
        if (hasMultimodalMode(parsed)) {
            // 多模态模式：处理多模态文件
            try {
                const multimodalContent = await _processMultimodalDiary(characterName, parsed, diaryContent, DEBUG_MODE);
                processedText = processedText.replaceAll(placeholder, multimodalContent);
            } catch (e) {
                console.error(`[replacePriorityVariables] 多模态日记本处理失败 (${characterName}):`, e.message);
                processedText = processedText.replaceAll(placeholder, diaryContent + `\n[多模态处理失败: ${e.message}]`);
            }
        } else {
            // 纯文本模式：原有逻辑 + 附加多模态描述信息文本
            let finalContent = diaryContent;
            try {
                const descTexts = await _getMultimediaDescriptionTexts(characterName);
                if (descTexts) {
                    finalContent += '\n\n' + descTexts;
                }
            } catch (e) {
                if (DEBUG_MODE) console.warn(`[replacePriorityVariables] 附加多模态描述失败 (${characterName}):`, e.message);
            }
            processedText = processedText.replaceAll(placeholder, finalContent);
        }
    }

    return processedText;
}

/**
 * 处理多模态日记本占位符
 * @param {string} characterName - 日记本名称
 * @param {object} parsed - 解析后的多模态参数
 * @param {string} textContent - 文本日记内容
 * @param {boolean} debugMode - 调试模式
 * @returns {string|object} 文本内容或 ContentPart 数组标记
 */
async function _processMultimodalDiary(characterName, parsed, textContent, debugMode) {
    const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, '..', 'dailynote');
    const dirPath = path.join(dailyNoteRootPath, characterName);
    const { textFiles, multimediaFiles } = await mediaDescriptionManager.scanDirectory(dirPath);

    // 确定目标多模态文件
    const targets = parsed.specifiedFiles.length > 0
        ? multimediaFiles.filter(f => parsed.specifiedFiles.includes(f))
        : multimediaFiles;

    // 确定目标文本文件（如果指定了特定 .txt/.md 文件）
    const specifiedTextFiles = parsed.specifiedFiles.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ext === '.txt' || ext === '.md';
    });

    switch (parsed.mode) {
        case 'OverBase64': {
            // 文本 + 描述信息（空描述先 AI 识别）
            let parts = [];

            // 文本部分
            if (!parsed.flags.noText) {
                const textSrc = specifiedTextFiles.length > 0 ? specifiedTextFiles : textFiles;
                const text = await mediaDescriptionManager.readTextFiles(dirPath, textSrc);
                if (text) parts.push(text);
            }

            // 多模态描述部分
            for (const mf of targets) {
                const filePath = path.join(dirPath, mf);
                let desc = await mediaDescriptionManager.readDescription(filePath);

                // 空描述 → AI 识别
                if ((!desc || !desc.description) || parsed.flags.noCaching) {
                    desc = await multimediaRecognizer.recognizeAndDescribe(
                        filePath, parsed.presetName, parsed.flags.noCaching
                    );
                }

                if (desc) {
                    const rendered = parsed.flags.tagOnly
                        ? mediaDescriptionManager.renderTagOnly(filePath, desc)
                        : mediaDescriptionManager.renderDescription(filePath, desc);
                    if (rendered) parts.push(rendered);
                }
            }

            return parts.join('\n\n');
        }

        case 'ShowBase64': {
            // 文本 + 原始文件 Base64（返回 ContentPart 标记）
            let contentParts = [];

            // 文本部分
            if (!parsed.flags.noText) {
                const textSrc = specifiedTextFiles.length > 0 ? specifiedTextFiles : textFiles;
                const text = await mediaDescriptionManager.readTextFiles(dirPath, textSrc);
                if (text) contentParts.push({ type: 'text', text });
            }

            // 多模态文件 Base64
            for (const mf of targets) {
                const filePath = path.join(dirPath, mf);
                if (mediaDescriptionManager.isBase64Sendable(mf)) {
                    contentParts.push(await mediaDescriptionManager.buildImageContentPart(filePath));
                }
            }

            // 返回 JSON 标记，chatCompletionHandler 会识别并转换
            return `<<<[MULTIMODAL_CONTENT_PARTS]>>>${JSON.stringify(contentParts)}<<<[END_MULTIMODAL_CONTENT_PARTS]>>>`;
        }

        case 'ShowBase64+': {
            // 文本 + 描述信息 + 原始文件 Base64
            let contentParts = [];

            // 文本部分
            if (!parsed.flags.noText) {
                const textSrc = specifiedTextFiles.length > 0 ? specifiedTextFiles : textFiles;
                const text = await mediaDescriptionManager.readTextFiles(dirPath, textSrc);
                if (text) contentParts.push({ type: 'text', text });
            }

            // 多模态文件：描述 + Base64
            for (const mf of targets) {
                const filePath = path.join(dirPath, mf);
                let desc = await mediaDescriptionManager.readDescription(filePath);

                // 空描述 → AI 识别
                if ((!desc || !desc.description) || parsed.flags.noCaching) {
                    desc = await multimediaRecognizer.recognizeAndDescribe(
                        filePath, parsed.presetName, parsed.flags.noCaching
                    );
                }

                // 添加描述文本
                if (desc) {
                    const rendered = parsed.flags.tagOnly
                        ? mediaDescriptionManager.renderTagOnly(filePath, desc)
                        : mediaDescriptionManager.renderDescription(filePath, desc);
                    if (rendered) contentParts.push({ type: 'text', text: rendered });
                }

                // 添加原始文件 Base64
                if (mediaDescriptionManager.isBase64Sendable(mf)) {
                    contentParts.push(await mediaDescriptionManager.buildImageContentPart(filePath));
                }
            }

            return `<<<[MULTIMODAL_CONTENT_PARTS]>>>${JSON.stringify(contentParts)}<<<[END_MULTIMODAL_CONTENT_PARTS]>>>`;
        }

        default:
            return textContent;
    }
}

/**
 * 获取日记本目录中所有多模态文件的描述信息文本（用于无参数的 {{XX日记本}} 附加）
 */
async function _getMultimediaDescriptionTexts(characterName) {
    const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, '..', 'dailynote');
    const dirPath = path.join(dailyNoteRootPath, characterName);
    const { multimediaFiles } = await mediaDescriptionManager.scanDirectory(dirPath);

    if (multimediaFiles.length === 0) return null;

    const descTexts = [];
    for (const mf of multimediaFiles) {
        const filePath = path.join(dirPath, mf);
        const desc = await mediaDescriptionManager.readDescription(filePath);
        if (desc && desc.description) {
            const rendered = mediaDescriptionManager.renderDescription(filePath, desc);
            if (rendered) descTexts.push(rendered);
        }
    }

    return descTexts.length > 0 ? descTexts.join('\n\n') : null;
}

/**
 * 分层解析方法：仅解析 Sar 变量
 */
async function replaceSarVariables(text, model, context) {
    if (text == null) return '';
    let processedText = String(text);
    // 复用 replaceOtherVariables 中的 Sar 逻辑
    const { pluginManager, cachedEmojiLists, detectors, superDetectors, DEBUG_MODE } = context;
    const role = 'system'; // Sar 仅在 system 角色中生效

    const sarPlaceholderRegex = /\{\{(SarPrompt\d+)\}\}/g;
    const matches = [...processedText.matchAll(sarPlaceholderRegex)];
    const uniquePlaceholders = [...new Set(matches.map(match => match[0]))];

    for (const placeholder of uniquePlaceholders) {
        const promptKey = placeholder.substring(2, placeholder.length - 2);
        const numberMatch = promptKey.match(/\d+$/);
        if (!numberMatch) continue;
        const index = numberMatch[0];
        const modelKey = `SarModel${index}`;
        const models = process.env[modelKey];
        let promptValue = process.env[promptKey];
        let replacementText = '';
        if (models && promptValue) {
            const modelList = models.split(',').map(m => m.trim().toLowerCase());
            if (model && modelList.includes(model.toLowerCase())) {
                if (typeof promptValue === 'string' && promptValue.toLowerCase().endsWith('.txt')) {
                    const fileContent = await tvsManager.getContent(promptValue);
                    if (!fileContent.startsWith('[变量文件') && !fileContent.startsWith('[处理变量文件')) {
                        promptValue = fileContent;
                    }
                }
                replacementText = promptValue;
            }
        }
        const placeholderRegExp = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
        processedText = processedText.replace(placeholderRegExp, replacementText);
    }
    return processedText;
}

/**
 * 分层解析方法：解析 Var + Sar 变量
 */
async function replaceVarVariables(text, model, context) {
    if (text == null) return '';
    let processedText = String(text);
    // Tar/Var 变量
    for (const envKey in process.env) {
        if (envKey.startsWith('Var')) {
            const placeholder = `{{${envKey}}}`;
            if (processedText.includes(placeholder)) {
                const value = process.env[envKey];
                if (value && typeof value === 'string' && value.toLowerCase().endsWith('.txt')) {
                    const fileContent = await tvsManager.getContent(value);
                    if (!fileContent.startsWith('[变量文件') && !fileContent.startsWith('[处理变量文件')) {
                        processedText = processedText.replaceAll(placeholder, fileContent);
                    } else {
                        processedText = processedText.replaceAll(placeholder, fileContent);
                    }
                } else {
                    processedText = processedText.replaceAll(placeholder, value || `[未配置 ${envKey}]`);
                }
            }
        }
    }
    // 然后解析 Sar
    processedText = await replaceSarVariables(processedText, model, context);
    return processedText;
}

/**
 * 分层解析方法：解析 Tar + Var + Sar 变量
 */
async function replaceTarVariables(text, model, context) {
    if (text == null) return '';
    let processedText = String(text);
    // Tar 变量
    for (const envKey in process.env) {
        if (envKey.startsWith('Tar')) {
            const placeholder = `{{${envKey}}}`;
            if (processedText.includes(placeholder)) {
                const value = process.env[envKey];
                if (value && typeof value === 'string' && value.toLowerCase().endsWith('.txt')) {
                    const fileContent = await tvsManager.getContent(value);
                    if (!fileContent.startsWith('[变量文件') && !fileContent.startsWith('[处理变量文件')) {
                        processedText = processedText.replaceAll(placeholder, fileContent);
                    } else {
                        processedText = processedText.replaceAll(placeholder, fileContent);
                    }
                } else {
                    processedText = processedText.replaceAll(placeholder, value || `[未配置 ${envKey}]`);
                }
            }
        }
    }
    // 然后解析 Var + Sar
    processedText = await replaceVarVariables(processedText, model, context);
    return processedText;
}

module.exports = {
    // 导出主函数，并重命名旧函数以供内部调用
    replaceAgentVariables: resolveAllVariables,
    resolveAllVariables,
    replaceOtherVariables,
    replacePriorityVariables,
    // 分层解析方法（用于召回内容多次解析）
    replaceTarVariables,
    replaceVarVariables,
    replaceSarVariables
};
