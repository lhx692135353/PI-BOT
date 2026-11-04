import AVFoundation

/// Microphone capture and speaker playback for one call, both 16 kHz mono PCM16 on the wire.
/// Runs on audio threads; everything shared with the main actor is guarded by `lock`.
final class CallAudio: @unchecked Sendable {
    static let rate: Double = 16_000

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: CallAudio.rate, channels: 1, interleaved: true)!
    private let playback = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: CallAudio.rate, channels: 1, interleaved: false)!
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var socket: URLSessionWebSocketTask?
    private var muted = false
    private var queuedFrames = 0
    private var generation = 0
    private var sawPlayback = false
    private var loudSince: TimeInterval = 0
    private var lastBarge: TimeInterval = 0
    private var configObserver: NSObjectProtocol?

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, bluetoothHFP])
        try session.setPreferredSampleRate(48_000)
        try session.setActive(true)
        // Voice processing gives the platform echo canceller, like Android's VOICE_COMMUNICATION source.
        try engine.inputNode.setVoiceProcessingEnabled(true)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playback)
        try installTap()
        engine.prepare()
        try engine.start()
        player.play()
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restart()
        }
    }

    func stop() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        lock.withLock { socket = nil; queuedFrames = 0; generation += 1 }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func setSocket(_ task: URLSessionWebSocketTask?) { lock.withLock { socket = task } }

    func setMuted(_ value: Bool) { lock.withLock { muted = value } }

    /// Route changes (headphones, Bluetooth) stop the engine and may change the input format.
    private func restart() {
        engine.inputNode.removeTap(onBus: 0)
        do {
            try installTap()
            if !engine.isRunning { try engine.start() }
            player.play()
        } catch {
            NSLog("PiBot voice: unable to restart audio after a route change: \(error)")
        }
    }

    private func installTap() throws {
        let input = engine.inputNode.outputFormat(forBus: 0)
        guard input.sampleRate > 0, input.channelCount > 0, let converter = AVAudioConverter(from: input, to: wire) else {
            throw CallAudioError.microphone
        }
        self.converter = converter
        engine.inputNode.installTap(onBus: 0, bufferSize: AVAudioFrameCount(input.sampleRate / 10), format: input) { [weak self] buffer, _ in
            self?.capture(buffer, converter: converter)
        }
    }

    private func capture(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter) {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * CallAudio.rate / buffer.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: capacity) else { return }
        var fed = false
        var failure: NSError?
        converter.convert(to: out, error: &failure) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard failure == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return }
        let count = Int(out.frameLength)
        let data = Data(bytes: samples, count: count * 2)
        let (task, silent) = lock.withLock { (socket, muted) }
        if !silent { task?.send(.data(data)) { _ in } }
        maybeBarge(samples, count: count, muted: silent, task: task)
    }

    /// Talking over the bot for 200 ms interrupts its reply.
    private func maybeBarge(_ samples: UnsafePointer<Int16>, count: Int, muted: Bool, task: URLSessionWebSocketTask?) {
        let now = Date().timeIntervalSince1970
        let fire: Bool = lock.withLock {
            if muted || queuedFrames <= 800 { loudSince = 0; return false }
            var sum = 0.0
            for i in 0..<count { let s = Double(samples[i]); sum += s * s }
            if count == 0 || (sum / Double(count)).squareRoot() < 1800 { loudSince = 0; return false }
            if loudSince == 0 { loudSince = now; return false }
            guard now - loudSince >= 0.2, now - lastBarge > 0.8 else { return false }
            lastBarge = now
            loudSince = 0
            return true
        }
        if fire { task?.send(.string(#"{"type":"barge"}"#)) { _ in } }
    }

    func play(_ data: Data) {
        let frames = data.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playback, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            for i in 0..<frames {
                let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
                channel[i] = Float(sample) / 32768
            }
        }
        let current = lock.withLock { () -> Int in
            queuedFrames += frames
            sawPlayback = true
            return generation
        }
        player.scheduleBuffer(buffer) { [weak self] in
            guard let self else { return }
            self.lock.withLock { if self.generation == current { self.queuedFrames = max(0, self.queuedFrames - frames) } }
        }
        if !player.isPlaying { player.play() }
    }

    /// The server asks to drop queued speech after a barge-in.
    func clearPlayback() {
        lock.withLock { generation += 1; queuedFrames = 0; sawPlayback = false; loudSince = 0 }
        player.stop()
        player.play()
    }

    /// True once when playback drains, so the server knows the bot stopped talking.
    func drained() -> Bool {
        lock.withLock {
            let active = queuedFrames > 800
            defer { sawPlayback = active }
            return sawPlayback && !active
        }
    }
}

/// `allowBluetoothHFP` only exists in the iOS 26 SDK; Xcode 16 still calls it `allowBluetooth`.
#if compiler(>=6.2)
private let bluetoothHFP = AVAudioSession.CategoryOptions.allowBluetoothHFP
#else
private let bluetoothHFP = AVAudioSession.CategoryOptions.allowBluetooth
#endif

enum CallAudioError: LocalizedError {
    case microphone
    var errorDescription: String? { "无法打开麦克风" }
}
