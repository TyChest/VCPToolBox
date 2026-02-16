// modules/tvsManager.js
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');

class TvsManager {
    constructor() {
        this.tvsDir = path.join(__dirname, '..', 'TVStxt'); // 默认值
        this.contentCache = new Map();
        this.debugMode = false;
        this.watcher = null;
    }

    /**
     * 设置 TVStxt 目录路径（参照 agentManager.setAgentDir 模式）
     * @param {string} dirPath - TVStxt 目录的绝对路径
     */
    setTvsDir(dirPath) {
        if (!dirPath || typeof dirPath !== 'string') {
            throw new Error('[TvsManager] dirPath must be a non-empty string');
        }
        this.tvsDir = dirPath;
        this.contentCache.clear(); // 清除缓存
        // 重新启动 watcher
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        console.log(`[TvsManager] TVS directory set to: ${this.tvsDir}`);
    }

    initialize(debugMode = false) {
        this.debugMode = debugMode;
        console.log('[TvsManager] Initializing...');
        this.watchFiles();
    }

    watchFiles() {
        // 关闭旧的 watcher
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }

        try {
            this.watcher = chokidar.watch(this.tvsDir, {
                ignored: /(^|[\/\\])\../, // ignore dotfiles
                persistent: true,
                ignoreInitial: true, // Don't trigger 'add' events on startup
            });

            this.watcher
                .on('change', (filePath) => {
                    const filename = path.basename(filePath);
                    if (this.contentCache.has(filename)) {
                        this.contentCache.delete(filename);
                        console.log(`[TvsManager] Cache for '${filename}' cleared due to file change.`);
                    }
                })
                .on('unlink', (filePath) => {
                    const filename = path.basename(filePath);
                    if (this.contentCache.has(filename)) {
                        this.contentCache.delete(filename);
                        console.log(`[TvsManager] Cache for '${filename}' cleared due to file deletion.`);
                    }
                })
                .on('error', (error) => console.error(`[TvsManager] Watcher error: ${error}`));

            if (this.debugMode) {
                console.log(`[TvsManager] Watching for changes in: ${this.tvsDir}`);
            }
        } catch (error) {
            console.error(`[TvsManager] Failed to set up file watcher:`, error);
        }
    }

    async getContent(filename) {
        if (this.contentCache.has(filename)) {
            if (this.debugMode) {
                console.log(`[TvsManager] Cache hit for '${filename}'.`);
            }
            return this.contentCache.get(filename);
        }

        if (this.debugMode) {
            console.log(`[TvsManager] Cache miss for '${filename}'. Reading from disk.`);
        }

        try {
            const filePath = path.join(this.tvsDir, filename);
            const content = await fs.readFile(filePath, 'utf8');
            this.contentCache.set(filename, content);
            return content;
        } catch (error) {
            // Don't cache errors, so it can be retried if the file appears later.
            console.error(`[TvsManager] Error reading file '${filename}':`, error.message);
            if (error.code === 'ENOENT') {
                return `[变量文件 (${filename}) 未找到]`;
            }
            return `[处理变量文件 (${filename}) 时出错]`;
        }
    }
}

const tvsManager = new TvsManager();
module.exports = tvsManager;