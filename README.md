# ds-browser-tabs

> A DeepSeek Harness plugin that lets the agent read the **rendered** content of the browser tabs you already have open — Firefox and Chrome.

让 DSH 读到**你此刻在浏览器里开着的那一页，已经渲染好的样子**——SPA 里动态渲染出来的内容、弹窗后面的表格、只有真实浏览器里才存在的文字。

`web_fetch` / `clash_fetch` 拿的是服务器返回的 HTML：SPA 首屏是空壳、内容由 JS 渲染、canvas 里根本没有文字。这个插件反过来，由你浏览器里已经加载好的页面**主动把渲染结果交出来**。

由你显式触发：敲 `/browser`，DSH 才去读，读到就投递给模型并立即开始分析。模型不会自己翻你的浏览器。

## 安装

1. **装宿主半体**：把这个目录作为本地 bundle 装进当前 DSH profile（`plugin_manager` → `install_bundle`，或设置页「插件」→ 添加本地目录）。装完重启 DSH。
2. **装浏览器扩展**：
   - Chrome / Edge：打开 `chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选择本目录下的 `extension/`。
   - Firefox：先 `node scripts/build-firefox.mjs` 生成 `dist/firefox/`，再按下面「Firefox」一节载入。
3. **对地址**：点扩展图标，确认「DSH 地址」是 DSH Web 的实际地址（默认 `http://127.0.0.1:3080`）。令牌留空即可。

> 扩展需要「读取和更改所有网站的数据」权限。这是 `chrome.scripting.executeScript` 跨站点注入的必要条件，不是可选项；扩展只读页面文本与截屏，不发数据给任何第三方。

## Firefox

同一份扩展代码，用 `node scripts/build-firefox.mjs` 生成 Firefox 版（event page 而不是 service worker，并带 gecko id）：

```
dist/firefox/                      临时载入用
dist/ds-browser-tabs-firefox.xpi   从文件安装用
```

### 临时载入（正式版和 ESR 都能用，重启后失效）

1. 地址栏打开 `about:debugging#/runtime/this-firefox`
2. 点 **临时载入附加组件…**
3. 选中 `dist/firefox/manifest.json`
4. 点扩展图标，确认地址是 `http://127.0.0.1:3080`

Firefox 关闭后需要重新载入一次。

### 永久安装（仅开发者版 / 夜间版）

1. `about:config` 里把 `xpinstall.signatures.required` 设为 `false`
2. `about:addons` → 右上角齿轮 → **从文件安装附加组件** → 选 `dist/ds-browser-tabs-firefox.xpi`

**正式版和 ESR 上这个开关不生效**：Firefox 要求扩展经 AMO 签名才能永久安装。这是浏览器策略，不是插件本身的问题。临时载入是可用的替代方案。

## 用法

| 命令 | 作用 |
|---|---|
| `/browser` | 读**第一个可读标签页**，与 `/browser list` 的 1 号一致；DSH 自己的页面也不跳过 |
| `/browser <序号>` | 按 `/browser list` 里的序号读，例如 `/browser 3` |
| `/browser list` | 编号列出可读的标签页（`★` 标出活动页），不唤醒模型 |
| `/browser <关键字>` | 按标题/URL 关键字选一个标签页再读；命中多个会列候选 |
| `/browser status` | 显示扩展在线状态、WebSocket 连接数、最后在线时间 |

附带一个只读工具 `browser_read`，供模型在追问「再看看那个标签页」时使用，语义与命令一致。

## 它是怎么工作的

```
你敲 /browser
  └─ 宿主把读取请求放进内存队列
        └─ 扩展常连 WebSocket 收到任务
              └─ 扩展在目标标签页里执行提取函数（渲染后的 DOM）
                    └─ 回传正文，宿主拼成一条用户消息 → 唤醒模型
```

**为什么用 WebSocket**：Chrome 的 MV3 service worker 空闲 30 秒就被回收，普通定时轮询活不过半分钟（这就是最初 `/browser` 报「未检测到扩展」的原因）。Chrome 116+ 明确规定「活跃的 WebSocket 会延长 worker 寿命，收发消息都会重置空闲计时」，所以扩展常连一条 WebSocket，宿主每 20 秒发一次应用层 ping。HTTP 长轮询保留作兜底：WebSocket 被环境挡住时仍能工作。

整条链路只在你敲命令之后发生，不常驻采集页面。

## 排查

| 现象 | 原因与处理 |
|---|---|
| `未检测到浏览器扩展` | 扩展没装/没启用，或扩展弹窗里的地址与 DSH 端口不一致。先点一下工具栏的扩展图标唤醒它。 |
| `浏览器扩展正在休眠` | 点一下工具栏的扩展图标唤醒它，再重试。 |
| 刚更新过插件代码 | **宿主半体改动必须重启 DSH**；扩展改动要在 `chrome://extensions` 点「重新加载」。 |
| `扩展 8 秒内没有响应` | 扩展在线但被 Chrome 休眠了。点一下扩展图标唤醒，或重新加载扩展。 |
| `该页面不允许扩展注入` | `chrome://`、扩展商店等内置页读不到，换普通网页。 |
| `扩展令牌与 DSH 配置不一致` | 宿主 `cordis.patch.yml` 里配了 `token`，扩展弹窗里要填同一串。 |

## 配置

`cordis.patch.yml` 里的 `config` 可选覆盖：

```yaml
config:
  routePrefix: /dsh-browser-tabs   # 扩展回连的路径前缀
  token: ''                        # 非空则校验扩展令牌
  timeoutMs: 8000                  # 单次读取超时
```

## 测试

```bash
node test/run.mjs                    # 宿主逻辑 + 扩展静态检查 + 真实浏览器提取验证（无 Chrome 或 Chrome 禁加载扩展时自动跳过）
node test/extract-browser-check.mjs  # 单独跑真实浏览器提取验证；可用 CHROME_BIN 指定浏览器
node test/extension-live-check.mjs   # 单独跑扩展与 DSH 的实时链路检查（需要能命令行加载扩展的 Chrome）
node test/live-ws-check.mjs          # 对着运行中的 DSH 验证 WebSocket 通道（不需要浏览器）
node scripts/build-firefox.mjs       # 生成 Firefox 版与 .xpi（主测试会自动跑一次）
```

`test/run.mjs` 覆盖：配置归一化、请求队列（超时/乱序/重复回包/取消）、消息拼装与 200k 截断、HTTP 端点（鉴权/CORS/404/405）、命令与工具的端到端往返、错误码文案。

## 验证状态

- 宿主逻辑：155 项自动测试通过（配置、队列与长轮询、拼装、HTTP 端点、WebSocket 握手/推送/保活、命令与工具端到端、错误码）。
- 提取函数：在真实无头 Chrome 里对固定页面验证 15 项（隐藏元素剔除、表单值、图片替代文本、可见 nav/footer 保留）。
- 扩展与 DSH 的实时链路：本机 Chrome 158 已禁止命令行加载扩展（`--disable-extensions-except` 被忽略），这项检查会明确跳过而不是假装通过。**需要你在自己的 Chrome 里装一次扩展来验证**：`/browser list` 能列出标签页、`/browser` 能把正文投递给模型。
- Chrome 回收 service worker 后的自动恢复（`chrome.alarms` 兜底）仍需人工验证。
- Firefox 版：manifest 结构、event page 形态、gecko id、XPI 打包均有自动检查；**Firefox 内的实际运行未验证**（headless Firefox 不支持命令行加载临时扩展），需要你按上面步骤载入后跑一次 `/browser`。

## 已知限制

- 只读：不点击、不输入、不滚动。
- 只取可见文本（`innerText` 语义），不是无障碍树；canvas / WebGL 内容没有文字可读。
- 跨域 iframe、closed shadow root 内部读不到。
- 不持久化任何页面内容；读到的文本只进会话日志，与你自己贴进来的内容同等对待。

## License

MIT
