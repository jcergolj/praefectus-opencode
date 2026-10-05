import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the same plain JavaScript that QML imports, without a desktop runtime.
export async function loadQmlScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: relativePath });
  return context;
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
