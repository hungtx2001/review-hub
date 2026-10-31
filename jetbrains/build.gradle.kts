plugins {
    id("java")
    kotlin("jvm") version "2.0.20"
    id("org.jetbrains.intellij.platform") version "2.0.1"
    kotlin("plugin.serialization") version "2.0.20"
}

group = "com.reviewhub"
version = "0.3.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.2.3")
        bundledPlugin("com.intellij.java")
        instrumentationTools()
    }

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        id = "com.reviewhub.jetbrains"
        name = "Review Hub"
        version = "0.3.0"
        description = """
            Always see what AI coding agents changed in your project, and accept or reject individual hunks.
            Works with Claude Code, opencode, dsh, Cline, Roo via MCP, and catches direct writes too.
        """.trimIndent()
        vendor {
            name = "Review Hub"
        }
        ideaVersion {
            sinceBuild = "241"
            untilBuild = "262.*"
        }
    }
}

tasks {
    processResources {
        val hubBundle = file("../dist/hub-server.cjs")
        if (hubBundle.exists()) {
            from(hubBundle) {
                into("server")
            }
        }
    }

    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}
