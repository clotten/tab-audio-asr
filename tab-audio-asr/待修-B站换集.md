# B 站换集提取旧视频：已解决（2026-10-21 夜）

状态：**已修复并实测通过**。完整过程与教训见 `复盘-2026-10-21-夜-B站.md`。

## 症状

- 在 B 站第一个视频上「整段提取」正常（真实测过：26 分钟 → 184 句 / 6158 字）
- 换到另一个视频（单页应用切换，不刷新页面）后：要么 403，要么**转出来的还是上一个视频的音频**
- 刷新页面后就正常 → 说明问题在"页面内缓存/快照"，不在下载或识别

## 根因（实测）

页面上能读到的两个全局变量**都是首屏快照，SPA 换集后永不更新**：

| 来源 | 实测指向 | 是否可用 |
|---|---|---|
`window.__playinfo__` | 42906225680 | ❌ 永不更新 |
`window.__INITIAL_STATE__` | 42868804351（另一个视频） | ❌ 永不更新 |
`location.href` | BV1fxni6XEwD（真实） | ✅ 只有它是对的 |

`performance` 里旧视频的分片甚至比当前视频的更"新"（startTime 68956 vs 14652），
所以"取最近""取体积最小"都只是碰巧，不可靠。

另外：`executeScript({world:'MAIN', files:[...]})` 在这台 Edge 上**静默不生效**，
换成 `world:'MAIN', func` 才行——这是平台陷阱，已改。

## 解法（当前代码顺序）

`popup.js → resolveMediaUrl()`：

1. **B 站播放接口现查**（首选，实测 cid 与当前视频对齐）
   `location.pathname` 取 BV 号 → `x/web-interface/view` 取 cid → `x/player/playurl` 取 `dash.audio[最高码率].baseUrl`
   - 实现在 `content/subtitle.js` 的 `BILI_AUDIO` 消息里（页面上下文发请求，自带 Referer 与 CORS 许可）
2. **主世界钩子**（`lib/page-hook.js`，`world:'MAIN' + func` 注入）
   - 只能在使用者**真的开始拉流**时抓到新 playurl；记录带 `href`，跨页即判过期
3. **页面上下文检查分片**（`CHECK_MEDIA`）：HEAD → 失败退回 `Range: bytes=0-1023`
4. **平台快照**：仅在没有任何分片、且 `timelength` 与当前 `<video>.duration` 相差 ≤2 秒时使用

**硬规则**：有分片地址却挑不出音轨 → 直接失败并提示，**绝不回退到快照**
（静默转错视频比失败糟糕得多）。

## 实测证据（用户提供的控制台日志）

```
v2026-10-21c
探测完成 · 平台=bilibili · 模式=mse · 分片=2 · 选用ID=42780986019 · 类型=bilibili-api
整段提取 · 即将下载ID=42780986019
```

探测与提取 ID 一致；换视频后 ID 跟着变；`sendResponse` 报错消失。

## 已加的防复发措施

- `tools/check-sendresponse.mjs`：用 `sendResponse` 必须在 `onMessage` 签名里声明
- `tools/strip-bom.mjs`：清 BOM（manifest 带 BOM 会直接装不上）
- 内容脚本版本戳：控制台 `v2026-10-21c` + DOM `document.documentElement.dataset.dshAsrVersion`
- 长视频（>10 分钟）提取前做花费二次确认

## 仍待处理

1. **音轨码率不稳**：同一视频不同次调用，`playurl` 可能返回 `30280`(~200kbps) 或 `30216`(~67kbps)，
   低码率会影响识别率。应在 `dash.audio` 里**显式优先 30280**，而不只按 bandwidth 排序。
2. `m4s`（分片 MP4）能否被 `decodeAudioData` 吃下，尚未在所有视频上验证；失败报错已明确。
3. 多 P 视频（`?p=N`）已按 `pages[N-1].cid` 处理，但**未实测**。
4. 唯一无法覆盖的情况：B 站若改为强制 `wbi` 签名，`/x/player/playurl` 会返回 `-403`；
   届时需回退到钩子（要求用户先播放几秒）。
