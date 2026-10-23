/** One button of a notification, as the push carries it. */
export interface PushAction {
  /** The id the worker learns when the button is pressed. */
  action: string;
  title: string;
  /** Where the button goes; the link of the notification when it has none. */
  url?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  image?: string;
  url?: string;
  notificationId?: number;
  /** The buttons of the notification, up to 3. */
  actions?: PushAction[];
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag?: string;
  /** The monochrome icon the system shows in its status bar. */
  badge?: string;
  /** The number the worker puts on the icon of an installed app. */
  badgeCount?: number;
}

import { SW_PATH, SW_SCOPE } from "./swDefaults";
import { EspressoNotifyError, EspressoNotifyHttpError } from "./errors";
import { RegistrationParts, RegistrationTracker } from "./registration";
import { readRetryAfter, withRetry } from "./retry";
import { ConsentInfo, NotificationPreference, isValidEventName, validateConsent, validatePreferences } from "./privacy";
import {
  PermissionState,
  SubscribeError,
  SubscribeResult,
  SupportInfo,
  getPermissionState,
  getSupport,
  isSupported,
  requestPermission,
} from "./support";

export { getPermissionState, getSupport, isSupported, requestPermission, SubscribeError };
export { EspressoNotifyError, EspressoNotifyHttpError, isValidEventName, validatePreferences };
export type { ConsentInfo, NotificationPreference };
export type { PermissionState, SubscribeFailureReason, SubscribeResult, SupportInfo, UnsupportedReason } from "./support";

const API_URL = "__ESPRESSO_API_URL__";

// The IANA time zone of the browser ("America/Sao_Paulo"), or undefined where the browser cannot say.
// The subscription carries it so quiet hours and delivery_mode can use the local clock of the visitor.
function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone ? zone : undefined;
  } catch {
    return undefined;
  }
}

export interface IdentifyOptions {
  name?: string;
  identityHash?: string;
}

export interface SubscribeOptions {
  /**
   * The record of the accept of the visitor: the version of the text they saw and where they accepted it. The API
   * stores it, with the time of the server, on the subscription. Pass it only when the visitor accepted; without it
   * nothing is recorded and a stored record is kept.
   */
  consent?: ConsentInfo;
}

export interface WebPushClientOptions {
  projectId: string;
  swPath?: string;
  swScope?: string;
  /**
   * The version of your site or app. A new value makes the next page load post the subscription again (and identify
   * again), so the server learns what changed. Optional.
   */
  appVersion?: string;
}

export class WebPushClient {
  private projectId: string;
  private apiUrl: string;
  private vapidPublicKey = "";
  private swPath: string;
  private swScope: string;
  private appVersion: string | undefined;
  private registration: ServiceWorkerRegistration | null = null;
  private subscription: PushSubscription | null = null;
  private tracker: RegistrationTracker | null = null;

  constructor(options: WebPushClientOptions) {
    // A secret key (sk_...) in a page is published to every visitor of it. The API refuses it from a browser
    // too (403 secret_key_in_browser); the client refuses to be built with it at all.
    if (typeof options.projectId === "string" && options.projectId.startsWith("sk_")) {
      throw new Error(
        "Security alert: a secret key (sk_...) cannot be used in the browser. Use the public key (pk_...) of the project.",
      );
    }
    this.projectId = options.projectId;
    this.apiUrl = API_URL;
    this.swPath = options.swPath ?? SW_PATH;
    this.swScope = options.swScope ?? SW_SCOPE;
    this.appVersion = typeof options.appVersion === "string" && options.appVersion ? options.appVersion : undefined;
  }

  // What the browser remembers of the calls that worked (src/registration.ts): the subscription and identify are
  // posted again only when something changed or a new session starts. Made on first use.
  private get registrationTracker(): RegistrationTracker {
    if (!this.tracker) {
      this.tracker = new RegistrationTracker({
        key: `espresso-notify:registration:${this.projectId}`,
        projectKey: this.projectId,
        appVersion: this.appVersion,
      });
    }
    return this.tracker;
  }

  // The state of a subscription that the fingerprint is made of (never stored in clear).
  private registrationParts(subscription: PushSubscription): RegistrationParts {
    const sub = subscription.toJSON();
    return {
      endpoint: sub.endpoint ?? subscription.endpoint,
      p256dh: sub.keys?.p256dh,
      auth: sub.keys?.auth,
      vapidKey: this.keyOf(subscription),
      timezone: browserTimeZone(),
    };
  }

  private get headers(): HeadersInit {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.projectId}`,
    };
  }

  /** Whether this browser can do Web Push. Same as the exported `isSupported()`. */
  isSupported(): boolean {
    return isSupported();
  }

  /** Whether this browser can do Web Push and, when it cannot, why (for example `ios_requires_installed_app`). */
  getSupport(): SupportInfo {
    return getSupport();
  }

  /** `default`, `granted`, `denied` or `unsupported`. Does not prompt. */
  getPermissionState(): PermissionState {
    return getPermissionState();
  }

  /**
   * Prompts for the permission and returns the state afterwards. Call it from a user gesture
   * (a click on "Enable notifications"); never on page load.
   */
  requestPermission(): Promise<PermissionState> {
    return requestPermission();
  }

  /** The subscription of this browser, or `null` when it has none. Does not prompt or register anything. */
  async getSubscription(): Promise<PushSubscription | null> {
    if (this.subscription) return this.subscription;
    if (!isSupported()) return null;
    const registration = await navigator.serviceWorker.getRegistration(this.swScope);
    return (await registration?.pushManager.getSubscription()) ?? null;
  }

  /**
   * Subscribes this browser and says why when it cannot, instead of throwing. Call it from a user
   * gesture: when the permission is still `default` it asks for it first, and a browser only shows
   * that prompt for a click or a tap. A `denied` permission is not asked again.
   */
  async trySubscribe(options: SubscribeOptions = {}): Promise<SubscribeResult> {
    const consentProblem = validateConsent(options.consent);
    if (consentProblem) return { ok: false, reason: "invalid_consent", message: consentProblem };
    const support = getSupport();
    if (!support.supported) return { ok: false, reason: "unsupported", message: support.reason };

    const state = getPermissionState();
    if (state === "denied") return { ok: false, reason: "permission_denied" };
    if (state === "default") {
      const asked = await requestPermission();
      if (asked === "denied") return { ok: false, reason: "permission_denied" };
      if (asked !== "granted") return { ok: false, reason: "permission_dismissed" };
    }

    try {
      await this.register(options.consent);
      return { ok: true };
    } catch (err) {
      if (err instanceof SubscribeError) return { ok: false, reason: err.reason, message: err.message };
      return { ok: false, reason: "server_error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Subscribes this browser. Resolves `false` when the browser has no service worker and throws on any other failure. */
  async subscribe(options: SubscribeOptions = {}): Promise<boolean> {
    const consentProblem = validateConsent(options.consent);
    if (consentProblem) throw new SubscribeError("invalid_consent", consentProblem);
    if (!("serviceWorker" in navigator)) {
      return false;
    }
    try {
      await this.register(options.consent);
    } catch (err) {
      // subscribe() has always thrown what the browser raised; keep doing that.
      throw err instanceof SubscribeError && err.original !== undefined ? err.original : err;
    }
    return true;
  }

  // The steps of a subscription, in the order the browser needs them. A failure throws a
  // SubscribeError that names the step; `subscribe()` lets it through and `trySubscribe()` turns it
  // into a result.
  private async register(consent?: ConsentInfo): Promise<void> {
    try {
      this.registration = await navigator.serviceWorker.register(this.swPath, { scope: this.swScope });
    } catch (err) {
      throw new SubscribeError("no_service_worker", err instanceof Error ? err.message : String(err), err);
    }
    const existing = await this.registration.pushManager.getSubscription();
    // A run of the service worker that could not finish left the endpoint the API still holds.
    const pending = (await readState()).pendingReplace;
    // A browser the API already knows in this session needs no call at all, and the key of the project is not read
    // either (a rotation of the key is noticed in the next session). A consent record, or an endpoint to replace, is
    // always sent.
    if (existing && !consent && !(typeof pending === "string" && pending && pending !== existing.endpoint)) {
      if (!(await this.registrationTracker.plan("register", this.registrationParts(existing)))) {
        this.subscription = existing;
        if (this.projectId.startsWith("pk_")) await writeState({ projectKey: this.projectId, endpoint: existing.endpoint });
        return;
      }
    }
    const serverKey = await this.currentVapidKey(existing !== null);
    let replaces: string | undefined;
    if (existing) {
      this.subscription = existing;
      // The key the browser subscription was made with is part of it. After a rotation of the project's
      // VAPID keys it is not the current key any more: the subscription is moved to the new one, and the
      // server hands what the old one had (the linked user, the metadata) to the new one.
      const bound = this.keyOf(existing);
      if (serverKey && bound && !this.sameKey(bound, serverKey)) {
        this.subscription = await this.moveToKey(existing, serverKey);
        if (this.subscription.endpoint !== existing.endpoint) replaces = existing.endpoint;
      }
    } else {
      const applicationServerKey = this.urlBase64ToUint8Array(serverKey as string);
      try {
        this.subscription = await this.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
        });
      } catch (err) {
        const denied = err instanceof Error && err.name === "NotAllowedError";
        throw new SubscribeError(denied ? "permission_denied" : "server_error", err instanceof Error ? err.message : String(err), err);
      }
    }

    // The endpoint the API still holds wins over the one this call moved from: the second may be a
    // subscription the worker made that the API never heard of.
    if (typeof pending === "string" && pending && pending !== this.subscription.endpoint) replaces = pending;
    const sub = this.subscription.toJSON();
    const usedKey = this.keyOf(this.subscription);
    const ticket = await this.registrationTracker.plan("register", this.registrationParts(this.subscription), {
      force: Boolean(consent) || replaces !== undefined,
    });
    if (ticket) {
      try {
        // Tried again when the failure can pass (no answer, 408, 429, 5xx), with a full-jitter wait or the Retry-After of the server.
        await this.request(
          "/v1/web-push/subscribe",
          {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify({
              endpoint: sub.endpoint,
              p256dh: sub.keys?.p256dh,
              auth: sub.keys?.auth,
              timezone: browserTimeZone(),
              vapid_public_key: usedKey || undefined,
              replaces_endpoint: replaces,
              ...(consent ? { consent: { ...(consent.version !== undefined ? { version: consent.version } : {}), ...(consent.source !== undefined ? { source: consent.source } : {}) } } : {}),
            }),
          },
          (status, body) => body.error ?? `Subscribe failed with status ${status}`,
        );
      } catch (err) {
        if (err instanceof EspressoNotifyHttpError) throw new SubscribeError("server_error", err.message);
        throw err;
      }
      await this.registrationTracker.commit(ticket);
    }
    if (this.projectId.startsWith("pk_")) await writeState({ projectKey: this.projectId, endpoint: this.subscription.endpoint });
  }

  // The current VAPID public key of the project. A browser that has no subscription cannot subscribe
  // without it, so a failure to read it throws; a browser that already has one goes on with what it
  // has (null), because a subscription that cannot be moved is still a working subscription.
  private async currentVapidKey(hasSubscription: boolean): Promise<string | null> {
    const missing = "Failed to fetch VAPID key — check that web push is configured in the dashboard";
    try {
      let res: { json: () => Promise<any> };
      if (hasSubscription) {
        // This browser goes on without the key, so it does not wait for it.
        const answer = await fetch(`${this.apiUrl}/v1/web-push/vapid-key`, { headers: this.headers });
        if (!answer.ok) throw new SubscribeError("vapid_key_missing", missing);
        res = answer;
      } else {
        try {
          res = await this.request("/v1/web-push/vapid-key", { headers: this.headers }, () => missing);
        } catch (err) {
          throw err instanceof EspressoNotifyHttpError ? new SubscribeError("vapid_key_missing", err.message) : err;
        }
      }
      const data = await res.json();
      if (!data?.vapid_public_key) throw new SubscribeError("vapid_key_missing", "The project has no VAPID key — check that web push is configured in the dashboard");
      this.vapidPublicKey = data.vapid_public_key;
      return this.vapidPublicKey;
    } catch (err) {
      if (!hasSubscription) throw err;
      return null;
    }
  }

  // The public key a browser subscription was made with (its applicationServerKey) as base64url, or ""
  // when the browser does not say.
  private keyOf(subscription: PushSubscription): string {
    try {
      const raw = subscription.options?.applicationServerKey;
      if (!raw) return "";
      const bytes = new Uint8Array(raw as ArrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch {
      return "";
    }
  }

  private sameKey(a: string, b: string): boolean {
    return a.replace(/=+$/, "") === b.replace(/=+$/, "");
  }

  // Replaces the subscription with one made with the given key. A browser refuses to subscribe with another
  // key while a subscription exists, so the old one goes first. When the old one cannot be dropped, nothing
  // changed. When the new one cannot be made, the old key is used again, so the browser is not left without
  // a subscription (it gets a new endpoint, which the server links to the old one); only when that fails too
  // does the call fail.
  private async moveToKey(existing: PushSubscription, key: string): Promise<PushSubscription> {
    const manager = (this.registration as ServiceWorkerRegistration).pushManager;
    const oldKey = existing.options?.applicationServerKey ?? null;
    try {
      await existing.unsubscribe();
    } catch {
      return existing;
    }
    try {
      return await manager.subscribe({ userVisibleOnly: true, applicationServerKey: this.urlBase64ToUint8Array(key).buffer as ArrayBuffer });
    } catch (err) {
      if (oldKey) {
        try {
          return await manager.subscribe({ userVisibleOnly: true, applicationServerKey: oldKey });
        } catch {}
      }
      throw new SubscribeError("server_error", err instanceof Error ? err.message : String(err), err);
    }
  }

  /**
   * Links this browser to a user of your app. `externalId` is your own id for
   * the user (the same value you pass to the React Native SDK); the numeric id
   * Espresso Notify keeps internally is never needed.
   *
   * `identityHash` is HMAC-SHA256(externalId, project secret) as lower-case hex,
   * computed by YOUR backend. Send it when the project verifies identities.
   */
  async identify(externalId: string, options: IdentifyOptions = {}): Promise<void> {
    if (!this.subscription) return;
    // The same user, name and proof, on the same subscription, in the same session: the server already has them.
    const ticket = await this.registrationTracker.plan("identify", {
      ...this.registrationParts(this.subscription),
      userId: externalId,
      userName: options.name || null,
      identityHash: options.identityHash || null,
    });
    if (!ticket) return;
    await this.postSubscription(
      {
        external_id: externalId,
        ...(options.name ? { name: options.name } : {}),
        ...(options.identityHash ? { identity_hash: options.identityHash } : {}),
      },
      "Identify",
      true,
    );
    await this.registrationTracker.commit(ticket);
  }

  async updateMetadata(metadata: Record<string, unknown>): Promise<void> {
    await this.postSubscription({ metadata }, "UpdateMetadata");
  }

  // Re-posts this browser's subscription with extra fields. The backend keeps
  // every field the request leaves out, so each call only changes what it sends.
  // `retry` tries the call again when the failure can pass (identify); updateMetadata is sent once.
  private async postSubscription(extra: Record<string, unknown>, action: string, retry = false): Promise<void> {
    if (!this.subscription) return;
    const sub = this.subscription.toJSON();
    try {
      await this.request(
        "/v1/web-push/subscribe",
        {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({
            endpoint: sub.endpoint,
            p256dh: sub.keys?.p256dh,
            auth: sub.keys?.auth,
            timezone: browserTimeZone(),
            ...extra,
          }),
        },
        (status, body) => body.error ?? `${action} failed with status ${status}`,
        retry,
      );
    } catch (err) {
      if (err instanceof EspressoNotifyHttpError) throw new Error(err.message);
      throw err;
    }
  }

  // One call to the API. An answer outside 2xx rejects with EspressoNotifyHttpError (the message is `describe(status,
  // body)`, the Retry-After of the answer is kept); a request that got no answer rejects with the error the browser
  // raised, marked `network`. With `retry` the call is tried again when the failure can pass: no answer, 408, 429, 5xx
  // (src/retry.ts); any other 4xx is final.
  private request(
    path: string,
    init: RequestInit,
    describe: (status: number, body: { error?: string; code?: string }) => string,
    retry = true,
  ): Promise<Response> {
    return withRetry(
      async () => {
        let res: Response;
        try {
          res = await fetch(`${this.apiUrl}${path}`, init);
        } catch (err) {
          if (err instanceof Error) Object.assign(err, { network: true });
          throw err;
        }
        if (!res.ok) {
          const body = ((await res.json().catch(() => ({}))) ?? {}) as { error?: string; code?: string };
          throw new EspressoNotifyHttpError(describe(res.status, body), res.status, body.code ?? body.error, path, readRetryAfter(res));
        }
        return res;
      },
      retry ? {} : { attempts: 1 },
    );
  }

  async unsubscribe(): Promise<void> {
    if (!this.subscription) return;
    const endpoint = this.subscription.endpoint;
    await this.subscription.unsubscribe();
    await writeState(undefined);
    await this.registrationTracker.forget();
    await fetch(`${this.apiUrl}/v1/web-push/subscribe`, {
      method: "DELETE",
      headers: this.headers,
      body: JSON.stringify({ endpoint }),
    });
    this.subscription = null;
  }

  /**
   * Erases this browser and its data from Espresso Notify: the subscription, its delivery records, the events
   * stored under it and the user (external id and name) when no other device of the user is left. It is the call
   * behind a "delete my data" button (LGPD, GDPR) and cannot be undone. Only after the API confirmed does it drop
   * the record the service worker keeps and cancel the subscription of the browser, so a failed call can be tried
   * again.
   *
   * When the project asks for the proof of identity, pass `identityHash`: HMAC-SHA256(externalId, project secret)
   * as lower-case hex, computed by YOUR server. Rejects with `EspressoNotifyError` (`no_subscription`) without
   * calling the API when the browser has no subscription, and with `EspressoNotifyHttpError` (`status`, `code`)
   * on any answer outside 2xx, such as 404 `not_found` or 403 `identity_verification_failed`.
   */
  async forgetDevice(options: { identityHash?: string } = {}): Promise<void> {
    const subscription = await this.requireSubscription();
    const path = "/v1/web-push/device";
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "DELETE",
      headers: this.headers,
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        ...(options.identityHash ? { identity_hash: options.identityHash } : {}),
      }),
    });
    if (!res.ok) throw await this.httpError(res, path, "forgetDevice");
    await writeState(undefined);
    await this.registrationTracker.forget();
    try {
      await subscription.unsubscribe();
    } catch {
      // The API no longer knows the endpoint; a subscription the browser keeps cannot receive anything.
    }
    this.subscription = null;
  }

  /**
   * Reads the category opt-outs of the person this browser is linked to (`identify`). Rejects
   * `EspressoNotifyHttpError` 404 `user_not_found` when `identify` was never called, and `EspressoNotifyError`
   * (`no_subscription`) without calling the API when the browser has no subscription.
   */
  async getPreferences(): Promise<NotificationPreference[]> {
    const subscription = await this.requireSubscription();
    const result = await this.postJson("/v1/web-push/preferences/query", "getPreferences", { endpoint: subscription.endpoint });
    if (!Array.isArray(result)) return [];
    return result.map((p: { category_identifier?: string; opted_out?: boolean }) => ({
      categoryIdentifier: String(p?.category_identifier ?? ""),
      optedOut: p?.opted_out === true,
    }));
  }

  /**
   * Saves the category opt-outs of the person this browser is linked to: 1 to 50 items, each a
   * `categoryIdentifier` of 1 to 64 bytes and a boolean `optedOut`. The check runs before any call. The API
   * refuses a category that does not exist (`unknown_category`) or that cannot be left
   * (`category_not_opt_outable`). Resolves `{ updated }`. Needs `identify` first (404 `user_not_found` otherwise).
   */
  async setPreferences(preferences: NotificationPreference[]): Promise<{ updated: number }> {
    validatePreferences(preferences);
    const subscription = await this.requireSubscription();
    const result = (await this.postJson("/v1/web-push/preferences", "setPreferences", {
      endpoint: subscription.endpoint,
      preferences: preferences.map((p) => ({ category_identifier: p.categoryIdentifier, opted_out: p.optedOut })),
    })) as { updated?: unknown } | null;
    return { updated: typeof result?.updated === "number" ? result.updated : preferences.length };
  }

  /**
   * Reports a business event of the person this browser is linked to (`identify`): `order.completed`, `signed_up`.
   * The name is 1 to 64 letters, digits, `_`, `.`, `:` or `-`, starting with a letter or a digit, and not one of the
   * six names of the delivery lifecycle (opened, clicked, received, dismissed, converted, app_opened); an invalid
   * name sends nothing and logs a warning. The event is recorded for the person, and journeys and goals react to it
   * when the person also has a mobile device. Silent: it never throws, has no queue and no retry, so an event the
   * network or the API refuses (404 `unknown_device`, 429 `rate_limited`) is lost and shows only in the debug
   * console. Each call carries its own `event_id`, which protects only against the same request arriving twice.
   */
  async trackEvent(name: string): Promise<void> {
    if (!isValidEventName(name)) {
      console.warn(
        `[espresso-notify] trackEvent: ${JSON.stringify(name)} is not a valid event name and was not sent. ` +
          'Use 1 to 64 letters, digits, "_", ".", ":" or "-", starting with a letter or a digit, ' +
          "and not one of opened, clicked, received, dismissed, converted or app_opened.",
      );
      return;
    }
    try {
      const subscription = await this.getSubscription();
      if (!subscription) return;
      const res = await fetch(`${this.apiUrl}/v1/web-push/event`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ endpoint: subscription.endpoint, event: name, event_id: newEventId() }),
        keepalive: true,
      });
      if (!res.ok) await this.logRefusal(res, "trackEvent");
    } catch (err) {
      console.debug(`[espresso-notify] trackEvent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Reports that the visitor did what a notification was sent for (bought, signed up): the `converted` event, which
   * adds to the conversion count of that notification once for this browser, and only for a notification delivered
   * to it. It carries no amount: revenue is reported from your server with the secret key. Pass the numeric id of the
   * notification (a positive integer, or digits in a string); anything else sends nothing and logs a warning.
   * Silent: it never throws.
   */
  async trackConversion(notificationId: number | string): Promise<void> {
    const id = conversionNotificationId(notificationId);
    if (id === null) return;
    try {
      const subscription = await this.getSubscription();
      if (!subscription) return;
      const res = await fetch(`${this.apiUrl}/v1/notifications/track-web`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notification_id: id, event_type: "converted", endpoint: subscription.endpoint }),
        keepalive: true,
      });
      if (!res.ok) await this.logRefusal(res, "trackConversion");
    } catch (err) {
      console.debug(`[espresso-notify] trackConversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // What a fire-and-forget call leaves behind when the API refuses it: one line in the debug console.
  private async logRefusal(res: { status: number; json: () => Promise<unknown> }, action: string): Promise<void> {
    const error = await this.httpError(res, "", action);
    console.debug(`[espresso-notify] ${error.message}`);
  }

  // The subscription of this browser, or a rejection that says there is none.
  private async requireSubscription(): Promise<PushSubscription> {
    const subscription = await this.getSubscription();
    if (!subscription) throw new EspressoNotifyError("no_subscription", "This browser has no push subscription.");
    return subscription;
  }

  // POST of a JSON body to a route of the browser; resolves the JSON of the answer, rejects with EspressoNotifyHttpError.
  private async postJson(path: string, action: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}${path}`, { method: "POST", headers: this.headers, body: JSON.stringify(body) });
    if (!res.ok) throw await this.httpError(res, path, action);
    return res.json().catch(() => ({}));
  }

  // The error of an answer outside 2xx: the status, and the code (else the error) of the JSON body.
  private async httpError(res: { status: number; json: () => Promise<unknown> }, path: string, action: string): Promise<EspressoNotifyHttpError> {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { code?: unknown; error?: unknown } | null;
      const found = body?.code ?? body?.error;
      if (typeof found === "string" && found) code = found;
    } catch {}
    // A subscription with no user has nobody to read preferences of or to count an event for.
    const hint = code === "user_not_found" ? ". Call identify() first: this browser is not linked to a user" : "";
    return new EspressoNotifyHttpError(`${action} failed with status ${res.status}${code ? `: ${code}` : ""}${hint}`, res.status, code, path);
  }

  // Listen for push messages forwarded by the service worker.
  // Called when the page is open — use this to build your own notification UI
  // (notification inbox, badge counter, etc.) next to the system notification.
  // The system notification is always shown, also while the page is visible:
  // browsers require every push to produce one (`userVisibleOnly`), and Safari
  // revokes the subscription of a site that hides them.
  onPush(handler: (data: PushPayload) => void): () => void {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === "espresso:push") {
        handler(event.data.data as PushPayload);
      }
    };
    navigator.serviceWorker.addEventListener("message", listener);
    // Returns an unsubscribe function
    return () => navigator.serviceWorker.removeEventListener("message", listener);
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }
}

// The id of one trackEvent call: the API recognises a repeat of the same request by it (8 to 64 of A-Z a-z 0-9 _ -).
function newEventId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof random?.randomUUID === "function") return random.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

// A notification id the API can count: a positive integer, or the digits of one. Anything else is logged and dropped.
function conversionNotificationId(value: unknown): number | null {
  const id = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id >= 1) return id;
  console.warn(
    `[espresso-notify] trackConversion: ${JSON.stringify(value)} is not a notification id and was not sent. ` +
      "Pass the numeric id of the notification (a positive integer, or digits in a string).",
  );
  return null;
}

// What the service worker needs to subscribe again when the browser changes the subscription while the page
// is closed (src/sw.ts uses the same three names): the PUBLIC key of the project (pk_...) and the endpoint the
// API knows, and, after a failed run of the worker, the endpoint to send as replaces_endpoint. Nothing secret.
const STATE_DB = "espresso-notify";
const STATE_STORE = "state";
const STATE_KEY = "web-push";

interface WebPushState {
  projectKey?: string;
  endpoint?: string;
  pendingReplace?: string;
}

function openStateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STATE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STATE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readState(): Promise<WebPushState> {
  try {
    const db = await openStateDb();
    try {
      return await new Promise<WebPushState>((resolve, reject) => {
        const request = db.transaction(STATE_STORE, "readonly").objectStore(STATE_STORE).get(STATE_KEY);
        request.onsuccess = () => resolve(request.result && typeof request.result === "object" ? request.result : {});
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

// Replaces the record (a value of undefined erases it). Never throws: a browser without IndexedDB, a private
// window or a full disk only costs the worker its way to subscribe again.
async function writeState(next: WebPushState | undefined): Promise<void> {
  try {
    const db = await openStateDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STATE_STORE, "readwrite");
        if (next === undefined) tx.objectStore(STATE_STORE).delete(STATE_KEY);
        else tx.objectStore(STATE_STORE).put(next, STATE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {}
}
