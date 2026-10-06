# Hibiki Player

本地音乐播放器，Windows 桌面版（Electron）+ 单文件网页版：波形 · 频谱 · 声谱图 · 声场，
Apple Music 风格界面，内置杜比 / DTS 解码，并支持从 B 站下载原始音频。

安卓版见 [hibiki-player-android](https://github.com/kato-ito/hibiki-player-android)。

## 功能

### 播放与界面

- **歌单矩阵主界面 + 歌曲播放主界面**：两个主界面随时互切，播放状态零丢失；歌单主界面底部是迷你播放条（封面 / 曲名 / 播放控制 / 进度线）
- **Apple Music 风格播放页**：左侧大封面 + 右侧歌词逐行高亮 + 居中播放控制；无歌词时封面整区居中
- **播放队列抽屉**：当前曲高亮、长按拖动排序、删除；队列与歌单面板分开
- **音频可视化**：波形 / 频谱 / 声谱图 / 声场四种视图，从 ⋯ 菜单一键在播放页右侧展开
- **皮肤与自定义背景**：深色 / 白色 / 复古三套皮肤 + 自定义背景图，设置保存在本机
- **歌词**：解析音频内嵌歌词，也可手动载入 `.lrc`
- **麦克风实时可视化**（桌面版已在主进程放行权限，无浏览器授权弹窗）

### 解码与音频输出

- 内置 FFmpeg：**杜比 E-AC3 / AC3 / DTS 等多声道编码**自动转码后播放，可切换多声道输出方式
- **采样率自适应**：44.1k / 48k / 96k / 192k 逐曲切换，转码保留原始采样率
- 常见格式 mp3 / flac / m4a / wav / ogg / aac，读取内嵌封面与 标题 · 歌手 · 专辑 标签
- 转码临时文件自动清理（带容量预算，不会无限增长）

### B 站音频下载

- 粘贴 BV 号 / 视频链接 / b23.tv 短链解析；显示标题、UP 主、封面、时长、分 P
- 音质档位：自动（最高）/ AAC / Hi-Res 无损 FLAC / 杜比全景声 E-AC3（后两者需登录会员账号）
- 格式：原始音频封装（不重编码）或 MP3 转码；可内嵌封面并写入 标题 / UP 主 / 专辑 / 来源 标签
- **合集（多 P）自动分文件夹**：以视频名建子文件夹，文件只用分 P 名命名（如 `P3 正片.m4a`），标题标签同步为分 P 名
- 逐任务显示进度 / 速度 / 大小，可随时取消；完成后自动加入歌单并可打开所在文件夹
- 扫码登录：二维码在本地渲染（内置 MIT 二维码库），不经过任何第三方服务

## 目录结构

```
Hibiki Player/
├── app/                     # Electron 应用源码（这里的文件才是桌面版本体）
│   ├── index.html           #   桌面版页面（与根目录 hibiki-player.html 保持同步）
│   ├── main.js              #   主进程：窗口、麦克风权限、旧数据迁移
│   ├── preload.js           #   渲染进程桥
│   ├── bili-ipc.js          #   B 站解析 / 取流 / 下载 / ffmpeg 封装 / 扫码登录
│   ├── bili-naming.js       #   合集命名规则（纯逻辑，可单测）
│   ├── bili-stream.js       #   DASH 音轨挑选（含降级兜底）
│   ├── dolby-ipc.js         #   杜比 / DTS 转码 IPC（ffmpeg）
│   ├── fs-ipc.js            #   已保存歌单的文件读取桥
│   ├── qrcode-lib.js        #   二维码生成库（MIT）
│   ├── build/               #   应用图标
│   └── verify-*.js / test-*.js / snap*.js   # 端到端验证与截图脚本
├── hibiki-player.html       # 单文件网页版（浏览器直接打开）
└── 使用说明.md              # 详细功能与版本说明
```

## 运行与打包

```bash
cd app
npm install
npm start            # 开发运行
npm run dist         # 打包 Windows 安装包（electron-builder --win nsis，输出到 app/dist）
```

网页版无需构建：直接用浏览器打开 `hibiki-player.html`。网页版没有桌面版专属能力（杜比 / DTS 转码、
B 站下载、本地文件直读等）。

## 测试

```bash
node app/check-syntax.js        # 页面内联脚本语法检查
node app/test-bili-naming.js    # 合集命名规则（17 项）
node app/test-bili-stream.js    # 音轨挑选规则（7 项）
npx electron app/verify-dolby.js <某个 .ac3/.eac3 文件>   # 需要 electron 依赖
```

## 隐私

- 所有数据（歌单、设置、B 站登录 Cookie）只保存在本机 `userData` 目录，不会上传到任何服务器
- Cookie 只在请求 `*.bilibili.com` 官方接口与官方 CDN 时使用；退出登录即删除本机 Cookie 文件
- 没有任何遥测、统计、广告或第三方上报端点

## 说明

- 本仓库只包含源码，不包含构建产物（`dist/`）、依赖目录（`node_modules/`）与签名密钥
- 安装包未做代码签名，运行时 Windows SmartScreen 可能提示「未知发布者」，选择「仍要运行」即可

## 许可

[MIT](LICENSE) © 2026 Zai
