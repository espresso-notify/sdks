#import "EspressoNotifyTransport.h"

#import "ESPPinStore.h"
#import "ESPRandomBytes.h"
#import "ESPTransportClient.h"

/// One client and one pin table for the process, so every instance of the module (a reload of the JavaScript makes a new
/// one) sends through the same session and keeps the pins it was given.
static ESPTransportClient *EspClient(void) {
    static ESPTransportClient *client;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        client = [[ESPTransportClient alloc] init];
    });
    return client;
}

static ESPPinStore *EspPins(void) {
    static ESPPinStore *pins;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        pins = [[ESPPinStore alloc] initWithClient:EspClient()];
    });
    return pins;
}

@implementation EspressoNotifyTransport

// The name the JavaScript asks for in `TurboModuleRegistry.get`; the codegen's `modulesProvider` maps it to this class.
RCT_EXPORT_MODULE(EspressoNotifyTransport)

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

// The constants are returned as `id` on purpose. The type the generated protocol spells for them
// (`ModuleConstants<...Constants>` or `ModuleConstants<...Constants::Builder>`) differs between React Native versions, and
// it is only a compile-time wrapper around an `NSDictionary`; `id` is compatible with both and the dictionary is the same.
- (id)constantsToExport {
    return @{@"contractVersion" : @(ESPContractVersion)};
}

#ifdef RCT_NEW_ARCH_ENABLED
- (id)getConstants {
    return [self constantsToExport];
}
#endif
// On the old architecture there is no `getConstants` here on purpose: the bridge copies `constantsToExport` onto the
// JavaScript module and defines `getConstants()` itself (`NativeModules.js` of React Native 0.79); a method of that name
// would only make it warn "Unable to define method 'getConstants()'".

RCT_EXPORT_METHOD(request
                  : (NSString *)method url
                  : (NSString *)url headers
                  : (NSArray *)headers body
                  : (NSString *)body timeoutMs
                  : (double)timeoutMs resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
    for (id header in headers) {
        if (![header isKindOfClass:[NSString class]]) {
            reject(ESPErrorInvalidRequest, ESPErrorInvalidRequest, nil);
            return;
        }
    }
    [EspClient() requestWithMethod:method
                               url:url
                           headers:headers
                              body:[body isKindOfClass:[NSString class]] ? body : nil
                         timeoutMs:(NSInteger)timeoutMs
                        completion:^(ESPHttpResult *result, NSString *code) {
                            if (result != nil) {
                                resolve(@{
                                    @"status" : @(result.status),
                                    @"statusText" : result.statusText,
                                    @"retryAfter" : result.retryAfter,
                                    @"body" : result.body,
                                });
                            } else {
                                reject(code, code, nil); // the code is the message too: no free text crosses the bridge
                            }
                        }];
}

RCT_EXPORT_METHOD(setPins : (NSArray *)entries resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
    resolve(@([EspPins() setEntries:entries]));
}

RCT_EXPORT_METHOD(clearPins : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
    [EspPins() clear];
    resolve(nil);
}

// `count` bytes from the platform generator as lowercase hex, for the device id and the nonce of a signed request. A count
// outside 1 to 256 (a NaN or an infinity included) rejects with `invalid_request`; the code is the message too.
RCT_EXPORT_METHOD(randomBytes
                  : (double)count resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
    NSInteger wanted = (count >= 1 && count <= (double)ESPRandomBytes.maxCount) ? (NSInteger)count : 0;
    NSString *code = nil;
    NSString *hex = [ESPRandomBytes hexWithCount:wanted errorCode:&code];
    if (hex != nil) {
        resolve(hex);
    } else {
        reject(code, code, nil);
    }
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
    return std::make_shared<facebook::react::NativeEspressoNotifyTransportSpecJSI>(params);
}
#endif

@end
