/**
 * background.js —— MV3 Service Worker
 *
 * 职责很窄，只做三件事：
 *  1. 收到 popup 的 START 后，向 chrome.tabCapture 申请"这个标签页的音频流 ID"；
 *  2. 保证 offscreen 文档存在（SW 里没有 Web Audio / MediaRecorder，必须搬到 offscreen）；
 *  3. 把 streamId 转交给 offscreen，并维护图标徽标状态。
 *
 * 真正的录制 + 编码 + 调接口全在 offscreen.js 里跑，这样即使 SW 被浏览器
 * 回收（MV3 常态，30 秒空闲就杀），长录音也不会中断。
 */

import { buildDoc, getDoc, upsertDoc, listDocs, removeDoc, sanitizeDocs } from './lib/docstore.js';

// 频道里给上面几个起短名，避免和消息分支里的局部变量重名
const docUpsert = upsertDoc;
const docGet = getDoc;
const docList = listDocs;
const docRemove = removeDoc;

const OFFSCREEN_URL = 'offscreen.html';
const LS_SESSION = 'asrSession';
const LS_HISTORY = 'asrHistory';
const SUBTITLE_SCRIPT = 'content/subtitle.js';
const ACTIVE_STATUS = ['starting', 'recording', 'stopping'];

let creatingOffscreen = null;
let lastStartAt = 0; // 用于避免"关闭定时器"撞上新一轮开始

/* ------------------------------------------------------------------ */
/* 悬浮字幕层注入                                                      */
/* ------------------------------------------------------------------ */

async function injectSubtitle(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [SUBTITLE_SCRIPT] });
    // 面板有"空闲 15 秒自动隐藏"，已停止的会话注入后会被立刻藏起来，
    // 所以注入完显式叫它显示一次（脚本里的 listenShowForce 会压掉自动隐藏）。
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_PANEL' }).catch(() => {});
    return true;
  } catch {
    // chrome:// 之类不允许注入，字幕层缺席但录制照常
    return false;
  }
}

/** 录制期间如果页面跳转/刷新，字幕层会跟着文档一起消失，重新注入一次 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  try {
    const { [LS_SESSION]: session } = await chrome.storage.local.get(LS_SESSION);
    if (!session || session.tabId !== tabId) return;
    if (!ACTIVE_STATUS.includes(session.status)) return;
    await injectSubtitle(tabId);
  } catch {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ */
/* offscreen 文档管理                                                  */
/* ------------------------------------------------------------------ */

async function offscreenExists() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        // USER_MEDIA：拿 getUserMedia 的标签页音频；AUDIO_PLAYBACK：把声音回放给用户听
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: '在后台持续捕获标签页音频、分段编码成 WAV 并调用语音转文字接口。'
      })
      .catch((err) => {
        const msg = String(err?.message || err);
        // 并发创建时浏览器会报"只能有一个 offscreen 文档"，忽略即可
        if (!msg.includes('Only a single offscreen document')) throw err;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

/** 刚 createDocument 完，脚本还没执行，listener 没注册，直接 sendMessage 会失败，所以要轮询等 ready */
async function waitOffscreenReady(timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' });
      if (res?.ok) return true;
    } catch {
      /* 还没注册 listener，继续等 */
    }
    await sleep(80);
  }
  return false;
}

/**
 * 把当前会话存进历史，避免"重新开始/清空"把稿子弄丢。
 * 只存有实际句子的会话，最多留 5 份。
 */
async function archiveCurrentSession(reason) {
  const stored = await chrome.storage.local.get([LS_SESSION, LS_HISTORY]);
  const cur = stored[LS_SESSION];
  const hasText = (cur?.segments || []).some((s) => s.status === 'done' && s.text);
  if (!hasText) return false;

  const list = Array.isArray(stored[LS_HISTORY]) ? stored[LS_HISTORY] : [];
  list.unshift({
    archivedAt: Date.now(),
    reason: reason || '',
    title: cur.tabTitle || cur.diag?.ingestUrl || '',
    count: (cur.segments || []).filter((s) => s.status === 'done' && s.text).length,
    session: cur
  });
  await chrome.storage.local.set({ [LS_HISTORY]: list.slice(0, 5) });
  return true;
}

function sendToOffscreen(payload) {
  return chrome.runtime.sendMessage({ ...payload, target: 'offscreen' });
}

/**
 * 给 offscreen 发"重活"命令（校正/精校）。
 *
 * 坑：offscreen 文档在停止录制 60 秒后会被回收，这时直接 sendMessage 就会得到
 * "Could not establish connection. Receiving end does not exist."。
 * 所以这里要：① 需要时重建文档；② 把会话状态和设置恢复进去
 * （新建的文档里 state=null、settings 是默认值，直接纠正会报"还没有会话/缺少 Key"）。
 */
async function callOffscreenTask(payload) {
  await ensureOffscreen();

  if (!(await waitOffscreenReady())) {
    throw new Error('后台页面启动超时，请重试一次');
  }

  const stored = await chrome.storage.local.get([LS_SESSION, 'asrSettings']);
  const state = stored[LS_SESSION] || null;
  const settings = stored.asrSettings || null;

  if (state) {
    await sendToOffscreen({ type: 'RESTORE_STATE', state, settings }).catch(() => null);
  } else if (settings) {
    await sendToOffscreen({ type: 'RESTORE_STATE', state: null, settings }).catch(() => null);
  }

  return sendToOffscreen(payload);
}

/* ------------------------------------------------------------------ */
/* 徽标                                                               */
/* ------------------------------------------------------------------ */

async function setBadge(recording) {
  try {
    await chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
    if (recording) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
      await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
    }
  } catch {
    /* 徽标失败不影响主流程 */
  }
}

/** 按状态刷新徽标，状态没变就不重复写（offscreen 每段都会推状态） */
let lastBadgeStatus = null;
function refreshBadge(status) {
  if (status === lastBadgeStatus) return;
  lastBadgeStatus = status;
  setBadge(status === 'recording' || status === 'starting');
}

/* ------------------------------------------------------------------ */
/* START / STOP                                                       */
/* ------------------------------------------------------------------ */

const BLOCKED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension):/i;
const BLOCKED_HOSTS = ['microsoftedge.microsoft.com', 'chrome.google.com', 'chromewebstore.google.com'];

async function startCapture(msg) {
  lastStartAt = Date.now();

  const tabId = msg?.tabId;
  if (typeof tabId !== 'number') return { ok: false, error: '没有拿到标签页 ID。' };

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: '目标标签页已关闭。' };

  const url = tab.url || '';
  if (BLOCKED_URL.test(url) || BLOCKED_HOSTS.some((h) => url.includes(h))) {
    return { ok: false, error: '浏览器内部页面 / 扩展商店页面不允许捕获音频，请换一个普通网页。' };
  }

  let streamId;
  try {
    // 关键 API：把标签页音频交给扩展。必须在扩展被"调用"过之后（点开 popup 即算）。
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    const msgText = String(err?.message || err);
    return {
      ok: false,
      error: msgText.includes('already being captured')
        ? '这个标签页已经在被捕获（可能上一轮还没停干净），请先停止再重新开始。'
        : `无法获取标签页音频：${msgText}`
    };
  }

  try {
    await ensureOffscreen();
  } catch (err) {
    return { ok: false, error: `无法创建后台页面：${String(err?.message || err)}` };
  }

  if (!(await waitOffscreenReady())) {
    return { ok: false, error: '后台页面启动超时，请重试一次（或重新加载插件）。' };
  }

  const res = await sendToOffscreen({
    type: 'START',
    streamId,
    tabId,
    tabTitle: tab.title || '',
    settings: msg.settings || null
  }).catch((err) => ({ ok: false, error: `后台页面未响应：${String(err?.message || err)}` }));

  if (res?.ok) {
    await injectSubtitle(tabId);
  }

  await setBadge(!!res?.ok);
  return res || { ok: false, error: '未知错误' };
}

async function stopCapture() {
  let stopped = false;
  try {
    const res = await sendToOffscreen({ type: 'STOP' }).catch(() => null);
    stopped = !!res?.ok;
  } catch {
    stopped = false;
  }

  if (!stopped) {
    // offscreen 不在了（比如被回收），至少把存储里的状态标成已停止，别让 UI 卡在"录制中"
    const { [LS_SESSION]: session } = await chrome.storage.local.get(LS_SESSION);
    if (session && (session.status === 'recording' || session.status === 'starting')) {
      await chrome.storage.local.set({
        [LS_SESSION]: { ...session, status: 'stopped', stoppedAt: Date.now(), stopReason: '后台页面已不存在' }
      });
    }
  }

  await setBadge(false);
  return { ok: true, stopped };
}

async function resetSession() {
  await chrome.storage.local.remove(LS_SESSION);
  try {
    await sendToOffscreen({ type: 'RESET' });
  } catch {
    /* offscreen 可能不存在，忽略 */
  }
  await setBadge(false);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------ CDN 请求头 ------------------------------ */

/**
 * 有些站点的 CDN 会校验 Referer（B 站的 bilivideo 就是），
 * 而 fetch 里不能手写 Referer（浏览器禁止），只能靠 declarativeNetRequest
 * 在请求真正发出去之前塞进去。
 *
 * 规则是**会话级**的（updateSessionRules，浏览器关掉就没了），
 * 只在整段提取期间装、结束后卸，不长期改用户的请求。
 */
const CDN_RULES = [
  // B 站：音频/视频都在 bilivideo.com，Referer 必须是 bilibili.com
  { id: 9001, filter: '||bilivideo.com', referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' },
  { id: 9002, filter: '||hdslb.com', referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' }
];

/** 给这个 URL 装对应的请求头规则（返回是否装了） */
async function applyCdnHeaders(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  const hit = CDN_RULES.find((r) => host.endsWith(r.filter.replace('||', '')));
  if (!hit) return false;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [hit.id],
      addRules: [
        {
          id: hit.id,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'referer', operation: 'set', value: hit.referer },
              { header: 'origin', operation: 'set', value: hit.origin }
            ]
          },
          condition: {
            urlFilter: hit.filter,
            resourceTypes: ['xmlhttprequest', 'media', 'other']
          }
        }
      ]
    });
    return true;
  } catch {
    return false;
  }
}

/** 卸掉所有 CDN 规则 */
async function clearCdnHeaders() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: CDN_RULES.map((r) => r.id)
    });
  } catch {
    /* 没权限/没规则都无所谓 */
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 发给 offscreen 的消息不要在这里处理，否则两个上下文会抢着回包
  if (!msg || typeof msg !== 'object' || msg.target === 'offscreen') return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'STATE_SET':
          // offscreen 没有 chrome.storage，状态由它通过消息送过来，这里落盘
          await chrome.storage.local.set({ [LS_SESSION]: msg.state });
          refreshBadge(msg.state?.status);
          sendResponse({ ok: true });
          break;

        case 'STATE_CLEAR':
          await chrome.storage.local.remove(LS_SESSION);
          refreshBadge('idle');
          sendResponse({ ok: true });
          break;


        case 'PICK_MEDIA': {
          // 从候选地址里挑出"真正的音轨"。
          //
          // 为什么需要这一步：B 站的 window.__playinfo__ 是首屏快照，换集后**永不更新**
          // （实测同一个 baseUrl 在几个视频之间一模一样），所以不能按它提取。
          // 而播放器每次换集都会真的去取分片，performance 里能看得到——那才是当前视频。
          // 分片里有音频也有视频，用 HEAD 的 content-type/体积分辨。
          const urls = Array.isArray(msg.urls) ? msg.urls.filter((u) => /^https?:/i.test(String(u))).slice(0, 8) : [];
          if (!urls.length) {
            sendResponse({ ok: false, error: '没有候选地址' });
            break;
          }

          // CDN 可能校验 Referer（B 站），HEAD 也一样要被拦
          await applyCdnHeaders(urls[0]).catch(() => false);

          const probed = [];
          for (const u of urls) {
            try {
              const r = await fetch(u, { method: 'HEAD' });
              let type = (r.headers.get('content-type') || '').toLowerCase();
              let size = Number(r.headers.get('content-length') || 0);
              let status = r.status;

              // 不少 CDN 不认 HEAD（直接 403/405）。退回 GET 只取前 2KB，
              // 从 content-range 里读出总长度——效果一样，代价几 KB。
              if (!r.ok || !type || !size) {
                try {
                  const g = await fetch(u, { headers: { Range: 'bytes=0-2047' } });
                  if (g.ok || g.status === 206) {
                    const gt = (g.headers.get('content-type') || '').toLowerCase();
                    const cr = g.headers.get('content-range') || '';
                    const total = Number((cr.match(/\/(\d+)$/) || [])[1] || 0);
                    if (gt) type = gt;
                    if (total) size = total;
                    status = g.status;
                  }
                  // 立刻放掉响应体，别真的下整段
                  g.body?.cancel?.().catch?.(() => {});
                } catch {
                  /* 退回也失败就按原结果打分 */
                }
              }

              probed.push({ url: u, status, type, size, ok: status === 200 || status === 206 });
            } catch (err) {
              probed.push({ url: u, error: String(err?.message || err), ok: false });
            }
          }

          // 打分：明确是音频的最好；其次是视频容器里最"小"的那个（音轨比视频小一个量级）
          const score = (x) => {
            if (!x.ok) return -1;
            if (x.type.startsWith('audio/')) return 100;
            if (x.type.startsWith('video/')) return 50;
            if (/\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i.test(x.url)) return 90;
            if (/\.(m4s|ts)(\?|$)/i.test(x.url)) return 40;
            return 10;
          };
          const ranked = probed
            .map((x) => ({ ...x, score: score(x) }))
            .sort((a, b) => b.score - a.score || (a.size || Infinity) - (b.size || Infinity));

          const best = ranked.find((x) => x.score >= 0) || null;
          sendResponse({ ok: !!best, best, all: ranked });
          break;
        }
        case 'PROBE_MEDIA': {
          // 探测当前页能不能整段提取（直链 / HLS / DASH / 现成字幕 / 平台播放信息），
          // 用来判断"能不能播之前就拿到全稿"。
          let tabId = msg.tabId;
          if (!tabId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab?.id;
          }
          if (!tabId) {
            sendResponse({ ok: false, error: '没有活动标签页' });
            break;
          }
          try {
            // ① 常规探测（隔离世界，能读 performance / DOM）
            const [res] = await chrome.scripting.executeScript({
              target: { tabId },
              files: ['content/probe.js']
            });
            const report = res?.result || null;

            // ② 平台播放信息（主世界，能读页面 JS 变量）
            //    B 站这类站点不吐 m3u8/mpd 清单，音频地址藏在 window.__playinfo__ 的 DASH JSON 里，
            //    必须进主世界才看得到。
            let playinfo = null;
            try {
              const [pm] = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                  const pick = (obj) => (obj && (obj.baseUrl || obj.base_url || (Array.isArray(obj.backupUrl) ? obj.backupUrl[0] : ''))) || '';
                  const out = { audio: '', video: '', duration: null, source: '', href: '', stale: false };
                  const el = document.querySelector('video');
                  const dur = el && Number.isFinite(el.duration) ? Math.round(el.duration) : null;

                  // ① 优先用 media-hook 记下的地址：它是"播放器最近一次拿到的音轨"，
                  //    单页应用换视频时只有它会更新（__playinfo__ 是首屏快照，不更新）。
                  const hooked = window.__dshAsrMedia;
                  if (hooked && hooked.audio) {
                    out.audio = hooked.audio;
                    out.video = hooked.video || '';
                    out.source = `hook:${hooked.source || '?'}`;
                    out.href = hooked.href || '';
                    out.duration = hooked.duration || dur;
                    // 记下的页面地址和现在不一样 → 说明是换集前抓的，已经不可信
                    out.stale = !!hooked.href && hooked.href !== location.href;
                  }

                  // ② 没有钩子记录才退回 __playinfo__（首屏那份）
                  if (!out.audio) {
                    const pi = window.__playinfo__;
                    const data = pi && pi.data;
                    if (data) {
                      out.source = '__playinfo__';
                      const audio = data.dash && Array.isArray(data.dash.audio) ? data.dash.audio.slice() : [];
                      audio.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)); // 最高码率
                      out.audio = pick(audio[0]);
                      const video = data.dash && Array.isArray(data.dash.video) ? data.dash.video.slice() : [];
                      video.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
                      out.video = pick(video[0]);
                      if (!out.audio && Array.isArray(data.durl) && data.durl[0]) {
                        out.audio = data.durl[0].url || '';
                        out.video = out.audio;
                      }

                      // 关键校验：__playinfo__ 是首屏快照，换集不会更新（实测几个视频拿到
                      // 同一个 baseUrl）。拿它里面的时长和当前 <video> 的时长比，对不上就
                      // 说明这份快照属于别的视频，必须作废——否则会拿旧视频的音轨去转写。
                      const snapMs = Number(data.timelength || (data.dash && data.dash.duration) || 0);
                      const snapSec = snapMs > 0 ? Math.round(snapMs / 1000) : 0;
                      if (snapSec && dur && Math.abs(snapSec - dur) > 2) out.stale = true;
                    }
                  }

                  out.duration = out.duration || dur;
                  out.href = location.href;
                  return out;
                }
              });
              playinfo = pm?.result || null;
            } catch {
              playinfo = null;
            }

            sendResponse({ ok: true, report, playinfo });
          } catch (err) {
            sendResponse({ ok: false, error: `无法探测这个页面：${String(err?.message || err)}` });
          }
          break;
        }

        case 'CLOSE_OFFSCREEN': {
          // 上传队列已清空，延迟几秒再关，避免用户马上又点开始
          const requestedAt = Date.now();
          setTimeout(async () => {
            // 期间如果已经开始新的一轮，就别关了
            if (lastStartAt > requestedAt) return;
            try {
              const { [LS_SESSION]: session } = await chrome.storage.local.get(LS_SESSION);
              // 会话被清空过（session 为 undefined）也算空闲，同样可以关
              const idle = !session || ['stopped', 'error'].includes(session.status);
              if (!idle) return;
              await chrome.offscreen.closeDocument();
              refreshBadge('idle');
            } catch {
              /* 文档可能已经关掉了 */
            }
          }, 5000);
          sendResponse({ ok: true });
          break;
        }

        case 'START':
          // 新会话会覆盖当前 session，先把有内容的旧稿存进历史
          await archiveCurrentSession('start');
          sendResponse(await startCapture(msg));
          break;
        case 'STOP':
          sendResponse(await stopCapture());
          break;
        case 'RESET':
          // 清空/重开前先把稿子存进历史，别一按就没了
          await archiveCurrentSession('reset');
          sendResponse(await resetSession());
          break;
        case 'SHOW_PANEL': {
          // 把已有稿子显示到页面：整段提取或旧会话都能用，不重新识别
          let tabId = msg.tabId;
          if (!tabId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab?.id;
          }
          const ok = tabId ? await injectSubtitle(tabId) : false;
          sendResponse({ ok, error: ok ? null : '无法在这个页面注入字幕层' });
          break;
        }

        case 'DOC_SAVE': {
          // 字幕库：按视频 key 存一份稿子（面板/弹窗都可触发）
          const { asrDocs: cur0 } = await chrome.storage.local.get('asrDocs');
          const nextDocs = docUpsert(sanitizeDocs(cur0), msg.doc);
          await chrome.storage.local.set({ asrDocs: nextDocs });
          sendResponse({ ok: true, total: Object.keys(nextDocs).length });
          break;
        }

        case 'DOC_LIST': {
          const { asrDocs: cur1 } = await chrome.storage.local.get('asrDocs');
          sendResponse({ ok: true, items: docList(sanitizeDocs(cur1)) });
          break;
        }

        case 'DOC_LOAD': {
          // 把字幕库里的一份稿子提升为当前会话（面板/弹窗立刻可见）
          const { asrDocs: cur2 } = await chrome.storage.local.get('asrDocs');
          const doc = docGet(sanitizeDocs(cur2), msg.key);
          if (!doc) {
            sendResponse({ ok: false, error: '字幕库里没有这个视频' });
            break;
          }
          const session = {
            status: 'stopped',
            tabId: null,
            tabTitle: doc.title || '',
            startedAt: doc.createdAt || Date.now(),
            stoppedAt: Date.now(),
            segments: doc.segments.map((s, idx) => ({ ...s, index: idx, status: 'done' })),
            transcript: doc.segments.map((s) => s.text).join('\\n'),
            pending: 0,
            done: doc.count,
            failed: 0,
            skipped: 0,
            model: doc.model || '',
            lastError: '',
            partial: null,
            videoKey: doc.key,
            diag: { source: 'url', ingestPhase: 'done', fromLibrary: true }
          };
          await chrome.storage.local.set({ [LS_SESSION]: session });
          refreshBadge('stopped');
          sendResponse({ ok: true, count: doc.count, title: doc.title || '' });
          break;
        }

        case 'DOC_REMOVE': {
          const { asrDocs: cur3 } = await chrome.storage.local.get('asrDocs');
          const left = docRemove(sanitizeDocs(cur3), msg.key);
          await chrome.storage.local.set({ asrDocs: left });
          sendResponse({ ok: true, total: Object.keys(left).length });
          break;
        }

        case 'HISTORY_INFO': {
          const { [LS_HISTORY]: hist } = await chrome.storage.local.get(LS_HISTORY);
          const list = Array.isArray(hist) ? hist : [];
          sendResponse({
            ok: true,
            count: list.length,
            items: list.map((h) => ({ archivedAt: h.archivedAt, title: h.title, count: h.count }))
          });
          break;
        }

        case 'RESTORE_HISTORY': {
          // 把最近一份归档恢复成当前稿（导出 SRT 就靠它）
          const { [LS_HISTORY]: hist2 } = await chrome.storage.local.get(LS_HISTORY);
          const list2 = Array.isArray(hist2) ? hist2 : [];
          if (!list2.length) {
            sendResponse({ ok: false, error: '没有历史稿' });
            break;
          }
          const last = list2.shift();
          await chrome.storage.local.set({ [LS_SESSION]: last.session, [LS_HISTORY]: list2 });
          refreshBadge(last.session?.status);
          sendResponse({ ok: true, count: last.count || 0, title: last.title || '' });
          break;
        }

        case 'GET_STATE': {
          const { [LS_SESSION]: session } = await chrome.storage.local.get(LS_SESSION);
          sendResponse({ ok: true, state: session || null });
          break;
        }

        case 'CORRECT_ALL': {
          // 纠错要请求对话模型，放在 offscreen 里跑；这里只做转发
          const res = await callOffscreenTask({ type: 'CORRECT_ALL' }).catch((err) => ({
            ok: false,
            error: `后台页面未响应：${String(err?.message || err)}`
          }));
          sendResponse(res || { ok: false, error: '没有响应' });
          break;
        }

        case 'REFINE': {
          // 离线精校：读保存的 WAV 重跑长上下文识别，耗时按分钟计
          const res = await callOffscreenTask({ type: 'REFINE' }).catch((err) => ({
            ok: false,
            error: `后台页面未响应：${String(err?.message || err)}`
          }));
          sendResponse(res || { ok: false, error: '没有响应' });
          break;
        }

        case 'INGEST_CANCEL': {
          const res = await callOffscreenTask({ type: 'INGEST_CANCEL' }).catch(() => ({ ok: false }));
          sendResponse(res || { ok: false });
          break;
        }

        case 'INGEST_URL': {
          // videoKey 必须一起转：offscreen 靠它决定「这份稿子属于哪个视频」并入库
          // CDN 可能校验 Referer（B 站的 bilivideo 就是），fetch 里写不了，只能靠 DNR 装规则
          const cdnApplied = await applyCdnHeaders(msg.url);
          // 顺便回一下规则条数：规则要是没装上，403 就无从解释
          let cdnRules = 0;
          try {
            cdnRules = (await chrome.declarativeNetRequest.getSessionRules()).length;
          } catch {
            cdnRules = -1;
          }
          const res = await callOffscreenTask({ type: 'INGEST_URL', url: msg.url, videoKey: msg.videoKey }).catch((err) => ({
            ok: false,
            error: `后台页面未响应：${String(err?.message || err)}`
          }));

          // 整段提取不走录制，所以字幕层要在这里补注入，否则页面上一片空白
          if (res?.ok && msg.tabId) {
            const ok = await injectSubtitle(msg.tabId);
            sendResponse({ ...res, cdnHeaders: cdnApplied, cdnRules, subtitle: ok });
          } else {
            sendResponse({ ...(res || { ok: false, error: '没有响应' }), cdnHeaders: cdnApplied, cdnRules });
          }
          break;
        }

        case 'VAD_SELFTEST': {
          const res = await callOffscreenTask({ type: 'VAD_SELFTEST' }).catch((err) => ({
            ok: false,
            step: 'sw',
            error: `后台页面未响应：${String(err?.message || err)}`
          }));
          sendResponse(res || { ok: false, error: '没有响应' });
          break;
        }

        case 'PRESCAN_DONE': {
          // 预扫期间视频播完了：停掉录制，清掉指令
          await chrome.storage.local.remove('prescanCommand');
          const res = await stopCapture();
          sendResponse(res);
          break;
        }
        case 'PING':
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `未知消息类型：${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // 异步 sendResponse
});

chrome.runtime.onInstalled.addListener(() => {
  setBadge(false);
});

/* 浏览器重启后，存储里可能残留"录制中"的状态，但采集进程早已不在，先把状态擦干净 */
chrome.runtime.onStartup.addListener(async () => {
  try {
    const { [LS_SESSION]: session } = await chrome.storage.local.get(LS_SESSION);
    if (session && ['recording', 'starting', 'stopping'].includes(session.status)) {
      await chrome.storage.local.set({
        [LS_SESSION]: {
          ...session,
          status: 'stopped',
          stoppedAt: Date.now(),
          stopReason: '浏览器重启，录音已中断'
        }
      });
    }
    await setBadge(false);
  } catch {
    /* ignore */
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}





