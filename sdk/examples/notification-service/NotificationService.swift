// Notification Service Extension for iOS: shows the image of a push.
//
// iOS draws the image of a push only when an app extension downloads it and attaches it to the notification.
// This extension finds the https URL of the image in the shapes the Espresso Notify server sends, downloads the
// file and attaches it. The banner shows a thumbnail, and a long press shows the large image.
//
// Where the URL is, in the order this file tries it (the first https URL wins):
//   userInfo["body"]["_richContent"]["image"]   push sent to an Expo push token (the Expo push service wraps it)
//   userInfo["_richContent"]["image"]
//   userInfo["richContent"]["image"]
//   userInfo["image"]                           push sent to a raw APNs token (device mode)
//   userInfo["fcm_options"]["image"]            push sent to a raw FCM token (an object, or JSON text)
//
// The push must be mutable for iOS to run the extension; the Espresso Notify server sets that when a push has an
// image. iOS attaches JPEG, PNG and GIF (WebP is not attached), so the file must be one of them.
//
// This file is generic. Copy it into the extension of your app (with `@bacons/apple-targets`, the folder
// `targets/notification-service/`), together with `expo-target.config.js`.

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttemptContent: UNMutableNotificationContent?
  private var downloadTask: URLSessionDownloadTask?

  // iOS may call serviceExtensionTimeWillExpire while the download still runs: the handler must run exactly once.
  private let lock = NSLock()
  private var finished = false

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let content = request.content.mutableCopy() as? UNMutableNotificationContent
    bestAttemptContent = content

    guard let content = content, let url = NotificationService.imageURL(from: request.content.userInfo) else {
      finish(request.content)
      return
    }
    download(url, into: content)
  }

  override func serviceExtensionTimeWillExpire() {
    // Called just before iOS ends the extension (about 30 seconds): deliver what there is, without the image.
    downloadTask?.cancel()
    if let content = bestAttemptContent { finish(content) }
  }

  // MARK: - Delivery

  /// Calls the content handler once; any later call is ignored.
  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    defer { lock.unlock() }
    guard !finished, let handler = contentHandler else { return }
    finished = true
    handler(content)
  }

  private func download(_ url: URL, into content: UNMutableNotificationContent) {
    var request = URLRequest(url: url)
    request.timeoutInterval = 20 // well under the time iOS gives the extension
    let task = URLSession.shared.downloadTask(with: request) { [weak self] file, response, error in
      guard let self = self else { return }
      defer { self.finish(content) } // with or without the image, the push is delivered
      guard error == nil, let file = file,
        let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
        let attachment = NotificationService.attachment(
          downloaded: file, mimeType: http.mimeType, pathExtension: url.pathExtension)
      else { return }
      content.attachments = [attachment]
    }
    downloadTask = task
    task.resume()
  }

  // MARK: - Pure helpers (also what the local test program exercises)

  /// The https URL of the image of a push, or nil. See the top of the file for the shapes and the order.
  static func imageURL(from userInfo: [AnyHashable: Any]) -> URL? {
    let body = dictionary(userInfo["body"])
    let candidates: [Any?] = [
      dictionary(body?["_richContent"])?["image"],
      dictionary(userInfo["_richContent"])?["image"],
      dictionary(userInfo["richContent"])?["image"],
      userInfo["image"],
      dictionary(userInfo["fcm_options"])?["image"],
    ]
    for candidate in candidates {
      if let text = candidate as? String, let url = httpsURL(text) { return url }
    }
    return nil
  }

  /// The file extension iOS accepts for this answer, or nil for a type iOS does not attach. The type of the answer
  /// decides; a server that answers `application/octet-stream` or no type falls back to the extension of the URL.
  static func attachmentExtension(mimeType: String?, pathExtension: String) -> String? {
    let type = mimeType?.lowercased()
    switch type {
    case "image/jpeg", "image/jpg": return "jpg"
    case "image/png": return "png"
    case "image/gif": return "gif"
    case nil, "application/octet-stream":
      switch pathExtension.lowercased() {
      case "jpg", "jpeg": return "jpg"
      case "png": return "png"
      case "gif": return "gif"
      default: return nil
      }
    default: return nil
    }
  }

  /// Moves the downloaded file to a name with the right extension (iOS reads the type from it) and builds the
  /// attachment. Nil when the type is refused or iOS refuses the file. iOS moves the file into its own storage.
  static func attachment(downloaded file: URL, mimeType: String?, pathExtension: String) -> UNNotificationAttachment? {
    guard let ext = attachmentExtension(mimeType: mimeType, pathExtension: pathExtension) else { return nil }
    let target = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension(ext)
    do {
      try FileManager.default.moveItem(at: file, to: target)
      return try UNNotificationAttachment(identifier: "image", url: target, options: nil)
    } catch {
      return nil
    }
  }

  private static func httpsURL(_ text: String) -> URL? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else {
      return nil
    }
    return url
  }

  /// A dictionary, or the dictionary a JSON text holds.
  private static func dictionary(_ value: Any?) -> [String: Any]? {
    if let dict = value as? [String: Any] { return dict }
    if let dict = value as? [AnyHashable: Any] {
      return Dictionary(uniqueKeysWithValues: dict.compactMap { key, value in (key as? String).map { ($0, value) } })
    }
    if let text = value as? String, let data = text.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    {
      return parsed
    }
    return nil
  }
}
