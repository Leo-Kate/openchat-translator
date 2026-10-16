# OpenChat Translator for WhatsApp

一个独立的 Manifest V3 Chrome 扩展，为 WhatsApp Web 提供双向消息翻译。项目参考了 Chrome Web Store 上公开展示的交互方向，但不复制目标扩展的品牌、代码、截图或私有服务。

项目仓库：[Leo-Kate/openchat-translator](https://github.com/Leo-Kate/openchat-translator)

## 关注项目

打开仓库页面后点击 **Watch**，选择 **All Activity** 即可订阅版本、Issue 和讨论更新；点击 **Star** 可以收藏项目。欢迎通过 Issue 报告 WhatsApp 页面兼容性问题，或提交 Pull Request 改进翻译服务适配器。

## 当前功能

- 接收消息自动翻译，或悬停后点击 `T` 手动翻译
- 默认逐条自动识别客户消息的语言并翻译为中文，客户交替使用俄语、西班牙语和英语也无需切换；“回复客户用语”只决定发送草稿的目标语言
- 纯图片、视频、语音、文件、纯链接和常见钱包地址/交易哈希跳过；图片或视频有文字说明时，只翻译说明。普通句子中的链接原样保留
- 输入框草稿翻译，点击按钮再次恢复原文；成功、失败和恢复状态会在按钮旁提示
- 当前对话级暂停/恢复翻译，暂停状态会保存在本地并随联系人切换
- `Alt + Enter` 翻译草稿；可选翻译后自动发送
- 中文、英语、西班牙语、法语、德语、意大利语、葡萄牙语、日语、韩语、阿拉伯语、俄语和印尼语
- Google Translate 公开接口为默认引擎，MyMemory 免费接口自动回退
- DeepL、OpenAI、Anthropic/Claude、Gemini、豆包、通义千问和 OpenAI 兼容中转站可通过 API Key 接入
- 本地翻译缓存、颜色和字号设置
- 设置页可用“测试当前引擎”验证 API Key、模型和中转站地址
- 设置全部存储在浏览器本地

设置页为中文。收到的消息默认按“自动识别 -> 我的语言（默认中文）”翻译；关闭自动检测后才使用固定的客户语言。发送草稿按“我的语言 -> 回复客户用语”翻译。按钮位于输入栏上方的独立控制行，不覆盖输入框、麦克风或发送按钮。

自动翻译只处理屏幕及其上下 160px 附近的消息，最多同时运行 2 个请求，等待队列最多 32 条。离开屏幕或移除的消息会退出待处理队列；移除的消息同时释放可见性监听。空闲时不扫描整页，输入文字和插件自己的界面更新也不会触发消息扫描；后台标签页暂停排队，回到前台后按可见区域处理。扩展无第三方运行依赖，不下载语言模型。

## 接口说明

这是独立开源实现，不包含 Chrome Web Store 商业扩展的私有后端、账号系统或 API 密钥。后台 service worker 提供统一的 `translate` 消息接口，当前支持以下服务适配器：

- `google`：Google Translate 公开端点，优先用于日常翻译，可能被网络或反自动化策略拦截
- `mymemory`：Google 失败时的免费回退服务，存在速率限制；自动模式下通过 Chrome 内置语言检测提供明确源语言，无法可靠识别时不会提交无效的 `auto` 语言对
- `deepl`：DeepL API，支持免费或 Pro endpoint，需要用户自己的 Key
- `openai`：OpenAI Chat Completions，需要 Key、Base URL 和模型
- `anthropic`：Anthropic Messages API；Claude Code 使用的客户端凭据不能直接当作此 API Key
- `gemini`：Google Gemini generateContent，需要 Key 和模型
- `doubao`：火山方舟 OpenAI 兼容接口，需要 Key、Endpoint ID 和 endpoint
- `qwen`：DashScope OpenAI 兼容接口，需要 Key 和模型
- `relay`：任意返回 OpenAI Chat Completions 格式的 HTTPS 中转站

请求失败时会尝试 Google/MyMemory 回退服务。收到 HTTP 429 后，该服务域名冷却至少 30 秒（最多 5 分钟），避免对限流端点持续发起请求。失败消息的自动重试也有 30 秒冷却，点击 `T` 可主动重试。

句子中的 URL 和常见链上标识符在翻译前替换为占位标记，返回后恢复原文。服务商破坏标记时会触发回退，不显示被改坏的链接。AI 服务的翻译指令要求保留否定、疑问、不确定性、型号、金额和单位，不擅自添加承诺。该措施和少量样本验证不能保证所有专业用语、口语和歧义句的准确性，金额、地址等业务关键信息应结合原文确认。

消息文字仅在自动翻译或手动请求时发送给翻译服务，缓存和设置保存在本地。
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

启用自动翻译时，可见区域的消息文字会发送到选定或回退的第三方翻译服务；关闭自动翻译时，仅发送手动请求翻译的文字。扩展不运行自建服务器、不收集账号、不批量上传历史会话。翻译缓存和设置保存在 `chrome.storage.local`。免费服务有速率限制，可按需要配置自己的翻译 API。

WhatsApp 是 WhatsApp LLC 的商标。本项目与 WhatsApp、Meta 或 Chrome Web Store 上的任何商业扩展无隶属关系。

## 开发状态

当前版本为 `0.3.4`。本版在 `0.3.3` 监听循环修复的基础上，增加逐条自动识别语言、媒体和纯链接过滤、可见区域翻译、请求/队列/缓存上限及限流冷却。缓存同时限制为 500 条和 500,000 个字符（缓存键与译文合计），并在写入时立即淘汰旧条目；这不是扩展总内存占用的承诺。迟到响应不能覆盖修改后的草稿、其他对话或回收复用的消息节点。反复翻译/还原草稿不会将旧译文拼接到输入框中。

监听器忽略插件自己的界面和输入框内的变化，其他变化合并为延后扫描。原来的 1.5 秒整页扫描已移除，仅保留轻量的扩展有效性检查。暂停、关闭或切到后台时取消排队；扩展关闭后控制行会隐藏。搜索框不会被识别为发送消息的输入框。

隔离 Chrome 的同一场景中，一次普通页面变化让旧版连续触发 200 次监听，直到测试保护强制断开；新版触发 1 次后停稳。连续模拟 20 次空闲检查没有产生新的消息扫描。此数据来自真实浏览器 DOM 和模拟 Chrome API，不是用户 WhatsApp 会话的 CPU 对比，也不代表所有卡顿原因都已排除。

扩展更新后，已加载新版的旧页面会停止后台调用和消息扫描，并显示“刷新页面”提示，避免未捕获的 `Extension context invalidated` 错误。消息和存储 API 同时兼容 Chrome 的 callback 与 Promise 返回形式，扩展重载时的拒绝 Promise 会被收口。普通后台连接失败不会被误判为扩展永久失效，暂停状态保存失败也不会显示成功。

升级时，需要重新加载扩展，再刷新 WhatsApp，新的脚本才会生效。如果 WhatsApp 已卡死，先关闭该标签页，关闭扩展后重新打开 WhatsApp 恢复使用；更新到新版并重新加载扩展后再启用。Chrome 已记录的历史错误不会被代码自动清除。

Node 回归测试无需安装依赖：`node --test tests/context-lifecycle.test.cjs tests/background-translation.test.cjs`。24 项测试覆盖扩展生命周期、异常收口、源语言参数、DeepL 自动模式、MyMemory 错误处理、链接还原、请求去重、缓存上限和限流冷却。

浏览器回归：用 Chrome 打开 [tests/browser-performance.html](tests/browser-performance.html)，先选择 `content.css`，再选择 `content.js`。38 项检查使用隔离 iframe、真实 MutationObserver 和模拟翻译响应；普通场景控制可见性回调以保证确定性，1,000 条历史消息场景使用原生 IntersectionObserver。该场景初次展示及滚动后共发起 8 个请求，移除历史后释放全部 1,000 个观察目标。检查还覆盖媒体、纯链接、语言切换、搜索框、重复草稿、迟到响应、320px 暗色布局、按钮遮挡和队列满后继续处理可见消息。监听达到 200 次会强制断开，避免错误版本卡死测试页。

另以隔离 Chrome 通过生产后台代码调用 Google 免费端点，对俄语、西语、英文、混合语言和含链接的 5 条合成样本进行了真实请求抽查，均成功返回，样本中的尺寸、型号、金额、否定含义和完整 URL 得到保留。终端环境同一免费端点曾返回 429；服务可用性受网络和限流影响。以上检查均未读取用户真实聊天，不是大量客户真实会话的内存/CPU 测量，也不能保证所有 WhatsApp 版本或翻译内容没有问题。

WhatsApp Web 的 DOM 结构会变化，消息选择器和发送逻辑仍需要在真实账号环境继续回归测试；中转站必须提供 HTTPS 的 OpenAI Chat Completions 兼容接口。发布到 Chrome Web Store 前还需要补充图标、端到端测试、服务条款和完整隐私政策。

## License

MIT，见 [LICENSE](LICENSE)。
