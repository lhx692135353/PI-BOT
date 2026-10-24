package dev.pibot.android.ui

/** User-facing guidance only: never echo raw backend errors, identifiers or credentials. */
internal fun phonePreviewHelp(message: String): String = when {
    message.contains("会话已失效") || message.contains("phone.preview", ignoreCase = true) ->
        "手机服务版本可能需要更新。请联系管理员检查执行电脑；无需先接管手机。"
    message.contains("离线") || message.contains("offline", ignoreCase = true) ->
        "执行电脑暂时离线。请确认电脑上的 Pi Bot 正在运行，再重试。"
    message.contains("授权") || message.contains("401") || message.contains("403") ->
        "连接授权需要确认。请返回检查登录状态和这台电脑的授权。"
    message.contains("timeout", ignoreCase = true) || message.contains("超时") ->
        "读取画面超时。请检查网络，稍后重试。"
    else -> "暂时无法读取画面。请检查网络和执行电脑上的手机服务，再重试。"
}

internal fun phoneAvailabilityHint(hasDevice: Boolean, online: Boolean, available: Boolean, occupied: Boolean): String = when {
    !hasDevice -> "选择一台已授权、已配置虚拟手机的电脑。"
    !online -> "电脑离线，连接恢复后会自动重试。"
    !available -> "等待手机服务就绪；若一直无法连接，请联系管理员检查配置。"
    occupied -> "手机正在使用中。你可以预览，待对方结束后再接管。"
    else -> "预览不会操作手机。需要点击或输入时，请先接管。"
}
