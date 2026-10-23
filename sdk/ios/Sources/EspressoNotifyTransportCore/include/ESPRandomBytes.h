// Secure random bytes for the SDK (sdk-secure-device-id). Foundation only in this header, like the rest of the core.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The bytes of the device id and of the nonce of a signed request. Hermes has no `crypto.getRandomValues`, so the
/// JavaScript asks the module, and the bytes come from `SecRandomCopyBytes`, the platform generator.
@interface ESPRandomBytes : NSObject

/// The most bytes one call gives; the SDK asks for 8 and 16.
@property (class, readonly) NSInteger maxCount;

/// `count` bytes as `2 x count` lowercase hex characters. When `count` is not from 1 to `maxCount` it returns nil and sets
/// `errorCode` to `ESPErrorInvalidRequest`; when the generator fails, nil and `ESPErrorUnknown`. Never throws.
+ (nullable NSString *)hexWithCount:(NSInteger)count errorCode:(NSString *_Nullable *_Nullable)errorCode;

/// The same with the generator given: `fill` writes `count` bytes at `bytes` and returns 0 on success. A seam for tests.
+ (nullable NSString *)hexWithCount:(NSInteger)count
                          errorCode:(NSString *_Nullable *_Nullable)errorCode
                               fill:(int (^)(size_t count, void *bytes))fill;

@end

NS_ASSUME_NONNULL_END
