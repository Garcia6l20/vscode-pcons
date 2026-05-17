import * as path from "path";
import * as vscode from "vscode";
import { Pcons } from "../extension";
import { readMetadata } from "./metadata";

export class PconsCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changeEmitter.event;

    constructor(private readonly ext: Pcons) {
    }

    refresh(): void {
        this.changeEmitter.fire();
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
                lenses.push(new vscode.CodeLens(range, {
                    title: "Debug",
                    command: "pcons.debugTarget",
                    arguments: [targetSelector],
                }));
            }
        }

        return lenses;
    }
}
