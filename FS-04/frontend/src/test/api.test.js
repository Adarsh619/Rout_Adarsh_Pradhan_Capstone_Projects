import { formatError } from "../api";

it("formats DRF error payloads", () => {
  expect(formatError({ detail: "Nope" })).toBe("Nope");
  expect(formatError({ title: ["This field is required."] })).toBe("title: This field is required.");
  expect(formatError({ non_field_errors: ["Bad"] })).toBe("Bad");
});
