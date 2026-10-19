package dev.pibot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.pibot.android.data.PiBotRepository

@Composable
fun AppRoot(repository: PiBotRepository) {
    val session by repository.session.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    val signedIn = session != null
    DisposableEffect(owner, signedIn) {
        val observer = LifecycleEventObserver { _, event ->
            if (!signedIn) return@LifecycleEventObserver
            if (event == Lifecycle.Event.ON_START) repository.startEvents()
            if (event == Lifecycle.Event.ON_STOP) repository.stopEvents()
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    if (!signedIn) LoginScreen(repository) else Signed(repository)
}

@Composable
private fun Signed(repository: PiBotRepository) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val bots by repository.bots.collectAsStateWithLifecycle()
    // Drafts belong to bots, so resizing, folding and switching conversations keep them.
    var drafts by rememberSaveable { mutableStateOf(mapOf<String, String>()) }
    var wideSelectionMade by rememberSaveable { mutableStateOf(false) }

    fun openBot(id: String) {
        if (route == "bot/{id}" && entry?.arguments?.getString("id") == id) return
        nav.navigate("bot/$id") {
            popUpTo("bots")
            launchSingleTop = true
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(Paper)) {
        // The available window width also adapts to split-screen and freeform windows.
        val expanded = maxWidth >= 720.dp
        val sidebarWidth = (maxWidth * 0.34f).coerceIn(280.dp, 360.dp)
        val showList = expanded && (route == "bots" || route == "bot/{id}")
        LaunchedEffect(expanded, route, bots?.firstOrNull()?.id) {
            if (expanded && route == "bot/{id}") wideSelectionMade = true
            if (expanded && route == "bots" && !wideSelectionMade) {
                (bots?.firstOrNull { it.isMain } ?: bots?.firstOrNull())?.let {
                    wideSelectionMade = true
                    openBot(it.id)
                }
            }
        }
        Row(Modifier.fillMaxSize()) {
            if (showList) {
                Box(Modifier.width(sidebarWidth).fillMaxHeight()) {
                    BotListScreen(
                        repository,
                        onOpen = ::openBot,
                        onCreate = { nav.navigate("editor/new") },
                        onSettings = { nav.navigate("settings") },
                        selectedId = entry?.arguments?.getString("id"),
                        expanded = true,
                    )
                }
                VerticalDivider(color = Line)
            }
            NavHost(nav, startDestination = "bots", modifier = Modifier.weight(1f)) {
                composable("bots") {
                    if (expanded) {
                        EmptyState(ORANGE, "happy", "一起开始新的对话", "从左侧选择一个 Bot，或新建你的专属伙伴。")
                    } else BotListScreen(
                        repository,
                        onOpen = ::openBot,
                        onCreate = { nav.navigate("editor/new") },
                        onSettings = { nav.navigate("settings") },
                    )
                }
                composable("editor/{id}") { editorEntry ->
                    val id = editorEntry.arguments?.getString("id").orEmpty()
                    BotEditorScreen(
                        repository,
                        botId = id.takeIf { it != "new" },
                        onDone = { saved ->
                            nav.popBackStack()
                            if (id == "new" && saved != null) openBot(saved)
                        },
                        onArchived = { nav.popBackStack("bots", inclusive = false) },
                    )
                }
                composable("bot/{id}") { botEntry ->
                    val id = botEntry.arguments?.getString("id").orEmpty()
                    TimelineScreen(
                        repository,
                        botId = id,
                        onBack = { nav.popBackStack() },
                        onEdit = { nav.navigate("editor/$id") },
                        onFiles = { nav.navigate("files/$id") },
                        onOpenBot = { other -> if (other != id) {
                            if (expanded) openBot(other) else nav.navigate("bot/$other")
                        } },
                        expanded = expanded,
                        draft = drafts[id].orEmpty(),
                        onDraftChange = { value -> drafts = if (value.isEmpty()) drafts - id else drafts + (id to value) },
                    )
                }
                composable("files/{id}") { filesEntry ->
                    FilesScreen(repository, filesEntry.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() })
                }
                composable("settings") { SettingsScreen(repository, onBack = { nav.popBackStack() }) }
            }
        }
    }
}
