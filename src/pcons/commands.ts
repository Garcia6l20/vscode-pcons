import * as vscode from "vscode";
import { channelExec, handleDiagnostics, Stream, getLogArgs } from "./run";
import { pcons } from "../extension";
import { isTarget, Target } from "./targets";
import { TestSuiteInfo, TestInfo } from "./testAdapter";
import { DebuggerEnvironmentVariable } from "./debugger";

export async function scanToolchains(ext: pcons) {
    return channelExec('scan-toolchains', getLogArgs());
}

const pconsBaseArgs = ['-u', '-m', 'pcons'];
const codeInterfaceArgs = [...pconsBaseArgs, 'code'];

export async function codeCommand<T>(ext: pcons, fn: string, ...args: string[]): Promise<T> {
    let stream = new Stream('python', [...codeInterfaceArgs, fn, ...args], {
        env: {
            ...process.env,
            // eslint-disable-next-line @typescript-eslint/naming-convention
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
    return codeCommand<Target[]>(ext, 'get-targets');
}


export async function getTests(ext: pcons): Promise<string[]> {
    return codeCommand<string[]>(ext, 'get-tests');
}

export async function getTestSuites(ext: pcons): Promise<TestSuiteInfo> {
    return codeCommand<TestSuiteInfo>(ext, 'get-test-suites');
}

export async function configure(ext: pcons) {
    const toolchain = await ext.currentToolchain();
    if (toolchain === undefined) {
        return;
    }
    let args = ['-B', ext.buildPath, '-S', ext.projectRoot];
    const settings = ext.getConfig<Object>('settings');
    if (settings !== undefined) {
        for (const [key, value] of Object.entries(settings)) {
            args.push('-s', `${key}=${value}`);
        }
    }
    args.push('-s', `build_type=${ext.buildType}`);
    const options = ext.getConfig<Object>('options');
    if (options !== undefined) {
        for (const [key, value] of Object.entries(options)) {
            args.push('-o', `${key}=${value}`);
        }
    }
    args.push(...getLogArgs());
    args.push('--toolchain', toolchain);
    return channelExec('configure', args, undefined, true, ext.projectRoot);
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
        await channelExec('code', ['build', ...args], undefined, true, ext.projectRoot, ext.buildDiagnostics);
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
    let cmdArgs = baseArgs(ext);
    if (ext.launchTarget) {
        cmdArgs.push(ext.launchTarget.fullname);
    }
    if (args) {
        cmdArgs.push(...args);
    }
    return channelExec('run', cmdArgs, undefined, true, ext.projectRoot);
}

export async function test(ext: pcons) {
    let args = baseArgs(ext);
    args.push(...ext.tests);
    return channelExec('test', args, undefined, true, ext.projectRoot);
}
