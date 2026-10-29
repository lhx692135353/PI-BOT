plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.pibot.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.pibot.android"
        minSdk = 26
        targetSdk = 37
        versionCode = providers.environmentVariable("PI_BOT_BUILD_NUMBER").orNull?.toInt() ?: 3
        versionName = providers.environmentVariable("PI_BOT_VERSION").orNull ?: "0.3.0"
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:8000\"")
    }

    // Never generate a fresh CI key for updates. A missing key blocks publication.
    signingConfigs {
        create("continuousTest") {
            val path = providers.environmentVariable("PI_BOT_KEYSTORE_PATH").orNull
            if (path != null) {
                storeFile = file(path)
                storePassword = providers.environmentVariable("PI_BOT_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("PI_BOT_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("PI_BOT_KEY_PASSWORD").orNull
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("continuousTest")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.all { it.systemProperty("botFaceSpec", botFaceSpec.asFile.absolutePath) }
    }
}

/** The character spec is shared with the TypeScript renderer; the app bundles a copy at build time. */
val botFaceSpec: RegularFile = rootProject.layout.projectDirectory.file("../packages/bot-face/spec.json")

abstract class CopyBotFaceSpec : DefaultTask() {
    @get:InputFile
    abstract val spec: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = outputDir.get().asFile.resolve("bot-face")
        dir.mkdirs()
        spec.get().asFile.copyTo(dir.resolve("spec.json"), overwrite = true)
    }
}

val copyBotFaceSpec = tasks.register<CopyBotFaceSpec>("copyBotFaceSpec") {
    spec.set(botFaceSpec)
}

// Both clients ship the same A2UI renderer; no UI code is downloaded from the agent.
val buildA2ui = tasks.register<Exec>("buildA2ui") {
    workingDir(rootProject.projectDir.parentFile)
    // npm ci --ignore-scripts skips the vendored Node download. Fall back to the Node already on PATH.
    val nodeExecutable = if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) "node.exe" else "node"
    val vendoredNode = rootProject.projectDir.resolve("../desktop/node_modules/node/bin/$nodeExecutable")
    val nodeCommand = if (vendoredNode.isFile) vendoredNode.absolutePath else "node"
    commandLine(nodeCommand, "packages/a2ui/scripts/build.mjs")
    inputs.dir(rootProject.projectDir.resolve("../packages/a2ui/src"))
    inputs.dir(rootProject.projectDir.resolve("../packages/a2ui/web"))
    inputs.file(rootProject.projectDir.resolve("../package-lock.json"))
    outputs.dir(rootProject.projectDir.resolve("../packages/a2ui/dist"))
}
abstract class CopyA2ui : DefaultTask() {
    @get:InputDirectory abstract val sourceDir: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @TaskAction fun copy() {
        val target = outputDir.get().asFile.resolve("a2ui")
        target.deleteRecursively()
        sourceDir.get().asFile.copyRecursively(target, overwrite = true)
    }
}
val copyA2ui = tasks.register<CopyA2ui>("copyA2ui") {
    dependsOn(buildA2ui)
    sourceDir.set(rootProject.layout.projectDirectory.dir("../packages/a2ui/dist"))
}

// Include the project license and the vendored MIT license in every APK.
abstract class CopyProjectLicenses : DefaultTask() {
    @get:InputFiles abstract val licenseFiles: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = outputDir.get().asFile.resolve("licenses")
        dir.mkdirs()
        licenseFiles.files.forEach { file ->
            val name = if (file.parentFile.name == "hermes-memory") "pi-hermes-memory-LICENSE" else file.name
            file.copyTo(dir.resolve(name), overwrite = true)
        }
    }
}
val copyOpenSourceLicenses = tasks.register<CopyProjectLicenses>("copyOpenSourceLicenses") {
    licenseFiles.from(
        rootProject.file("../LICENSE"), rootProject.file("../NOTICE"),
        rootProject.file("../THIRD_PARTY_NOTICES.md"),
        rootProject.file("../packages/agent/src/hermes-memory/LICENSE"),
    )
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyBotFaceSpec, CopyBotFaceSpec::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(copyA2ui, CopyA2ui::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(copyOpenSourceLicenses, CopyProjectLicenses::outputDir)
    }
}

dependencies {
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.androidx.work)
    implementation(libs.google.play.services.base)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
