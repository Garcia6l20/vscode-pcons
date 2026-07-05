import * as vscode from "vscode";
import * as cp from "child_process";
import * as sq from 'shell-quote';

export function str2cmdline(str: string, env?: { readonly [key: string]: string | undefined }): Array<string> {
    return sq.parse(str, env).map((e) => e.toString());
};

function quoteShellArg(arg: string): string {
    if (arg.length === 0) {
        return "''";
    }

    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
        return arg;
    }

    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function processBuffer(data: any, isError: boolean, fn: (line: string, isError: boolean) => void) {
    for (let line of data.toString().split(/\r?\n|\r/)) {
        line = line.trim();
        if (line.length > 0) {
            fn(line, isError);
        }
    }
}

export class Stream {
    private proc: cp.ChildProcess;
    private killed = false;

    constructor(command: string, args: string[], options: cp.SpawnOptions = {}) {
        // Run the child as its own process group leader (POSIX) so we can signal
        // the whole tree on cancel. pcons spawns ninja, which spawns cc1plus;
        // those grandchildren survive a kill aimed only at the direct child.
        this.proc = cp.spawn(command, args, {
            ...options,
            detached: process.platform !== "win32",
        });
    }

    onLine(fn: (line: string, isError: boolean) => void) {
        this.proc.stdout?.on("data", (chunk: any) => processBuffer(chunk, false, fn));
        this.proc.stderr?.on("data", (chunk: any) => processBuffer(chunk, true, fn));
    }
    kill(signal: NodeJS.Signals = "SIGTERM") {
        this.killed = true;
        const pid = this.proc.pid;
        if (pid === undefined) {
            return;
        }
        if (process.platform === "win32") {
            // No POSIX process groups; let taskkill walk the tree.
            cp.spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
            return;
        }
        try {
            // Negative pid targets the whole process group created via detached.
            process.kill(-pid, signal);
        } catch {
            // Group already gone, or never created; fall back to the direct child.
            this.proc.kill(signal);
        }
    }
    private _onExit(code: number | null): number {
        if (code === null) {
            if (this.killed || this.proc.killed) {
                return -1;
            } else {
                return 0;
            }
        }
        return code;
    }
    finished() {
        return new Promise<number>(res => {
            this.proc.on("exit", (code) => {
                code = this._onExit(code);
                res(code);
            });
        });
    }
}

let _channel: vscode.OutputChannel;
export function getOutputChannel(): vscode.OutputChannel {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel("pcons");
    }
    return _channel;
}

export function getLogArgs(): string[] {
    switch (vscode.env.logLevel) {
        case vscode.LogLevel.Trace:
            return ['-vv'];
        case vscode.LogLevel.Debug:
            return ['-v'];
        default:
            return [];
    }
}


class ProgressBar implements vscode.Disposable {
    private bar;
    private progress?: vscode.Progress<{ message?: string; increment?: number }>;
    private token?: vscode.CancellationToken;
    private cancelCallbacks: Array<() => any> = [];
    private done: Promise<boolean>;
    private resolve?: ((value: boolean) => void);
    private reject?: (() => void);
    private currentPercentage = 0;
    private onDone?: ((bar: ProgressBar) => void);

    constructor(readonly id: string, cancellable: boolean = false, onDone?: (bar: ProgressBar) => void) {
        this.onDone = onDone;
        this.done = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.bar = vscode.window.withProgress({
            title: id,
            cancellable: cancellable,
            location: vscode.ProgressLocation.Notification,
        },
            async (progress, token) => {
                this.progress = progress;
                this.token = token;
                for (const cb of this.cancelCallbacks) {
                    token.onCancellationRequested(cb);
                }
                this.cancelCallbacks = [];
                await this.done;
                console.debug(`${this.id} terminated`);
            });
    }

    dispose() {
        this.resolve?.(true);
        this.onDone?.(this);
    }

    public onCancellationRequested(callback: () => any) {
        if (this.token) {
            this.token.onCancellationRequested(callback);
        } else {
            this.cancelCallbacks.push(callback);
        }
    }

    public report(percentage?: number, message?: string) {
        let increment = undefined;
        if (percentage !== undefined && !Number.isNaN(percentage)) {
            increment = percentage - this.currentPercentage;
            this.currentPercentage = percentage;
        }
        this.progress?.report({ message: message, increment: increment });
        if (percentage !== undefined && percentage >= 100) {
            this.dispose();
        }
    }
};

class ProgressSet implements vscode.Disposable {
    private bars: { [id: string]: ProgressBar } = {};
    private onCancel: (() => any) | undefined = undefined;
    public get(id: string, cancellable: boolean = false) {
        if (!(id in this.bars)) {
            this.bars[id] = new ProgressBar(id, cancellable, (bar: ProgressBar) => this.barTerminated(bar));
        }
        return this.bars[id];
    }
    public clear(id: string) {
        if (id in this.bars) {
            this.bars[id].dispose();
        }
    }
    private barTerminated(bar: ProgressBar) {
        for (let id in this.bars) {
            if (this.bars[id] === bar) {
                delete this.bars[id];
                return;
            }
        }
    }
    public onCancellationRequested(callback: () => any) {
        this.onCancel = callback;
        for (let id in this.bars) {
            this.bars[id].onCancellationRequested(this.onCancel);
        }
    }
    dispose() {
        for (let id in this.bars) {
            this.bars[id].dispose();
        }
    }
};

class LogStream implements vscode.Disposable {
    static readonly _expr = /\[([\d:.]+)\]\[(\w+)\]\s*(.+?):\s*(.+)?/;
    static readonly _progressExpr = /(.+) - (.+)\/(.+)/;
    static readonly _sequenceExpr = /\x1b\[./;

    public bars = new ProgressSet();

    constructor(readonly output: vscode.OutputChannel) {
    }

    dispose() {
        this.bars.dispose();
    }

    processLine(line: string) {
        const [m, , level, id, msg] = LogStream._expr.exec(line) || [];
        if (m) {
            switch (level) {
                case 'STATUS':
                    return;
                case 'PROGRESS':
                    {
                        const [bm, pmsg, nStr, totStr] = LogStream._progressExpr.exec(msg) || [];
                        if (bm) {
                            if (nStr === 'done') {
                                this.bars.clear(id);
                            } else {
                                const bar = this.bars.get(id);
                                const n = parseInt(nStr);
                                const total = parseInt(totStr);
                                let progress = undefined;
                                if (total > 0) {
                                    progress = 100 * n / total;
                                }
                                bar.report(progress, pmsg);
                            }
                        } else {
                            console.debug('non matching progress');
                        }
                    }
                    return;
            }
            this.output.appendLine(`${id}: ${msg}`);
        } else {
            if (!LogStream._sequenceExpr.exec(line)) {
                this.output.appendLine(line);
            }
        }
    }
};

export async function channelExec(command: string,
    parameters: string[] = [],
    title: string | undefined = undefined,
    cancellable: boolean = true,
    cwd: string | undefined = undefined,
    onBuildLine?: (line: string) => void,
    lineTransform?: (line: string) => string) {
    let stream = new Stream('python', ['-u', '-m', 'pcons', command, ...parameters], { cwd: cwd });
    title = title ?? `Executing ${command} ${parameters.join(' ')}`;
    const channel = getOutputChannel();
    channel.clear();
    channel.show();
    channel.appendLine(title);
    const logStream = new LogStream(channel);
    logStream.bars.get('make', true);
    logStream.bars.onCancellationRequested(() => stream.kill());
    stream.onLine((line: string) => {
        const resolved = lineTransform ? lineTransform(line) : line;
        onBuildLine?.(resolved);
        logStream.processLine(resolved);
    });
    const rc = await stream.finished();
    const statusStr = rc === 0 ? 'succeed' : 'failed';
    logStream.dispose();
    if (rc !== 0) {
        channel.appendLine(`command: ${command} failed`);
        vscode.window.showErrorMessage(`pcons: ${command} ${statusStr}: see output log`);
        channel.show();
        throw Error(`command: ${command} failed`);
    } else {
        channel.appendLine(`command: ${command} succeed`);
    }
}

function getTerminal(): vscode.Terminal {
    let terminal = vscode.window.terminals.find(t => t.name === 'pcons') ?? null;
    if (!terminal) {
        terminal = vscode.window.createTerminal("pcons");
    }
    terminal.show();
    return terminal;
}

let runTerminal: vscode.Terminal | undefined;

vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === runTerminal) {
        runTerminal = undefined;
    }
});

export function execInTerminal(
    command: string,
    args: string[] = [],
    cwd: string | undefined = undefined,
    env: { [key: string]: string } | undefined = undefined,
    name: string = 'pcons'
) {
    // Reuse a single run terminal slot: dispose the previous one and create a
    // fresh terminal so cwd/env are always correct for the current target.
    const old = runTerminal;
    runTerminal = undefined;
    old?.dispose();

    const terminal = vscode.window.createTerminal({
        name,
        cwd,
        env,
    });
    runTerminal = terminal;

    terminal.show();
    terminal.sendText([command, ...args].map(quoteShellArg).join(' '), true);
}


export function termExec(command: string,
    parameters: string[] = [],
    title: string | null = null,
    cancellable: boolean = true,
    cwd: string | undefined = undefined) {
    let term = getTerminal();
    term.show();
    let args = ['python', '-m', 'pcons', command, ...parameters];
    if (cwd) {
        args.unshift('cd', cwd, '&&');
    }
    term.sendText(args.join(' '));
}
