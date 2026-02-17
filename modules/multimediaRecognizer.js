// modules/multimediaRecognizer.js
// 多模态文件 AI 识别与描述填充模块

const path = require('path');
const mediaDescriptionManager = require('./mediaDescriptionManager');
const multimediaPresetManager = require('./multimediaPresetManager');

class MultimediaRecognizer {
    constructor() {
        this.debugMode = false;
    }

    /**
     * 对单个多模态文件进行 AI 识别并写入描述
     * 支持分段写入：仅更新指定预设段落的内容
     * @param {string} filePath - 多模态文件完整路径
     * @param {string} presetName - 预设名称
     * @param {boolean} forceOverwrite - 是否强制覆盖该预设段落的已有描述
     * @returns {object|null} 描述信息对象
     */
    async recognizeAndDescribe(filePath, presetName = 'PresetDefault', forceOverwrite = false) {
        // 统一去掉预设名开头的 @ 符号
        const cleanPresetName = presetName.startsWith('@') ? presetName.substring(1) : presetName;

        // 1. 检查是否已有该预设的描述
        const existing = await mediaDescriptionManager.readDescription(filePath);
        const segments = mediaDescriptionManager.parseSegmentedDescription(existing?.description || '');
        
        if (!forceOverwrite && segments.has(cleanPresetName)) {
            if (this.debugMode) {
                console.log(`[MultimediaRecognizer] 预设 ${cleanPresetName} 已有描述，跳过: ${path.basename(filePath)}`);
            }
            return existing;
        }

        // 2. 检查文件是否可以发送给 LLM
        if (!mediaDescriptionManager.isBase64Sendable(path.basename(filePath))) {
            console.warn(`[MultimediaRecognizer] 文件类型不支持直接识别: ${path.basename(filePath)}`);
            return null;
        }

        // 3. 加载预设
        const preset = await multimediaPresetManager.getPresetOrDefault(presetName);

        // 4. 构建 API 请求
        const apiUrl = preset.apiUrl || process.env.API_URL;
        const apiKey = preset.apiKey || process.env.API_Key;
        const model = preset.model || process.env.MultiModalModel || 'gemini-2.0-flash';

        if (!apiUrl || !apiKey) {
            console.error('[MultimediaRecognizer] API URL 或 API Key 未配置');
            return null;
        }

        try {
            console.log(`[MultimediaRecognizer] 正在识别: ${path.basename(filePath)} (预设: ${preset.name || presetName}, 模型: ${model})`);

            // 5. 读取文件为 Base64
            const dataUri = await mediaDescriptionManager.readAsBase64DataUri(filePath);

            // 6. 构建多模态消息
            const messages = [];

            if (preset.systemPrompt) {
                messages.push({
                    role: 'system',
                    content: preset.systemPrompt
                });
            }

            messages.push({
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: dataUri }
                    },
                    {
                        type: 'text',
                        text: preset.userPrompt || '请描述这个文件。最后一行请用 Tag: 格式列出关键标签。'
                    }
                ]
            });

            // 7. 调用 LLM API
            const { default: fetch } = await import('node-fetch');
            const response = await fetch(`${apiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    max_tokens: preset.maxTokens || 1000,
                    temperature: preset.temperature || 0.3,
                    stream: false
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[MultimediaRecognizer] API 调用失败 (${response.status}): ${errorText.substring(0, 200)}`);
                return null;
            }

            const result = await response.json();
            const aiResponse = result.choices?.[0]?.message?.content;

            if (!aiResponse) {
                console.error('[MultimediaRecognizer] API 返回空内容');
                return null;
            }

            // 8. 从回复中提取描述和 Tag
            const { description, tags } = this._parseAIResponse(aiResponse);

            // 9. 更新描述对象的分段内容并写入侧车文件
            // 重新解析以防在识别期间文件被修改
            const latestDesc = await mediaDescriptionManager.readDescription(filePath) || { description: '', tags: '', originalMetadata: {} };
            const latestSegments = mediaDescriptionManager.parseSegmentedDescription(latestDesc.description);
            
            // 更新或添加当前预设段落
            latestSegments.set(cleanPresetName, description);
            
            // 重新组装完整描述字符串
            let fullDescription = '';
            for (const [segName, content] of latestSegments) {
                fullDescription += `[@${segName}:]\n${content}\n\n`;
            }

            const descObj = {
                ...latestDesc,
                description: fullDescription.trim(),
                // 合并标签（去重）
                tags: this._mergeTags(latestDesc.tags, tags),
                modelUsed: model
            };

            await mediaDescriptionManager.writeDescription(filePath, descObj);
            console.log(`[MultimediaRecognizer] 描述已写入: ${path.basename(filePath)} (${description.length} 字符, ${tags ? tags.split(',').length : 0} 个标签)`);

            return descObj;

        } catch (e) {
            console.error(`[MultimediaRecognizer] 识别失败 ${path.basename(filePath)}:`, e.message);
            return null;
        }
    }

    /**
     * 批量识别目录中的多模态文件
     * @param {string} dirPath - 目录路径
     * @param {string} presetName - 预设名称
     * @param {boolean} forceOverwrite - 是否强制覆盖
     * @param {string[]} specifiedFiles - 指定文件列表（为空则处理全部）
     * @returns {Map<string, object>} 文件名 → 描述对象
     */
    async recognizeBatch(dirPath, presetName = 'PresetDefault', forceOverwrite = false, specifiedFiles = []) {
        const { multimediaFiles } = await mediaDescriptionManager.scanDirectory(dirPath);
        const results = new Map();

        // 确定目标文件
        const targets = specifiedFiles.length > 0
            ? multimediaFiles.filter(f => specifiedFiles.includes(f))
            : multimediaFiles;

        for (const fileName of targets) {
            const filePath = path.join(dirPath, fileName);
            const desc = await this.recognizeAndDescribe(filePath, presetName, forceOverwrite);
            if (desc) {
                results.set(fileName, desc);
            }
        }

        return results;
    }

    /**
     * 合并标签字符串
     */
    _mergeTags(oldTags, newTags) {
        if (!newTags) return oldTags || '';
        if (!oldTags) return newTags;
        
        const tagSet = new Set([
            ...oldTags.split(',').map(t => t.trim()).filter(Boolean),
            ...newTags.split(',').map(t => t.trim()).filter(Boolean)
        ]);
        return Array.from(tagSet).join(', ');
    }

    /**
     * 从 AI 回复中提取描述正文和 Tag 行
     * @param {string} aiResponse - AI 的回复文本
     * @returns {{ description: string, tags: string }}
     */
    _parseAIResponse(aiResponse) {
        const lines = aiResponse.trim().split('\n');
        let tags = '';
        let descriptionLines = [];

        // 从最后一行开始向上查找 Tag: 行
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.match(/^Tag[s]?:\s*/i)) {
                tags = line.replace(/^Tag[s]?:\s*/i, '').trim();
                // Tag 行之前的所有内容为描述
                descriptionLines = lines.slice(0, i);
                break;
            }
        }

        // 如果没找到 Tag 行，整个回复都是描述
        if (descriptionLines.length === 0 && !tags) {
            descriptionLines = lines;
        }

        return {
            description: descriptionLines.join('\n').trim(),
            tags: tags
        };
    }
}

module.exports = new MultimediaRecognizer();