# 待修：B 站换集后仍提取到旧视频（2026-10-21 夜）

## 现状

- 「整段提取」在 B 站**第一条视频**上能跑通（真实测过：26 分钟 → 184 句 / 6158 字）。
- 换到**另一个**视频（单页应用切换，不刷新页面）后，提取的仍是**上一个视频**的音频。
- 刷新页面后再提取就是对的 → 说明问题在"页面内缓存/快照"，不在下载或识别。

## 已做的两轮修复（都没根治）

1. **`lastProbe` 过期判断**：`ingestFromPage()` 比对 `lastProbe.url` 和当前 tab URL，不一致就重探。
   → 无效。说明重探本身拿到的还是旧地址。
2. **主世界读 `window.__playinfo__`**：取 `data.dash.audio[0].baseUrl`（最高码率）。
   → 首次有效，换集后无效。**`__playinfo__` 是首屏服务端渲染的快照，SPA 换集不会更新它。**

## 第三轮（已提交 e4a76f3，待验证）

`content/media-hook.js`：在主世界包 `fetch` / `XMLHttpRequest`，凡是 URL 命中
`playurl|playinfo|player/wbi|mediainfo` 的响应，解析出 `dash.audio[].baseUrl`，记到
`window.__dshAsrMedia`（带 `href` 和 `source`）。探测器优先读它，`href` 不匹配就当过期。

打开弹窗时注入（`INSTALL_MEDIA_HOOK`，activeTab 授权）。

## 零成本诊断（不花 API 钱，先做这个）

在 B 站视频页按 F12 → Console，粘贴：

```js
// ① 钩子装上没有？
window.__dshAsrHookInstalled

// ② 抓到过东西吗？（换集后立刻看）
window.__dshAsrMedia

// ③ 首屏快照是不是还指着老视频？
window.__playinfo__?.data?.dash?.audio?.[0]?.baseUrl?.slice(0, 120)

// ④ 当前页面地址（和 ② 里的 href 比）
location.href
```

判断：

| 结果 | 结论 | 下一步 |
|---|---|---|
① 是 `undefined` | 钩子没注入 | 检查 `executeScript({world:'MAIN', files})` 是否被页面 CSP 拦；改用 `func` 注入 |
② 有值但 `href` 是旧页面 | 钩子在工作，但换集后没有新请求被捕获 | 换集时的请求可能不是 XHR/fetch，而是 `sendBeacon` 或 worker 内 fetch → 需要 hook Worker |
② 一直没有值 | URL 过滤没命中 | 打印所有 XHR/fetch 的 URL（临时把过滤条件改成全捕获），看真实请求长什么样 |
③ 和 ④ 一致 | 说明这个视频的 `__playinfo__` 是新的，问题在别处 | 回头查 `pickMediaUrl` 的优先级 |

## 兜底方案（如果钩子路线走不通）

B 站的分片请求已经从 `performance.getEntriesByType('resource')` 抓得到（探测里"分片 2"）。
思路：直接用**音频分片 URL**（`-30280.m4s` 这类）当整段地址——它一定是当前视频的。
不确定点是"哪个分片是音频"：可以用 `Content-Type` 判断（HEAD 请求，扩展有权限），
`audio/*` 或 `video/mp4` + 体积明显小的那个。

## 顺便要做的（成本护栏）

用户在峰值时段花了 ¥4 却没拿到结果。建议加：

1. 提取前显示**预计请求数**（时长 ÷ 20 秒）和"当前是峰值时段"提醒；
2. 超过 10 分钟的视频要求**二次确认**；
3. 失败重试上限从 3 次降到 2 次（403 这种不该重试）。
