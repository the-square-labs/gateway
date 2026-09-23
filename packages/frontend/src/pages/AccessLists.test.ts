import { describe, expect, it, vi } from "vitest";

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

import { validateBasicAuthUsers } from "./AccessLists";

describe("validateBasicAuthUsers", () => {
  it("rejects a new user with a blank password instead of dropping the row", () => {
    expect(validateBasicAuthUsers([{ username: "alice", password: "" }], [])).toEqual({
      error: 'Enter a password for basic auth user "alice"',
    });
  });

  it("keeps existing users without a new password when editing", () => {
    expect(
      validateBasicAuthUsers(
        [
          { username: "alice", password: "" },
          { username: " bob ", password: "secret" },
          { username: "", password: "" },
        ],
        ["alice"]
      )
    ).toEqual({
      users: [
        { username: "alice", password: "" },
        { username: "bob", password: "secret" },
      ],
    });
  });

  it("rejects basic auth without any user and rows without a username", () => {
    expect(validateBasicAuthUsers([{ username: "", password: "" }], [])).toEqual({
      error: "Add at least one user to enable basic authentication",
    });
    expect(validateBasicAuthUsers([{ username: "", password: "secret" }], [])).toEqual({
      error: "Enter a username for every basic auth user",
    });
  });
});
