# OpenChat Translator for WhatsApp

一个独立的 Manifest V3 Chrome 扩展，为 WhatsApp Web 提供双向消息翻译。项目参考了 Chrome Web Store 上公开展示的交互方向，但不复制目标扩展的品牌、代码、截图或私有服务。

## 当前功能

- 接收消息自动翻译，或悬停后点击 `T` 手动翻译
- 输入框草稿翻译，点击按钮再次恢复原文
- `Alt + Enter` 翻译草稿；可选翻译后自动发送
- 中文、英语、西班牙语、法语、德语、意大利语、葡萄牙语、日语、韩语、阿拉伯语、俄语和印尼语
- MyMemory 免费接口与 Google Translate 非官方接口二选一，并自动回退
- 本地翻译缓存、颜色和字号设置
- 设置全部存储在浏览器本地

设置页和消息翻译说明均为中文。WhatsApp 页面更新后，脚本会持续扫描当前对话中的新消息，并按“我的语言 -> 联系人语言”处理发送草稿，按“联系人语言 -> 我的语言”处理收到的消息。

## 接口说明

这是独立开源实现，不包含 Chrome Web Store 商业扩展的私有后端、账号系统或 API 密钥。后台 service worker 提供统一的 `translate` 消息接口，当前有两个公开服务适配器：

- `mymemory`：默认免费服务，适合个人测试，存在速率限制
- `google`：Google Translate 非官方公开端点，可能被网络或反自动化策略拦截

请求失败时会自动尝试另一个适配器。消息文字只在请求翻译时发送给选定服务，缓存和设置保存在本地。

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

这是第一版可运行原型。WhatsApp Web 的 DOM 结构会变化，消息选择器和发送逻辑需要在真实账号环境继续回归测试。发布到 Chrome Web Store 前还需要补充图标、端到端测试、服务条款和完整隐私政策。

## License

MIT，见 [LICENSE](LICENSE)。
