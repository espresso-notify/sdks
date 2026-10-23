#import "ESPTransportClient.h"

const NSInteger ESPContractVersion = 1;
const NSUInteger ESPMaxResponseBytes = 4194304;
const NSInteger ESPDefaultTimeoutMs = 30000;

NSString *const ESPErrorTimeout = @"timeout";
NSString *const ESPErrorNoConnection = @"no_connection";
NSString *const ESPErrorDns = @"dns";
NSString *const ESPErrorTls = @"tls";
NSString *const ESPErrorPinMismatch = @"pin_mismatch";
NSString *const ESPErrorCancelled = @"cancelled";
NSString *const ESPErrorResponseTooLarge = @"response_too_large";
NSString *const ESPErrorInvalidRequest = @"invalid_request";
NSString *const ESPErrorUnknown = @"unknown";

NSArray<NSString *> *ESPAllErrorCodes(void) {
    return @[ ESPErrorTimeout, ESPErrorNoConnection, ESPErrorDns, ESPErrorTls, ESPErrorPinMismatch, ESPErrorCancelled,
              ESPErrorResponseTooLarge, ESPErrorInvalidRequest, ESPErrorUnknown ];
}

@implementation ESPHttpResult
- (instancetype)initWithStatus:(NSInteger)status statusText:(NSString *)statusText retryAfter:(NSString *)retryAfter body:(NSString *)body {
    if ((self = [super init])) {
        _status = status;
        _statusText = [statusText copy];
        _retryAfter = [retryAfter copy];
        _body = [body copy];
    }
    return self;
}
@end

/// What one request keeps while it is in flight. Touched only on the client's queue.
@interface ESPTaskState : NSObject
@property(nonatomic, copy) ESPCompletion completion;
@property(nonatomic, strong) NSMutableData *data;
@property(nonatomic, strong, nullable) NSHTTPURLResponse *response;
@property(nonatomic) BOOL finished;
@property(nonatomic) BOOL timedOut;
@property(nonatomic) BOOL tooLarge;
/// Set when the challenge handler cancelled the request: the code it gave.
@property(nonatomic, copy, nullable) NSString *challengeCode;
@end
@implementation ESPTaskState
@end

/// Decodes UTF-8, replacing every byte that is not part of a valid sequence with U+FFFD (never an error).
static NSString *ESPDecodeUtf8(NSData *data) {
    if (data.length == 0) return @"";
    NSString *fast = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (fast != nil) return fast;
    const uint8_t *bytes = data.bytes;
    NSUInteger length = data.length;
    NSMutableData *clean = [NSMutableData dataWithCapacity:length + 8];
    static const uint8_t replacement[3] = { 0xEF, 0xBF, 0xBD };
    NSUInteger i = 0;
    while (i < length) {
        uint8_t b = bytes[i];
        NSUInteger need = 0;
        uint8_t lo = 0x80, hi = 0xBF;
        if (b < 0x80) {
            [clean appendBytes:&bytes[i] length:1];
            i += 1;
            continue;
        } else if (b >= 0xC2 && b <= 0xDF) {
            need = 1;
        } else if (b >= 0xE0 && b <= 0xEF) {
            need = 2;
            if (b == 0xE0) lo = 0xA0;
            if (b == 0xED) hi = 0x9F;
        } else if (b >= 0xF0 && b <= 0xF4) {
            need = 3;
            if (b == 0xF0) lo = 0x90;
            if (b == 0xF4) hi = 0x8F;
        } else {
            [clean appendBytes:replacement length:3];
            i += 1;
            continue;
        }
        BOOL valid = i + need < length;
        for (NSUInteger k = 1; valid && k <= need; k++) {
            uint8_t c = bytes[i + k];
            uint8_t from = (k == 1) ? lo : 0x80;
            uint8_t to = (k == 1) ? hi : 0xBF;
            valid = c >= from && c <= to;
        }
        if (valid) {
            [clean appendBytes:&bytes[i] length:need + 1];
            i += need + 1;
        } else {
            [clean appendBytes:replacement length:3];
            i += 1;
        }
    }
    return [[NSString alloc] initWithData:clean encoding:NSUTF8StringEncoding] ?: @"";
}

/// Names a failure with one of the closed codes. The text of the error is never read.
static NSString *ESPCodeForError(NSError *error, ESPTaskState *state) {
    if (state.tooLarge) return ESPErrorResponseTooLarge;
    if (state.timedOut) return ESPErrorTimeout;
    if (state.challengeCode != nil) return state.challengeCode;
    if (![error.domain isEqualToString:NSURLErrorDomain]) return ESPErrorUnknown;
    switch (error.code) {
        case NSURLErrorTimedOut:
            return ESPErrorTimeout;
        case NSURLErrorCannotFindHost:
        case NSURLErrorDNSLookupFailed:
            return ESPErrorDns;
        case NSURLErrorSecureConnectionFailed:
        case NSURLErrorServerCertificateHasBadDate:
        case NSURLErrorServerCertificateUntrusted:
        case NSURLErrorServerCertificateHasUnknownRoot:
        case NSURLErrorServerCertificateNotYetValid:
        case NSURLErrorClientCertificateRejected:
        case NSURLErrorClientCertificateRequired:
            return ESPErrorTls;
        case NSURLErrorNotConnectedToInternet:
        case NSURLErrorNetworkConnectionLost:
        case NSURLErrorCannotConnectToHost:
        case NSURLErrorInternationalRoamingOff:
        case NSURLErrorCallIsActive:
        case NSURLErrorDataNotAllowed:
            return ESPErrorNoConnection;
        case NSURLErrorCancelled:
            return ESPErrorCancelled;
        case NSURLErrorBadURL:
        case NSURLErrorUnsupportedURL:
            return ESPErrorInvalidRequest;
        default:
            return ESPErrorUnknown;
    }
}

@implementation ESPTransportClient {
    NSURLSessionConfiguration *_configuration;
    dispatch_queue_t _queue;
    NSOperationQueue *_delegateQueue;
    NSURLSession *_session;
    NSUInteger _generation;
    NSUInteger _invalidated;
    NSMapTable<NSURLSessionTask *, ESPTaskState *> *_states; // touched only on _queue
}

+ (NSURLSessionConfiguration *)productionConfiguration {
    NSURLSessionConfiguration *c = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    c.HTTPCookieStorage = nil;
    c.HTTPShouldSetCookies = NO;
    c.URLCache = nil;
    c.URLCredentialStorage = nil;
    c.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    c.waitsForConnectivity = NO;
    c.HTTPMaximumConnectionsPerHost = 4;
    c.timeoutIntervalForRequest = ESPDefaultTimeoutMs / 1000.0;
    c.timeoutIntervalForResource = ESPDefaultTimeoutMs / 1000.0;
    return c;
}

- (instancetype)init {
    return [self initWithConfiguration:[ESPTransportClient productionConfiguration]];
}

- (instancetype)initWithConfiguration:(NSURLSessionConfiguration *)configuration {
    if ((self = [super init])) {
        _configuration = [configuration copy];
        _queue = dispatch_queue_create("com.espressonotify.transport", DISPATCH_QUEUE_SERIAL);
        _delegateQueue = [[NSOperationQueue alloc] init];
        _delegateQueue.maxConcurrentOperationCount = 1;
        _delegateQueue.underlyingQueue = _queue;
        _states = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsObjectPointerPersonality | NSPointerFunctionsStrongMemory
                                        valueOptions:NSPointerFunctionsStrongMemory];
        _session = [self makeSession];
        _generation = 1;
    }
    return self;
}

- (NSURLSession *)makeSession {
    return [NSURLSession sessionWithConfiguration:_configuration delegate:self delegateQueue:_delegateQueue];
}

- (NSURLSession *)session {
    @synchronized(self) {
        return _session;
    }
}

- (NSUInteger)sessionGeneration {
    @synchronized(self) {
        return _generation;
    }
}

- (NSUInteger)invalidatedSessionCount {
    @synchronized(self) {
        return _invalidated;
    }
}

- (void)resetSession {
    NSURLSession *old;
    @synchronized(self) {
        old = _session;
        _session = [self makeSession];
        _generation += 1;
    }
    [old finishTasksAndInvalidate];
}

#pragma mark - Requests

- (void)requestWithMethod:(NSString *)method
                      url:(NSString *)url
                  headers:(NSArray<NSString *> *)headers
                     body:(NSString *)body
                timeoutMs:(NSInteger)timeoutMs
               completion:(ESPCompletion)completion {
    NSURL *parsed = [NSURL URLWithString:url];
    NSString *scheme = parsed.scheme.lowercaseString;
    NSString *upper = method.uppercaseString;
    BOOL bodyAllowed = ![upper isEqualToString:@"GET"] && ![upper isEqualToString:@"HEAD"];
    if (parsed == nil || parsed.host.length == 0 || !([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"]) ||
        upper.length == 0 || headers.count % 2 != 0 || (body != nil && !bodyAllowed)) {
        completion(nil, ESPErrorInvalidRequest);
        return;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:parsed];
    request.HTTPMethod = upper;
    request.HTTPShouldHandleCookies = NO;
    request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    for (NSUInteger i = 0; i < headers.count; i += 2) {
        [request setValue:headers[i + 1] forHTTPHeaderField:headers[i]]; // replaces: the last value wins
    }
    if (body != nil) {
        request.HTTPBody = [body dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:YES];
    } else if (bodyAllowed) {
        request.HTTPBody = [NSData data];
    }
    NSInteger limitMs = timeoutMs > 0 ? timeoutMs : ESPDefaultTimeoutMs;

    ESPTaskState *state = [[ESPTaskState alloc] init];
    state.completion = completion;
    state.data = [NSMutableData data];
    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request];
    dispatch_async(_queue, ^{
        [self->_states setObject:state forKey:task];
        [task resume];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)limitMs * NSEC_PER_MSEC), self->_queue, ^{
            if (!state.finished) {
                state.timedOut = YES;
                [task cancel];
            }
        });
    });
}

/// Settles a request once, on the client's queue.
- (void)finish:(ESPTaskState *)state task:(NSURLSessionTask *)task result:(ESPHttpResult *)result code:(NSString *)code {
    if (state.finished) return;
    state.finished = YES;
    [_states removeObjectForKey:task];
    ESPCompletion completion = state.completion;
    state.completion = nil;
    if (completion) completion(result, code);
}

#pragma mark - NSURLSessionDelegate

- (void)URLSession:(NSURLSession *)session didBecomeInvalidWithError:(NSError *)error {
    @synchronized(self) {
        _invalidated += 1;
    }
}

- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *_Nullable))completionHandler {
    completionHandler(nil); // a redirect is returned to the JavaScript as it is, never followed
}

- (void)URLSession:(NSURLSession *)session
              dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveResponse:(NSURLResponse *)response
     completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    ESPTaskState *state = [_states objectForKey:dataTask];
    if (state != nil) {
        state.response = [response isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)response : nil;
        if (response.expectedContentLength > 0 && (unsigned long long)response.expectedContentLength > ESPMaxResponseBytes) {
            state.tooLarge = YES;
            completionHandler(NSURLSessionResponseCancel);
            return;
        }
    }
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveData:(NSData *)data {
    ESPTaskState *state = [_states objectForKey:dataTask];
    if (state == nil || state.tooLarge) return;
    if (state.data.length + data.length > ESPMaxResponseBytes) {
        state.tooLarge = YES;
        state.data = [NSMutableData data]; // never held in full
        [dataTask cancel];
        return;
    }
    [state.data appendData:data];
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
 willCacheResponse:(NSCachedURLResponse *)proposedResponse
 completionHandler:(void (^)(NSCachedURLResponse *_Nullable))completionHandler {
    completionHandler(nil);
}

- (void)URLSession:(NSURLSession *)session
                   task:(NSURLSessionTask *)task
    didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
      completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *_Nullable))completionHandler {
    id<ESPChallengeHandler> handler = self.challengeHandler;
    if (handler == nil || ![challenge.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust]) {
        completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
        return;
    }
    NSURLCredential *credential = nil;
    NSString *code = nil;
    switch ([handler decideForChallenge:challenge credential:&credential code:&code]) {
        case ESPChallengeDecisionUseCredential:
            completionHandler(NSURLSessionAuthChallengeUseCredential, credential);
            break;
        case ESPChallengeDecisionCancel: {
            ESPTaskState *state = [_states objectForKey:task];
            state.challengeCode = code ?: ESPErrorTls;
            completionHandler(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
            break;
        }
        default:
            completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    }
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    ESPTaskState *state = [_states objectForKey:task];
    if (state == nil) return;
    if (error != nil || state.tooLarge || state.timedOut) {
        [self finish:state task:task result:nil code:ESPCodeForError(error, state)];
        return;
    }
    NSHTTPURLResponse *response = state.response;
    if (response == nil) {
        [self finish:state task:task result:nil code:ESPErrorUnknown];
        return;
    }
    NSString *retryAfter = [response valueForHTTPHeaderField:@"Retry-After"] ?: @"";
    ESPHttpResult *result = [[ESPHttpResult alloc] initWithStatus:response.statusCode
                                                       statusText:@""
                                                       retryAfter:retryAfter
                                                             body:ESPDecodeUtf8(state.data)];
    [self finish:state task:task result:result code:nil];
}

@end
