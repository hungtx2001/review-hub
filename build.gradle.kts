plugins {
    id("java")
    kotlin("jvm") version "2.0.20"
    id("org.jetbrains.intellij.platform") version "2.0.1"
    kotlin("plugin.serialization") version "2.0.20"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

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
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")
        vendor {
            name = "Trịnh Xuân Hưng"
        }
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = providers.gradleProperty("pluginUntilBuild")
        }
    }

    publishing {
        token.set(providers.environmentVariable("JETBRAINS_TOKEN"))
    }
}

tasks {
    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
    // AGENTS.md and gradle.properties are bundled as single sources of truth for rules and version.
    processResources {
        from(rootProject.file("AGENTS.md")) {
            into("rules")
        }
        from(rootProject.file("gradle.properties")) {
            into("META-INF")
        }
    }
}
