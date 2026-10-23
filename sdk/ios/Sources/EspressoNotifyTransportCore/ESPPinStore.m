#import "ESPPinStore.h"

#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>

@interface ESPPinEntry : NSObject
@property(nonatomic, copy) NSString *host;
@property(nonatomic) BOOL includeSubdomains;
@property(nonatomic, copy) NSArray<NSData *> *pins; // 32 bytes each
@end
@implementation ESPPinEntry
@end

#pragma mark - DER

/// Reads the header of the DER element at `offset`. Fails on a truncated element or an indefinite or oversized length.
static BOOL ESPReadElement(const uint8_t *bytes, NSUInteger length, NSUInteger offset, uint8_t *tag, NSUInteger *contentStart, NSUInteger *contentLength) {
    if (offset > length || length - offset < 2) return NO;
    *tag = bytes[offset];
    NSUInteger first = bytes[offset + 1];
    NSUInteger position = offset + 2;
    NSUInteger size = first;
    if (first & 0x80) {
        NSUInteger count = first & 0x7F;
        if (count == 0 || count > 4 || length - position < count) return NO;
        size = 0;
        for (NSUInteger i = 0; i < count; i++) size = (size << 8) | bytes[position + i];
        position += count;
    }
    if (size > length - position) return NO;
    *contentStart = position;
    *contentLength = size;
    return YES;
}

/// Constant time over the length: no early exit on the first byte that differs.
static BOOL ESPConstantTimeEqual(const uint8_t *a, const uint8_t *b, NSUInteger length) {
    uint8_t difference = 0;
    for (NSUInteger i = 0; i < length; i++) difference |= (uint8_t)(a[i] ^ b[i]);
    return difference == 0;
}

@implementation ESPPinStore {
    __weak ESPTransportClient *_client;
    NSArray<ESPPinEntry *> *_entries; // immutable snapshots, swapped under @synchronized
}

- (instancetype)initWithClient:(ESPTransportClient *)client {
    if ((self = [super init])) {
        _client = client;
        _entries = @[];
        client.challengeHandler = self;
    }
    return self;
}

#pragma mark - Public

+ (NSData *)spkiSha256ForCertificateDer:(NSData *)der {
    const uint8_t *b = der.bytes;
    NSUInteger length = der.length;
    uint8_t tag;
    NSUInteger start, size;
    // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version OPTIONAL, serial, signature, issuer, validity,
    // subject, subjectPublicKeyInfo ... } ... }. A walk covers every key type with one rule.
    if (!ESPReadElement(b, length, 0, &tag, &start, &size) || tag != 0x30) return nil;
    NSUInteger certEnd = start + size;
    NSUInteger tbsStart, tbsSize;
    if (!ESPReadElement(b, certEnd, start, &tag, &tbsStart, &tbsSize) || tag != 0x30) return nil;
    NSUInteger end = tbsStart + tbsSize;
    NSUInteger position = tbsStart;
    NSUInteger contentStart, contentSize;
    if (!ESPReadElement(b, end, position, &tag, &contentStart, &contentSize)) return nil;
    if (tag == 0xA0) position = contentStart + contentSize; // the optional version
    for (int skipped = 0; skipped < 5; skipped++) { // serial, signature, issuer, validity, subject
        if (!ESPReadElement(b, end, position, &tag, &contentStart, &contentSize)) return nil;
        position = contentStart + contentSize;
    }
    if (!ESPReadElement(b, end, position, &tag, &contentStart, &contentSize) || tag != 0x30) return nil;
    NSUInteger spkiLength = contentStart + contentSize - position;
    uint8_t digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(b + position, (CC_LONG)spkiLength, digest);
    return [NSData dataWithBytes:digest length:CC_SHA256_DIGEST_LENGTH];
}

- (BOOL)isHostPinned:(NSString *)host {
    return [self entryForHost:host] != nil;
}

- (BOOL)setEntries:(NSArray<NSDictionary<NSString *, id> *> *)entries {
    NSArray<ESPPinEntry *> *valid = [ESPPinStore validate:entries];
    if (valid == nil) return NO;
    @synchronized(self) {
        _entries = valid;
    }
    [_client resetSession]; // the new session meets the new pins; the old one finishes its requests and goes
    return YES;
}

- (void)clear {
    @synchronized(self) {
        _entries = @[];
    }
    [_client resetSession];
}

#pragma mark - Validation

/// The entries in the form the store keeps, or nil when the list is empty or any entry is invalid.
+ (NSArray<ESPPinEntry *> *)validate:(NSArray *)entries {
    if (![entries isKindOfClass:[NSArray class]] || entries.count == 0) return nil;
    static NSRegularExpression *hostPattern, *pinPattern;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        // A host name or an address: letters, digits, dots and hyphens, no wildcard, no port, no scheme.
        hostPattern = [NSRegularExpression regularExpressionWithPattern:@"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$" options:0 error:nil];
        // 32 bytes in standard base64 with padding: 43 characters and one `=`.
        pinPattern = [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9+/]{43}=$" options:0 error:nil];
    });
    NSMutableArray<ESPPinEntry *> *out = [NSMutableArray arrayWithCapacity:entries.count];
    for (id item in entries) {
        if (![item isKindOfClass:[NSDictionary class]]) return nil;
        id rawHost = item[@"host"], flag = item[@"includeSubdomains"], rawPins = item[@"pins"];
        if (![rawHost isKindOfClass:[NSString class]] || ![flag isKindOfClass:[NSNumber class]] || ![rawPins isKindOfClass:[NSArray class]] || [rawPins count] == 0) return nil;
        NSString *host = [[(NSString *)rawHost stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
        if ([hostPattern numberOfMatchesInString:host options:0 range:NSMakeRange(0, host.length)] != 1) return nil;
        NSMutableArray<NSData *> *pins = [NSMutableArray arrayWithCapacity:[rawPins count]];
        for (id rawPin in rawPins) {
            if (![rawPin isKindOfClass:[NSString class]]) return nil;
            NSString *pin = [(NSString *)rawPin stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
            if ([pin hasPrefix:@"sha256/"]) pin = [pin substringFromIndex:7];
            if ([pinPattern numberOfMatchesInString:pin options:0 range:NSMakeRange(0, pin.length)] != 1) return nil;
            NSData *decoded = [[NSData alloc] initWithBase64EncodedString:pin options:0];
            if (decoded.length != CC_SHA256_DIGEST_LENGTH) return nil;
            [pins addObject:decoded];
        }
        ESPPinEntry *entry = [[ESPPinEntry alloc] init];
        entry.host = host;
        entry.includeSubdomains = [flag boolValue];
        entry.pins = pins;
        [out addObject:entry];
    }
    return out;
}

#pragma mark - Challenges

- (nullable ESPPinEntry *)entryForHost:(NSString *)host {
    NSString *name = host.lowercaseString;
    NSArray<ESPPinEntry *> *entries;
    @synchronized(self) {
        entries = _entries;
    }
    for (ESPPinEntry *entry in entries) {
        if ([name isEqualToString:entry.host]) return entry;
        if (entry.includeSubdomains && [name hasSuffix:[@"." stringByAppendingString:entry.host]]) return entry;
    }
    return nil;
}

- (ESPChallengeDecision)decideForChallenge:(NSURLAuthenticationChallenge *)challenge
                                credential:(NSURLCredential **)credential
                                      code:(NSString **)code {
    NSURLProtectionSpace *space = challenge.protectionSpace;
    ESPPinEntry *entry = [self entryForHost:space.host];
    if (entry == nil || ![space.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust]) {
        return ESPChallengeDecisionDefault;
    }
    SecTrustRef trust = space.serverTrust;
    if (trust == NULL) {
        *code = ESPErrorTls;
        return ESPChallengeDecisionCancel;
    }
    // The normal validation first: the pins are in addition to it, never instead of it.
    CFErrorRef trustError = NULL;
    BOOL trusted = SecTrustEvaluateWithError(trust, &trustError);
    if (trustError != NULL) CFRelease(trustError);
    if (!trusted) {
        *code = ESPErrorTls;
        return ESPChallengeDecisionCancel;
    }
    CFArrayRef chain = SecTrustCopyCertificateChain(trust);
    BOOL matched = NO;
    if (chain != NULL) {
        for (CFIndex i = 0; i < CFArrayGetCount(chain); i++) {
            SecCertificateRef certificate = (SecCertificateRef)CFArrayGetValueAtIndex(chain, i);
            CFDataRef data = SecCertificateCopyData(certificate);
            NSData *hash = [ESPPinStore spkiSha256ForCertificateDer:(__bridge NSData *)data];
            if (data != NULL) CFRelease(data);
            if (hash == nil) continue;
            for (NSData *pin in entry.pins) { // every pin is compared, with no early exit
                matched |= ESPConstantTimeEqual(hash.bytes, pin.bytes, CC_SHA256_DIGEST_LENGTH);
            }
        }
        CFRelease(chain);
    }
    if (!matched) {
        *code = ESPErrorPinMismatch;
        return ESPChallengeDecisionCancel;
    }
    *credential = [NSURLCredential credentialForTrust:trust];
    return ESPChallengeDecisionUseCredential;
}

@end
