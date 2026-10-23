# The native transport of the Espresso Notify SDK for iOS (sdk-private-transport). React Native autolinking finds this file
# at the root of the package, so the app's Podfile needs no line for it. Objective-C and Objective-C++ only, so it builds
# with and without `use_frameworks!`. The React and codegen dependencies come from `install_modules_dependencies`; the pod
# declares none of its own and links `Security` only.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "EspressoNotifyTransport"
  s.version      = package["version"]
  s.summary      = "Native HTTP transport of the Espresso Notify React Native SDK."
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => package["repository"]["url"].sub("git+", ""), :tag => "v#{s.version}" }

  s.source_files = "ios/Sources/**/*.{h,m,mm}"
  # The core headers import Foundation only; the module header imports React and stays private to the pod.
  s.public_header_files = "ios/Sources/EspressoNotifyTransportCore/include/*.h"
  s.frameworks   = "Security"
  s.requires_arc = true

  install_modules_dependencies(s)
end
