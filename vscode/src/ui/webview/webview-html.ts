import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export interface WebviewFiles {
  html: string;
  css: string;
  js: string;
}

/**
 * Shared HTML templating for webviews.
 * Files live in `resources/webview/<subpath>` with placeholders:
 * ${cspSource}, ${nonce}, ${styleUri}, ${scriptUri}.
 */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  subpathOrFiles: string | WebviewFiles,
  maybeFiles?: WebviewFiles,
): string {
  const nonce = randomBytes(16).toString("base64");
  const subpath = typeof subpathOrFiles === "string" ? subpathOrFiles : "";
  const files = typeof subpathOrFiles === "string" ? maybeFiles! : subpathOrFiles;

  const candidates = [
    vscode.Uri.joinPath(extensionUri, "resources", "webview", subpath),
    vscode.Uri.joinPath(extensionUri, "vscode", "resources", "webview", subpath),
    vscode.Uri.joinPath(extensionUri, "resources", subpath),
    vscode.Uri.joinPath(extensionUri, "media"),
  ];

  let baseUri = candidates[0];
  for (const c of candidates) {
    if (fs.existsSync(vscode.Uri.joinPath(c, files.html).fsPath)) {
      baseUri = c;
      break;
    }
  }

  const asset = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(baseUri, name)).toString();

  const template = fs.readFileSync(vscode.Uri.joinPath(baseUri, files.html).fsPath, "utf8");
  return template
    .replace(/\$\{cspSource\}/g, webview.cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{styleUri\}/g, asset(files.css))
    .replace(/\$\{scriptUri\}/g, asset(files.js));
}
