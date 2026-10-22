import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const [html, css, js] = await Promise.all([
  readFile(resolve(root, "web/index.html"), "utf8"),
  readFile(resolve(root, "web/style.css"), "utf8"),
  readFile(resolve(root, "web/app.js"), "utf8"),
]);
if (!html.includes("/* STYLE */") || !html.includes("/* SCRIPT */")) throw new Error("HTML build markers missing");
const page = html.replace("/* STYLE */", css).replace("/* SCRIPT */", js.replaceAll("</script", "<\\/script"));
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await cp(resolve(root, "worker/index.js"), resolve(dist, "server/index.js"));
await cp(resolve(root, ".openai/hosting.json"), resolve(dist, ".openai/hosting.json"));
await writeFile(resolve(dist, "server/page.js"), `export default ${JSON.stringify(page)};\n`);
console.log("Built", dist);

