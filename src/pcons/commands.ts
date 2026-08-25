import * as vscode from "vscode";
import * as path from "path";
import { channelExec, execInTerminal, getLogArgs } from "./run";
import { BuildOutputConsumer } from "./buildOutput";
import { Pcons } from "../extension";
import { isTarget, Target } from "./targets";
import { DebuggerEnvironmentVariable } from "./debugger";

// Matches compiler output lines that start with a file path (must contain '/')
// followed by ':' and either a line number or a space (GCC "In function" context lines).
const _filePathExpr = /^([^\s:]+\/[^\s:]*):(?=\d|\s)/;

function makeLineResolver(base: string): (line: string) => string {
    return (line: string) => {
        const m = _filePathExpr.exec(line);
        if (m && !path.isAbsolute(m[1])) {
            return path.resolve(base, m[1]) + line.slice(m[1].length);
        }
        return line;
    };
}

export async function generate(ext: Pcons, debug = false) {
    let args = ['-B', ext.buildPath, '-b', `${ext.projectRoot}/pcons-build.py`];
    const variables = ext.getConfig<Object>('variables');
    if (variables !== undefined) {
        for (const [key, value] of Object.entries(variables)) {
            args.push(`${key}=${value}`);
        }
    }

    const variant = ext.variant;
    if (variant) {
        args.push(`--variant=${variant}`);
    }

    args.push(...getLogArgs());
    args.push('-G', 'ninja', '-G', 'metadata');

    if (debug) {
        await debugExec(ext, ['generate', ...args]);
    } else {
        await channelExec('generate', args, undefined, true, ext.projectRoot);
    }
}

function baseArgs(ext: Pcons): string[] {
    let args = ['-B', ext.buildPath, ...getLogArgs()];
    const jobs = ext.getConfig<number>('jobs');
    if (jobs !== undefined && jobs > 0) {
        args.push('-j', jobs.toString());
    }
    return args;
}

interface PythonDebugConfiguration {
    type: string;
    name: string;
    request: string;
    program?: string;
    module?: string;
    justMyCode?: boolean;
    args?: string[];
    cwd?: string;
    environment?: DebuggerEnvironmentVariable[];
}

export async function build(ext: Pcons, targets: Target[] | string[] = [], debug = false) {
    let args = baseArgs(ext);
    if (targets.length !== 0) {
        args.push(...targets.map((t) => {
            if (isTarget(t)) {
                return t.fullname;
            } else {
                return t;
            }
        }));
    }
    if (debug) {
        await debugExec(ext, ['build', ...args]);
    } else {
        const buildPath = ext.buildPath;
        const consumer = new BuildOutputConsumer(buildPath);
        const resolveLine = makeLineResolver(buildPath);
        ext.buildDiagnostics.clear();
        try {
            await channelExec('build', [...args], undefined, true, ext.projectRoot,
                line => consumer.feedLine(line), resolveLine);
        } finally {
            consumer.resolveToCollection(ext.buildDiagnostics);
        }
    }
}

export async function debugExec(ext: Pcons, args: string[]) {
    const cfg: PythonDebugConfiguration = {
        name: 'pcons build',
        type: 'python',
        request: 'launch',
        module: 'pcons',
        justMyCode: ext.getConfig<boolean>('pythonDebugJustMyCode'),
        args: args,
        cwd: ext.projectRoot
    };
    await vscode.debug.startDebugging(undefined, cfg);
}

export async function clean(ext: Pcons) {
    return channelExec('clean', ['--no-status', ...baseArgs(ext), ...ext.buildTargets.map(t => t.fullname)], undefined, true, ext.projectRoot);
}

export async function run(ext: Pcons, args?: string[]) {
    const target = ext.launchTarget;
    if (!target || !target.executable || !target.output) {
        throw new Error('No executable launch target selected');
    }

    const targetDirectory = path.dirname(target.output);

    await execInTerminal(
        target.output,
        args ?? [],
        targetDirectory,
        target.env,
        `pcons: ${target.name}`
    );
}

export async function test(ext: Pcons) {
    let args = baseArgs(ext);
    args.push(...ext.tests);
    return channelExec('test', args, undefined, true, ext.projectRoot);
}
