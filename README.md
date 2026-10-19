# AI 划词 & 网页翻译

一个简洁的 Chrome 扩展（Manifest V3）：选中文字即时翻译，整页中英文对照翻译。

## 功能

- **划词翻译**：选中网页文字后点出现的「译」按钮，弹出译文气泡
- **双语发音**：划词气泡中分别点「原文发音」「译文发音」；微软免费系统女声，英语固定美式 `en-US`，无需新的 Key
- **整页翻译**：原文下方插入译文，中英对照；按钮可一键还原原文
- **双引擎**：
  - 谷歌免费翻译（无需 API Key，开箱即用）
  - 自定义大模型（OpenAI / Azure OpenAI / Foundry 兼容），可填 URL、Key、模型
- **右键菜单** + 工具栏弹窗，可切换目标语言
- **日志面板**：弹窗内查看请求/错误，方便排错

## 安装

1. 下载或克隆本仓库
2. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `ai-translate` 文件夹

已有安装升级：更新原目录中的发布文件后，在 `chrome://extensions` 找到本扩展，点击「重新加载」，再刷新要翻译的网页。不要删除或重新安装扩展，以保留已有翻译配置。1.1.0 新增 `tts` 权限，如 Chrome 提示需要确认权限，请确认。

## 划词原文 / 译文发音

在译文气泡中点击对应的发音按钮；播放时再次点击同一按钮即可停止，点击另一按钮会先停止上一段。关闭气泡、点击气泡外部、切换划词结果或离开网页时也会停止；不增加全文朗读功能。气泡显示实际声音名称和语言，失败原因也直接显示在气泡中。

使用受支持的 [Chrome `chrome.tts` API](https://developer.chrome.com/docs/extensions/reference/api/tts)，调用本机微软女声；没有额外 TTS 网络请求、付费服务、私有接口或新的 API Key。原文语言取自 Google 翻译返回的检测结果，或自定义模型同次翻译返回的 `sourceLang`；译文使用本次请求的目标语言。自定义模型仍可返回旧版译文数组，此时只在 Chrome 能可靠识别原文语言时启用原文发音；无法识别不会猜成英语。

本功能优先面向安装了微软语音包的 Windows Chrome。英语（包括英式英语原文）一律使用 `en-US`；其他语言按对应语种/地区选择。只接受已知的微软女性声音名称并核对语言，不会退回系统默认、男性、英式英语或性别未知的声音。系统女声安装情况可参考[微软支持的语言和声音](https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-a-supported-languages-and-voices)。

| 语言 | 允许的微软女声（按优先顺序） |
| --- | --- |
| 美式英语 `en-US` | Zira |
| 简体中文 `zh-CN` | Huihui、Yaoyao |
| 繁体中文 `zh-TW` | Hanhan、Yating |
| 日语 / 韩语 | Haruka、Ayumi / Heami |
| 法语 `fr-FR` / `fr-CA` | Hortense、Julie / Caroline |
| 德语 | Hedda、Katja |
| 西班牙语 `es-ES` / `es-MX` | Helena、Laura / Sabina |

如提示「未找到微软女声」，请在 Windows「设置 → 时间和语言 → 语言和区域」中为对应语言安装「文本转语音」语音包，重启 Chrome 后再试。仅安装了 Narrator 自然语音不保证 Chrome 可以访问；以 Chrome 实际列出的声音为准。其他系统或未安装对应女声时会明确提示不可用，而不是假装播放成功。单次最多 32768 个字符，启动超时或播放超过 5 分钟会停止并提示缩短选择范围。

## 使用自定义大模型

弹窗里选「自定义大模型」，填写：

- **API URL**：如 `https://<资源>.openai.azure.com/openai/v1`（OpenAI 用 `https://api.openai.com/v1`）
- **API Key**：你的密钥（仅保存在浏览器本地 `chrome.storage`，不会上传）
- **模型/部署名**：如 `gpt-5.4-mini`

点「测试」验证，再「保存并收起」。

## 隐私

API Key 仅存于本地浏览器，不包含在代码中。谷歌引擎走免费翻译接口。
发音使用微软本地系统语音，文字不会为 TTS 发送到 Google / 微软云端；翻译请求仍遵循所选翻译引擎的原有流程。

## 开发验证

无需安装依赖，Node.js 22+：

```powershell
node --test tests\speech.test.cjs
```

真实 Chrome 集成检查（会启动独立临时浏览器、实际请求免费 Google 翻译，并调用系统发音；不会读取日常浏览器配置）：

```powershell
node tests\browser-smoke.cjs
```

默认使用 Windows 标准 Chrome 安装路径；可通过 `CHROME_PATH` 指定浏览器。需要支持 CDP `Extensions.loadUnpacked` 的 Chrome，并在测试机安装 Zira 和 Huihui；用未安装德语女声的环境检查真实「声音不可用」提示。脚本覆盖原文/译文双向语言、原生播放/切换/停止/完成、气泡关闭、离页停止和整页翻译/还原；引擎失败、翻译乱序分别标注为模拟故障。脚本以原生 TTS 事件和 `isSpeaking` 校验，不等同于人耳听感或扬声器输出验收；自定义模型协议由不含真实凭据的单元测试覆盖，集成脚本不调用用户的模型账户。

## 后续计划

PDF 翻译、术语表、悬浮工具条、更多引擎。

## License

MIT
