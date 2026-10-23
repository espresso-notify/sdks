package com.espressonotify.transport

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers the native transport module; autolinking adds this class to the app's package list. */
class EspressoNotifyTransportPackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == EspressoNotifyTransportModule.NAME) EspressoNotifyTransportModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            EspressoNotifyTransportModule.NAME to ReactModuleInfo(
                EspressoNotifyTransportModule.NAME,
                EspressoNotifyTransportModule::class.java.name,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                true, // isTurboModule
            ),
        )
    }
}
