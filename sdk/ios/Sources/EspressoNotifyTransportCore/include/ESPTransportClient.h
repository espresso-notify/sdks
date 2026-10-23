// The HTTP side of the iOS native transport (sdk-private-transport T30). Foundation only: this header imports no React
// header, so a dynamic-framework build of the pod never meets a non-modular header, and a SwiftPM harness compiles it
// on the macOS host (`sdk/native-tests/ios`).
//
// The client owns one ephemeral `NSURLSession` of its own. It never uses `NSURLSession.shared`, the default configuration
// or the networking of React Native, so the calls stay out of every JavaScript inspector (SPT-29).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The version this module reports in `getConstants().contractVersion`; the JavaScript lists the versions it speaks.
FOUNDATION_EXPORT const NSInteger ESPContractVersion;

/// The most response bytes the module reads; more cancels the call with `response_too_large`.
FOUNDATION_EXPORT const NSUInteger ESPMaxResponseBytes;

/// The time one request may take, from the start of the call to the last byte of the answer.
FOUNDATION_EXPORT const NSInteger ESPDefaultTimeoutMs;

/// The closed list of failures the module may report. The code is also the message of the rejection.
FOUNDATION_EXPORT NSString *const ESPErrorTimeout;
FOUNDATION_EXPORT NSString *const ESPErrorNoConnection;
FOUNDATION_EXPORT NSString *const ESPErrorDns;
FOUNDATION_EXPORT NSString *const ESPErrorTls;
FOUNDATION_EXPORT NSString *const ESPErrorPinMismatch;
FOUNDATION_EXPORT NSString *const ESPErrorCancelled;
FOUNDATION_EXPORT NSString *const ESPErrorResponseTooLarge;
FOUNDATION_EXPORT NSString *const ESPErrorInvalidRequest;
FOUNDATION_EXPORT NSString *const ESPErrorUnknown;

/// All nine codes, in the order of the design.
FOUNDATION_EXPORT NSArray<NSString *> *ESPAllErrorCodes(void);

/// What the module gives back for any HTTP answer, whatever its status. No other header leaves the native layer.
@interface ESPHttpResult : NSObject
@property(nonatomic, readonly) NSInteger status;
/// Empty: `NSURLSession` does not expose the reason phrase, and the contract allows an empty one.
@property(nonatomic, readonly, copy) NSString *statusText;
/// The raw `Retry-After` value, or an empty string.
@property(nonatomic, readonly, copy) NSString *retryAfter;
/// UTF-8 text, at most `ESPMaxResponseBytes` bytes before decoding (invalid bytes are replaced).
@property(nonatomic, readonly, copy) NSString *body;
- (instancetype)initWithStatus:(NSInteger)status statusText:(NSString *)statusText retryAfter:(NSString *)retryAfter body:(NSString *)body NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
@end

/// Settled once per request: with an answer, or with one of the codes of `ESPAllErrorCodes`.
typedef void (^ESPCompletion)(ESPHttpResult *_Nullable result, NSString *_Nullable code);

typedef NS_ENUM(NSInteger, ESPChallengeDecision) {
    /// Let the system evaluate the server trust as it would without this module.
    ESPChallengeDecisionDefault = 0,
    /// Continue with the credential.
    ESPChallengeDecisionUseCredential = 1,
    /// Cancel the request; the code names why (`pin_mismatch` or `tls`).
    ESPChallengeDecisionCancel = 2,
};

/// The seam the pin store (`ESPPinStore`) plugs into. The client calls it on its private queue for every server-trust
/// challenge and knows nothing about pins.
@protocol ESPChallengeHandler <NSObject>
- (ESPChallengeDecision)decideForChallenge:(NSURLAuthenticationChallenge *)challenge
                                credential:(NSURLCredential *_Nullable *_Nonnull)credential
                                      code:(NSString *_Nullable *_Nonnull)code;
@end

@interface ESPTransportClient : NSObject <NSURLSessionDataDelegate>

/// The configuration production uses: ephemeral, no cache, no cookie storage, no credential storage, no redirect
/// handling of its own, 30 seconds, 4 connections per host. A test copies it and sets `protocolClasses` to a stub.
+ (NSURLSessionConfiguration *)productionConfiguration;

/// A client on `productionConfiguration`.
- (instancetype)init;

/// A client on `configuration` (tests inject a stub protocol here).
- (instancetype)initWithConfiguration:(NSURLSessionConfiguration *)configuration NS_DESIGNATED_INITIALIZER;

/// The session in use now.
@property(atomic, readonly) NSURLSession *session;

/// Counts the sessions this client has made: 1 at first, one more on every `resetSession`.
@property(atomic, readonly) NSUInteger sessionGeneration;

/// How many sessions this client has finished and invalidated (a session ends when its last task ends).
@property(atomic, readonly) NSUInteger invalidatedSessionCount;

/// Called on the client's queue for every server-trust challenge. Weak: the owner of the pin store keeps it.
@property(atomic, weak, nullable) id<ESPChallengeHandler> challengeHandler;

/// Makes a new session from the same configuration and lets the old one finish its tasks and invalidate. A connection
/// opened under the old session is never reused by the new one.
- (void)resetSession;

/// Sends one request and settles `completion` once. Never throws: a request that cannot be built is `invalid_request`.
/// @param headers flat list `name, value, name, value`; the last value of a repeated name wins.
/// @param body UTF-8 text, or nil when there is none.
- (void)requestWithMethod:(NSString *)method
                      url:(NSString *)url
                  headers:(NSArray<NSString *> *)headers
                     body:(nullable NSString *)body
                timeoutMs:(NSInteger)timeoutMs
               completion:(ESPCompletion)completion NS_SWIFT_NAME(request(method:url:headers:body:timeoutMs:completion:));

@end

NS_ASSUME_NONNULL_END
