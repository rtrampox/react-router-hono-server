import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import honoDevServer, { type DevServerOptions } from "@hono/vite-dev-server";
import bunAdapter from "@hono/vite-dev-server/bun";
import nodeAdapter from "@hono/vite-dev-server/node";
import type { Config as ReactRouterConfig } from "@react-router/dev/config";
import type { Plugin, UserConfig } from "vite";
import { getReactVersion } from "./helpers";
import type { Runtime } from "./types/runtime";

type MetaEnv<T> = {
  [K in keyof T as `import.meta.env.${string & K}`]: T[K];
};

type ReactRouterHonoServerPluginOptions = {
  /**
   * The runtime to use for the server.
   *
   * Defaults to `node`.
   */
  runtime?: Runtime;
  /**
   * The path to the server file, relative to `vite.config.ts`.
   *
   * If it is a folder (`app/server`), it will look for an `index.ts` file.
   *
   * Defaults to `${appDirectory}/server[.ts | /index.ts]` if present.
   *
   * Fallback to a virtual module `virtual:react-router-hono-server/server`.`
   */
  serverEntryPoint?: string;
  /**
   * The paths that are not served by the dev-server.
   *
   * Defaults include `appDirectory` content.
   */
  dev?: {
    /**
     * The paths that are not served by the dev-server.
     *
     * Defaults include `appDirectory` content.
     */
    exclude?: DevServerOptions["exclude"];
    /**
     * The name of the export to use for the server.
     *
     * Defaults to `default`.
     */
    export?: DevServerOptions["export"];
  };
};

const virtualModuleId = "\0virtual:react-router-hono-server/server";
const reactRouterExport =
  "export {serverManifest as assets, assetsBuildDirectory, basename, entry, future, isSpaMode, publicPath, routes };";

export function reactRouterHonoServer(options: ReactRouterHonoServerPluginOptions = {}): Plugin {
  const runtime: Runtime = options.runtime || "node";
  let pluginConfig: PluginConfig;
  let devServerPlugin: Plugin | undefined;

  return {
    name: "react-router-hono-server",
    enforce: "post",
    resolveId(id) {
      if (id === virtualModuleId) {
        return id;
      }
    },
    load(id) {
      if (id === virtualModuleId) {
        return `
          // generated by react-router-hono-server/dev
          import { createHonoServer } from "react-router-hono-server/${runtime}";

          export default await createHonoServer();
        `;
      }
    },
    async config(config) {
      pluginConfig = resolvePluginConfig(config, options);

      if (!pluginConfig) {
        return;
      }

      if (pluginConfig.future.unstable_viteEnvironmentApi) {
        console.warn(
          "\x1b[33mThe unstable_viteEnvironmentApi is enabled.\nThis is experimental and may break your build.\x1b[0m\n"
        );
      }

      if (
        runtime === "cloudflare" &&
        !config.plugins?.find((p) => p && "name" in p && p.name === "react-router-cloudflare-vite-dev-proxy")
      ) {
        console.warn(
          `\x1b[31mMissing cloudflareDevProxy() in your vite.config.ts.\nPlease add it to your plugins: import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";\x1b[0m\n`
        );
        // throw new Error("Missing mandatory plugin cloudflareDevProxy() in vite.config.ts");
      }

      const baseConfig = {
        // Define environment variables that are hot-swapped during development and SSR build
        define: {
          "import.meta.env.REACT_ROUTER_HONO_SERVER_BUILD_DIRECTORY": JSON.stringify(pluginConfig.buildDirectory),
          "import.meta.env.REACT_ROUTER_HONO_SERVER_ASSETS_DIR": JSON.stringify(pluginConfig.assetsDir),
          "import.meta.env.REACT_ROUTER_HONO_SERVER_RUNTIME": JSON.stringify(runtime),
          "import.meta.env.REACT_ROUTER_HONO_SERVER_BASENAME": JSON.stringify(pluginConfig.basename),
        } satisfies MetaEnv<ReactRouterHonoServerEnv>,
        ssr: {
          target: runtime === "cloudflare" ? "webworker" : undefined,
          // Ensure our package is not externalized during SSR build
          // This is necessary because we are using a virtual import to load the React Router server entry point
          noExternal: ["react-router-hono-server"],
        },
      } satisfies UserConfig;

      if (!pluginConfig.future.unstable_viteEnvironmentApi && !pluginConfig.isSsrBuild) {
        return baseConfig;
      }

      let reactRouterBuildFile = pluginConfig.serverBuildFile;

      if (reactRouterBuildFile === "index.js") {
        reactRouterBuildFile = "assets/server-build.js";
      }

      let alias = undefined;

      if (runtime === "cloudflare") {
        const reactVersion = await getReactVersion();

        alias = {
          "react-dom/server": reactVersion >= 19 ? "react-dom/server.edge" : "react-dom/server.browser",
        };
      }

      const ssrConfig = {
        resolve: {
          alias,
        },
        build: {
          // https://vite.dev/config/build-options#build-target
          cssTarget: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
          target: "esnext",
          rollupOptions: {
            input: pluginConfig.serverEntryPoint,
            output: {
              entryFileNames: "index.js",
              chunkFileNames: (chunk) => {
                if (chunk.name === "server-build") {
                  return reactRouterBuildFile;
                }
                return "assets/[name]-[hash].js";
              },
              footer: runtime === "cloudflare" ? reactRouterExport : undefined,
            },
          },
        },
      } satisfies Partial<UserConfig>;

      if (pluginConfig.future.unstable_viteEnvironmentApi) {
        return {
          ...baseConfig,
          environments: {
            ssr: ssrConfig,
          },
        };
      }

      return {
        ...baseConfig,
        ...ssrConfig,
      };
    },
    async closeBundle() {
      if (!pluginConfig || !pluginConfig.isSsrBuild || runtime !== "cloudflare") {
        return;
      }

      console.log("Cleaning up server exports...");

      const buildPath = path.join(pluginConfig.rootDirectory, pluginConfig.buildDirectory, "server", "index.js");
      let content = await fs.promises.readFile(buildPath, "utf-8");
      content = content.replace(reactRouterExport, "");

      // Patch cloudflare server build for react 19 (#77)
      if ((await getReactVersion()) >= 19) {
        content = content.replace(/react-dom\/server\.browser/g, "react-dom/server.edge");
      }

      await fs.promises.writeFile(buildPath, content);

      console.log("\x1b[32mAll done!\x1b[0m");
    },
    async configureServer(server) {
      // bind viteDevServer to global 🤫
      globalThis.__viteDevServer = server;

      if (!pluginConfig) {
        return;
      }

      if (devServerPlugin) {
        return;
      }

      let adapter: DevServerOptions["adapter"] = nodeAdapter;

      if (runtime === "bun") {
        adapter = bunAdapter;
      }

      if (runtime === "cloudflare") {
        const { cloudflareAdapter } = await import("@hono/vite-dev-server/cloudflare");
        adapter = cloudflareAdapter;
      }

      // Create and apply the Hono dev server plugin
      devServerPlugin = honoDevServer({
        adapter,
        injectClientScript: false,
        entry: pluginConfig.serverEntryPoint,
        export: options.dev?.export || "default",
        exclude: [
          new RegExp(
            `^(?=\\/${pluginConfig.appDirectory.replace(/^\/+|\/+$/g, "").replaceAll("/", "\\/")}\\/)((?!.*\\.data(\\?|$)).*\\..*(\\?.*)?$)`
          ),
          /\?import(\?.*)?$/,
          /^\/@.+$/,
          /^\/node_modules\/.*/,
          `/${pluginConfig.appDirectory}/**/.*/**`,
          ...(pluginConfig.dev?.exclude || []),
        ],
      });

      // Bind socket info to the request headers
      server.middlewares.use((req: IncomingMessage, _res: ServerResponse, next: () => void) => {
        req.rawHeaders.push("x-remote-address", req.socket.remoteAddress || "unknown");
        req.rawHeaders.push("x-remote-port", String(req.socket.remotePort || "unknown"));
        req.rawHeaders.push("x-remote-family", req.socket.remoteFamily || "unknown");

        next();
      });

      // Apply the dev server plugin's configureServer hook if it exists
      if (typeof devServerPlugin.configureServer === "function") {
        devServerPlugin.configureServer(server);
      } else {
        console.error("Dev server plugin configureServer hook is not a function. This is likely a bug, I guess 😅\n");
        throw new Error("Cannot apply dev server plugin configureServer hook");
      }
    },
  };
}

type ReactRouterPluginContext = {
  reactRouterConfig: Required<ReactRouterConfig>;
  environmentBuildContext: { name: "client" | "ssr" } | null;
  rootDirectory: string;
  entryClientFilePath: string;
  entryServerFilePath: string;
};

function resolvePluginConfig(config: UserConfig, options: ReactRouterHonoServerPluginOptions) {
  if (!("__reactRouterPluginContext" in config)) {
    return null;
  }

  const { reactRouterConfig, environmentBuildContext, rootDirectory } =
    config.__reactRouterPluginContext as ReactRouterPluginContext;
  const buildDirectory = path.relative(rootDirectory, reactRouterConfig.buildDirectory);
  const appDirectory = path.relative(rootDirectory, reactRouterConfig.appDirectory);
  const isSsrBuild = environmentBuildContext?.name === "ssr";
  const assetsDir = config.build?.assetsDir || "assets";
  const serverEntryPoint = options.serverEntryPoint || findDefaultServerEntry(appDirectory);
  const serverBuildFile = reactRouterConfig.serverBuildFile;
  const basename = reactRouterConfig.basename;
  const future = reactRouterConfig.future;

  return {
    rootDirectory,
    buildDirectory,
    appDirectory,
    isSsrBuild,
    assetsDir,
    serverEntryPoint,
    dev: options.dev,
    serverBuildFile,
    basename,
    future,
  };
}

type PluginConfig = ReturnType<typeof resolvePluginConfig>;

let warned = false;

function findDefaultServerEntry(appDirectory: string): string {
  const fileWay = `${appDirectory}/server.ts`;
  const folderWay = `${appDirectory}/server/index.ts`;

  // Check if direct file exists
  if (fs.existsSync(fileWay)) {
    return fileWay;
  }

  // Check if index file exists
  if (fs.existsSync(folderWay)) {
    return folderWay;
  }

  if (!warned) {
    console.warn(
      `\x1b[33mNo server entry point found.\nWill use a virtual module (${virtualModuleId}) with a default Hono server.\n\nTo customize the server, create one of the following files:\n - ${fileWay} (npx react-router-hono-server reveal file)\n - ${folderWay} (npx react-router-hono-server reveal folder)\nYou can also set the \`serverEntryPoint\` option in the reactRouterHonoServer plugin for more control.\x1b[0m\n`
    );
    warned = true;
  }
  // If neither create a virtual module with a default Hono server
  return virtualModuleId;
}
