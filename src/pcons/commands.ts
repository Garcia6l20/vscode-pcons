import * as vscode from "vscode";
import * as path from "path";
import { channelExec, execInTerminal, handleDiagnostics, Stream, getLogArgs } from "./run";
import { pcons } from "../extension";
import { isTarget, Target } from "./targets";
import { TestSuiteInfo, TestInfo } from "./testAdapter";
import { DebuggerEnvironmentVariable } from "./debugger";
import { PconsMetadataAlias, PconsMetadataTarget, readMetadata } from "./metadata";

// export async function scanToolchains(ext: pcons) {
//     return channelExec('scan-toolchains', getLogArgs());
// }

const pconsBaseArgs = ['-u', '-m', 'pcons'];
const codeInterfaceArgs = [...pconsBaseArgs, 'code'];

export async function codeCommand<T>(ext: pcons, fn: string, ...args: string[]): Promise<T> {
    let stream = new Stream('python', [...codeInterfaceArgs, fn, ...args], {
        env: {
            ...process.env,
            'pcons_BUILD_PATH': ext.buildPath,
        },
        cwd: ext.projectRoot,
    });
    let data = '';
    stream.onLine((line: string, isError: boolean) => {
        if (!handleDiagnostics(line, ext.buildDiagnostics)) {
            data += line;
        }
    });
    let rc = await stream.finished();
    if (rc !== 0) {
        const msg = `pcons: ${fn} failed: ${data}`;
        console.error(msg);
        throw Error(msg);
    } else {
        try {
            return JSON.parse(data) as T;
        } catch (e) {
            const msg = `pcons: ${fn} failed to parse output: ${data}`;
            console.error(msg);
            throw Error(msg);
        }
    }
}

export async function getToolchains(ext: pcons): Promise<string[]> {
    return codeCommand<string[]>(ext, 'get-toolchains');
}

export async function getTargets(ext: pcons): Promise<Target[]> {
    const metadata = await readMetadata(ext.buildPath);
    if (metadata === undefined) {
        throw new Error(`pcons metadata not found in ${ext.buildPath}`);
    }

    const targets = metadata.targets.map((target) => metadataTargetToTarget(target, ext.projectRoot));
    const targetNames = new Set(targets.map((target) => target.fullname));
    const aliases = metadata.aliases
        .filter((alias) => !targetNames.has(alias.name))
        .map((alias) => metadataAliasToTarget(alias, ext.projectRoot));

    return [...targets, ...aliases];
}

function metadataTargetToTarget(target: PconsMetadataTarget, projectRoot: string): Target {
    const output = target.outputs.length > 0
        ? path.resolve(projectRoot, target.outputs[0])
        : "";

    const sourcePath = target.sources.length > 0
        ? path.resolve(projectRoot, path.dirname(target.sources[0]))
        : projectRoot;

    const buildPath = output.length > 0
        ? path.dirname(output)
        : projectRoot;

    return {
        name: target.name,
        fullname: target.name,
        output: output,
        srcPath: sourcePath,
        buildPath: buildPath,
        executable: target.type === "program",
        type: target.type,
    };
}

function metadataAliasToTarget(alias: PconsMetadataAlias, projectRoot: string): Target {
    return {
        name: alias.name,
        fullname: alias.name,
        output: "",
        srcPath: projectRoot,
        buildPath: projectRoot,
        executable: false,
        type: "alias",
    };
}


export async function getTests(ext: pcons): Promise<string[]> {
    return codeCommand<string[]>(ext, 'get-tests');
}

export async function getTestSuites(ext: pcons): Promise<TestSuiteInfo> {
    return codeCommand<TestSuiteInfo>(ext, 'get-test-suites');
}

export async function generate(ext: pcons, debug = false) {
    // const toolchain = await ext.currentToolchain();
    // if (toolchain === undefined) {
    //     return;
    // }
    let args = ['-B', ext.buildPath, '-b', `${ext.projectRoot}/pcons-build.py`];
    const variables = ext.getConfig<Object>('variables');
    if (variables !== undefined) {
        for (const [key, value] of Object.entries(variables)) {
            args.push(`${key}=${value}`);
        }
    }
    args.push(...getLogArgs());
    // args.push('--toolchain', toolchain);

    if (debug) {
        await debugExec(ext, ['generate', ...args]);
    } else {
        await channelExec('generate', args, undefined, true, ext.projectRoot);
    }

    const metadataArgs = [...args, '-G', 'metadata'];
    await channelExec(
        'generate',
        metadataArgs,
        'Generating pcons metadata',
        true,
        ext.projectRoot
    );
}

function baseArgs(ext: pcons): string[] {
    let args = ['-B', ext.buildPath, ...getLogArgs()];
    const jobs = ext.getConfig<number>('jobs');
    if (jobs !== undefined) {
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

export async function build(ext: pcons, targets: Target[] | string[] = [], debug = false) {
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
        await channelExec('build', [...args], undefined, true, ext.projectRoot, ext.buildDiagnostics);
    }
}

export async function debugExec(ext: pcons, args: string[]) {
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

export async function clean(ext: pcons) {
    return channelExec('clean', ['--no-status', ...baseArgs(ext), ...ext.buildTargets.map(t => t.fullname)], undefined, true, ext.projectRoot);
}

export async function run(ext: pcons, args?: string[]) {
    const target = ext.launchTarget;
    if (!target || !target.executable) {
        throw new Error('No executable launch target selected');
    }

    const targetDirectory = target.output.length > 0
        ? path.dirname(target.output)
        : target.buildPath || ext.projectRoot;

    execInTerminal(
        target.output,
        args ?? [],
        targetDirectory,
        target.env,
        `pcons: ${target.name}`
    );
}

export async function test(ext: pcons) {
    let args = baseArgs(ext);
    args.push(...ext.tests);
    return channelExec('test', args, undefined, true, ext.projectRoot);
}
