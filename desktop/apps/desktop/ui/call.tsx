import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { PiBot } from '@pi-bot/bot-face/react';
import type { Mood } from '@pi-bot/bot-face';
import type { Bot } from '../../../packages/protocol/src/index.js';
import { call, errorText } from './bridge.js';

const RATE = 16000;
const GRACE_MS = 15000;

export function voiceSocketUrl(serverUrl: string, ticket: string, callId?: string) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws/voice`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('ticket', ticket);
  if (callId) url.searchParams.set('call_id', callId);
  return url.toString();
}

const PHASE: Record<string, string> = { connecting: '接通中', listening: '正在听', speaking: '正在说', thinking: '想一下' };
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

export interface VoiceHandle { hangup(): void; toggleMute(): void }

interface Props {
  bot: Bot;
  mood: Mood;
  serverUrl: string;
  onMuted(muted: boolean): void;
  onEnded(): void;
}

export const VoiceCall = forwardRef<VoiceHandle, Props>(function VoiceCall({ bot, mood, serverUrl, onMuted, onEnded }, ref) {
  const [phase, setPhase] = useState('connecting');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');

  useEffect(() => {
    const session = connectVoice({
      botId: bot.id,
      serverUrl,
      onPhase: setPhase,
      onStarted: setStartedAt,
      onMuted,
      onError: setError,
      onEnded,
    });
    return () => session.stop();
    // The call belongs to this mount. Switching bots unmounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, serverUrl]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useImperativeHandle(ref, () => ({ hangup: () => voiceControls.hangup(), toggleMute: () => voiceControls.toggleMute() }), []);

  return (
    <div className="call-overlay" role="dialog" aria-label="语音通话">
      <PiBot avatar={bot.avatar} mood={phase === 'speaking' ? 'working' : mood} size={180} followPointer />
      <h2>{bot.name}</h2>
      <p className="muted">{error || PHASE[phase] || '通话中'}</p>
      <p className="call-clock">{startedAt ? clock(now - startedAt) : '00:00'}</p>
    </div>
  );
});

const voiceControls = { hangup() {}, toggleMute() {} };

function connectVoice(input: {
  botId: string;
  serverUrl: string;
  onPhase(phase: string): void;
  onStarted(at: number): void;
  onMuted(muted: boolean): void;
  onError(detail: string): void;
  onEnded(): void;
}) {
  let stopped = false;
  let ended = false;
  let muted = false;
  let callId = '';
  let droppedAt = 0;
  let attempts = 0;
  let reconnectTimer = 0;
  let pingTimer = 0;
  let ws: WebSocket | null = null;
  let playing = false;
  let barged = false;
  let loudAt = 0;
  let started = false;
  const sources: AudioBufferSourceNode[] = [];
  let nextAt = 0;
  let playCtx: AudioContext | null = null;
  let micCtx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let processor: ScriptProcessorNode | null = null;

  const send = (value: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const finish = (detail?: string) => {
    if (ended) return;
    ended = true;
    stopped = true;
    window.clearTimeout(reconnectTimer);
    window.clearInterval(pingTimer);
    releaseAudio();
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
    if (detail && detail !== 'hangup') input.onError(detail);
    input.onEnded();
  };
  const hangup = () => {
    if (ended) return;
    send({ type: 'hangup' });
    finish('hangup');
  };
  const toggleMute = () => {
    muted = !muted;
    input.onMuted(muted);
    send({ type: 'mute', on: muted });
  };
  voiceControls.hangup = hangup;
  voiceControls.toggleMute = toggleMute;

  const clearPlayback = () => {
    barged = false;
    loudAt = 0;
    for (const node of sources.splice(0)) { try { node.onended = null; node.stop(); } catch { /* already stopped */ } }
    nextAt = 0;
    if (playing) { playing = false; send({ type: 'playback_idle' }); }
  };
  const enqueue = (pcm: ArrayBuffer) => {
    if (!playCtx || ended) return;
    const view = new Int16Array(pcm);
    if (!view.length) return;
    const buffer = playCtx.createBuffer(1, view.length, RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < view.length; i++) channel[i] = view[i]! / 32768;
    const node = playCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(playCtx.destination);
    const start = Math.max(playCtx.currentTime + 0.02, nextAt);
    try { node.start(start); } catch { return; }
    nextAt = start + buffer.duration;
    sources.push(node);
    playing = true;
    node.onended = () => {
      const index = sources.indexOf(node);
      if (index >= 0) sources.splice(index, 1);
      if (!sources.length && playing) { playing = false; nextAt = 0; send({ type: 'playback_idle' }); }
    };
  };
  const considerBarge = (samples: Float32Array) => {
    if (!playing || muted) { loudAt = 0; return; }
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    if (rms < 0.06) { loudAt = 0; return; }
    const now = performance.now();
    if (!loudAt) loudAt = now;
    else if (!barged && now - loudAt >= 200) { barged = true; send({ type: 'barge' }); }
  };
  const downlink = (data: ArrayBuffer) => {
    const copy = data.slice(0);
    const pcm16 = new Int16Array(copy);
    if (pcm16.length) enqueue(copy);
  };

  function releaseAudio() {
    clearPlayback();
    processor?.disconnect();
    processor = null;
    micStream?.getTracks().forEach(track => track.stop());
    micStream = null;
    void micCtx?.close();
    void playCtx?.close();
    micCtx = null;
    playCtx = null;
  }

  async function openMic() {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    if (stopped) { micStream.getTracks().forEach(track => track.stop()); return; }
    playCtx = new AudioContext();
    micCtx = new AudioContext();
    const source = micCtx.createMediaStreamSource(micStream);
    processor = micCtx.createScriptProcessor(2048, 1, 1);
    const sink = micCtx.createGain();
    sink.gain.value = 0;
    const inputRate = micCtx.sampleRate;
    processor.onaudioprocess = event => {
      const samples = event.inputBuffer.getChannelData(0);
      considerBarge(samples);
      if (muted || ws?.readyState !== WebSocket.OPEN) return;
      const pcm = downsample(samples, inputRate, RATE);
      if (pcm.byteLength) ws.send(pcm.buffer);
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(micCtx.destination);
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (!callId) { finish('没有接通'); return; }
    if (!droppedAt) droppedAt = Date.now();
    if (Date.now() - droppedAt > GRACE_MS) { finish('通话已结束'); return; }
    input.onPhase('connecting');
    const wait = Math.min(4000, 400 * 2 ** attempts);
    attempts += 1;
    reconnectTimer = window.setTimeout(() => { void openSocket(); }, wait);
  }

  async function openSocket() {
    if (stopped) return;
    let ticket: { ticket: string };
    try { ticket = await call<{ ticket: string }>('voiceTicket', { botId: input.botId }); }
    catch (error) { finish(errorText(error)); return; }
    if (stopped) return;
    const socket = new WebSocket(voiceSocketUrl(input.serverUrl, ticket.ticket, callId || undefined));
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.onmessage = event => {
      if (socket !== ws || stopped) return;
      if (event.data instanceof ArrayBuffer) { downlink(event.data); return; }
      let message: { type?: string; call_id?: string; phase?: string; detail?: string; reason?: string };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'hello') {
        callId = message.call_id ?? callId;
        attempts = 0;
        droppedAt = 0;
        if (!started) { started = true; input.onStarted(Date.now()); }
        input.onPhase(message.phase ?? 'listening');
      } else if (message.type === 'state' && message.phase) input.onPhase(message.phase);
      else if (message.type === 'clear') clearPlayback();
      else if (message.type === 'ended') finish(message.reason === 'hangup' ? 'hangup' : undefined);
      else if (message.type === 'error') input.onError(message.detail ?? '通话失败');
    };
    socket.onclose = () => { if (socket === ws) { ws = null; scheduleReconnect(); } };
    socket.onerror = () => socket.close();
  }

  void openMic().then(() => {
    if (stopped) return;
    pingTimer = window.setInterval(() => send({ type: 'ping' }), 20000);
    return openSocket();
  }).catch(error => finish(errorText(error)));

  return { stop: () => { if (!ended) hangup(); } };
}

function downsample(input: Float32Array, from: number, to: number) {
  if (from === to) {
    const same = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) same[i] = clamp(input[i]!);
    return same;
  }
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  let offset = 0;
  for (let i = 0; i < length; i++) {
    const next = Math.min(input.length, Math.round((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = offset; j < next; j++) { sum += input[j]!; count += 1; }
    out[i] = clamp(count ? sum / count : 0);
    offset = next;
  }
  return out;
}

function clamp(sample: number) {
  return Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
}
