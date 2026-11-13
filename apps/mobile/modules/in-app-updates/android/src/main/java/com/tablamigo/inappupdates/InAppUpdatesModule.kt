package com.tablamigo.inappupdates

import android.app.Activity
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Google Play's In-App Updates, the small part of it this app uses. Written here rather than taken from a library because
 * every published wrapper (expo-in-app-updates, sp-react-native-in-app-updates) either calls completeUpdate() the moment a
 * flexible update finishes downloading -- which restarts the app under the person, mid-chat, with no warning -- or carries
 * dependencies this app does not want. Google's own guidance is to tell the person it is ready and let them choose the
 * moment, which is what `install()` is for (src/lib/update-prompt.ts shows the banner).
 *
 * Everything here is a thin pass-through to Play Core; when and whether anything is shown is decided in TypeScript
 * (src/lib/update-policy.ts). On a device without the Play Store (a sideloaded build, an emulator image without Play) the
 * Play Core task fails and `check()` rejects with ERR_UPDATE_CHECK, which the app treats as "no update".
 */
class InAppUpdatesModule : Module() {
  companion object {
    private const val REQUEST_CODE = 4211
    private const val EVENT_DOWNLOADED = "downloaded"
    private const val EVENT_INSTALLED = "installed"
    private const val EVENT_FAILED = "failed"
    private const val EVENT_CANCELLED = "cancelled"
  }

  private var manager: AppUpdateManager? = null

  /** Play reports the download and install of a flexible update here, in any order, and after the app was restarted. */
  private val installListener = InstallStateUpdatedListener { state ->
    when (state.installStatus()) {
      InstallStatus.DOWNLOADED -> sendEvent(EVENT_DOWNLOADED, emptyMap<String, Any>())
      InstallStatus.INSTALLED -> sendEvent(EVENT_INSTALLED, emptyMap<String, Any>())
      InstallStatus.FAILED -> sendEvent(EVENT_FAILED, mapOf("code" to state.installErrorCode()))
      InstallStatus.CANCELED -> sendEvent(EVENT_CANCELLED, mapOf("where" to "download"))
      else -> Unit
    }
  }

  override fun definition() = ModuleDefinition {
    Name("TablamigoInAppUpdates")

    Events(EVENT_DOWNLOADED, EVENT_INSTALLED, EVENT_FAILED, EVENT_CANCELLED)

    OnCreate {
      val context = appContext.reactContext
      if (context != null) {
        manager = AppUpdateManagerFactory.create(context).also { it.registerListener(installListener) }
      }
    }

    OnDestroy {
      manager?.unregisterListener(installListener)
      manager = null
    }

    // Asks Play what it has for this package. Play answers from its own cache, so this is cheap and offline-safe
    // (offline it fails, and the promise rejects).
    AsyncFunction("check") { promise: Promise ->
      val m = manager
      if (m == null) {
        promise.reject(CodedException("ERR_UPDATE_UNAVAILABLE", "Play In-App Updates is not set up in this process", null))
        return@AsyncFunction
      }
      m.appUpdateInfo
        .addOnSuccessListener { info -> promise.resolve(describe(info)) }
        .addOnFailureListener { e -> promise.reject(CodedException("ERR_UPDATE_CHECK", "Play could not be asked for an update: ${e.message}", e)) }
    }

    /**
     * Starts Play's own update flow. `immediate` picks the blocking full-screen flow; otherwise the flexible one, where
     * Play downloads in the background and the app stays usable. Resolves false when Play says this type is not allowed
     * (which is Play's call, not ours) or there is nothing to update.
     */
    AsyncFunction("start") { immediate: Boolean, promise: Promise ->
      val m = manager
      if (m == null) {
        promise.reject(CodedException("ERR_UPDATE_UNAVAILABLE", "Play In-App Updates is not set up in this process", null))
        return@AsyncFunction
      }
      m.appUpdateInfo.addOnSuccessListener { info ->
        val availability = info.updateAvailability()
        val usable = availability == UpdateAvailability.UPDATE_AVAILABLE ||
          availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
        val type = if (immediate) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
        val activity: Activity? = appContext.currentActivity
        if (!usable || !info.isUpdateTypeAllowed(type) || activity == null) {
          promise.resolve(false)
          return@addOnSuccessListener
        }
        // Play Core calls these listeners on the main thread, which is where the update flow has to be started.
        try {
          val options = AppUpdateOptions.newBuilder(type).setAllowAssetPackDeletion(true).build()
          promise.resolve(m.startUpdateFlowForResult(info, activity, options, REQUEST_CODE))
        } catch (e: Exception) {
          // A dead IntentSender (the activity went away while Play was answering) must not take the app down.
          promise.reject(CodedException("ERR_UPDATE_START", "Play could not start the update: ${e.message}", e))
        }
      }.addOnFailureListener { e ->
        promise.reject(CodedException("ERR_UPDATE_START", "Play could not start the update: ${e.message}", e))
      }
    }

    /**
     * Installs a flexible update that has finished downloading. Play shows its own full-screen notice and restarts the
     * app, so this is only ever called from a button the person pressed.
     */
    AsyncFunction("install") { promise: Promise ->
      val m = manager
      if (m == null) {
        promise.reject(CodedException("ERR_UPDATE_UNAVAILABLE", "Play In-App Updates is not set up in this process", null))
        return@AsyncFunction
      }
      m.completeUpdate()
        .addOnSuccessListener { promise.resolve(true) }
        // Nothing was downloaded after all (installed elsewhere, or Play cleared it): the banner goes away.
        .addOnFailureListener { e -> promise.reject(CodedException("ERR_UPDATE_INSTALL", "Play could not install the update: ${e.message}", e)) }
    }

    OnActivityResult { _, result ->
      if (result.requestCode != REQUEST_CODE) return@OnActivityResult
      when (result.resultCode) {
        Activity.RESULT_OK -> Unit
        Activity.RESULT_CANCELED -> sendEvent(EVENT_CANCELLED, mapOf("where" to "dialog"))
        // ActivityResult.RESULT_IN_APP_UPDATE_FAILED (1) and anything else Play may add.
        else -> sendEvent(EVENT_FAILED, mapOf("code" to result.resultCode))
      }
    }
  }

  private fun describe(info: AppUpdateInfo): Map<String, Any?> {
    val availability = info.updateAvailability()
    return mapOf(
      "available" to (availability == UpdateAvailability.UPDATE_AVAILABLE),
      // An immediate update the person started and then killed the app during: Play requires it to be resumed.
      "inProgress" to (availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS),
      // Play returns the package's own versionCode when nothing newer exists; the app only reads this when available.
      "versionCode" to info.availableVersionCode(),
      "flexibleAllowed" to info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
      "immediateAllowed" to info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE),
      "priority" to info.updatePriority(),
      "stalenessDays" to info.clientVersionStalenessDays(),
      // A flexible update can finish downloading after the app was closed; then it is waiting to be installed.
      "downloaded" to (info.installStatus() == InstallStatus.DOWNLOADED),
      // Play is already fetching or installing it, so nothing new should be started.
      "inFlight" to (info.installStatus() in setOf(InstallStatus.PENDING, InstallStatus.DOWNLOADING, InstallStatus.INSTALLING)),
    )
  }
}
