// Must load before @openuidev/react-lang: suppresses its dev-only devtools launcher + "share your app" toast.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;
export {};
