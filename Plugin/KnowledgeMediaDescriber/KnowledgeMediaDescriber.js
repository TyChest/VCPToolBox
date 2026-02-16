// Plugin/KnowledgeMediaDescriber/KnowledgeMediaDescriber.js
// 多模态文件描述信息编辑器 — hybridservice 插件

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

let dailyNoteRootPath = '';
let debugMode = false;

// 延迟加载依赖模块（避免启动时模块尚未就绪）
let mediaDescriptionManager = null;
let multimediaPresetManager = null;
let multimediaRecognizer = null;

function getMediaDescriptionManager() {
    if (!mediaDescriptionManager) {
        try {
            mediaDescriptionManager = require('../../modules/mediaDescriptionManager.js');
        } catch (e) {
            console.error('[KnowledgeMediaDescriber] 无法加载 mediaDescriptionManager:', e.message);
        }
    }
    return mediaDescriptionManager;
}

function getMultimediaPresetManager() {
    if (!multimediaPresetManager) {
        try {
            multimediaPresetManager = require('../../modules/multimediaPresetManager.js');
        } catch (e) {
            console.error('[KnowledgeMediaDescriber] 无法加载 multimediaPresetManager:', e.message);
        }
    }
    return multimediaPresetManager;
}

function getMultimediaRecognizer() {
    if (!multimediaRecognizer) {
        try {
            multimediaRecognizer = require('../../modules/multimediaRecognizer.js');
        } catch (e) {
            console.error('[KnowledgeMediaDescriber] 无法加载 multimediaRecognizer:', e.message);
        }
    }
    return multimediaRecognizer;
}

function getRootPath() {
    return dailyNoteRootPath || process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, '..', '..', 'dailynote');
}

// ============================================================
// 初始化
// ============================================================

function initialize(pluginConfig) {
    dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, '..', '..', 'dailynote');
    debugMode = pluginConfig && pluginConfig.DebugMode === true;
    console.log('[KnowledgeMediaDescriber] 初始化完成，知识库路径:', dailyNoteRootPath);
}

// ============================================================
// AdminPanel HTTP 路由（通过 adminApiRouter，cookie 认证）
// ============================================================

function registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath) {
    const router = express.Router();

    // 静态文件：编辑器前端
    router.get('/editor', (req, res) => {
        res.sendFile(path.join(__dirname, 'editor.html'));
    });

    // GET /diaries — 列出所有日记本目录
    router.get('/diaries', async (req, res) => {
        try {
            const result = await _actionListDiaries();
            res.json({ success: true, diaries: result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // GET /files/:diaryName — 列出指定日记本的多模态文件及其描述状态
    router.get('/files/:diaryName', async (req, res) => {
        try {
            const result = await _actionListFiles(req.params.diaryName);
            res.json({ success: true, files: result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // GET /desc/:diaryName/:fileName — 获取文件描述信息
    router.get('/desc/:diaryName/:fileName', async (req, res) => {
        try {
            const result = await _actionGetDesc(req.params.diaryName, req.params.fileName);
            res.json({ success: true, description: result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // PUT /desc/:diaryName/:fileName — 更新描述
    router.put('/desc/:diaryName/:fileName', async (req, res) => {
        try {
            await _actionSetDesc(req.params.diaryName, req.params.fileName, req.body);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // POST /recognize/:diaryName/:fileName — 触发 AI 识别
    router.post('/recognize/:diaryName/:fileName', async (req, res) => {
        try {
            const preset = req.query.preset || 'PresetDefault';
            const force = req.query.force === 'true';
            const result = await _actionRecognize(req.params.diaryName, req.params.fileName, preset, force);
            res.json({ success: true, description: result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // GET /thumbnail/:diaryName/:fileName — 获取缩略图
    router.get('/thumbnail/:diaryName/:fileName', async (req, res) => {
        try {
            const filePath = path.join(getRootPath(), req.params.diaryName, req.params.fileName);
            const ext = path.extname(filePath).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
                res.sendFile(filePath);
            } else {
                res.json({ success: true, type: 'placeholder', ext });
            }
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // POST /reconcile/:diaryName — 手动触发孤立 sidecar 协调
    router.post('/reconcile/:diaryName', async (req, res) => {
        try {
            const result = await _actionReconcile(req.params.diaryName);
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // GET /presets — 列出所有可用预设
    router.get('/presets', async (req, res) => {
        try {
            const pm = getMultimediaPresetManager();
            if (!pm) return res.status(503).json({ success: false, error: 'multimediaPresetManager 未就绪' });
            const presets = await pm.listPresets();
            res.json({ success: true, presets });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // 挂载到 adminApiRouter（cookie 认证，AdminPanel iframe 可直接访问）
    adminApiRouter.use('/media-describer', router);

    console.log('[KnowledgeMediaDescriber] 路由已注册: /admin_api/media-describer');
}

// ============================================================
// processToolCall — VCP 工具调用接口（hybridservice）
// ============================================================

async function processToolCall(args) {
    const action = args.action;
    if (!action) {
        return { status: 'error', error: '缺少 action 参数。支持的操作: list_diaries, list_files, get_desc, set_desc, update_tags, delete_desc, rename_file, move_file, recognize' };
    }

    try {
        switch (action) {
            case 'list_diaries': {
                const diaries = await _actionListDiaries();
                return { status: 'success', result: { diaries } };
            }

            case 'list_files': {
                if (!args.diary) return { status: 'error', error: '缺少 diary 参数' };
                const files = await _actionListFiles(args.diary);
                return { status: 'success', result: { diary: args.diary, files } };
            }

            case 'get_desc': {
                if (!args.diary || !args.file) return { status: 'error', error: '缺少 diary 或 file 参数' };
                const desc = await _actionGetDesc(args.diary, args.file);
                return { status: 'success', result: { diary: args.diary, file: args.file, description: desc } };
            }

            case 'set_desc': {
                if (!args.diary || !args.file) return { status: 'error', error: '缺少 diary 或 file 参数' };
                await _actionSetDesc(args.diary, args.file, {
                    presetName: args.presetName || args.preset || 'Manual',
                    description: args.description || '',
                    tags: args.tags || ''
                });
                return { status: 'success', result: { message: `已更新 ${args.diary}/${args.file} 的描述信息` } };
            }

            case 'update_tags': {
                if (!args.diary || !args.file) return { status: 'error', error: '缺少 diary 或 file 参数' };
                const result = await _actionUpdateTags(args.diary, args.file, args.mode || 'replace', args.tags || '');
                return { status: 'success', result };
            }

            case 'delete_desc': {
                if (!args.diary || !args.file) return { status: 'error', error: '缺少 diary 或 file 参数' };
                await _actionDeleteDesc(args.diary, args.file);
                return { status: 'success', result: { message: `已删除 ${args.diary}/${args.file} 的描述文件` } };
            }

            case 'rename_file': {
                if (!args.diary || !args.file || !args.newName) return { status: 'error', error: '缺少 diary、file 或 newName 参数' };
                await _actionRenameFile(args.diary, args.file, args.newName);
                return { status: 'success', result: { message: `已将 ${args.file} 重命名为 ${args.newName}` } };
            }

            case 'move_file': {
                if (!args.diary || !args.file || !args.targetDiary) return { status: 'error', error: '缺少 diary、file 或 targetDiary 参数' };
                await _actionMoveFile(args.diary, args.file, args.targetDiary);
                return { status: 'success', result: { message: `已将 ${args.file} 从 ${args.diary} 迁移到 ${args.targetDiary}` } };
            }

            case 'recognize': {
                if (!args.diary || !args.file) return { status: 'error', error: '缺少 diary 或 file 参数' };
                const desc = await _actionRecognize(args.diary, args.file, args.preset || 'PresetDefault', args.force === true || args.force === 'true');
                return { status: 'success', result: { diary: args.diary, file: args.file, description: desc } };
            }

            case 'reconcile': {
                if (!args.diary) return { status: 'error', error: '缺少 diary 参数' };
                const result = await _actionReconcile(args.diary);
                return { status: 'success', result };
            }

            default:
                return { status: 'error', error: `未知操作: ${action}。支持: list_diaries, list_files, get_desc, set_desc, update_tags, delete_desc, rename_file, move_file, recognize, reconcile` };
        }
    } catch (e) {
        console.error(`[KnowledgeMediaDescriber] processToolCall 错误 (action=${action}):`, e.message);
        return { status: 'error', error: e.message };
    }
}

// ============================================================
// 内部操作函数（HTTP 路由和 processToolCall 共用）
// ============================================================

async function _actionListDiaries() {
    const rootPath = getRootPath();
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
}

async function _actionListFiles(diaryName) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');

    const dirPath = path.join(getRootPath(), diaryName);

    // 自动协调孤立的 sidecar 文件（原文件改名后通过哈希追踪）
    try {
        const { reconciled } = await mdm.reconcileOrphanedDescFiles(dirPath);
        if (reconciled.length > 0) {
            console.log(`[KnowledgeMediaDescriber] 自动协调了 ${reconciled.length} 个孤立描述文件:`,
                reconciled.map(r => `${r.oldName} → ${r.newName}`).join(', '));
        }
    } catch (e) {
        // 协调失败不影响文件列表
        if (debugMode) console.warn('[KnowledgeMediaDescriber] 协调孤立描述文件时出错:', e.message);
    }

    const { textFiles, multimediaFiles } = await mdm.scanDirectory(dirPath);

    const files = [];
    for (const f of textFiles) {
        files.push({ name: f, type: 'text', hasDescription: false });
    }
    for (const f of multimediaFiles) {
        const filePath = path.join(dirPath, f);
        const desc = await mdm.readDescription(filePath);
        const ext = path.extname(f).toLowerCase();
        let fileType = 'unknown';
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif', '.avif'].includes(ext)) fileType = 'image';
        else if (['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv'].includes(ext)) fileType = 'video';
        else if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'].includes(ext)) fileType = 'audio';
        else if (ext === '.pdf') fileType = 'pdf';

        files.push({
            name: f,
            type: fileType,
            hasDescription: !!(desc && desc.description),
            presetName: desc?.presetName || null,
            hasTags: !!(desc?.tags && desc.tags.trim())
        });
    }
    return files;
}

async function _actionGetDesc(diaryName, fileName) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');
    const filePath = path.join(getRootPath(), diaryName, fileName);
    return await mdm.readDescription(filePath);
}

async function _actionSetDesc(diaryName, fileName, body) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');
    const filePath = path.join(getRootPath(), diaryName, fileName);
    await mdm.writeDescription(filePath, {
        presetName: body.presetName || 'Manual',
        description: body.description || '',
        tags: body.tags || '',
        modelUsed: 'manual-edit'
    });
}

async function _actionUpdateTags(diaryName, fileName, mode, tagsInput) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');
    const filePath = path.join(getRootPath(), diaryName, fileName);
    const existing = await mdm.readDescription(filePath) || {};

    const existingTags = (existing.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const inputTags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);

    let newTags;
    switch (mode) {
        case 'append':
            // 追加不重复的标签
            newTags = [...existingTags];
            for (const t of inputTags) {
                if (!newTags.includes(t)) newTags.push(t);
            }
            break;
        case 'remove':
            // 删除指定标签
            newTags = existingTags.filter(t => !inputTags.includes(t));
            break;
        case 'replace':
        default:
            // 完全替换
            newTags = inputTags;
            break;
    }

    const newTagsStr = newTags.join(', ');
    await mdm.writeDescription(filePath, {
        ...existing,
        tags: newTagsStr,
        modelUsed: existing.modelUsed || 'manual-edit'
    });

    return {
        diary: diaryName,
        file: fileName,
        mode,
        previousTags: existingTags.join(', '),
        currentTags: newTagsStr
    };
}

async function _actionDeleteDesc(diaryName, fileName) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');
    const filePath = path.join(getRootPath(), diaryName, fileName);
    const descPath = mdm.getDescPath(filePath);
    try {
        await fs.unlink(descPath);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        // 文件不存在则静默忽略
    }
}

async function _actionRenameFile(diaryName, fileName, newName) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');

    const dirPath = path.join(getRootPath(), diaryName);
    const oldFilePath = path.join(dirPath, fileName);
    const newFilePath = path.join(dirPath, newName);

    // 检查目标是否已存在
    try {
        await fs.access(newFilePath);
        throw new Error(`目标文件 ${newName} 已存在`);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }

    // 重命名主文件
    await fs.rename(oldFilePath, newFilePath);

    // 重命名 sidecar 描述文件（如果存在）
    const oldDescPath = mdm.getDescPath(oldFilePath);
    const newDescPath = mdm.getDescPath(newFilePath);
    try {
        await fs.access(oldDescPath);
        await fs.rename(oldDescPath, newDescPath);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
}

async function _actionMoveFile(diaryName, fileName, targetDiary) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');

    const rootPath = getRootPath();
    const srcDir = path.join(rootPath, diaryName);
    const dstDir = path.join(rootPath, targetDiary);

    // 确保目标目录存在
    await fs.mkdir(dstDir, { recursive: true });

    const srcFilePath = path.join(srcDir, fileName);
    const dstFilePath = path.join(dstDir, fileName);

    // 检查目标是否已存在
    try {
        await fs.access(dstFilePath);
        throw new Error(`目标目录 ${targetDiary} 中已存在同名文件 ${fileName}`);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }

    // 移动主文件
    await fs.rename(srcFilePath, dstFilePath);

    // 移动 sidecar 描述文件（如果存在）
    const srcDescPath = mdm.getDescPath(srcFilePath);
    const dstDescPath = mdm.getDescPath(dstFilePath);
    try {
        await fs.access(srcDescPath);
        await fs.rename(srcDescPath, dstDescPath);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
}

async function _actionReconcile(diaryName) {
    const mdm = getMediaDescriptionManager();
    if (!mdm) throw new Error('mediaDescriptionManager 未就绪');
    const dirPath = path.join(getRootPath(), diaryName);
    const { reconciled, orphaned } = await mdm.reconcileOrphanedDescFiles(dirPath);
    return {
        diary: diaryName,
        reconciled,
        orphaned,
        message: reconciled.length > 0
            ? `成功协调 ${reconciled.length} 个文件: ${reconciled.map(r => `${r.oldName} → ${r.newName}`).join(', ')}`
            : '没有需要协调的孤立描述文件'
    };
}

async function _actionRecognize(diaryName, fileName, presetName, force) {
    const recognizer = getMultimediaRecognizer();
    if (!recognizer) throw new Error('multimediaRecognizer 未就绪');
    const filePath = path.join(getRootPath(), diaryName, fileName);
    return await recognizer.recognizeAndDescribe(filePath, presetName, force);
}

// ============================================================
// 导出
// ============================================================

module.exports = {
    initialize,
    registerRoutes,
    processToolCall
};