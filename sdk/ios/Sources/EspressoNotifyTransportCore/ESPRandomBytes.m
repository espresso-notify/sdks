#import "ESPRandomBytes.h"

#import <Security/Security.h>

#import "ESPTransportClient.h"

@implementation ESPRandomBytes

+ (NSInteger)maxCount {
    return 256;
}

+ (NSString *)hexWithCount:(NSInteger)count errorCode:(NSString **)errorCode {
    return [self hexWithCount:count
                    errorCode:errorCode
                         fill:^int(size_t length, void *bytes) {
                             return SecRandomCopyBytes(kSecRandomDefault, length, bytes);
                         }];
}

+ (NSString *)hexWithCount:(NSInteger)count errorCode:(NSString **)errorCode fill:(int (^)(size_t, void *))fill {
    if (count < 1 || count > self.maxCount) {
        if (errorCode) *errorCode = ESPErrorInvalidRequest;
        return nil;
    }
    uint8_t bytes[256];
    if (fill((size_t)count, bytes) != 0) {
        if (errorCode) *errorCode = ESPErrorUnknown;
        return nil;
    }
    static const char digits[] = "0123456789abcdef";
    char text[512];
    for (NSInteger i = 0; i < count; i++) {
        text[2 * i] = digits[bytes[i] >> 4];
        text[2 * i + 1] = digits[bytes[i] & 0x0f];
    }
    return [[NSString alloc] initWithBytes:text length:(NSUInteger)(2 * count) encoding:NSASCIIStringEncoding];
}

@end
