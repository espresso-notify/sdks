import { WebPushClient, type PushPayload } from "@espresso-notify/web";
import "./style.css";

// The public key of the project, from the environment (see .env.example). A secret key (sk_) must
// never be here: this file is sent to every visitor.
const projectId = import.meta.env.VITE_ESPRESSO_PROJECT_ID as string | undefined;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from index.html`);
  return element as T;
};

const statusList = $<HTMLDListElement>("status");
const notice = $<HTMLParagraphElement>("notice");
const enableButton = $<HTMLButtonElement>("enable");
const disableButton = $<HTMLButtonElement>("disable");
const identifyForm = $<HTMLFormElement>("identify-form");
const identifyButton = $<HTMLButtonElement>("identify");
const externalIdInput = $<HTMLInputElement>("external-id");
const received = $<HTMLUListElement>("received");

const REASONS: Record<string, string> = {
  unsupported: "This browser cannot receive web push.",
  permission_denied: "Notifications are blocked for this site. Allow them in the site settings of the browser, then reload.",
  permission_dismissed: "The permission prompt was closed without an answer. Click the button again when you are ready.",
  no_service_worker: "The service worker could not be registered. Check that /push/espressonotify/espresso-notify-sw.js answers.",
  vapid_key_missing: "This project has no Web Push keys yet. Generate them in the dashboard, Web Push tab.",
  server_error: "The server did not accept the subscription.",
  ios_requires_installed_app: "On iPhone and iPad, add this page to the Home Screen (Share, then Add to Home Screen) and open it from there.",
};

function say(message: string): void {
  notice.textContent = message;
  notice.hidden = message === "";
}

function row(label: string, value: string): void {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  statusList.append(term, detail);
}

if (!projectId || projectId.includes("xxxx")) {
  say("Set VITE_ESPRESSO_PROJECT_ID to the public key (pk_) of your project in .env, then restart the dev server.");
  enableButton.disabled = true;
} else {
  start(new WebPushClient({ projectId }));
}

async function start(push: WebPushClient): Promise<void> {
  async function render(): Promise<void> {
    statusList.replaceChildren();
    const support = push.getSupport();
    row("Supported", support.supported ? "yes" : `no (${support.reason})`);
    row("Permission", push.getPermissionState());
    const subscription = await push.getSubscription();
    row("Subscribed", subscription ? "yes" : "no");

    enableButton.hidden = subscription !== null;
    disableButton.hidden = subscription === null;
    enableButton.disabled = !support.supported && support.reason !== "ios_requires_installed_app";
    identifyButton.disabled = subscription === null;
    if (!support.supported && support.reason) say(REASONS[support.reason] ?? "");
    else if (push.getPermissionState() === "denied") say(REASONS.permission_denied);
  }

  // Asking for the permission has to come from a click: a prompt on page load is ignored or penalized.
  enableButton.addEventListener("click", async () => {
    enableButton.disabled = true;
    const result = await push.trySubscribe();
    say(result.ok ? "Subscribed. Now identify the user, then send a notification." : (REASONS[result.reason] ?? result.reason) + (result.message ? ` (${result.message})` : ""));
    enableButton.disabled = false;
    await render();
  });

  disableButton.addEventListener("click", async () => {
    await push.unsubscribe();
    say("Unsubscribed.");
    await render();
  });

  identifyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await push.identify(externalIdInput.value.trim());
      say(`This browser is now linked to ${externalIdInput.value.trim()}.`);
    } catch (error) {
      say(error instanceof Error ? error.message : "Identify failed.");
    }
  });

  // The service worker shows the system notification for every push and forwards a copy to the open page.
  if (push.isSupported()) {
    push.onPush((payload: PushPayload) => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = payload.title;
      const body = document.createElement("span");
      body.textContent = payload.body;
      item.append(title, body);
      received.prepend(item);
    });
  }

  await render();

  // A visitor who is already subscribed is subscribed again on every visit, quietly: it keeps the subscription
  // fresh and, after the project rotates its VAPID keys, moves it to the new key without asking again.
  if (push.getPermissionState() === "granted" && (await push.getSubscription())) {
    const result = await push.trySubscribe();
    if (result.ok) await render();
  }
}
