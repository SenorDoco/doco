import { describe, expect, it } from "vitest";
import { loader } from "../connect";

describe("/connect", () => {
  it("derives the hosted MCP base URL from the request origin", () => {
    expect(loader({ request: new Request("https://doco.to/connect") }).baseUrl).toBe(
      "https://doco.to",
    );
    expect(loader({ request: new Request("http://localhost:5173/connect") }).baseUrl).toBe(
      "http://localhost:5173",
    );
  });
});
