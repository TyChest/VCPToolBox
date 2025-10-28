
# MultimediaProcessor 插件 (多媒体预设处理器)

这是一个强大的 `messagePreprocessor` 类型插件，支持基于自定义预设处理多媒体数据（图像、音频、视频），提供预设组合、缓存复用、文件夹批量处理和路径别名等高级功能。

## 核心功能

### 1. 自定义预设系统
- 支持创建多个命名预设，每个预设包含独立的 prompt、maxTokens 和 thinkingBudget 配置
- 预设可以组合使用，最多支持 5 个预设同时应用
- 预设之间使用分号 `;` 分隔

### 2. 智能缓存机制
- 基于文件内容的 MD5 哈希和预设名称建立缓存键
- **默认启用缓存**，节省 API 成本和响应时间
- 支持 `::no_cache` 语法禁用缓存，强制重新分析
- 缓存文件自动管理，支持持久化存储

### 3. 路径处理能力
- **支持绝对路径**: 直接使用文件系统的完整路径
- **支持相对路径**: 相对于插件目录的路径
- **支持路径别名**: 在 `path-aliases.json` 中定义别名映射
- **支持文件夹路径**: 自动扫描文件夹中的所有媒体文件
- **支持深层路径**: 别名路径后可以添加子目录，如 `images/subfolder/deeper`

### 4. 批量处理与过滤
- 单个语法可以处理整个文件夹的媒体文件
- 支持异步并发处理，可配置并发数量
- **白名单机制**：通过配置 `SupportedMediaFormats` 指定支持的格式
- **黑名单机制**：在文件夹中放置 `.overbase64ignore` 文件排除特定文件
- 自动识别并过滤文件，只处理符合条件的媒体

## 语法格式

### 基本语法
```
{{OverBase64::PresetName::filePath}}
```

### 多预设组合
```
{{OverBase64::PresetName01;PresetName02::filePath}}
{{OverBase64::PresetName01;PresetName02;PresetName03::filePath}}
```

### 禁用缓存（强制重新分析）
```
{{OverBase64::PresetName::filePath::no_cache}}
{{OverBase64::PresetName01;PresetName02::filePath::no_cache}}
```

**注意**：默认行为是使用缓存，只有明确添加 `::no_cache` 才会禁用。

### 路径类型示例

#### 1. 绝对路径
```
{{OverBase64::detailed::/Users/username/Pictures/photo.jpg}}
{{OverBase64::technical::/home/user/videos/clip.mp4}}
{{OverBase64::detailed::C:\Users\Name\Images\photo.png}}
```

#### 2. 路径别名
```
{{OverBase64::detailed::images}}
{{OverBase64::technical::videos/project1}}
{{OverBase64::emotional::downloads/photo.jpg}}
```

#### 3. 文件夹批量处理
```
{{OverBase64::detailed::/path/to/folder}}
{{OverBase64::detailed::images/vacation}}
{{OverBase64::summary;technical::downloads::cache}}
```

#### 4. 混合使用示例
```
系统提示词中：
请分析这些图片：
{{OverBase64::detailed::images/project}}
{{OverBase64::technical;emotional::downloads/screenshot.png::cache}}
{{OverBase64::summary::videos}}
```

## 配置文件

### 1. presets.json
定义预设配置，支持自定义 prompt 和模型参数：

```json
{
  "detailed": {
    "displayName": "详细描述预设",
    "prompt": "请详细描述这个多媒体内容，包括主要元素、颜色、构图、氛围等所有细节。",
    "model": "",
    "maxTokens": 2000,
    "temperature": 0.7,
    "topP": 1.0,
    "thinkingBudget": 0
  },
  "technical": {
    "displayName": "技术分析预设",
    "prompt": "从技术角度分析这个多媒体内容：分辨率、质量、格式特征、技术细节等。",
    "model": "gpt-4-vision-preview",
    "maxTokens": 1500,
    "temperature": 0.3,
    "topP": 0.9,
    "thinkingBudget": 0
  },
  "creative": {
    "displayName": "创意描述预设",
    "prompt": "用富有创意和想象力的语言描述这个内容，可以使用比喻和修辞手法。",
    "model": "claude-3-opus-20240229",
    "maxTokens": 1500,
    "temperature": 1.0,
    "topP": 0.95,
    "thinkingBudget": 0
  },
  "precise": {
    "displayName": "精确分析预设",
    "prompt": "以最精确和客观的方式描述这个内容，只陈述可观察的事实。",
    "model": "gpt-4-vision-preview",
    "maxTokens": 1200,
    "temperature": 0.1,
    "topP": 0.8,
    "thinkingBudget": 0
  }
}
```

**预设参数说明：**

| 参数 | 类型 | 说明 | 默认值 |
|-----|------|------|--------|
| `displayName` | string | 预设的显示名称 | 必需 |
| `prompt` | string | 发送给模型的提示词 | 必需 |
| `model` | string | 使用的模型名称，空字符串则使用全局配置 | "" |
| `maxTokens` | integer | 最大输出 token 数 | 2000 |
| `temperature` | float | 温度参数 (0.0-2.0)，控制输出随机性 | 0.7 |
| `topP` | float | Top-P 采样参数 (0.0-1.0) | 1.0 |
| `thinkingBudget` | integer | 思考预算（支持的模型） | 0 |

**温度参数使用建议：**
- `0.1-0.3`: 精确、客观的分析（技术文档、数据分析）
- `0.5-0.7`: 平衡的描述（通用场景）
- `0.8-1.0`: 创意、多样的输出（创意写作、营销文案）
- `1.0-2.0`: 极具创意和随机性（实验性用途）

**模型选择建议：**
- `gpt-4-vision-preview`: 强大的视觉理解能力
- `gpt-4o`: 更快的响应速度
- `claude-3-opus`: 创意写作和深度分析
- `claude-3-sonnet`: 平衡性能和成本
- 空字符串 `""`: 使用全局配置的模型

### 2. path-aliases.json
定义路径别名映射：

```json
{
  "images": "/Users/username/Pictures",
  "videos": "/Users/username/Videos",
  "downloads": "/Users/username/Downloads",
  "media": "/mnt/media",
  "project": "/path/to/project/assets"
}
```

### 3. config.env
插件特定配置（可选，不设置则使用全局配置）：

```env
API_URL=https://api.openai.com
API_Key=your_api_key_here
MultiModalModel=gpt-4-vision-preview
MultiModalModelOutputMaxTokens=2000
MultiModalModelThinkingBudget=0
MultiModalModelAsynchronousLimit=3
DebugMode=false
```

## 完整使用示例

### 示例 1: 单文件详细分析
```
用户消息: 
请帮我分析这张图片
{{OverBase64::detailed::/Users/me/Pictures/sunset.jpg}}
```

输出:
```
[多媒体内容分析结果]

文件: sunset.jpg
  [detailed]: 这是一张美丽的日落照片。画面中，橘红色的太阳正缓缓沉入地平线...
```

### 示例 2: 多预设组合分析
```
系统提示词:
分析以下图片的技术质量和情感表达
{{OverBase64::technical;emotional::images/portrait.jpg}}
```

输出:
```
[多媒体内容分析结果]

文件: portrait.jpg
  [technical]: 图像分辨率为1920x1080，色彩饱和度适中，对焦清晰...
  [emotional]: 照片传达出一种温暖、平静的氛围，人物表情柔和...
```

### 示例 3: 文件夹批量处理（使用缓存）
```
用户消息:
总结这个项目文件夹中的所有图片
{{OverBase64::summary::project/screenshots::cache}}
```

输出:
```
[多媒体内容分析结果]

文件: screen1.png
  [summary (缓存)]: 应用程序的登录界面
  
文件: screen2.png
  [summary]: 用户设置面板
  
文件: screen3.png
  [summary (缓存)]: 数据可视化图表
```

### 示例 4: 复杂场景 - 多个文件和预设
```
系统提示词:
你是一个专业的视觉内容分析师。以下是需要分析的材料：

项目概览：
{{OverBase64::summary::project/overview}}

详细设计稿：
{{OverBase64::detailed;technical::project/designs/final.png::cache}}

参考视频：
{{OverBase64::summary::videos/reference.mp4}}
```

## 工作流程

1. **语法解析**: 插件扫描消息中的 `{{OverBase64::...}}` 语法
2. **路径解析**: 
   - 检查是否为路径别名
   - 解析为绝对路径或相对路径
   - 判断是文件还是文件夹
3. **文件处理**:
   - 如果是文件夹，扫描所有支持的媒体文件
   - 读取文件并转换为 Base64 格式
   - 计算文件内容的 MD5 哈希
4. **缓存检查**:
   - 如果启用缓存且缓存存在，直接使用缓存描述
   - 否则调用多模态 API 获取新描述
5. **预设处理**:
   - 按顺序处理每个预设
   - 使用预设的 prompt 和参数调用 API
   - 支持并发处理以提高效率
6. **结果格式化**:
   - 将所有预设的结果格式化为结构化文本
   - 标注哪些结果来自缓存
   - 替换原始语法为格式化结果

## 支持的媒体格式

- **图像**: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- **视频**: `.mp4`
- **音频**: `.mp3`, `.wav`

## 性能优化

1. **智能缓存**: 基于内容哈希的缓存避免重复处理
2. **并发控制**: 可配置的异步并发数量（`MultiModalModelAsynchronousLimit`）
3. **批量处理**: 一次语法可处理整个文件夹
4. **增量更新**: 只有文件内容变化时才重新处理

## 注意事项

1. **路径别名优先**: 如果路径开头匹配别名，将优先使用别名映射
2. **预设数量限制**: 最多支持 5 个预设组合
3. **缓存持久化**: 缓存会自动保存到 `multimedia_cache.json`
4. **API 调用成本**: 未使用缓存时，每个文件的每个预设都会调用一次 API
5. **文件大小**: 注意 Base64 编码后的数据大小限制

## 与其他多模态处理方式的区别

### MultimediaProcessor vs ImageProcessor

| 特性 | ImageProcessor | MultimediaProcessor |
|------|----------------|---------------------|
| 触发方式 | 自动处理所有 Base64 | 需要明确语法 `{{OverBase64::...}}` |
| 预设支持 | 无，使用全局配置 | 完整的预设系统 |
| 多预设组合 | 不支持 | 支持最多 5 个预设 |
| 文件夹处理 | 不支持 | 完全支持 |
| 路径别名 | 不支持 | 完全支持 |
| 缓存控制 | 自动缓存 | 默认缓存（可用 `::no_cache` 禁用） |
| 批量处理 | 不支持 | 完全支持 |
| 处理方式 | 翻译为文本描述 | 翻译为文本描述 |

### MultimediaProcessor vs `{{ShowBase64::path}}` vs `{{ShowBase64+::~}}`

| 特性 | `{{ShowBase64::path}}` | `{{OverBase64::...}}` | `{{ShowBase64+::...}}` |
|------|------------------------|----------------------|------------------------|
| 触发方式 | `{{ShowBase64::path}}` | `{{OverBase64::preset::path}}` | `{{ShowBase64+::preset::path}}` |
| 处理方式 | **仅发送原始 Base64** | **仅文本描述** | **描述 + 原始 Base64** |
| 预设支持 | ❌ 不支持 | ✅ 支持多预设组合 | ✅ 支持多预设组合 |
| 缓存机制 | ❌ 无缓存 | ✅ 智能缓存系统 | ✅ 智能缓存系统 |
| 路径别名 | ✅ 完全支持 | ✅ 完全支持 | ✅ 完全支持 |
| 文件夹处理 | ✅ 完全支持 | ✅ 完全支持 | ✅ 完全支持 |
| Ignore 文件支持 | `.showbase64ignore` | `.overbase64ignore` | `.showbase64plusignore` |
| 适用场景 | LLM 原生多模态 | 纯文本描述 | **完整体验** |
| API 消耗 | 仅主对话 | 主对话 + 翻译 API | 主对话 + 翻译 API |
| 性能 | 最快 | 中等 | 中等 |
| 模型要求 | 必须支持多模态 | 任意文本模型 | 必须支持多模态 |
| 信息完整度 | 仅原始内容 | 仅文本描述 | **描述 + 原始内容** |

### 使用建议

**使用 `{{ShowBase64::path}}`：**
- ✅ 模型原生支持多模态（GPT-4V, Claude 3, Gemini Pro Vision）
- ✅ 只需要模型直接"看到"原始图像/视频，不需要预先描述
- ✅ 追求最快响应速度
- ✅ 节省 API 成本（无需额外翻译调用）
- ✅ 固定的表情包集合、UI 截图等简单场景

**使用 `{{OverBase64::preset::path}}`：**
- ✅ 只需要文本描述，不需要发送原始多模态内容
- ✅ 需要特定角度的文本描述（技术分析、情感分析、创意描述等）
- ✅ 需要多个不同视角的分析结果
- ✅ 利用缓存避免重复分析
- ✅ 模型不支持多模态输入
- ✅ 需要结构化的文本输出用于后续处理

**使用 `{{ShowBase64+::preset::path}}`（推荐用于复杂场景）：**
- ✅ 需要 LLM 同时理解文本描述和原始多模态内容
- ✅ 复杂的多模态理解任务（医疗诊断、设计评审、代码审查等）
- ✅ 需要多角度预设分析 + 原始内容验证
- ✅ 充分利用缓存节省翻译 API 成本
- ✅ 模型支持多模态，且需要最完整的信息
- ✅ 教育、咨询等需要详细解释的场景

**三者共享的能力：**
- ✅ 路径别名系统（`path-aliases.json`）
- ✅ 文件夹批量处理
- ✅ 专用忽略文件机制（`.showbase64ignore` / `.overbase64ignore` / `.showbase64plusignore`）
- ✅ 深层路径支持
- ✅ 相对路径和绝对路径

**性能与成本对比：**
- `{{ShowBase64::path}}`：最快，成本最低（无翻译 API）
- `{{OverBase64::...}}`：中等速度，中等成本（需翻译 API）
- `{{ShowBase64+::...}}`：中等速度，中等成本（需翻译 API），但信息最完整

## 高级技巧

### 1. 创建专用预设
根据不同的使用场景创建专用预设，例如：
- `code_screenshot`: 专门分析代码截图
- `ui_design`: 专门分析 UI 设计稿
- `documentation`: 专门为文档图片生成说明

### 2. 预设组合策略
合理组合预设可以获得更全面的分析：
- `summary;detailed`: 先概括再详述
- `technical;emotional`: 技术和艺术双重视角
- `default;custom`: 通用+特定需求

### 3. 缓存管理
- **默认启用缓存**，大多数场景无需额外配置
- 开发时使用 `::no_cache` 以获取最新结果
- 生产环境使用默认缓存以节省 API 成本和提高速度
- 定期清理过期缓存（可手动删除 `multimedia_cache.json` 中的旧条目）

## 故障排查

### 问题 1: 路径别名不工作
- 检查 `path-aliases.json` 是否存在且格式正确
- 确认别名路径是否以别名开头
- 查看调试日志（开启 `DebugMode=true`）

### 问题 2: 无法读取文件
- 确认路径是否正确（注意操作系统的路径分隔符）
- 检查文件权限
- 尝试使用绝对路径测试

### 问题 3: 缓存未按预期工作
- **默认就启用缓存**，无需添加 `::cache`
- 如果需要禁用缓存，使用 `::no_cache` 语法
- 检查文件内容是否改变（改变后哈希会不同，会自动重新生成）

## 缓存机制详解

缓存文件位于 `Plugin/MultimediaProcessor/multimedia_cache.json`，采用 **v3.0 优化版缓存结构**。

### 🎯 核心优化：避免 Base64 数据冗余

**v3.0 的关键改进**：以文件 hash 为主键，Base64 数据只存储一次，不同预设的描述结果存储在 `descriptions` 子对象中。

**优势**：
- ✅ **大幅节省存储空间**：同一文件用多个预设处理时，Base64 数据不会重复存储
- ✅ **统一文件管理**：同一文件的所有信息集中在一个条目中
- ✅ **路径追踪**：记录文件被引用的所有路径历史
- ✅ **预设隔离**：每个预设的描述结果独立存储，互不干扰

### 缓存键格式

**v3.0 新格式**：直接使用文件的 MD5 hash 作为主键
```
{MD5_HASH}
```

例如：`a1b2c3d4e5f6789abcdef0123456789`

### 完整缓存数据结构（v3.0）

```json
{
  "a1b2c3d4e5f6789abcdef0123456789": {
    // === 基本标识信息 ===
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "hash": "a1b2c3d4e5f6789abcdef0123456789",
    "cacheVersion": "3.0",
    
    // === 媒体数据（只存储一次）===
    "mimeType": "image/jpeg",
    "base64Data": "/9j/4AAQSkZJRgABAQAA...",
    "fileSize": 245760,
    
    // === 路径信息数组（记录所有引用路径）===
    "paths": [
      {
        "originalPath": "@hornet/example.jpg",
        "resolvedPath": "/Users/username/Pictures/Hornet表情包/example.jpg",
        "usedAlias": true,
        "aliasName": "@hornet",
        "isFolder": false,
        "folderPath": null,
        "batchId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "groupId": "def456abc789xyz123456789abcdef01",
        "fileIndex": 0,
        "totalFiles": 1,
        "lastUsed": "2024-01-15T08:30:00.000Z"
      }
    ],
    
    // === 时间信息 ===
    "createdTime": "2024-01-01T12:00:00.000Z",
    "lastAccessTime": "2024-01-20T14:22:00.000Z",
    
    // === 不同预设的描述结果 ===
    "descriptions": {
      "technical": {
        "description": "这是一张高质量的角色表情包图片...",
        "descriptionLength": 89,
        "presetConfig": {
          "model": "gpt-4o",
          "temperature": 0.3,
          "maxTokens": 2000,
          "topP": 0.9,
          "thinkingBudget": null
        },
        "createdTime": "2024-01-01T12:00:00.000Z",
        "lastAccessTime": "2024-01-15T08:30:00.000Z",
        "accessCount": 15
      },
      "detailed": {
        "description": "一张可爱的角色表情包。画面中的角色双眼闪亮...",
        "descriptionLength": 112,
        "presetConfig": {
          "model": "gpt-4-vision-preview",
          "temperature": 0.7,
          "maxTokens": 2000,
          "topP": 1.0,
          "thinkingBudget": 0
        },
        "createdTime": "2024-01-03T10:15:00.000Z",
        "lastAccessTime": "2024-01-20T14:22:00.000Z",
        "accessCount": 8
      }
    }
  }
}
```

### 缓存元数据字段说明

#### 🔑 基本标识
- **`id`**: 唯一 UUID 标识符，每个文件的全局唯一 ID
- **`hash`**: 媒体内容的 MD5 哈希值（基于 Base64 数据计算）
- **`cacheVersion`**: 缓存格式版本号（当前为 3.0）

#### 📦 媒体数据（只存储一次）
- **`mimeType`**: MIME 类型（如 `image/jpeg`, `video/mp4`）
- **`base64Data`**: **完整的 Base64 编码数据**（不含前缀），所有预设共享
- **`fileSize`**: 估算的原始文件大小（字节）

#### 📂 路径信息数组
`paths` 数组记录该文件被引用的所有路径，每个路径包含：
- **`originalPath`**: 用户输入的原始路径（含别名）

### v3.0 vs v2.0 对比

| 特性 | v2.0 | v3.0 |
|------|------|------|
| 缓存键 | `{hash}_{preset}` | `{hash}` |
| Base64 存储 | 每个预设重复存储 | 只存储一次 |
| 空间效率 | 低（大量冗余） | 高（无冗余） |
| 路径追踪 | 单一路径 | 多路径数组 |
| 预设管理 | 分散在多个条目 | 集中在 descriptions |
| 查询效率 | 需要遍历多个键 | 直接通过 hash 访问 |
| 存储示例 | 同一文件3个预设 = 3份Base64 | 同一文件3个预设 = 1份Base64 |

- **`resolvedPath`**: 解析后的实际文件系统路径
- **`usedAlias`**: 是否使用了路径别名
- **`aliasName`**: 使用的别名名称
- **`isFolder`**: 是否属于文件夹批量处理
- **`folderPath`**: 所属文件夹路径
- **`batchId`**: 批次唯一标识（UUID）
- **`groupId`**: 组合唯一哈希标识
- **`fileIndex`**: 在组合中的索引位置
- **`totalFiles`**: 该组合包含的文件总数
- **`lastUsed`**: 该路径最后使用时间

#### 📝 描述结果对象
`descriptions` 对象以预设名称为键，存储每个预设的处理结果：
- **`description`**: 描述文本内容
- **`descriptionLength`**: 描述长度
- **`presetConfig`**: 使用的预设配置（model, temperature, maxTokens, topP, thinkingBudget）
- **`createdTime`**: 首次创建时间
- **`lastAccessTime`**: 最后访问时间
- **`accessCount`**: 累计访问次数

#### 📊 文件级时间信息
- **`createdTime`**: 文件首次被处理的时间
- **`lastAccessTime`**: 文件最后被访问的时间（任何预设）

### 缓存使用场景

#### 1. 查找文件的所有预设描述
```javascript
// 直接通过 hash 获取所有预设结果
const fileHash = 'a1b2c3d4e5f6789abcdef0123456789';
const fileCache = mediaCache[fileHash];
const allDescriptions = fileCache.descriptions;
// 输出: { technical: {...}, detailed: {...}, emotional: {...} }
```

#### 2. 添加新预设描述（无需重复存储 Base64）
```javascript
// 在已存在的文件记录中添加新预设
mediaCache[fileHash].descriptions['newPreset'] = {
  description: '...',
  presetConfig: {...},
  createdTime: new Date().toISOString(),
  lastAccessTime: new Date().toISOString(),
  accessCount: 1
};
```

#### 3. 追踪文件引用路径
```javascript
// 查看文件被哪些路径引用过
const paths = mediaCache[fileHash].paths;
paths.forEach(p => {
  console.log(`路径: ${p.originalPath}, 最后使用: ${p.lastUsed}`);
});
```

#### 4. Base64 复用（所有预设共享）
```javascript
// 直接读取文件的 Base64，用于任何预设
const base64Data = mediaCache[fileHash].base64Data;
const mimeType = mediaCache[fileHash].mimeType;
// 无需重新读取文件
```

#### 5. 统计空间节省
```javascript
// 计算如果用 v2.0 会浪费多少空间
Object.values(mediaCache).forEach(file => {
  const presetCount = Object.keys(file.descriptions).length;
  const savedSpace = file.fileSize * (presetCount - 1);
  console.log(`文件 ${file.hash.substring(0,8)}: 节省了 ${savedSpace} 字节`);
});
```

### 缓存优势（v3.0）

- ✅ **大幅节省存储空间**：Base64 数据只存储一次，避免重复（关键优化！）
- ✅ **统一文件管理**：同一文件的所有信息集中管理
- ✅ **避免重复调用 API**：相同内容和预设直接使用缓存
- ✅ **快速响应**：无需等待 API 调用
- ✅ **节省成本**：减少 API 调用费用
- ✅ **完整追溯**：保存完整的处理上下文和元数据
- ✅ **多路径追踪**：记录文件被引用的所有路径
- ✅ **预设灵活性**：轻松添加新预设描述，无需重复存储媒体数据
- ✅ **统计分析**：访问次数、时间等统计信息
- ✅ **批量管理**：通过 batchId 和 groupId 管理批量处理结果

**空间节省示例**：
- 一个 2MB 的图片用 3 个预设处理
- v2.0: 存储 3 次 Base64 = 6MB
- v3.0: 存储 1 次 Base64 = 2MB
- 节省: 4MB (67%)

### 缓存管理建议

1. **定期清理**：删除 `lastAccessTime` 超过 30 天且 `accessCount` 较低的记录
2. **大小控制**：监控 `multimedia_cache.json` 文件大小，超过一定阈值时清理
3. **备份策略**：定期备份缓存文件，避免丢失历史数据
4. **版本迁移**：旧版本缓存（无 `cacheVersion` 字段）可手动删除或迁移

### 缓存查询示例（v3.0）

#### 查找特定文件的所有预设描述
```javascript
// 直接通过 hash 访问
const fileHash = 'a1b2c3d4e5f6789abcdef0123456789';
const file = mediaCache[fileHash];

// 列出所有预设及其描述
Object.entries(file.descriptions).forEach(([preset, info]) => {
  console.log(`${preset}: ${info.description.substring(0, 50)}...`);
  console.log(`  访问次数: ${info.accessCount}`);
});
```

#### 查找使用特定预设的所有文件
```javascript
// 查找所有使用 'technical' 预设的文件
const filesWithTechnical = Object.entries(mediaCache)
  .filter(([hash, file]) => file.descriptions.technical)
  .map(([hash, file]) => ({
    hash: hash.substring(0, 8),
    description: file.descriptions.technical.description,
    accessCount: file.descriptions.technical.accessCount
  }));
```

#### 查找特定批次的所有文件
```javascript
// 假设 batchId 为 7c9e6679-7425-40de-944b-e07fc1f90ae7
const batchFiles = Object.entries(mediaCache)
  .filter(([hash, file]) => 
    file.paths.some(p => p.batchId === '7c9e6679-7425-40de-944b-e07fc1f90ae7')
  )
  .map(([hash, file]) => {
    const pathInfo = file.paths.find(p => p.batchId === '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    return { hash, fileIndex: pathInfo.fileIndex, file };
  })
  .sort((a, b) => a.fileIndex - b.fileIndex);
```

#### 统计最常用的预设
```javascript
const presetStats = {};
Object.values(mediaCache).forEach(file => {
  Object.entries(file.descriptions).forEach(([preset, info]) => {
    if (!presetStats[preset]) {
      presetStats[preset] = { count: 0, totalAccess: 0 };
    }
    presetStats[preset].count++;
    presetStats[preset].totalAccess += info.accessCount;
  });
});
console.log(presetStats);
// 输出: { technical: { count: 50, totalAccess: 320 }, ... }
```

#### 计算存储空间节省
```javascript
let totalSaved = 0;
Object.values(mediaCache).forEach(file => {
  const presetCount = Object.keys(file.descriptions).length;
  if (presetCount > 1) {
    const saved = file.fileSize * (presetCount - 1);
    totalSaved += saved;
    console.log(`${file.hash.substring(0,8)}: ${presetCount}个预设, 节省 ${(saved/1024/1024).toFixed(2)}MB`);
  }
});
console.log(`总共节省: ${(totalSaved/1024/1024).toFixed(2)}MB`);
```
- 查看 `multimedia_cache.json` 