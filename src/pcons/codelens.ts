import * as path from "path";
import * as vscode from "vscode";
import { Pcons } from "../extension";

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
        if (!this.ext.buildInfo.isLoaded) {
            return [];
        }

        const normalizedDoc = path.normalize(document.uri.fsPath);

        type RawTarget = ReturnType<typeof this.ext.buildInfo.rawTargets>[number];
        const byLine = new Map<number, RawTarget[]>();

        for (const target of this.ext.buildInfo.rawTargets()) {
            const filePath = target.defined_at.file;
            const absoluteFile = path.isAbsolute(filePath)
                ? filePath
                : path.join(this.ext.projectRoot, filePath);

            if (path.normalize(absoluteFile) !== normalizedDoc) {
                continue;
            }

            const line = Math.max(target.defined_at.line - 1, 0);
            const group = byLine.get(line);
            if (group) {
                group.push(target);
            } else {
                byLine.set(line, [target]);
            }
        }

        const lenses: vscode.CodeLens[] = [];

        for (const [line, targets] of byLine) {
            const range = new vscode.Range(line, 0, line, 0);
            const selectors = targets.map(t => t.outputs.length > 0 ? t.outputs[0] : t.name);
            const programSelectors = targets
                .filter(t => t.type === "program")
                .map(t => t.outputs.length > 0 ? t.outputs[0] : t.name);

            lenses.push(new vscode.CodeLens(range, {
                title: "Build",
                command: "pcons.buildTarget",
                arguments: [selectors],
            }));

            if (programSelectors.length > 0) {
                lenses.push(new vscode.CodeLens(range, {
                    title: "Run",
                    command: "pcons.runTarget",
                    arguments: [programSelectors],
                }));

                if (this.advancedMode) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: "Run with args",
                        command: "pcons.runTargetWithArgs",
                        arguments: [programSelectors],
                    }));
                }

                lenses.push(new vscode.CodeLens(range, {
                    title: "Debug",
                    command: "pcons.debugTarget",
                    arguments: [programSelectors],
                }));

                if (this.advancedMode) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: "Debug with args",
                        command: "pcons.debugTargetWithArgs",
                        arguments: [programSelectors],
                    }));
                }
            }
        }

        return lenses;
    }
}
