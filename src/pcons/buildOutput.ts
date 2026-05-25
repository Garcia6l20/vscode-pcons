import * as vscode from 'vscode';
import * as path from 'path';
import * as gcc from '@cmt/diagnostics/gcc';
import * as gnuLd from '@cmt/diagnostics/gnu-ld';
import * as msvc from '@cmt/diagnostics/msvc';
import { diagnosticSeverity } from '@cmt/diagnostics/util';

export class BuildOutputConsumer {
    private readonly parsers = [new gcc.Parser(), new gnuLd.Parser(), new msvc.Parser()];

    constructor(private readonly cwd: string) {}

    feedLine(line: string): void {
        for (const parser of this.parsers) {
            parser.handleLine(line);
        }
    }

    resolveToCollection(collection: vscode.DiagnosticCollection): void {
        const diagsByFile = new Map<string, vscode.Diagnostic[]>();

        for (const parser of this.parsers) {
            for (const raw of parser.diagnostics) {
                const severity = diagnosticSeverity(raw.severity);
                if (severity === undefined) { continue; }

                const diag = new vscode.Diagnostic(raw.location, raw.message, severity);
                diag.source = 'pcons';
                if (raw.code) {
                    diag.code = raw.code;
                }
                if (raw.related.length > 0) {
                    diag.relatedInformation = raw.related.map(r =>
                        new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(vscode.Uri.file(this.absPath(r.file)), r.location),
                            r.message
                        )
                    );
                }

                const absFile = this.absPath(raw.file);
                const list = diagsByFile.get(absFile) ?? [];
                if (!diagsByFile.has(absFile)) { diagsByFile.set(absFile, list); }
                list.push(diag);
            }
        }

        diagsByFile.forEach((diags, file) => {
            collection.set(vscode.Uri.file(file), diags);
        });
    }

    private absPath(file: string): string {
        return path.isAbsolute(file) ? file : path.resolve(this.cwd, file);
    }
}
