package dev.pibot.android.ui

import dev.pibot.android.data.RuntimeErrorCodes

/** User-facing guidance only: never echo raw backend errors, identifiers or credentials. */
internal fun phonePreviewHelp(error: Throwable): String = when ((error as? dev.pibot.android.data.ApiException)?.code) {
    RuntimeErrorCodes.UNSUPPORTED, RuntimeErrorCodes.SESSION_EXPIRED -> "手机服务可能需要更新。请检查执行电脑上的 Pi Bot。"
    RuntimeErrorCodes.UNAVAILABLE, RuntimeErrorCodes.TRANSPORT_CLOSED -> "执行电脑暂时离线，连接恢复后再试。"
    RuntimeErrorCodes.UNAUTHORIZED, RuntimeErrorCodes.FORBIDDEN -> "请检查登录状态和这台电脑的授权。"
    RuntimeErrorCodes.TIMEOUT -> "读取画面超时，稍后重试。"
    else -> "暂时无法读取画面，请检查网络和执行电脑。"
}

internal fun phoneAvailabilityHint(hasDevice: Boolean, online: Boolean, available: Boolean, occupied: Boolean): String = when {
    !hasDevice -> "选择一台已授权、已配置虚拟手机的电脑。"
    !online -> "电脑离线，连接恢复后会自动重试。"
    !available -> "等待手机服务就绪；若一直无法连接，请联系管理员检查配置。"
    occupied -> "手机正在使用中。你可以预览，待对方结束后再接管。"
    else -> "预览不会操作手机。需要点击或输入时，请先接管。"
}
