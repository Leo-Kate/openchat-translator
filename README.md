# OpenChat Translator for WhatsApp

一个独立的 Manifest V3 Chrome 扩展，为 WhatsApp Web 提供双向消息翻译。项目参考了 Chrome Web Store 上公开展示的交互方向，但不复制目标扩展的品牌、代码、截图或私有服务。

项目仓库：[Leo-Kate/openchat-translator](https://github.com/Leo-Kate/openchat-translator)

## 关注项目

打开仓库页面后点击 **Watch**，选择 **All Activity** 即可订阅版本、Issue 和讨论更新；点击 **Star** 可以收藏项目。欢迎通过 Issue 报告 WhatsApp 页面兼容性问题，或提交 Pull Request 改进翻译服务适配器。

## 当前功能

- 接收消息自动翻译，或悬停后点击 `T` 手动翻译
- 输入框草稿翻译，点击按钮再次恢复原文；成功、失败和恢复状态会在按钮旁提示
- 当前对话级暂停/恢复翻译，暂停状态会保存在本地并随联系人切换
- `Alt + Enter` 翻译草稿；可选翻译后自动发送
- 中文、英语、西班牙语、法语、德语、意大利语、葡萄牙语、日语、韩语、阿拉伯语、俄语和印尼语
- Google Translate 公开接口为默认引擎，MyMemory 免费接口自动回退
- DeepL、OpenAI、Anthropic/Claude、Gemini、豆包、通义千问和 OpenAI 兼容中转站可通过 API Key 接入
- 本地翻译缓存、颜色和字号设置
- 设置页可用“测试当前引擎”验证 API Key、模型和中转站地址
- 设置全部存储在浏览器本地

设置页和消息翻译说明均为中文。WhatsApp 页面更新后，脚本会持续扫描当前对话中的新消息，并按“我的语言 -> 联系人语言”处理发送草稿，按“联系人语言 -> 我的语言”处理收到的消息。

## 接口说明

这是独立开源实现，不包含 Chrome Web Store 商业扩展的私有后端、账号系统或 API 密钥。后台 service worker 提供统一的 `translate` 消息接口，当前支持以下服务适配器：

- `google`：Google Translate 公开端点，优先用于日常翻译，可能被网络或反自动化策略拦截
- `mymemory`：Google 失败时的免费回退服务，存在速率限制
- `deepl`：DeepL API，支持免费或 Pro endpoint，需要用户自己的 Key
- `openai`：OpenAI Chat Completions，需要 Key、Base URL 和模型
- `anthropic`：Anthropic Messages API；Claude Code 使用的客户端凭据不能直接当作此 API Key
- `gemini`：Google Gemini generateContent，需要 Key 和模型
- `doubao`：火山方舟 OpenAI 兼容接口，需要 Key、Endpoint ID 和 endpoint
- `qwen`：DashScope OpenAI 兼容接口，需要 Key 和模型
- `relay`：任意返回 OpenAI Chat Completions 格式的 HTTPS 中转站

请求失败时会自动尝试另一个适配器。消息文字只在请求翻译时发送给选定服务，缓存和设置保存在本地。
API Key 仅写入 `chrome.storage.local`，不会提交到 Git，也不会注入 WhatsApp 页面。使用自定义中转站时，Chrome 会按该域名请求可选的 HTTPS host permission。

## 本地加载

1. 打开 Chrome 的 `chrome://extensions/`
2. 打开右上角的 Developer mode
3. 选择 Load unpacked
4. 选择本目录
5. 打开 `https://web.whatsapp.com/`，刷新页面后使用工具栏图标设置语言对

更新代码后需要在 `chrome://extensions/` 点击本扩展的“重新加载”，再刷新 WhatsApp 标签页。看到消息气泡上的 `T` 按钮或翻译行，才算完成页面端验证。

项目无构建步骤，直接加载目录即可。修改 `content.js` 或 `content.css` 后，在扩展管理页点击 Reload，并刷新 WhatsApp Web。

## 隐私与服务边界

翻译请求会把用户主动请求翻译的文字发送到当前选定的第三方翻译服务。扩展本身不运行自建服务器、不收集账号、不上传聊天记录；翻译缓存和设置保存在 `chrome.storage.local`。免费服务有速率限制，生产使用前应替换为自己控制的、具备隐私政策的翻译 API。

WhatsApp 是 WhatsApp LLC 的商标。本项目与 WhatsApp、Meta 或 Chrome Web Store 上的任何商业扩展无隶属关系。

## 开发状态

当前版本为 `0.3.2`。扩展更新后，已加载本版本的旧页面会停止后台调用和消息扫描，并显示“刷新页面”提示，避免未捕获的 `Extension context invalidated` 错误。消息和存储 API 同时兼容 Chrome 的 callback 与 Promise 返回形式，扩展重载时的拒绝 Promise 会被收口。普通后台连接失败不会被误判为扩展永久失效，暂停状态保存失败也不会显示成功。

首次从 `0.3.0` 或 `0.3.1` 升级时，需要重新加载扩展，再刷新 WhatsApp，保护逻辑才会生效。Chrome 已记录的历史错误不会被代码自动清除；清除历史记录后，重新加载扩展并刷新 WhatsApp，再观察是否产生新错误。

异常回归测试无需安装依赖：`node --test tests/context-lifecycle.test.cjs`。测试覆盖初始化、同步异常、异步回调异常、扫描停止、暂停状态存储失败和失效后的迟到响应；使用模拟 Chrome API 与最小 DOM，不替代真实 WhatsApp 账号中的端到端验证。

WhatsApp Web 的 DOM 结构会变化，消息选择器和发送逻辑仍需要在真实账号环境继续回归测试；中转站必须提供 HTTPS 的 OpenAI Chat Completions 兼容接口。发布到 Chrome Web Store 前还需要补充图标、端到端测试、服务条款和完整隐私政策。

## License

MIT，见 [LICENSE](LICENSE)。
