import com.google.protobuf.gradle.proto

plugins {
    id("com.android.application")
    id("com.google.protobuf")
}

android {
    namespace = "io.lazurio.app.proof"
    compileSdk = 36
    defaultConfig {
        // A proof's own identity, so it never takes the place of the real io.lazurio.app.
        applicationId = "io.lazurio.app.proof"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1-proof"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // The helper is an executable, so Android has to unpack it next to the app's libraries.
    packaging { jniLibs { useLegacyPackaging = true } }
    // The helper protocol of Lazurio App, the same files the desktop app and its helpers use.
    sourceSets { getByName("main") { proto { srcDir("../../../proto") } } }
}

protobuf {
    protoc { artifact = "com.google.protobuf:protoc:4.31.1" }
    generateProtoTasks {
        all().forEach { task ->
            task.builtins { create("java") { option("lite") } }
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.google.protobuf:protobuf-javalite:4.31.1")
}
