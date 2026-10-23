import { PushClient, PushUser } from "../src/index";

// Mock fetch
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ success: true })),
  })
) as jest.Mock;

describe("SDK Validation Tests", () => {
  let client: PushClient;

  beforeEach(() => {
    client = new PushClient({ projectId: "pk_test_123" });
    (global.fetch as jest.Mock).mockClear();
  });

  test("should register successfully without user object", async () => {
    const data: PushUser = {
      pushToken: "token-123",
      platform: "ios",
    };

    await expect(client.devices.register(data)).resolves.toEqual({
      success: true,
    });
  });

  test("should register successfully with complete user object", async () => {
    const data: PushUser = {
      pushToken: "token-123",
      platform: "android",
      user: {
        name: "John Doe",
        externalId: "user-123",
      },
    };

    await expect(client.devices.register(data)).resolves.toEqual({
      success: true,
    });
  });

  test("should throw error if name is missing in user object", async () => {
    const data: any = {
      pushToken: "token-123",
      platform: "ios",
      user: {
        externalId: "user-123",
        // name is missing
      },
    };

    await expect(client.devices.register(data)).rejects.toThrow(
      "❌ Validation Error: Both 'name' and 'externalId' must be provided in the user object."
    );
  });

  test("should throw error if externalId is missing in user object", async () => {
    const data: any = {
      pushToken: "token-123",
      platform: "ios",
      user: {
        name: "John Doe",
        // externalId is missing
      },
    };

    await expect(client.devices.register(data)).rejects.toThrow(
      "❌ Validation Error: Both 'name' and 'externalId' must be provided in the user object."
    );
  });
});
