# Deep Dive: Provider Integrations

## 概览
后端通过多个 Provider 连接外部 AI 服务。所有调用都在服务端执行, 前端只与本地 API 通信。

## Ark (Volc) - LLM/Image/Video
- **LLM**: `ARK_CHAT_ENDPOINT` (默认 `/api/v3/chat/completions`)
- **Image**: `ARK_IMAGE_ENDPOINT` (默认 `/api/v3/images/generations`)
- **Video**: `ARK_BASE_URL + /contents/generations/tasks`

常用环境变量:
- `ARK_API_KEY`
- `ARK_BASE_URL`
- `ARK_LLM_MODEL`
- `ARK_IMAGE_MODEL`
- `ARK_VIDEO_MODEL`
- `ARK_TIMEOUT_MS`

注意:
- `LlmProvider` 支持超时与重试
- `ImageProvider` 使用 HTTPS JSON, 失败会返回详细错误码
- `VideoProvider` 采用 create + poll 模式

## Volc Speech ASR
- 端点: `https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash`
- Headers:
  - `X-Api-App-Id`
  - `X-Api-Access-Key`
  - `X-Api-Resource-Id`
- 输入: `audio.data` (纯 base64, 不带 dataURL 前缀)

相关环境变量:
- `VOLC_SPEECH_APP_ID`
- `VOLC_SPEECH_ACCESS_KEY`
- `ASR_RESOURCE_ID`

## DashScope TTS (Qwen3)
- 端点: `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- 模型: `qwen3-tts-flash`
- 输出: audio URL (wav)

相关环境变量:
- `DASHSCOPE_API_KEY`
- `TTS_TIMEOUT_MS`
- `TTS_SPEAKER` (仅允许白名单, 默认 Cherry)

## 备用 TTS Provider (Volc Unidirectional)
- 文件: `src/voice/TtsProvider.js`
- 使用流式 JSON 拼接音频 base64
- 当前 `VoiceService` 未使用该 Provider

## 运行环境注意事项
- Node 需支持 `fetch` (建议 Node 18+)
- 服务端为无状态, 外部 API 的失败需要任务层重试或返回错误
