/* ---------------- 音调测试 ---------------- */
      let audioCtx = null;
      let osc = null;
      let toneTimer = null;

      const toneStatus = document.getElementById('toneStatus');
      const meter = document.getElementById('meter');

      function setToneStatus(text, warn) {
        toneStatus.textContent = text || '';
        toneStatus.className = 'status' + (warn ? ' warn' : '');
      }

      document.getElementById('toneBtn').addEventListener('click', async () => {
        stopTone();
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        await audioCtx.resume();

        const gain = audioCtx.createGain();
        gain.gain.value = 0.18;
        gain.connect(audioCtx.destination);

        osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 1000;
        osc.connect(gain);
        osc.start();

        const endAt = performance.now() + 10000;
        setToneStatus('正在播放 1kHz 音调，10 秒后自动停止…');

        toneTimer = setInterval(() => {
          const left = endAt - performance.now();
          meter.style.width = Math.max(0, Math.min(100, (left / 10000) * 100)) + '%';
          if (left <= 0) {
            stopTone();
            setToneStatus('音调播放结束。');
          }
        }, 100);
      });

      document.getElementById('toneStopBtn').addEventListener('click', () => {
        stopTone();
        setToneStatus('已停止。');
      });

      function stopTone() {
        clearInterval(toneTimer);
        toneTimer = null;
        meter.style.width = '0%';
        if (osc) {
          try { osc.stop(); osc.disconnect(); } catch {}
          osc = null;
        }
        if (audioCtx) {
          audioCtx.close().catch(() => {});
          audioCtx = null;
        }
      }

      /* ---------------- 语音测试 ---------------- */
      const speakStatus = document.getElementById('speakStatus');
      const voiceSelect = document.getElementById('voiceSelect');
      const speechText = document.getElementById('speechText');
      let loopTimer = null;

      function setSpeakStatus(text, warn) {
        speakStatus.textContent = text || '';
        speakStatus.className = 'status' + (warn ? ' warn' : '');
      }

      function loadVoices() {
        const voices = (window.speechSynthesis?.getVoices?.() || []).filter((v) => /zh|cmn/i.test(v.lang));
        voiceSelect.innerHTML = '';
        if (!voices.length) {
          const opt = document.createElement('option');
          opt.textContent = '（未找到中文语音，可用系统默认）';
          opt.value = '';
          voiceSelect.appendChild(opt);
          return;
        }
        for (const v of voices) {
          const opt = document.createElement('option');
          opt.value = v.name;
          opt.textContent = `${v.name}（${v.lang}）`;
          voiceSelect.appendChild(opt);
        }
      }

      if (window.speechSynthesis) {
        loadVoices();
        window.speechSynthesis.onvoiceschanged = loadVoices;
      } else {
        setSpeakStatus('这个浏览器不支持 speechSynthesis，请用真实视频测试。', true);
      }

      function speakOnce() {
        if (!window.speechSynthesis) return null;
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(speechText.value || '测试');
        utter.lang = 'zh-CN';
        utter.rate = 1;
        const chosen = (window.speechSynthesis.getVoices() || []).find(
          (v) => v.name === voiceSelect.value
        );
        if (chosen) utter.voice = chosen;
        utter.onend = () => {
          if (!loopTimer) setSpeakStatus('朗读结束。');
        };
        window.speechSynthesis.speak(utter);
        return utter;
      }

      document.getElementById('speakBtn').addEventListener('click', () => {
        stopLoop();
        speakOnce();
        setSpeakStatus('正在朗读一次…');
      });

      document.getElementById('speakStopBtn').addEventListener('click', () => {
        stopLoop();
        window.speechSynthesis?.cancel();
        setSpeakStatus('已停止。');
      });

      document.getElementById('loopBtn').addEventListener('click', () => {
        stopLoop();
        speakOnce();
        setSpeakStatus('循环朗读中，每 12 秒一次（适合测试长录音）。');
        loopTimer = setInterval(() => {
          speakOnce();
        }, 12000);
      });

      function stopLoop() {
        clearInterval(loopTimer);
        loopTimer = null;
      }
    