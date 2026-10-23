/**
 * Config of the notification service extension for `@bacons/apple-targets`.
 *
 * Put this file and `NotificationService.swift` in `targets/notification-service/` of your app, add
 * `"@bacons/apple-targets"` to the `plugins` of your app config, and set `ios.appleTeamId` and
 * `ios.bundleIdentifier` there. Version 4.x of the package is for Expo SDK 54, 5.x for Expo SDK 55 and newer.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "notification-service",
  // The extension only downloads an image and attaches it: no app group and no capability is needed.
  entitlements: {},
});
