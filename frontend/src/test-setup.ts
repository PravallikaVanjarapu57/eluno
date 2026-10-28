import { afterEach } from "vitest";

// Component tests opt in to jsdom with a `@vitest-environment jsdom` comment; the plain unit tests stay in node.
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  localStorage.clear();
});
