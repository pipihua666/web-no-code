import { CodexBridge } from "@web-no-code/server/codex/bridge";

const bridge = new CodexBridge();

try {
  const status = await bridge.status("app-server");
  console.log(JSON.stringify(status, null, 2));
} finally {
  await bridge.dispose();
}
