// The certificate pins of the iOS native transport (sdk-private-transport T31, SPT-33 to SPT-38). Foundation only in
// this header, like the rest of the core.
#import <Foundation/Foundation.h>

#import "ESPTransportClient.h"

NS_ASSUME_NONNULL_BEGIN

/// Pins are kept in memory for the life of the process. `setEntries:` replaces the whole set or applies nothing: when any
/// entry is invalid, or the list is empty, it returns NO and the set that was there stays. A valid set, and `clear`, make
/// the client build a new session and invalidate the old one, so no connection validated under the old pins is reused.
///
/// For a server-trust challenge of a pinned host the store evaluates the trust first (a chain the system does not trust
/// fails even with a matching pin), then hashes the SubjectPublicKeyInfo of every certificate of the chain and compares
/// it in constant time with every pin; a match on any certificate passes. A host with no entry is left to the default
/// handling. The pin format is base64 SPKI SHA-256 (32 bytes); a leading `sha256/` is accepted and removed.
@interface ESPPinStore : NSObject <ESPChallengeHandler>

/// Makes the store the challenge handler of `client`, and the owner of its session changes.
- (instancetype)initWithClient:(ESPTransportClient *)client NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Each entry: `host` (NSString), `includeSubdomains` (NSNumber), `pins` (NSArray of NSString). Never throws.
- (BOOL)setEntries:(NSArray<NSDictionary<NSString *, id> *> *)entries;

/// Removes every pin.
- (void)clear;

/// True when `host` is covered by the pins now in force.
- (BOOL)isHostPinned:(NSString *)host;

/// The SHA-256 of the SubjectPublicKeyInfo of a DER certificate (32 bytes), or nil when the bytes are not a certificate.
+ (nullable NSData *)spkiSha256ForCertificateDer:(NSData *)der;

@end

NS_ASSUME_NONNULL_END
