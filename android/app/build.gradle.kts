plugins { id("com.android.application") }
android {
    namespace = "com.plyt.app"
    compileSdk = 37
    defaultConfig { applicationId = "com.plyt.app"; minSdk = 26; targetSdk = 37; versionCode = 1; versionName = "0.1.0" }
    buildFeatures { buildConfig = true }
    buildTypes { release { isMinifyEnabled = false } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_11; targetCompatibility = JavaVersion.VERSION_11 }
}
