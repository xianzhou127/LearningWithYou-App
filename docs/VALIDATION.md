# 独立验证

本次日期：2026-09-26。独立工程候选 0.16.4，仍待用户人工验收。

## 已执行的检查

环境：Windows 11 企业版 x64，10.0.22621；Node 24.18.0、pnpm 11.19.0、Electron 44.3.0、系统 .NET Framework 4.x csc。实际 WebGL 为 ANGLE / NVIDIA GeForce RTX 2060 / Direct3D11（驱动 32.0.15.8115）。没有验证其他操作系统、CPU 架构或所有 GPU/缩放组合。

| 检查 | 本地工作区结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过，零警告 |
| `pnpm test` | 172/172 通过，无跳过；mock/合成测试 |
| `pnpm build` / `pnpm package` | Windows x64 生产构建、C# 编译及便携打包通过；约 389.47 MiB |
| 包资源 | 383 项显式资源，含 258 个依赖声明/README；ASAR 及解包哈希、sharp/ws 原生加载通过；Electron/Chromium 声明存在 |
| `pnpm test:package` | 实际 EXE、Windows safeStorage、v2→v3 迁移、独立配置列表及保存/重启恢复、合成连接测试通过 |
| `pnpm test:windows` | 实际页面及 Win32 前台/层级、最小化、最大化/还原、反馈材质、窗口 IPC/会话状态检查最终通过，零主进程/渲染异常 |
| `pnpm test:glass` | 生成的视频/像素上的 GPU、文字遮罩、菜单与动效检查通过；不代表真实背景视觉验收 |
| `pnpm test:appearance` / `pnpm screenshots` | 实际 EXE 玻璃渲染、材质和动效保存/重启恢复、轨道释放及合成 UI/MathML 截图通过 |

所有运行检查都使用临时 userData。配置测试使用合成密钥和本机 HTTP mock；外观测试以生成 canvas 视频替代 getDisplayMedia，禁用麦克风。没有真实录音、ASR 或模型调用；未读取或改写真实用户配置和学习历史。README 图片是上述实际 App 页面，非设计稿。

## 检查中遇到的问题

- 继承的 GPU 浏览器测试通过 DesktopSession 新增引用触及 Node 配置解析边界，首次构建失败。只在 GPU 测试入口把这两个永远不应调用的配置函数替换成抛错桩；Node 配置回归照常运行，生产代码和权限不变。修正后 GPU 检查通过。
- 新增外观检查首次从胶囊请求只对调参页开放的 telemetry，收到 IPC 拒绝；改由调参页读取后通过。没有放宽权限来通过测试。
- 继承的窗口脚本把空 settings 当作“关闭材质”的配置，但空对象按原验证规则无效。测试夹具改用有效数值并增加启动 disabled 断言，防止验证意外采集真实背景。
- 一次 Win32 前台检查获得 `other` 而非 settings；保留失败日志并重新验证，不据此修改窗口实现或删除断言。
- 原生 sharp 包禁止常规 metadata/bare import，初版声明收集遗漏其 README 许可表。按 Node 搜索目录解析后，原生 README、LICENSE 与传递依赖完整纳入显式打包清单。

原始日志、加密合成配置和临时报告只留在忽略的 `.local/`、`artifacts/` 或临时目录，不纳入源码 Git。

## 来源只读与独立性

867 个来源已跟踪/未忽略文件的 SHA256、Git 状态、HEAD 和 `.git/config` 与提取前一致。127 个提取的业务/资源/测试文件在仅规范记录的引用、Next lint 注释及末尾空白调整后内容一致。ASR 错误类单独抽取，来源与变化见 PROVENANCE。

暂存文件经过路径、普通文件/链接及凭据模式扫描，并人工检查清单；只含代码、锁文件、文档和生成的合成页面截图。未包含用户数据、环境密钥、音频、实际资料截图、产物或来源 .git。运行/构建脚本没有来源绝对路径、跨仓库链接或 file: 依赖。

## 干净检出验证

从初始提交 `0d9e60b8c5eff75dfe678e151adb2cbc1e44b3b2` 使用 `git clone --no-hardlinks` 建立全新 C 盘检出；更新到 `6bae779dd78b9e3b97b6a67523f41badcacb3afc`（仅新增 lint 忽略本地 pnpm 存储）。没有复制原项目或新工作区的 node_modules、dist、release、配置、环境文件。

- `pnpm install --frozen-lockfile --store-dir .pnpm-store --package-import-method copy`：通过，使用该检出自己的全新内容存储，23 个直接运行/开发依赖真实路径全部在检出目录内。
- 按 README 执行 `pnpm check`：类型、无警告 lint、172/172 测试通过；新增 ignore 后 lint 再次通过。
- `pnpm package`：从源码重新编译 C#、生产 bundle 和 Windows x64 便携包，383 项资源及原生依赖检查通过。
- 该检出生成的真实 EXE 再执行 `test:package`、`test:windows`、`test:appearance`：全部通过，零主进程/渲染异常；配置/加密/迁移/重启、窗口、玻璃调参恢复与资源释放结果与主工作区一致。
- `test:glass`：该检出自己的 Electron/依赖完成全部 GPU 合成检查；未进行真实背景视觉验收。
- 检查后 `git status --short` 为空；玻璃许可证与两个内置预设在 Git 检出后仍与来源字节相同。之后仅追加验证/状态文档，不修改已验证运行代码。

## GitHub

GitHub CLI 已通过官方发布 SHA256 校验取得，`gh auth status` 显示未登录。所有可独立完成的本地工作已完成，当前只等待用户登录后新建 Private 仓库、推送并核验远端；没有创建公网部署、npm 发布或二进制 Release。

## 仍需人工/真实服务验收

非百炼云端、本地真实视觉模型、真实麦克风/ASR→两张截图→分析→归档→连续下一轮；真实多屏/缩放、捕获排除、被遮挡文档、整屏黑块、长期资源稳定性及反馈质量。源 T11/T12 和 T15 历史失败/未测结论保留，不用本次 mock 成功覆盖。
