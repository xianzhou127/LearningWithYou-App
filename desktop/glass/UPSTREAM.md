# T15 formal capsule source

Material and motion transplanted from T14.8 candidate 10, commit `74aa059`.
Static acceptance: T14.7 candidate24 `presets/static-accepted24.json`, byte-for-byte copy,
SHA256 `C85F712063998DF003E024237772E26190E3ED701932B02A74335ABE71A525AD`.
Motion acceptance: final record in `docs/T14.8.md`, 2026-09-23;
engineering DEFAULT values do not represent that accepted configuration.

Optical reference: iyinchao/liquid-glass-studio, commit
`f7b28c36305a862f5cffed3ddd51511cf1204f56`, MIT, Copyright (c) 2024 Charles Yin.
License retained in `upstream/LICENSE.txt`, included in the production package.
The original upstream references and previous failure evidence remain in the experiment.

Production owns its capture lifecycle, IPC, window geometry and settings files.
The optical shaders, elastic solver, deformation, foreground and range definitions
retain the accepted implementation. No experiment launcher, fake service,
performance console, runtime cache or raw evidence is shipped.

Only the optional user-selected JSON import reads an experiment save file. It
changes the current preview; explicit Save writes a separate formal file.
Normal startup and packaging need no experiment directory or development server.

0.15.1 adapts the texture crop pass for adjacent display streams, resizes the
foreground atlas at the active display density, and normalizes input coordinates
through the host transform. All five shader strings and the motion solver remain
identical to candidate10. Physical monitor metadata comes from the existing
bundled Windows source catalog; material starts automatically unless explicitly
disabled in saved material preferences. This does not grant learning or audio access.

0.15.4 adds an inline menu view of the same capture pool and saved configuration.
The accepted capsule shaders remain unchanged. The optional panel adapter changes
only the signed-distance outline/normal to the existing 16-DIP menu corner radius;
foreground masks and adaptive frost use the menu dimensions and existing glyphs.
Menu presses/contact light sample the accepted MotionEngine. Menu placement stays
fixed (no drag handle or capsule-wide elastic deformation is added to the menu).
No upstream license or historical acceptance/failure record is changed.
## T15 / 0.15.5 菜单跟随与预热

菜单与主体在同一渲染帧更新真实位置，主进程共享 menuPlacementFor 用于松手后的命中区域。按已连接屏幕的不同像素密度保留有限菜单预热缓存，收起停止绘制；隐藏、关闭材质、失败和退出时释放。

用户要求的菜单高磨砂默认开启（menuFrost），只对菜单启用固定 σ=6 DIP 模糊并关闭菜单自适应模糊变化，主体验收参数不变。关闭后直接使用主体设置。沿用原模糊着色器和清晰前景，B 对照模式也支持菜单固定高模糊；A 或材质关闭时仍不采集。

## T15 / 0.15.6 菜单收起残影

常驻菜单的父级 visibility:hidden 不能遮住显式 visibility:visible 的缓存画布。关闭/等待首帧时增加整层 opacity 门控，并在开合状态切换时隐藏缓存画布，等实际绘制后恢复显示。保留缓存与布局测量，不修改原材质、动效算法或菜单业务操作。
