# 音锁 UnlockTune

> 在浏览器本地把 `.ncm` / `.qmc` / `.kgm` / `.kwm` 等加密音乐**还原**为原始 MP3、FLAC、M4A 音频流。
> 文件不上传、音频不重编码、项目零依赖。

---

## 🌐 在线体验

**<https://unlocktune.app.workbuddy.host/?sharecode=O36LECPUBZ>**

公网直接打开即可使用，无需注册、无需安装。站点托管在 WorkBuddy 应用发布服务上，服务器只提供静态 HTML / CSS / JS；**所有解密运算都在你自己的浏览器 Web Worker 内完成**，可在处理时断开网络验证。

| 访问方式 | 地址 |
| --- | --- |
| 线上（推荐体验） | <https://unlocktune.app.workbuddy.host/?sharecode=O36LECPUBZ> |
| 本地预览 | <http://localhost:4173/>（执行 `npm run dev` 后） |

> 目前依赖的静态资源（`src/*.js`、`styles.css`）全部相对路径引用，任何静态托管（Nginx / GitHub Pages / Vercel / OSS）都能直接部署整个目录，无需构建步骤。

---

## 它做什么，不做什么

**它是「解密还原」，不是「转码」。** 各平台下载的加密文件内部本来就是完整的 MP3 / FLAC / M4A 音频流，只是被逐字节异或或流密码打乱了。音锁把这层锁去掉，把**原始字节**还给你，因此零音质损失。

- ✅ 输出后缀由解密后文件的**魔数**自动判定，而不是硬改成 `.mp3`：`mp3` / `flac` / `m4a` / `ogg` / `wav` / `ape` / `wv` / `aiff` / `amr` / `dff`
- ✅ NCM 容器内嵌的歌名、歌手、专辑、封面会被解析展示；封面可单独下载或随 ZIP 打包
- ❌ 不重新编码、不改变音质、不主动改写 ID3 / FLAC 标签（原本带标签的文件原样保留）
- ❌ 不提供绕过付费、账号体系或获取未授权内容的能力；不向任何平台服务器请求密钥
- ❌ 若确实需要把 FLAC 转成 MP3，请用 ffmpeg 等工具做二次转码

---

## 支持矩阵

| 平台 | 常见后缀 | 处理方式 | 状态 |
| --- | --- | --- | --- |
| 网易云音乐 | `.ncm` | AES-128-ECB 解出密钥盒 → 逐字节还原；解析元数据与封面 | ✅ 完全离线 |
| QQ 音乐（老版） | `.qmc` `.qmc3` `.qmcflac` `.mflac` `.mgg` | 静态 8 字节 mask / Map / RC4 三种流密码 | ✅ 完全离线 |
| QQ 音乐（带 ekey） | 上述后缀 + QTag 尾部 | TEA 解包 ekey → Map / RC4 | ✅ 完全离线 |
| 酷我音乐 | `.kwm` | 内置静态密钥表异或 | ✅ 完全离线 |
| 酷狗音乐 | `.kgm` `.vpr`，部分 `.kgma` | 文件头 17 字节私钥 + 静态大掩码表 | ⚠️ 需导入 `kgm.maskfile` |
| QQ / 酷狗 / 酷我新版 | `.mflac0` `.mgg1` `.mggl` `.kgg` `.kwma` 等 | 密钥由平台服务器或客户端账号库下发 | ⛔ 不支持，明确报错 |
| 任意平台 | 仅后缀伪装、内容其实是普通音频 | 魔数嗅探后原样输出 | ✅ 完全离线 |

对于无法离线解开的变体，工具会**明确报错**，不会生成看似成功、实则无法播放的坏文件。

### 关于酷狗密钥表

老版 KGM / VPR 除文件头私钥外还需要一份开源社区提取的公开静态大掩码表（常见文件名 `kgm.maskfile`，解压后约 6.5 MB）。本站**不内置、不联网下载**，由你在页面「酷狗 KGM / VPR 密钥表」区域自行拖入，全程只存在于本机内存。

- 支持：原始 `.bin` / `.maskfile` / `.dat`、gzip 压缩的 `.gz`
- `.xz` 压缩（`kugou_key.xz`）请先在本机解压后再导入
- 每 1 字节掩码对应 16 字节音频，表越大可处理的文件越大

---

## 快速开始

### 在线使用（三步）

1. 打开 <https://unlocktune.app.workbuddy.host/?sharecode=O36LECPUBZ>
2. 把加密音乐拖进工作台（支持多选），或点击选择文件；队列自动开始并行处理
3. 单首点击「下载」，或点「打包下载全部 (ZIP)」一次带走

### 本地运行

需要 Node.js ≥ 18（仅用于起一个静态服务器，项目本身零依赖、无需 `npm install`）：

```bash
npm run dev        # 启动本地预览 → http://localhost:4173/
```

也可以把整个目录丢给任意静态服务器，例如：

```bash
python3 -m http.server 4173
```

> 注意：请通过 HTTP 访问，不要直接双击 `index.html` 用 `file://` 打开 —— ES Module 与 Web Worker 会受浏览器同源策略限制。

---

## 功能清单

- 拖拽 / 多选导入，自动识别格式与真实音频类型
- 多任务队列 + Web Worker 并行处理，实时进度与大文件分块（1 MB）让出执行
- 每首展示歌名 / 歌手 / 专辑、封面、输出格式与体积
- 单文件下载、封面单独下载、中文名去重、ZIP（store 模式）批量打包
- 失败项一键重试、清空队列、Toast 提示
- 格式支持矩阵、使用说明、FAQ 与合规声明
- 深色主题、响应式布局

---

## 项目结构

```
.
├── index.html            # 页面结构与文案
├── styles.css            # 深色主题样式
├── src/
│   ├── aes.js            # 纯 JS AES-128-ECB（不依赖 WebCrypto，file:// 亦可用）
│   ├── tea.js            # TEA / simpleMakeKey，用于 QMC ekey 解包
│   ├── utils.js          # 字节工具、Base64、XOR、错误处理
│   ├── ncm.js            # NCM 容器：密钥盒、元数据、封面
│   ├── qmc.js            # QMC 静态 mask / Map / RC4 / QTag ekey
│   ├── kwm.js            # 酷我 KWM
│   ├── kgm.js            # 酷狗 KGM / VPR（含 272 字节修正表）
│   ├── sniff.js          # 解密后按魔数判定真实格式
│   ├── index.js          # 统一入口：路由、元数据、命名
│   ├── worker.js         # Worker 消息协议与分块解密
│   ├── zip.js            # 零依赖 ZIP（store）打包
│   └── main.js           # UI 交互、队列调度、下载、密钥表导入
├── scripts/serve.mjs     # 零依赖本地静态服务器
├── tests/                # 内核自测、Worker 浏览器自检、UI 端到端
└── README.md
```

---

## 测试

```bash
npm test             # 解密内核自测（17 项）
npm run test:browser # 真实 Chrome UI 端到端（需本机安装 Chrome）
# 直接对线上站点做端到端验证：
APP_URL='https://unlocktune.app.workbuddy.host/?sharecode=O36LECPUBZ' npm run test:browser
```

`npm test` 覆盖 AES FIPS-197 标准向量、自建合法 NCM 容器（音频 / 元数据 / 封面字节级还原）、TEA ekey 反向构造、QMC 三种流密码、KWM、KGM 掩码公式与 ZIP 回读。浏览器侧另有一份 Worker 通道自检页（`tests/browser-check.html`，12 项）与 CDP 驱动的 UI 端到端测试。

---

## 隐私与合规

- 页面加载后**不发起任何音频上传请求**，服务器只提供静态资源；任务结果只存在于浏览器内存，刷新即清空
- 请仅将本工具用于**自己合法下载、供个人跨设备播放与备份**的音频文件，并遵守相应平台服务条款与所在地法律法规
- 尊重音乐版权，勿用于传播未授权内容

算法参考社区开源逆向实现（unlock-music 等），本项目为纯前端学习与技术验证用途。

---

## 常见问题

**为什么有些文件提示「需要服务器密钥」？**
新版加密把密钥放在服务端或绑定客户端登录态与本地数据库，无法从文件本身推导。任何声称能「纯网页离线解开」的站点都值得怀疑。

**解密后歌名、封面还在吗？**
NCM 容器单独存了一份元数据和封面，本站会解析展示并可单独导出；音频流自带的 ID3 / FLAC 标签原样保留，本站不主动改写。

**支持整个文件夹或超大无损文件吗？**
可一次多选 / 拖入多个文件（浏览器不支持直接拖入文件夹，请先全选文件）。解密按 1 MB 分块并让出主线程，几十 MB 的 FLAC 可稳定处理。

**线上地址会变吗？**
该链接由 WorkBuddy 应用发布服务托管；后续重新发布会沿用同一域名。可在「设置—数据管理—应用」中查看与管理已发布的应用。
