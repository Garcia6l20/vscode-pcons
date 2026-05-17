import * as path from "path";
import * as vscode from "vscode";
import { Pcons } from "../extension";
import { readMetadata } from "./metadata";

export class PconsCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private advancedMode = false;
    readonly onDidChangeCodeLenses = this.changeEmitter.event;

    constructor(private readonly ext: Pcons) {
    }

    refresh(): void {
        this.changeEmitter.fire();
    }

    toggleAdvancedMode(): void {
        this.advancedMode = !this.advancedMode;
        vscode.window.setStatusBarMessage(
            this.advancedMode
                ? "Pcons: Advanced CodeLens enabled"
                : "Pcons: Advanced CodeLens disabled",
            2000
        );
        this.refresh();
    }

    setAdvancedMode(enabled: boolean): void {
        if (this.advancedMode !== enabled) {
            this.advancedMode = enabled;
            this.refresh();
        }
    }

    isAdvancedMode(): boolean {
        return this.advancedMode;
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const metadata = await readMetadata(this.ext.buildPath);
        if (metadata === undefined) {
            return [];
        }

        const normalizedDoc = path.normalize(document.uri.fsPath);
        const lenses: vscode.CodeLens[] = [];

        for (const target of metadata.targets) {
            const targetSelector = target.outputs.length > 0
                ? target.outputs[0]
                : target.name;

            const filePath = target.defined_at.file;
            const absoluteFile = path.isAbsolute(filePath)
                ? filePath
                : path.join(this.ext.projectRoot, filePath);

            if (path.normalize(absoluteFile) !== normalizedDoc) {
                continue;
            }

            const line = Math.max(target.defined_at.line - 1, 0);
            const range = new vscode.Range(line, 0, line, 0);

            lenses.push(new vscode.CodeLens(range, {
                title: "Build",
                command: "pcons.buildTarget",
                arguments: [targetSelector],
            }));

            if (target.type === "program") {
                lenses.push(new vscode.CodeLens(range, {
                    title: "Run",
                    command: "pcons.runTarget",
                    arguments: [targetSelector],
                }));

                if (this.advancedMode) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: "Run with args",
                        command: "pcons.runTargetWithArgs",
                        arguments: [targetSelector],
                    }));
                }

                lenses.push(new vscode.CodeLens(range, {
                    title: "Debug",
                    command: "pcons.debugTarget",
                    arguments: [targetSelector],
                }));

                if (this.advancedMode) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: "Debug with args",
                        command: "pcons.debugTargetWithArgs",
                        arguments: [targetSelector],
                    }));
                }
            }
        }

        return lenses;
    }
}
