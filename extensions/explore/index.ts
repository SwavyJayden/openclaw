import type { OpenClawPluginApi } from "openclaw/plugin-sdk/explore";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/explore";
import { createExploreTool } from "./src/explore-tool.js";

const EXPLORE_AGENT_GUIDANCE = `## Explore Tool
You have access to an \`explore\` tool that delegates codebase research to a fast, cheap sub-agent.
Use it when you need to search for files, understand how something works, or find code patterns.
It's much cheaper than doing the search yourself — prefer it for broad exploration.`;

const plugin = {
  id: "explore",
  name: "Explore",
  description: "Haiku-powered codebase exploration tool",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerTool(createExploreTool(api));

    api.on("before_prompt_build", async () => ({
      prependSystemContext: EXPLORE_AGENT_GUIDANCE,
    }));

    api.logger.info("explore: registered");
  },
};

export default plugin;
