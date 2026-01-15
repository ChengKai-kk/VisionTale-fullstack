# Deep Dive: Frontend SPA

## 概览
前端是 Vue 3 + Vite 的单页应用, 通过 Vue Router 组织成 7 个步骤页面。每个页面独立拉取 session 与轮询 task, 通过 localStorage 保存 sessionId。

## 入口与布局
- 入口: `visiontale_front/src/main.js`
- 根组件: `visiontale_front/src/App.vue`
- 布局: `visiontale_front/src/layouts/AppLayout.vue`
- 顶部进度条: `StepProgress.vue`
- 底部导航栏: `NavigationBar.vue`
- 加载状态组件: `LoadingState.vue`

## 路由与页面
路由定义在 `visiontale_front/src/router/index.js`。

| 路由 | 页面 | 主要 API | 关键 artifacts |
| --- | --- | --- | --- |
| `/photo` | Photo.vue | POST `/api/avatar/stylize/start`, GET `/api/task/:id` | `avatar` |
| `/dialog` | Dialog.vue | POST `/api/voice/dialog/start`, GET `/api/task/:id`, GET `/api/session/:id` | `storyDialog`, `storyReq`, `voice.*` |
| `/story` | Story.vue | POST `/api/story/generate/start`, GET `/api/task/:id`, POST `/api/session/:id/artifacts/story` | `story` |
| `/split` | Split.vue | POST `/api/story/split/start`, GET `/api/task/:id`, POST `/api/session/:id/artifacts/scenes` | `scenes` |
| `/images` | Images.vue | POST `/api/image/scenes/start`, GET `/api/task/:id`, GET `/api/session/:id` | `sceneImages` |
| `/storybook` | Storybook.vue | GET `/api/session/:id` | `story`, `scenes`, `sceneImages` |
| `/video` | Video.vue | POST `/api/video/start`, GET `/api/task/:id`, GET `/api/session/:id` | `videoClips` |

## 页面要点
- **Photo**: 拍照或上传后, 转成 dataURL 直接提交到后端
- **Dialog**: 按住说话, 上传音频并轮询 task, 再拉 session 展示对话与 TTS
- **Story**: 只在 storyReq.done 时允许生成, 可单独保存 moral
- **Split**: 拆分后可编辑并保存 scenes
- **Images**: 轮询 session 让图片逐张出现, 生成中可翻页浏览
- **Storybook**: 基于 sceneImages 构建翻页, `window.print()` 导出 PDF
- **Video**: 后端生成 clips, 前端轮询并提供播放器

## 状态管理
- sessionId 通过 localStorage 存储 (`visiontale_session_id`)
- 每页维护自身 task 状态与轮询定时器
- 通过 `session.artifacts` 读取/写入跨页面数据

## UI 与样式
- 主题变量定义在 `visiontale_front/src/styles/global.css`
- 使用卡通风格配色与手写字体
- LoadingState 通过 stage 与 progress 显示不同动画

## 潜在改进
- 统一 API client, 避免重复 fetch 逻辑
- 抽离 session/task 轮询为 composable
- 增加路由守卫, 强化步骤依赖
