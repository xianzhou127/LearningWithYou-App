# 来源与独立拆分

来源为用户指定的 LearningWithYou 当前工作区，基线提交 `e4510f52dabf0e2cf64b0bbf92d158de735e5518`（2026-09-24，原作者标识 `Codex <codex@local>`）。原路径仅用于此次提取，没有写入构建/运行脚本或依赖配置。

**不是纯 HEAD 导出。** 来源 STATUS 与 README 表示工作区已经实现 0.16.4，尚未提交、尚待人工验收；最近人工验收为 T15 / 0.15.10。本次读取了源 AGENTS、STATUS、README、最新 `docs/T16.0.md`、T15 与玻璃上游记录。实际提取 UTC 时间和各文件的原始 SHA256、已跟踪/已修改/未跟踪状态见 [source-manifest.json](source-manifest.json)。新 Git 仓库使用全新历史，不复制原 .git。

必要的未跟踪内容包括 ASR 预设、分析/ASR 配置解析、配置弹窗与连接测试、窗口标题组件、T16 回归测试。必要的已修改代码包括主进程、预加载、配置和会话、分析/ASR 服务及 UI。完整逐项状态在清单中，不能把这些内容称为完全来自已提交 T15。

提取基于 TypeScript 静态导入闭包：Electron 五个入口、桌面单元测试、GPU 测试及配置/窗口 UI 测试，再补齐 HTML、PCM worklet、C# 工具、预设和声明等非 import 资源。共享 `app/lib` 移至 `shared/`；仅被桌面使用的 ASR 错误类型/类从网页客户端中抽取为 `asr-errors.ts`。网页专用的 AnalysisFeedback 测试从混合 T16 UI 测试文件移除，保留桌面配置用例。未复制网页组件、路由、服务器或网页测试套件。

独立整理改动：修正相对引用；移除 Next 专用 lint 注释、框架/环境加载依赖和少量末尾空行；替换为独立 TypeScript/ESLint 配置；依赖使用源项目已安装版本并由原锁文件裁剪，额外声明之前靠外部环境提供的 Playwright；重命名构建输出为 dist、包为 LearningWithYou-App；增加完整运行依赖许可证收集、文档、合成截图和独立包验证。业务提示词、会话状态、媒体策略、玻璃算法与预设不因拆分而改写。

应用版本保留 0.16.4，标为独立工程候选，不创造已验收新功能版本。源码仓库名改变；运行时名称 `LearningWithYou T11`、AppUserModelId `local.learningwithyou.t11`、默认 userData 路径和配置迁移保持原样。

未提取：原项目 `.env.local`、个人配置、历史、音频和真实截图、未明来源的目录、历史实验、原始验证产物、缓存、node_modules、旧 release、网页配置与无用途的演示启动器。验证报告只写入新项目；原项目文件、STATUS、Git index、HEAD、remote 和工作区状态保持只读，最终核验见 VALIDATION。

原 T11/T12 媒体结束及归档失败、T15 性能观察未完成/实例关闭、history-status 拒绝记录仍在来源项目，本仓库不将其改写为成功。来源 T16 记录的用户确认“ASR 已可用”和既有合成资料真实分析不等于本次完整流程重新验证；本次独立整理未授权新的真实录音/付费调用。
