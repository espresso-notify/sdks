/**
 * Images in a push with the app open, on Android.
 *
 * With the app closed or in the background Android's FCM client draws the push itself, and a push that has an
 * image gets the large expandable picture. With the app open `expo-notifications` draws it, and it only
 * has a thumbnail (`setLargeIcon`). This module draws the large picture with `react-native-notify-kit`
 * in that one case, and tells `expo-notifications` not to draw the push again. Everything else (iOS,
 * a push without an image, an app without notify-kit) is left to `expo-notifications` as it was.
 *
 * Nothing here runs unless the app wraps its notification handler with `createNotificationHandler`.
 */
/**
 * The push data of an expo-notifications content, as the SDK reads it everywhere else: `data`, with the keys of
 * the JSON the Expo push service wraps in `body` (and `dataString`) merged in; a key at the top level wins.
 * A copy of `_unwrapPushData` in `index.ts`, which imports this module and so cannot be imported here.
 */
export declare function unwrapPushData(content: any): Record<string, unknown>;
/**
 * The https URL of the image of a push, from an expo-notifications notification, or undefined. The shapes, in the
 * order they are tried (the first one that holds an https URL wins):
 *  1. `request.trigger.remoteMessage.notification.imageUrl` (Android: the FCM message the Expo push service sends),
 *  2. `data.body._richContent.image` (the body the Expo push service wraps, an object or a JSON string),
 *  3. `data._richContent.image`, 4. `data.richContent.image`, 5. `data.image`, 6. `data.fcm_options.image`.
 * The values `_richContent`, `richContent` and `fcm_options` may be objects or JSON strings. Never throws.
 */
export declare function pickPushImage(notification: any): string | undefined;
/** What `expo-notifications` asks a notification handler for (the old `shouldShowAlert` and the two that replace it). */
export interface NotificationBehaviorLike {
    shouldShowBanner?: boolean;
    shouldShowList?: boolean;
    /** Deprecated in expo-notifications, still honored by older versions. */
    shouldShowAlert?: boolean;
    shouldPlaySound?: boolean;
    shouldSetBadge?: boolean;
    [key: string]: unknown;
}
/** The `handleNotification` of `Notifications.setNotificationHandler`. */
export type NotificationHandlerFn<B extends NotificationBehaviorLike = NotificationBehaviorLike> = (notification: any) => Promise<B> | B;
/** What the wrapped handler returns when the app has none: every field `expo-notifications` requires, set. */
export interface DefaultNotificationBehavior extends NotificationBehaviorLike {
    shouldShowBanner: boolean;
    shouldShowList: boolean;
    shouldPlaySound: boolean;
    shouldSetBadge: boolean;
}
export interface ImagePushOptions {
    /**
     * Draw the large picture with `react-native-notify-kit` when the app is open on Android. Default: **true**.
     * `false` leaves every push to expo-notifications, as if the handler were not wrapped.
     */
    bigPicture?: boolean;
    /**
     * The name of the Android drawable used as the small icon of the notification that notify-kit draws, tried before
     * `notification_icon` (the icon the config plugin of expo-notifications generates) and `ic_launcher`.
     */
    smallIcon?: string;
    /**
     * Register the listeners of notify-kit (the foreground and background events and the launch notification) so the
     * taps on the pictures reach the client. Default: **true**. `false` is for an app that handles notify-kit itself:
     * it forwards the events with `handleImagePushBackgroundEvent` and `handleImagePushInitialNotification`.
     */
    installListeners?: boolean;
}
/** The marker the SDK puts in the `data` of a notification it draws, and the key that holds the original data as JSON. */
export declare const IMAGE_PUSH_MARKER = "_espressoImage";
export declare const IMAGE_PUSH_DATA_KEY = "_espressoData";
/**
 * Wraps the notification handler of the app so a push with an image shows the large picture on Android with the app
 * open. Use it where you call `Notifications.setNotificationHandler`:
 *
 *     Notifications.setNotificationHandler({ handleNotification: createNotificationHandler(myHandler) })
 *
 * It calls `userHandler` (when there is none, it shows the push with no sound and no badge). If the app chose to show
 * the notification, the platform is Android, the push has an https image and `react-native-notify-kit` is installed,
 * notify-kit draws the notification with `AndroidStyle.BIGPICTURE` and the handler tells expo-notifications to draw
 * nothing, so the push shows once. In every other case the behavior of the app is returned unchanged, and a refusal
 * of notify-kit falls back to the thumbnail expo-notifications draws. With the app closed or in the background the
 * system draws the push and this code does not run. The taps on the notification this draws are reported as `opened`
 * by the client like any other.
 */
export declare function createNotificationHandler(userHandler?: undefined, options?: ImagePushOptions): (notification: any) => Promise<DefaultNotificationBehavior>;
export declare function createNotificationHandler<B extends NotificationBehaviorLike>(userHandler: NotificationHandlerFn<B>, options?: ImagePushOptions): (notification: any) => Promise<B>;
/** A tap on a notification the SDK drew. The same shape as `OpenedInfo` of `index.ts`, which takes it as is. */
export interface ImagePushOpenedInfo {
    notificationId?: string | number;
    /** `default` for the notification itself, the id of the button otherwise. */
    actionId?: string;
    /** The push data the app sent, as it was before the SDK drew the notification. */
    data?: Record<string, unknown>;
    /** True for a tap that came before any client existed (the app was being launched). */
    coldStart?: boolean;
}
/** The events of notify-kit. */
type NotifyKitEvent = {
    type?: number;
    detail?: any;
};
/**
 * Subscribes to the taps on notifications the SDK drew; `ExpoDisplayAdapter` does it for the client. A tap that came
 * before any subscriber is handed to the first one, once, with `coldStart` true. Returns the unsubscribe.
 */
export declare function subscribeImagePushTaps(listener: (info: ImagePushOpenedInfo) => void): () => void;
/**
 * For an app that registers its own `onBackgroundEvent` in notify-kit (only one handler exists, and the last one
 * registered wins): call this with the event from inside it, so the taps on the push images are still reported.
 * Any event of notify-kit can be passed, the foreground ones too; whatever is not a tap on a notification of the SDK is ignored.
 */
export declare function handleImagePushBackgroundEvent(event: NotifyKitEvent): Promise<void>;
/**
 * For an app that reads `getInitialNotification()` of notify-kit itself: pass what it returned. A notification the
 * SDK drew is reported as a tap with `coldStart` and the function returns true; for any other (or null) it returns
 * false and the app handles it.
 */
export declare function handleImagePushInitialNotification(initial: any): boolean;
/**
 * The notification that launched the app, when it is not one the SDK drew: use it where you called notify-kit's
 * `getInitialNotification()`. notify-kit hands that notification out once and the SDK reads it first when it installed
 * its listeners, so a second reader gets null. Like notify-kit it returns the notification once, then null. A launch
 * notification of the SDK is reported as a tap and this returns null for it. Without notify-kit it returns null.
 */
export declare function getForeignInitialNotification(): Promise<any>;
/**
 * Starts listening to notify-kit for the taps on the notifications the SDK draws: the foreground and background
 * events and the notification that launched the app. Safe to call again; does nothing without notify-kit. It
 * registers the one `onBackgroundEvent` handler of notify-kit (replacing one the app registered earlier, so an app
 * that has its own registers it after this and forwards, or passes `installListeners: false`), and reads (so
 * consumes) `getInitialNotification()` once: a launch notification that is not the SDK's is kept for `getForeignInitialNotification()`.
 */
export declare function installImagePush(): void;
export {};
