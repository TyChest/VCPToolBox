// modules/mediaDescriptionManager.js
// 多模态文件描述信息管理器 — 侧车文件(.desc.json)读写、目录扫描、Base64编码
// PNG 嵌入式元数据读写（tEXt/iTXt chunk 直接解析，无外部依赖）
// JPEG 嵌入式元数据读写（COM marker + EXIF ImageDescription 解析，无外部依赖）

const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// 支持的多模态文件扩展名
const MULTIMEDIA_EXTENSIONS = new Set([
    // 图片
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif', '.avif',
    // 视频
    '.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv',
    // 音频
    '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
    // 文档
    '.pdf'
]);

// 支持直接 Base64 编码发送的文件扩展名（LLM 可直接处理的）
const BASE64_SENDABLE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
    '.pdf' // 部分模型支持
]);

// MIME 类型映射
const MIME_MAP = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.tiff': 'image/tiff', '.tif': 'image/tiff', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.flv': 'video/x-flv',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf'
};

class MediaDescriptionManager {
    constructor() {
        this.descriptionCache = new Map(); // filePath → { desc, mtime }
    }

    /**
     * 判断文件是否为多模态文件
     */
    isMultimediaFile(filename) {
        const ext = path.extname(filename).toLowerCase();
        return MULTIMEDIA_EXTENSIONS.has(ext);
    }

    /**
     * 判断文件是否可以 Base64 直发给 LLM
     */
    isBase64Sendable(filename) {
        const ext = path.extname(filename).toLowerCase();
        return BASE64_SENDABLE_EXTENSIONS.has(ext);
    }

    /**
     * 判断文件/文件夹是否应被忽略（.开头）
     */
    shouldIgnore(filename) {
        return filename.startsWith('.');
    }

    /**
     * 获取侧车描述文件路径
     */
    getDescPath(filePath) {
        return filePath + '.desc.json';
    }

    /**
     * 获取文件的 MIME 类型
     */
    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return MIME_MAP[ext] || 'application/octet-stream';
    }

    /**
     * 读取文件的描述信息
     * @param {string} filePath - 多模态文件的完整路径
     * @returns {object|null} 描述信息对象，或 null（无描述）
     */
    async readDescription(filePath) {
        const descPath = this.getDescPath(filePath);
        try {
            const data = await fs.readFile(descPath, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            if (e.code === 'ENOENT') {
                // 侧车文件不存在，尝试读取嵌入式元数据（兼容层）
                return await this._readEmbeddedMetadata(filePath);
            }
            console.error(`[MediaDescManager] 读取描述文件失败 ${descPath}:`, e.message);
            return null;
        }
    }

    /**
     * 写入/更新文件的描述信息
     * 同时尝试同步写入 PNG 嵌入式元数据（双端同步）
     */
    async writeDescription(filePath, descObj) {
        const descPath = this.getDescPath(filePath);
        const { presetName, ...rest } = descObj; // 移除冗余的 presetName
        const data = {
            ...rest,
            updatedAt: new Date().toISOString()
        };
        if (!data.createdAt) {
            data.createdAt = data.updatedAt;
        }
        // 计算原文件内容哈希用于改名追踪
        try {
            const fileBuffer = await fs.readFile(filePath);
            data.fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        } catch (e) {
            // 原文件不可读时保留已有 hash
        }
        await fs.writeFile(descPath, JSON.stringify(data, null, 2), 'utf-8');
        // 清除缓存
        this.descriptionCache.delete(filePath);

        // 双端同步：尝试将描述写入嵌入式元数据（PNG/JPEG）
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
            try {
                await this._writeEmbeddedMetadata(filePath, data);
            } catch (e) {
                console.warn(`[MediaDescManager] 嵌入式元数据写入失败 ${filePath}:`, e.message);
            }
        }
    }

    /**
     * 删除文件的描述信息
     */
    async deleteDescription(filePath) {
        const descPath = this.getDescPath(filePath);
        try {
            await fs.unlink(descPath);
            this.descriptionCache.delete(filePath);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error(`[MediaDescManager] 删除描述文件失败 ${descPath}:`, e.message);
            }
        }
    }

    /**
     * 解析分段描述信息
     * @param {string} fullDescription - 包含 [@预设名:] 标记的完整描述字符串
     * @returns {Map<string, string>} 预设名 -> 内容
     */
    parseSegmentedDescription(fullDescription) {
        const segments = new Map();
        if (!fullDescription) return segments;

        // 正则匹配 [@预设名:] 及其后的内容，直到下一个标记或结尾
        const regex = /\[@([^\]]+):\]([\s\S]*?)(?=\[@[^\]]+:\]|$)/g;
        let match;
        let hasMatches = false;

        while ((match = regex.exec(fullDescription)) !== null) {
            hasMatches = true;
            const presetName = match[1].trim();
            const content = match[2].trim();
            if (content) {
                segments.set(presetName, content);
            }
        }

        // 如果没有任何标记，则视为整个内容属于 "Native" 或 "Manual" (取决于上下文，这里暂存为 "Legacy")
        if (!hasMatches && fullDescription.trim()) {
            segments.set('Native', fullDescription.trim());
        }

        return segments;
    }

    /**
     * 渲染描述信息为文本格式（用于注入 System Prompt）
     * 支持分段选择
     * @param {string} filePath - 文件路径
     * @param {object} descObj - 描述对象
     * @param {string[]} requestedPresets - 请求的预设列表，若为空或包含 'All' 则返回全部
     * @param {boolean} hideFilePath - 是否隐藏文件路径
     */
    renderDescription(filePath, descObj, requestedPresets = [], hideFilePath = false) {
        if (!descObj || !descObj.description) return null;

        const segments = this.parseSegmentedDescription(descObj.description);
        if (segments.size === 0) return null;

        let renderedParts = [];
        const isAll = requestedPresets.length === 0 || requestedPresets.some(p => p.toLowerCase() === 'all');

        for (const [presetName, content] of segments) {
            // 检查是否匹配请求的预设 (忽略开头的 @ 符号进行匹配)
            const shouldInclude = isAll || requestedPresets.some(p => {
                const cleanP = p.startsWith('@') ? p.substring(1) : p;
                return cleanP.toLowerCase() === presetName.toLowerCase();
            });
            
            if (shouldInclude) {
                renderedParts.push(`[${presetName}]\n${content}`);
            }
        }

        if (renderedParts.length === 0) return null;

        let finalRendered = renderedParts.join('\n\n');
        
        // 文件路径/名称
        if (hideFilePath) {
            finalRendered += `\n[文件名: ${path.basename(filePath)}]`;
        } else {
            finalRendered += `\n[文件路径: ${filePath}]`;
        }
        
        // Tag 行
        if (descObj.tags && descObj.tags.trim()) {
            finalRendered += `\nTag: ${descObj.tags.trim()}`;
        }
        
        return finalRendered;
    }

    /**
     * 仅渲染 Tag 行（用于 :TagOnly 模式）
     */
    renderTagOnly(filePath, descObj, hideFilePath = false) {
        if (!descObj) return null;
        let rendered = '';
        if (descObj.tags && descObj.tags.trim()) {
            rendered += `Tag: ${descObj.tags.trim()}`;
            if (hideFilePath) {
                rendered += `\n[文件名: ${path.basename(filePath)}]`;
            } else {
                rendered += `\n[文件路径: ${filePath}]`;
            }
        }
        return rendered;
    }

    /**
     * 扫描目录，返回分类后的文件列表
     * @param {string} dirPath - 日记本目录路径
     * @returns {{ textFiles: string[], multimediaFiles: string[] }}
     */
    async scanDirectory(dirPath) {
        const textFiles = [];
        const multimediaFiles = [];

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                // 忽略 . 开头的文件和文件夹
                if (this.shouldIgnore(entry.name)) continue;
                // 忽略 .desc.json 侧车文件
                if (entry.name.endsWith('.desc.json')) continue;

                if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (ext === '.txt' || ext === '.md') {
                        textFiles.push(entry.name);
                    } else if (this.isMultimediaFile(entry.name)) {
                        multimediaFiles.push(entry.name);
                    }
                }
            }
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error(`[MediaDescManager] 扫描目录失败 ${dirPath}:`, e.message);
            }
        }

        return {
            textFiles: textFiles.sort(),
            multimediaFiles: multimediaFiles.sort()
        };
    }

    /**
     * 将文件读取为 Base64 data URI
     */
    async readAsBase64DataUri(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_MAP[ext] || 'application/octet-stream';
        const buffer = await fs.readFile(filePath);
        const base64 = buffer.toString('base64');
        return `data:${mime};base64,${base64}`;
    }

    /**
     * 构建 OpenAI 多模态消息格式的 image_url content part
     */
    async buildImageContentPart(filePath) {
        const dataUri = await this.readAsBase64DataUri(filePath);
        return {
            type: 'image_url',
            image_url: {
                url: dataUri,
                filePath: filePath // 附加路径信息，供后续 introText 使用
            }
        };
    }

    /**
     * 读取目录中所有文本文件的内容并拼接
     * @param {string} dirPath - 目录路径
     * @param {string[]} textFiles - 文本文件名列表
     * @returns {string} 拼接后的文本内容
     */
    async readTextFiles(dirPath, textFiles) {
        if (!textFiles || textFiles.length === 0) return '';

        const contents = await Promise.all(
            textFiles.map(async (file) => {
                const filePath = path.join(dirPath, file);
                try {
                    return await fs.readFile(filePath, 'utf-8');
                } catch (e) {
                    return `[Error reading file: ${file}]`;
                }
            })
        );
        return contents.join('\n\n---\n\n');
    }

    /**
     * 计算文件的 SHA-256 哈希
     */
    async computeFileHash(filePath) {
        const buffer = await fs.readFile(filePath);
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    /**
     * 协调孤立的 .desc.json 文件
     * 当原文件被改名时，通过 fileHash 匹配找到新文件名并自动重命名 sidecar
     * @param {string} dirPath - 要扫描的目录
     * @returns {{ reconciled: Array<{oldName: string, newName: string}>, orphaned: string[] }}
     */
    async reconcileOrphanedDescFiles(dirPath) {
        const reconciled = [];
        const orphaned = [];

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            // 1. 收集所有 .desc.json 文件及其对应的原文件名
            const descFiles = [];
            const mediaFiles = []; // 没有 sidecar 的多模态文件

            for (const entry of entries) {
                if (!entry.isFile()) continue;
                if (this.shouldIgnore(entry.name)) continue;

                if (entry.name.endsWith('.desc.json')) {
                    const originalName = entry.name.replace(/\.desc\.json$/, '');
                    descFiles.push({ descName: entry.name, originalName });
                }
            }

            // 2. 找出孤立的 desc 文件（原文件不存在）
            const orphanDescs = [];
            for (const df of descFiles) {
                const originalPath = path.join(dirPath, df.originalName);
                try {
                    await fs.access(originalPath);
                    // 原文件存在，跳过
                } catch {
                    orphanDescs.push(df);
                }
            }

            if (orphanDescs.length === 0) return { reconciled, orphaned };

            // 3. 收集目录中没有 sidecar 的多模态文件
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                if (this.shouldIgnore(entry.name)) continue;
                if (entry.name.endsWith('.desc.json')) continue;
                if (!this.isMultimediaFile(entry.name)) continue;

                const descPath = path.join(dirPath, entry.name + '.desc.json');
                try {
                    await fs.access(descPath);
                    // 已有 sidecar，跳过
                } catch {
                    mediaFiles.push(entry.name);
                }
            }

            // 4. 对每个孤立 desc，读取 fileHash，与无 sidecar 的文件匹配
            for (const orphan of orphanDescs) {
                const descPath = path.join(dirPath, orphan.descName);
                try {
                    const descData = JSON.parse(await fs.readFile(descPath, 'utf-8'));
                    if (!descData.fileHash) {
                        orphaned.push(orphan.descName);
                        continue;
                    }

                    let matched = false;
                    for (let i = 0; i < mediaFiles.length; i++) {
                        const candidatePath = path.join(dirPath, mediaFiles[i]);
                        const candidateHash = await this.computeFileHash(candidatePath);
                        if (candidateHash === descData.fileHash) {
                            // 匹配成功，重命名 sidecar
                            const newDescPath = candidatePath + '.desc.json';
                            await fs.rename(descPath, newDescPath);
                            reconciled.push({ oldName: orphan.originalName, newName: mediaFiles[i] });
                            mediaFiles.splice(i, 1); // 从候选列表移除
                            matched = true;
                            break;
                        }
                    }

                    if (!matched) {
                        orphaned.push(orphan.descName);
                    }
                } catch (e) {
                    orphaned.push(orphan.descName);
                }
            }
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error(`[MediaDescManager] 协调孤立描述文件失败 ${dirPath}:`, e.message);
            }
        }

        return { reconciled, orphaned };
    }

    // ================================================================
    // PNG chunk 直接解析（无外部依赖）
    // ================================================================

    /**
     * 解析 PNG 文件的所有 chunk
     * @returns {Array<{type: string, data: Buffer, offset: number}>}
     */
    _parsePngChunks(buffer) {
        const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        if (buffer.length < 8 || !buffer.slice(0, 8).equals(PNG_SIGNATURE)) {
            throw new Error('不是有效的 PNG 文件');
        }

        const chunks = [];
        let offset = 8;
        while (offset < buffer.length) {
            if (offset + 8 > buffer.length) break;
            const length = buffer.readUInt32BE(offset);
            const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
            if (offset + 12 + length > buffer.length) break;
            const data = buffer.slice(offset + 8, offset + 8 + length);
            chunks.push({ type, data, offset });
            offset += 12 + length; // 4(length) + 4(type) + data + 4(CRC)
        }
        return chunks;
    }

    /**
     * 从 PNG tEXt chunk 读取文本
     */
    _readTEXtChunk(data) {
        const nullIdx = data.indexOf(0);
        if (nullIdx < 0) return null;
        const keyword = data.slice(0, nullIdx).toString('latin1');
        const text = data.slice(nullIdx + 1).toString('latin1');
        return { keyword, text };
    }

    /**
     * 从 PNG iTXt chunk 读取文本
     */
    _readITXtChunk(data) {
        const nullIdx = data.indexOf(0);
        if (nullIdx < 0) return null;
        const keyword = data.slice(0, nullIdx).toString('utf-8');
        let pos = nullIdx + 1;
        if (pos + 2 > data.length) return null;
        const compressionFlag = data[pos++];
        const compressionMethod = data[pos++];
        // language tag (null-terminated)
        const langEnd = data.indexOf(0, pos);
        if (langEnd < 0) return null;
        pos = langEnd + 1;
        // translated keyword (null-terminated)
        const transEnd = data.indexOf(0, pos);
        if (transEnd < 0) return null;
        pos = transEnd + 1;
        let text;
        if (compressionFlag === 1 && compressionMethod === 0) {
            // zlib compressed
            try {
                text = zlib.inflateSync(data.slice(pos)).toString('utf-8');
            } catch {
                text = data.slice(pos).toString('utf-8');
            }
        } else {
            text = data.slice(pos).toString('utf-8');
        }
        return { keyword, text };
    }

    /**
     * 构建 PNG iTXt chunk 的数据部分
     */
    _buildITXtChunkData(keyword, text) {
        const keywordBuf = Buffer.from(keyword, 'utf-8');
        const nullByte = Buffer.from([0]);
        const compressionFlags = Buffer.from([0, 0]); // no compression
        const languageTag = Buffer.from(''); // empty
        const translatedKeyword = Buffer.from(''); // empty
        const textBuf = Buffer.from(text, 'utf-8');
        return Buffer.concat([
            keywordBuf, nullByte,
            compressionFlags,
            languageTag, nullByte,
            translatedKeyword, nullByte,
            textBuf
        ]);
    }

    /**
     * 计算 PNG chunk 的 CRC32
     */
    _crc32(buffer) {
        // CRC32 lookup table
        if (!this._crc32Table) {
            this._crc32Table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) {
                    if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
                    else c = c >>> 1;
                }
                this._crc32Table[n] = c;
            }
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buffer.length; i++) {
            crc = this._crc32Table[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * 构建完整的 PNG chunk（含 length、type、data、CRC）
     */
    _buildPngChunk(type, data) {
        const lengthBuf = Buffer.alloc(4);
        lengthBuf.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crcInput = Buffer.concat([typeBuf, data]);
        const crc = this._crc32(crcInput);
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc, 0);
        return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
    }

    /**
     * 兼容层：尝试从文件嵌入式元数据中读取描述
     * 直接解析 PNG tEXt/iTXt chunk，无需 ExifReader
     */
    async _readEmbeddedMetadata(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.png') return this._readPngEmbeddedMetadata(filePath);
        if (ext === '.jpg' || ext === '.jpeg') return this._readJpegEmbeddedMetadata(filePath);
        return null;
    }

    /**
     * PNG 嵌入式元数据读取
     */
    async _readPngEmbeddedMetadata(filePath) {

        try {
            const buffer = await fs.readFile(filePath);
            const chunks = this._parsePngChunks(buffer);

            for (const chunk of chunks) {
                let parsed = null;
                if (chunk.type === 'tEXt') {
                    parsed = this._readTEXtChunk(chunk.data);
                } else if (chunk.type === 'iTXt') {
                    parsed = this._readITXtChunk(chunk.data);
                }

                if (parsed && (parsed.keyword === 'Description' || parsed.keyword === 'Comment')) {
                    const text = parsed.text;
                    if (!text) continue;

                    // 原封不动保留嵌入式描述信息文本，不解析 JSON 结构
                    // 同时尝试提取 maid 字段作为 presetName（仅用于显示）
                    let presetName = 'Embedded';
                    let originalMetadata = {};
                    try {
                        const jsonData = JSON.parse(text);
                        if (jsonData.maid) presetName = jsonData.maid;
                        originalMetadata = jsonData;
                    } catch {
                        // 非 JSON 格式，保持默认值
                    }

                    return {
                        presetName,
                        description: text,
                        tags: '',
                        originalMetadata
                    };
                }
            }
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.warn(`[MediaDescManager] PNG 嵌入式元数据读取失败 ${filePath}:`, e.message);
            }
        }
        return null;
    }

    /**
     * 将描述信息写入 PNG 嵌入式元数据（iTXt chunk）
     * 如果已存在 Description chunk 则替换，否则在 IHDR 后插入
     */
    async _writeEmbeddedMetadata(filePath, descObj) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.png') return this._writePngEmbeddedMetadata(filePath, descObj);
        if (ext === '.jpg' || ext === '.jpeg') return this._writeJpegEmbeddedMetadata(filePath, descObj);
    }

    /**
     * PNG 嵌入式元数据写入
     */
    async _writePngEmbeddedMetadata(filePath, descObj) {

        const buffer = await fs.readFile(filePath);
        const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        if (buffer.length < 8 || !buffer.slice(0, 8).equals(PNG_SIGNATURE)) return;

        // 直接写入描述信息原文（纯自由文本，不套 JSON 格式）
        const textToWrite = descObj.description || '';
        if (!textToWrite.trim()) return; // 空描述不写入
        const newChunkData = this._buildITXtChunkData('Description', textToWrite);
        const newChunk = this._buildPngChunk('iTXt', newChunkData);

        // 重建 PNG：保留所有 chunk，替换或插入 Description iTXt/tEXt
        const parts = [PNG_SIGNATURE];
        let offset = 8;
        let replaced = false;
        let insertedAfterIHDR = false;

        while (offset < buffer.length) {
            if (offset + 8 > buffer.length) break;
            const length = buffer.readUInt32BE(offset);
            const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
            const chunkTotalLength = 12 + length;
            if (offset + chunkTotalLength > buffer.length) break;

            const chunkBuf = buffer.slice(offset, offset + chunkTotalLength);

            // 检查是否是已有的 Description chunk
            if ((type === 'iTXt' || type === 'tEXt') && !replaced) {
                const data = buffer.slice(offset + 8, offset + 8 + length);
                const nullIdx = data.indexOf(0);
                if (nullIdx >= 0) {
                    const keyword = data.slice(0, nullIdx).toString('utf-8');
                    if (keyword === 'Description') {
                        // 替换为新 chunk
                        parts.push(newChunk);
                        replaced = true;
                        offset += chunkTotalLength;
                        continue;
                    }
                }
            }

            parts.push(chunkBuf);

            // 如果刚写完 IHDR 且还没替换，在 IHDR 后插入
            if (type === 'IHDR' && !replaced && !insertedAfterIHDR) {
                insertedAfterIHDR = true;
                // 标记位置，如果最终没找到已有 Description chunk，在这里插入
            }

            offset += chunkTotalLength;
        }

        // 如果没有替换已有的 Description chunk，在 IHDR 后插入
        if (!replaced) {
            // 找到 IHDR chunk 后的位置（parts[0] 是 signature，parts[1] 是 IHDR）
            if (parts.length >= 2) {
                parts.splice(2, 0, newChunk);
            } else {
                parts.push(newChunk);
            }
        }

        const newBuffer = Buffer.concat(parts);
        await fs.writeFile(filePath, newBuffer);
    }

    // ================================================================
    // JPEG 嵌入式元数据解析（COM marker + EXIF ImageDescription）
    // ================================================================

    /**
     * 解析 JPEG 文件的所有 marker 段
     * JPEG 结构：SOI (0xFFD8) + 一系列 marker 段 + SOS + 图像数据 + EOI
     * 每个 marker 段：0xFF + marker_type + 2字节长度(含自身) + 数据
     * @returns {Array<{marker: number, offset: number, length: number, data: Buffer}>}
     */
    _parseJpegMarkers(buffer) {
        if (buffer.length < 2 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
            throw new Error('不是有效的 JPEG 文件');
        }

        const markers = [];
        let offset = 2; // skip SOI

        while (offset < buffer.length - 1) {
            // 寻找 0xFF marker 前缀
            if (buffer[offset] !== 0xFF) {
                offset++;
                continue;
            }

            const markerType = buffer[offset + 1];

            // 跳过填充字节 (0xFF followed by 0xFF)
            if (markerType === 0xFF) {
                offset++;
                continue;
            }

            // 独立 marker（无数据段）：SOI, EOI, RST0-RST7, TEM
            if (markerType === 0xD8 || markerType === 0xD9 ||
                (markerType >= 0xD0 && markerType <= 0xD7) || markerType === 0x01) {
                markers.push({ marker: markerType, offset, length: 2, data: Buffer.alloc(0) });
                offset += 2;
                if (markerType === 0xD9) break; // EOI
                continue;
            }

            // SOS (0xDA) — 后面是压缩图像数据，停止解析 marker
            if (markerType === 0xDA) {
                markers.push({ marker: markerType, offset, length: buffer.length - offset, data: Buffer.alloc(0), isSOS: true });
                break;
            }

            // 带数据的 marker 段
            if (offset + 3 >= buffer.length) break;
            const segLength = buffer.readUInt16BE(offset + 2); // 包含自身2字节
            if (segLength < 2 || offset + 2 + segLength > buffer.length) break;

            const data = buffer.slice(offset + 4, offset + 2 + segLength);
            markers.push({ marker: markerType, offset, length: 2 + segLength, data });
            offset += 2 + segLength;
        }

        return markers;
    }

    /**
     * 从 JPEG EXIF APP1 段中读取 ImageDescription (tag 0x010E)
     * EXIF 结构：'Exif\0\0' + TIFF header + IFD0
     */
    _readExifImageDescription(app1Data) {
        const EXIF_HEADER = 'Exif\0\0';
        if (app1Data.length < 14) return null;
        if (app1Data.slice(0, 6).toString('binary') !== EXIF_HEADER) return null;

        const tiffOffset = 6;
        const tiffData = app1Data.slice(tiffOffset);
        if (tiffData.length < 8) return null;

        // 字节序：'II' = little-endian, 'MM' = big-endian
        const byteOrder = tiffData.slice(0, 2).toString('ascii');
        const isLE = byteOrder === 'II';
        const readU16 = isLE
            ? (buf, off) => buf.readUInt16LE(off)
            : (buf, off) => buf.readUInt16BE(off);
        const readU32 = isLE
            ? (buf, off) => buf.readUInt32LE(off)
            : (buf, off) => buf.readUInt32BE(off);

        // 验证 TIFF magic number (42)
        if (readU16(tiffData, 2) !== 42) return null;

        // IFD0 偏移
        const ifd0Offset = readU32(tiffData, 4);
        if (ifd0Offset + 2 > tiffData.length) return null;

        const entryCount = readU16(tiffData, ifd0Offset);
        for (let i = 0; i < entryCount; i++) {
            const entryOffset = ifd0Offset + 2 + i * 12;
            if (entryOffset + 12 > tiffData.length) break;

            const tag = readU16(tiffData, entryOffset);
            const type = readU16(tiffData, entryOffset + 2);
            const count = readU32(tiffData, entryOffset + 4);
            const valueOffset = readU32(tiffData, entryOffset + 8);

            // ImageDescription = 0x010E, type ASCII (2)
            if (tag === 0x010E && type === 2) {
                let strOffset, strLength;
                if (count <= 4) {
                    // 值直接存在 value/offset 字段中
                    strOffset = entryOffset + 8;
                    strLength = count;
                } else {
                    strOffset = valueOffset;
                    strLength = count;
                }
                if (strOffset + strLength > tiffData.length) return null;
                // ASCII 字符串以 null 结尾
                let str = tiffData.slice(strOffset, strOffset + strLength).toString('ascii');
                if (str.endsWith('\0')) str = str.slice(0, -1);
                return str.trim() || null;
            }
        }
        return null;
    }

    /**
     * 从 JPEG COM marker (0xFE) 中读取注释文本
     */
    _readJpegComment(markers) {
        for (const m of markers) {
            if (m.marker === 0xFE && m.data.length > 0) {
                // COM marker 数据就是纯文本
                return m.data.toString('utf-8').trim();
            }
        }
        return null;
    }

    /**
     * JPEG 嵌入式元数据读取
     * 优先读取 COM marker，fallback 到 EXIF ImageDescription
     */
    async _readJpegEmbeddedMetadata(filePath) {
        try {
            const buffer = await fs.readFile(filePath);
            const markers = this._parseJpegMarkers(buffer);

            // 1. 优先读取 COM marker（我们写入的格式）
            const comment = this._readJpegComment(markers);
            if (comment) {
                let presetName = 'Embedded';
                let originalMetadata = {};
                try {
                    const jsonData = JSON.parse(comment);
                    if (jsonData.maid) presetName = jsonData.maid;
                    originalMetadata = jsonData;
                } catch {
                    // 非 JSON，保持原文
                }
                return {
                    presetName,
                    description: comment,
                    tags: '',
                    originalMetadata
                };
            }

            // 2. Fallback: 读取 EXIF APP1 中的 ImageDescription
            for (const m of markers) {
                if (m.marker === 0xE1 && m.data.length > 6) { // APP1
                    const desc = this._readExifImageDescription(m.data);
                    if (desc) {
                        let presetName = 'EXIF';
                        let originalMetadata = {};
                        try {
                            const jsonData = JSON.parse(desc);
                            if (jsonData.maid) presetName = jsonData.maid;
                            originalMetadata = jsonData;
                        } catch {
                            // 非 JSON
                        }
                        return {
                            presetName,
                            description: desc,
                            tags: '',
                            originalMetadata
                        };
                    }
                }
            }
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.warn(`[MediaDescManager] JPEG 嵌入式元数据读取失败 ${filePath}:`, e.message);
            }
        }
        return null;
    }

    /**
     * JPEG 嵌入式元数据写入（使用 COM marker 0xFE）
     * COM marker 是 JPEG 标准注释段，结构简单，不会破坏 EXIF
     * 策略：替换已有 COM marker，或在 SOI 后、第一个 APP marker 前插入
     */
    async _writeJpegEmbeddedMetadata(filePath, descObj) {
        const buffer = await fs.readFile(filePath);
        if (buffer.length < 2 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return;

        // 直接写入描述信息原文（纯自由文本，不套 JSON 格式）
        const textToWrite = descObj.description || '';
        if (!textToWrite.trim()) return; // 空描述不写入
        const textBuf = Buffer.from(textToWrite, 'utf-8');

        // COM marker 段：0xFF 0xFE + 2字节长度(含自身) + 文本数据
        const comLength = textBuf.length + 2; // +2 for length field itself
        if (comLength > 65535) {
            console.warn(`[MediaDescManager] JPEG COM 数据过长 (${comLength} bytes)，跳过写入`);
            return;
        }
        const comMarker = Buffer.alloc(4 + textBuf.length);
        comMarker[0] = 0xFF;
        comMarker[1] = 0xFE;
        comMarker.writeUInt16BE(comLength, 2);
        textBuf.copy(comMarker, 4);

        // 重建 JPEG：SOI + (替换或插入 COM) + 其余 marker + SOS + 图像数据
        const parts = [Buffer.from([0xFF, 0xD8])]; // SOI
        let offset = 2;
        let replaced = false;
        let insertPos = -1; // 记录第一个非 COM marker 的位置，用于插入

        while (offset < buffer.length - 1) {
            if (buffer[offset] !== 0xFF) {
                // 不应该出现，但安全起见把剩余数据都加上
                parts.push(buffer.slice(offset));
                break;
            }

            const markerType = buffer[offset + 1];

            // 填充字节
            if (markerType === 0xFF) {
                offset++;
                continue;
            }

            // SOI（已处理）
            if (markerType === 0xD8) {
                offset += 2;
                continue;
            }

            // EOI
            if (markerType === 0xD9) {
                parts.push(buffer.slice(offset));
                break;
            }

            // 独立 marker（RST0-RST7, TEM）
            if ((markerType >= 0xD0 && markerType <= 0xD7) || markerType === 0x01) {
                parts.push(buffer.slice(offset, offset + 2));
                offset += 2;
                continue;
            }

            // SOS — 后面是压缩数据，直接把剩余全部追加
            if (markerType === 0xDA) {
                // 如果还没插入 COM，在 SOS 前插入
                if (!replaced) {
                    parts.push(comMarker);
                    replaced = true;
                }
                parts.push(buffer.slice(offset));
                break;
            }

            // 带数据的 marker 段
            if (offset + 3 >= buffer.length) {
                parts.push(buffer.slice(offset));
                break;
            }
            const segLength = buffer.readUInt16BE(offset + 2);
            if (segLength < 2 || offset + 2 + segLength > buffer.length) {
                parts.push(buffer.slice(offset));
                break;
            }

            const segTotal = 2 + segLength;

            // 如果是 COM marker，替换
            if (markerType === 0xFE) {
                if (!replaced) {
                    parts.push(comMarker);
                    replaced = true;
                }
                // 跳过旧 COM（如果有多个 COM，只保留我们的一个）
                offset += segTotal;
                continue;
            }

            // 其他 marker 原样保留
            parts.push(buffer.slice(offset, offset + segTotal));
            offset += segTotal;
        }

        // 如果整个文件都没有合适的插入点（极端情况），追加
        if (!replaced) {
            // 在 SOI 后插入
            parts.splice(1, 0, comMarker);
        }

        const newBuffer = Buffer.concat(parts);
        await fs.writeFile(filePath, newBuffer);
    }
}

module.exports = new MediaDescriptionManager();