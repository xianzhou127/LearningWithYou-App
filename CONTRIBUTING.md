# 贡献与维护

先阅读 README、AGENTS.md 和 STATUS.md。当前仓库为私有维护项目，原创代码许可尚未指定；保留文件已有作者和第三方声明。

1. 使用 README 指定的 Node/pnpm，执行 `pnpm install --frozen-lockfile`。
2. 从清晰的问题出发创建 `codex/` 分支，保持小范围修改；不要混入依赖批量升级或 UI 重做。
3. 用独立 `--user-data-dir` 测试，素材、凭据和服务响应均使用合成数据。真实录音或 API 联调需单独授权。
4. 执行 `pnpm check`、`pnpm build`。资源、IPC、窗口或配置改动还需 `pnpm package` 和适用的 `test:package`、`test:windows`、`test:glass`、`test:appearance`。
5. 提交前检查暂存文件与内容，不能包含 `.env.local`、用户数据、加密配置、历史、录音、真实截图、日志、node_modules、dist 或 release。
6. 描述具体行为变化、验证命令、真实服务未验项；更新简短 STATUS。自动化通过不替代人工验收。

当前构建依赖锁定版本；依赖调整需同时审查 lockfile、打包资源和许可证。二进制如需分发，应进入明确授权的 GitHub Release，标明候选/验收状态，不提交到源码 Git。
