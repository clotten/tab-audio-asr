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

        case 'PROBE_MEDIA': {
          // 探测当前页能不能整段提取（直链 / HLS / DASH / 现成字幕），
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
            const [res] = await chrome.scripting.executeScript({
              target: { tabId },
              files: ['content/probe.js']
            });
            sendResponse({ ok: true, report: res?.result || null });
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

        case 'INGEST_URL': {
          const res = await callOffscreenTask({ type: 'INGEST_URL', url: msg.url }).catch((err) => ({
            ok: false,
            error: `后台页面未响应：${String(err?.message || err)}`
          }));

          // 整段提取不走录制，所以字幕层要在这里补注入，否则页面上一片空白
          if (res?.ok && msg.tabId) {
            const ok = await injectSubtitle(msg.tabId);
            sendResponse({ ...res, subtitle: ok });
          } else {
            sendResponse(res || { ok: false, error: '没有响应' });
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



