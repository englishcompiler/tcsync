import esbuild from "esbuild";
import fs from "node:fs";

// Exposes bridge/dist/tcsync.wasm.gz.b64 as the default export of "tcsync:wasm".
const embedWasm = {
  name: "embed-wasm",
  setup(build) {
    build.onResolve({ filter: /^tcsync:wasm$/ }, () => ({ path: "tcsync-wasm", namespace: "tcsync" }));
    build.onLoad({ filter: /.*/, namespace: "tcsync" }, () => ({
      contents: `export default ${JSON.stringify(fs.readFileSync("bridge/dist/tcsync.wasm.gz.b64", "utf8").trim())};`,
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  outfile: "main.js",
  minify: true,
  legalComments: "inline",
  banner: { js: "/* tcsync — https://github.com/englishcompiler/tcsync (MIT). Embeds tailcat (BSD-3-Clause) compiled to WebAssembly. */" },
  plugins: [embedWasm],
  logLevel: "info",
});
