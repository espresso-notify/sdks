// The native transport of the Espresso Notify SDK as a React Native module (sdk-private-transport, design "iOS").
// Objective-C++ on purpose: a Swift pod that imports the React pods would force `use_frameworks!` or modular headers on the
// integrator's Podfile (owner decision D-5). The module is a transport and nothing else; the code that does the work is
// the React-free core in `../EspressoNotifyTransportCore`.
#import <Foundation/Foundation.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <EspressoNotifyTransportSpec/EspressoNotifyTransportSpec.h>
@interface EspressoNotifyTransport : NSObject <NativeEspressoNotifyTransportSpec>
#else
#import <React/RCTBridgeModule.h>
@interface EspressoNotifyTransport : NSObject <RCTBridgeModule>
#endif
@end
