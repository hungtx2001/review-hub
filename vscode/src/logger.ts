import * as vscode from "vscode";

export class Logger {
  private channel: vscode.OutputChannel;
  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }
  debug(message: string) {
    this.channel.appendLine(`[debug] ${message}`);
  }
  info(message: string) {
    this.channel.appendLine(`[info] ${message}`);
  }
  warn(message: string) {
    this.channel.appendLine(`[warn] ${message}`);
  }
  error(message: string) {
    this.channel.appendLine(`[error] ${message}`);
  }
  show() {
    this.channel.show();
  }
  dispose() {
    this.channel.dispose();
  }
}
