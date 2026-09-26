# 第三方来源与许可

本文件是来源说明，不为原创代码授予新许可。未在源项目根目录发现明确的原创代码项目级许可证；本仓库 `license: UNLICENSED` 表示尚未指定，不是将第三方组件改为专有许可。

## 液态玻璃

`desktop/glass/` 随 App 内置，来自原项目 T15 正式集成；静态参数来自候选24，动效来自候选10。光学参考/派生实现的上游为 [iyinchao/liquid-glass-studio](https://github.com/iyinchao/liquid-glass-studio)，固定提交 `f7b28c36305a862f5cffed3ddd51511cf1204f56`，MIT，Copyright (c) 2024 Charles Yin。

完整原声明见 `desktop/glass/UPSTREAM.md`，完整许可证原字节保留在 `desktop/glass/upstream/LICENSE.txt`，随包放入 `glass/LICENSE.txt`。原声明提及的历史实验/文档保留在来源项目；本仓库不复制整套实验，也不依赖其目录。该 MIT 许可只覆盖其适用的上游代码，不覆盖整个 App。本次没有建立、发布或处理独立玻璃仓库。

## JavaScript、原生依赖和运行时

直接运行依赖：React、React DOM、react-markdown、remark-gfm、remark-math、rehype-katex（及 KaTeX）、sharp、ws。精确版本及传递依赖以 `pnpm-lock.yaml` 为准。构建时 `scripts/licenses.mjs` 沿安装后的生产依赖图收集完整 LICENSE/COPYING/NOTICE/AUTHORS，连同已 bundle 的 Markdown/数学渲染依赖声明放入 `licenses/`；esbuild 的 linked legal comments 同时保留。

sharp 的 JavaScript 包遵循 Apache-2.0；其 Windows 原生包带有自身声明，所含 libvips 等第三方库需遵守各自许可证（包括 LGPL 的相关条款）。随包保留原包声明及上游获取源码信息，不重写这些文件。ws、React 及多数组件遵循其各自 MIT 等声明，不能用本说明替代完整许可证。

Windows 原生依赖的许可表位于包内 `node_modules/@img/sharp-win32-x64/README.md`，各库版本位于同目录 `versions.json`；构建/源码来源为 [sharp-libvips](https://github.com/lovell/sharp-libvips) 及其列出的各上游库。原生 DLL 以解包文件随便携目录提供。本次仅上传源码仓库，没有发布二进制 Release。

Electron 的 `LICENSE` 和 `LICENSES.chromium.html` 由官方运行时随便携包携带，涵盖 Electron/Chromium 的第三方声明。开发工具（TypeScript、ESLint、esbuild、Playwright、Electron Packager 等）只参与开发构建，不是学习应用的运行服务，其许可证保留在安装依赖中。

## 字体、图标和本地资源

界面使用系统 Segoe UI、微软雅黑和 Cambria Math 等字体。公式输出为 MathML，不使用 KaTeX 网页 CSS/网络字体；本仓库和安装包不复制 Microsoft 系统字体。Electron 在目标 Windows 系统解析这些字体，缺失时使用 CSS 后备字体。

本地图标为来源项目 `desktop/ui-icon.tsx` 的内联 SVG；来源项目未附额外图标包或独立第三方来源声明，本次不改作者或杜撰归属。PCM worklet、C# 窗口辅助源码及其来源 SHA256 见提取清单。README 截图由本仓库包在隔离测试数据下生成，不含第三方文档、真实用户资料或服务回复。
