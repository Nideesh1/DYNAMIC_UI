// The documented Next.js `instrumentation.ts` pattern (as plain JS), imported by node-watch.test.mjs's child.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { watch } = await import("../../../src/node.ts"); // in an app: await import("agentglow/node")
    watch({ service: "web-bff", url: process.env.AGENTGLOW_URL });
  }
}
