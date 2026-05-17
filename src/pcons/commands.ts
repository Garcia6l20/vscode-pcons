import * as vscode from "vscode";
import * as path from "path";
import { channelExec, execInTerminal, handleDiagnostics, Stream, getLogArgs } from "./run";
import { Pcons } from "../extension";
import { isTarget, Target } from "./targets";
import { TestSuiteInfo, TestInfo } from "./testAdapter";
import { DebuggerEnvironmentVariable } from "./debugger";
import { PconsMetadataAlias, PconsMetadataTarget, readMetadata } from "./metadata";

// export async function scanToolchains(ext: pcons) {
//     return channelExec('scan-toolchains', getLogArgs());
// }

const pconsBaseArgs = ['-u', '-m', 'pcons'];
const codeInterfaceArgs = [...pconsBaseArgs, 'code'];

export async function codeCommand<T>(ext: Pcons, fn: string, ...args: string[]): Promise<T> {
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

export async function getToolchains(ext: Pcons): Promise<string[]> {
    return codeCommand<string[]>(ext, 'get-toolchains');
}

export async function getTargets(ext: Pcons): Promise<Target[]> {
    const metadata = await readMetadata(ext.buildPath);
    if (metadata === undefined) {
        throw new Error(`pcons metadata not found in ${ext.buildPath}`);
    }

    const targets = metadata.targets.map((target) =>
        metadataTargetToTarget(target, ext.projectRoot, metadata.project.build_dir)
    );
    const targetNames = new Set(targets.map((target) => target.fullname));
    const aliases = metadata.aliases
        .filter((alias) => !targetNames.has(alias.name))
        .map((alias) => metadataAliasToTarget(alias, ext.projectRoot));

    return [...targets, ...aliases];
}

function metadataTargetToTarget(
    target: PconsMetadataTarget,
    projectRoot: string,
    buildDir: string
): Target {
    const mainOutput = pickMainOutput(target);
    const buildTargetName = stripBuildDirPrefix(mainOutput, buildDir);

    const output = mainOutput.length > 0
        ? path.resolve(projectRoot, mainOutput)
        : "";

    const sourcePath = target.sources.length > 0
        ? path.resolve(projectRoot, path.dirname(target.sources[0]))
        : projectRoot;

    const buildPath = output.length > 0
        ? path.dirname(output)
        : projectRoot;

    return {
        name: target.name,
        // Build commands need the concrete build target identifier used in
        // build.ninja (often the first output path in subdir layouts).
        fullname: buildTargetName.length > 0 ? buildTargetName : target.name,
        output: output,
        srcPath: sourcePath,
        buildPath: buildPath,
        executable: target.type === "program" && mainOutput.length > 0,
        type: target.type,
    };
}

function pickMainOutput(target: PconsMetadataTarget): string {
    if (target.outputs.length === 0) {
        return "";
    }

    if (target.type !== "program") {
        return target.outputs[0];
    }

    // Prefer the real executable when extra linker artifacts are present.
    const executableCandidate = target.outputs.find((output) => {
        const name = output.toLowerCase();
        return !name.endsWith(".pdb")
            && !name.endsWith(".ilk")
            && !name.endsWith(".exp")
            && !name.endsWith(".lib")
            && !name.endsWith(".dylib")
            && !name.endsWith(".so")
            && !name.endsWith(".a");
    });

    return executableCandidate ?? target.outputs[0];
}

function stripBuildDirPrefix(outputPath: string, buildDir: string): string {
    const normalizedOutput = outputPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const normalizedBuildDir = buildDir
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");

    if (normalizedBuildDir.length === 0 || normalizedBuildDir === ".") {
        return normalizedOutput;
    }

    const prefix = `${normalizedBuildDir}/`;
    if (normalizedOutput.startsWith(prefix)) {
        return normalizedOutput.substring(prefix.length);
    }

    return normalizedOutput;
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


export async function getTests(ext: Pcons): Promise<string[]> {
    return codeCommand<string[]>(ext, 'get-tests');
}

export async function getTestSuites(ext: Pcons): Promise<TestSuiteInfo> {
    return codeCommand<TestSuiteInfo>(ext, 'get-test-suites');
}

export async function generate(ext: Pcons, debug = false) {
    let args = ['-B', ext.buildPath, '-b', `${ext.projectRoot}/pcons-build.py`];
    const variables = ext.getConfig<Object>('variables');
    if (variables !== undefined) {
        for (const [key, value] of Object.entries(variables)) {
            args.push(`${key}=${value}`);
        }
    }
    args.push(...getLogArgs());

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
        await channelExec('build', [...args], undefined, true, ext.projectRoot, ext.buildDiagnostics);
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

export async function test(ext: Pcons) {
    let args = baseArgs(ext);
    args.push(...ext.tests);
    return channelExec('test', args, undefined, true, ext.projectRoot);
}
