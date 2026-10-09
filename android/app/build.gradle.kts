plugins {
    id("com.android.application")
}

// The CI passes the run number so every build installs as an update.
val buildNumber = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "io.github.hhukkvghj.chromaflux"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.hhukkvghj.chromaflux"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // A fixed hobby key, committed on purpose, so new builds install over old ones.
    // It only proves "same Chromaflux pipeline"; this app is not meant for the Play Store.
    signingConfigs {
        create("hobby") {
            storeFile = file("../chromaflux-hobby.keystore")
            storePassword = "chromaflux"
            keyAlias = "chromaflux"
            keyPassword = "chromaflux"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("hobby")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
