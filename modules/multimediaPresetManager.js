// modules/multimediaPresetManager.js
// 多模态识别预设管理器（单例）

const fs = require('fs').promises;
const path = require('path');

class MultimediaPresetManager {
    constructor() {
        this.presetsDir = path.join(__dirname, '..', 'MultimediaPresets');
        this.presetCache = new Map(); // name → preset object
        this.debugMode = false;
    }

    /**
     * 设置预设文件夹路径（参照 agentManager.setAgentDir 模式）
     */
    setPresetsDir(dirPath) {
        if (!dirPath || typeof dirPath !== 'string') {
            throw new Error('[MultimediaPresetManager] dirPath must be a non-empty string');
        }
        this.presetsDir = dirPath;
        this.presetCache.clear();
        console.log(`[MultimediaPresetManager] Presets directory set to: ${this.presetsDir}`);
    }

    /**
     * 初始化：确保目录存在
     */
    async initialize(debugMode = false) {
        this.debugMode = debugMode;
        try {
            await fs.mkdir(this.presetsDir, { recursive: true });
            if (this.debugMode) {
                console.log(`[MultimediaPresetManager] Presets directory ensured: ${this.presetsDir}`);
            }
        } catch (e) {
            console.error(`[MultimediaPresetManager] Failed to create presets directory:`, e.message);
        }
    }

    /**
     * 加载指定预设
     * @param {string} name - 预设名称（不含 .json 后缀）
     * @returns {object|null} 预设对象
     */
    async loadPreset(name) {
        // 检查缓存
        if (this.presetCache.has(name)) {
            return this.presetCache.get(name);
        }

        const filePath = path.join(this.presetsDir, `${name}.json`);
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            const preset = JSON.parse(data);
            this.presetCache.set(name, preset);
            if (this.debugMode) {
                console.log(`[MultimediaPresetManager] Loaded preset: ${name}`);
            }
            return preset;
        } catch (e) {
            if (e.code === 'ENOENT') {
                console.warn(`[MultimediaPresetManager] Preset "${name}" not found at ${filePath}`);
            } else {
                console.error(`[MultimediaPresetManager] Failed to load preset "${name}":`, e.message);
            }
            return null;
        }
    }

    /**
     * 获取预设，不存在则回退到 PresetDefault
     * @param {string} name - 预设名称
     * @returns {object} 预设对象（保证非 null）
     */
    async getPresetOrDefault(name) {
        if (name) {
            const preset = await this.loadPreset(name);
            if (preset) return preset;
        }

        // 回退到默认预设
        const defaultPreset = await this.loadPreset('PresetDefault');
        if (defaultPreset) return defaultPreset;

        // 连默认预设都没有，返回内置兜底配置
        console.warn('[MultimediaPresetManager] No PresetDefault found, using built-in fallback');
        return {
            name: 'BuiltinFallback',
            model: process.env.MultiModalModel || 'gemini-2.0-flash',
            apiUrl: '',
            apiKey: '',
            systemPrompt: '你是一个多模态内容描述专家。请详细描述这个文件的内容。',
            userPrompt: '请描述这个文件。最后一行请用 Tag: 格式列出关键标签。',
            maxTokens: 1000,
            temperature: 0.3
        };
    }

    /**
     * 列出所有可用预设
     * @returns {string[]} 预设名称列表
     */
    async listPresets() {
        try {
            const files = await fs.readdir(this.presetsDir);
            return files
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace(/\.json$/, ''));
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error(`[MultimediaPresetManager] Failed to list presets:`, e.message);
            }
            return [];
        }
    }

    /**
     * 清除缓存（配置变更时调用）
     */
    clearCache() {
        this.presetCache.clear();
    }
}

module.exports = new MultimediaPresetManager();