import { WebPushClient } from "../src/index";

// SEC1-12: the web client refuses a secret key, as the React Native client does. A secret key in a page is
// published to every visitor of it.
describe("WebPushClient secret key guard", () => {
  it("throws when the project key is a secret key", () => {
    expect(() => new WebPushClient({ projectId: "sk_live_abc" })).toThrow(/secret key/i);
  });

  it("accepts a public key", () => {
    expect(() => new WebPushClient({ projectId: "pk_live_abc" })).not.toThrow();
  });
});
