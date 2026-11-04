import AVFoundation
import Observation
import PiBotKit

/// One voice call from this device. Audio stays on the device; the server relays it to the voice model.
/// Mirrors Android's `VoiceCallService`, including resuming the same call after a short drop.
@MainActor
@Observable
final class VoiceCallController {
    private static let graceMs: Int64 = 15_000

    @ObservationIgnored private let store: AppStore
    @ObservationIgnored private let session = URLSession(configuration: .default)
    @ObservationIgnored private var botId: String?
    @ObservationIgnored private var callId: String?
    @ObservationIgnored private var muted = false
    @ObservationIgnored private var hungUp = false
    @ObservationIgnored private var startedAt: Int64 = 0
    @ObservationIgnored private var droppedAt: Int64 = 0
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var audio: CallAudio?
    @ObservationIgnored private var retry: Task<Void, Never>?
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var pinger: Task<Void, Never>?

    init(store: AppStore) {
        self.store = store
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            MainActor.assumeIsolated { self?.interrupted() }
        }
    }

    /// Returns a message to show when the call cannot start.
    func start(botId: String) async -> String? {
        if self.botId != nil { return nil }
        guard await AVAudioApplication.requestRecordPermission() else { return "需要麦克风权限才能语音通话" }
        guard self.botId == nil, store.session != nil else { return nil }
        self.botId = botId
        callId = nil; muted = false; hungUp = false; startedAt = 0; droppedAt = 0; attempts = 0
        publish(phase: "connecting")
        let audio = CallAudio()
        do {
            try audio.start()
        } catch {
            audio.stop()
            fail(error is CallAudioError ? "无法打开麦克风" : "无法开启语音通话，请重试")
            return nil
        }
        self.audio = audio
        watcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 120_000_000)
                guard let self, let audio = self.audio else { return }
                if audio.drained() { self.sendJSON(#"{"type":"playback_idle"}"#) }
            }
        }
        connect()
        return nil
    }

    func hangup() {
        guard botId != nil, !hungUp else { return }
        hungUp = true
        sendJSON(#"{"type":"hangup"}"#)
        finish("hangup")
    }

    func setMuted(_ next: Bool) {
        guard botId != nil else { return }
        muted = next
        audio?.setMuted(next)
        sendJSON(#"{"type":"mute","on":\#(next)}"#)
        publish(muted: next)
    }

    private func interrupted() {
        if botId != nil { fail("通话被系统中断") }
    }

    private func connect() {
        guard let account = store.session else { return fail("请先登录") }
        guard let bot = botId else { return }
        guard let address = try? account.url.voiceSocket(token: account.token, botId: bot, callId: callId), let url = URL(string: address) else {
            return fail("服务器地址无效")
        }
        publish(phase: "connecting")
        let task = session.webSocketTask(with: url)
        socket = task
        audio?.setSocket(task)
        task.resume()
        Task { [weak self] in await self?.receive(task) }
        pinger?.cancel()
        pinger = Task { [weak task] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                task?.sendPing { _ in }
            }
        }
    }

    private func receive(_ task: URLSessionWebSocketTask) async {
        while true {
            let message: URLSessionWebSocketTask.Message
            do { message = try await task.receive() } catch { closed(task); return }
            guard socket === task else { return }
            switch message {
            case .data(let data): audio?.play(data)
            case .string(let text): control(text)
            @unknown default: break
            }
        }
    }

    private func control(_ text: String) {
        guard let packet = JSONValue.parse(text) else { return }
        switch packet["type"]?.stringValue {
        case "hello":
            callId = packet["call_id"]?.stringValue ?? callId
            attempts = 0
            droppedAt = 0
            if startedAt == 0 { startedAt = nowMillis() }
            publish(phase: packet["phase"]?.stringValue ?? "listening", callId: callId)
        case "state":
            if let phase = packet["phase"]?.stringValue { publish(phase: phase) }
        case "clear":
            audio?.clearPlayback()
            sendJSON(#"{"type":"playback_idle"}"#)
        case "ended":
            finish(packet["reason"]?.stringValue == "hangup" ? "hangup" : "通话已结束")
        case "error":
            publish(error: packet["detail"]?.stringValue ?? "通话失败")
        default:
            break
        }
    }

    private func closed(_ task: URLSessionWebSocketTask) {
        guard socket === task else { return }
        let code = task.closeCode.rawValue
        if [4401, 4403, 4404, 4409].contains(code) {
            let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
            fail(reason.trimmingCharacters(in: .whitespaces).isEmpty ? "通话已结束" : reason)
            return
        }
        socket = nil
        audio?.setSocket(nil)
        if hungUp { return }
        if callId == nil {
            fail(store.liveCall.flatMap { $0.botId == botId ? $0.error : nil } ?? "没有接通")
            return
        }
        if droppedAt == 0 { droppedAt = nowMillis() }
        if nowMillis() - droppedAt > Self.graceMs { fail("通话已结束"); return }
        let wait = min(4000, 400 << min(attempts, 4))
        attempts += 1
        publish(phase: "connecting")
        retry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000)
            guard let self, !Task.isCancelled, !self.hungUp, self.botId != nil else { return }
            self.connect()
        }
    }

    private func fail(_ detail: String) {
        publish(phase: "ended", error: detail)
        finish(detail)
    }

    private func finish(_ reason: String) {
        hungUp = true
        retry?.cancel(); retry = nil
        watcher?.cancel(); watcher = nil
        pinger?.cancel(); pinger = nil
        socket?.cancel(with: .normalClosure, reason: reason.data(using: .utf8).map { $0.prefix(120) })
        socket = nil
        audio?.stop()
        audio = nil
        let bot = botId
        botId = nil
        if let bot { store.endLiveCall(botId: bot, error: reason) }
    }

    private func sendJSON(_ json: String) { socket?.send(.string(json)) { _ in } }

    private func publish(phase: String? = nil, callId: String? = nil, muted: Bool? = nil, error: String? = nil) {
        guard let bot = botId else { return }
        let current = store.liveCall?.botId == bot ? store.liveCall : nil
        store.updateLiveCall(LiveCall(
            botId: bot,
            callId: callId ?? current?.callId,
            phase: phase ?? current?.phase ?? "connecting",
            muted: muted ?? self.muted,
            startedAt: startedAt > 0 ? startedAt : current?.startedAt ?? 0,
            error: error ?? current?.error,
            local: true
        ))
    }
}
