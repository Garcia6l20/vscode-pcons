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
    return new Target(target, projectRoot, buildDir);
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
    return new Target(alias, projectRoot, undefined);
}


export async function getTests(ext: Pcons): Promise<string[]> {
    const metadata = await readMetadata(ext.buildPath);
    if (!metadata) {
        return codeCommand<string[]>(ext, 'get-tests');
    }

    const tests: string[] = [];
    for (const t of metadata.targets) {
        if ((t as any).test === undefined) {
            continue;
        }
        const targetObj = metadataTargetToTarget(t, ext.projectRoot, metadata.project.build_dir);
        const spec: any = (t as any).test;
        const testId = `${targetObj.fullname}:${spec.name}`;
        tests.push(testId);
    }
    tests.sort();
    return tests;
}

export async function getTestSuites(ext: Pcons): Promise<TestSuiteInfo> {
    // Prefer metadata when available so Test Explorer can use the
    // pre-generated metadata JSON instead of invoking the code interface.
    const metadata = await readMetadata(ext.buildPath);
    if (!metadata) {
        return codeCommand<TestSuiteInfo>(ext, 'get-test-suites');
    }

    const root: TestSuiteInfo = {
        id: `pcons:${metadata.project.name}`,
        label: metadata.project.name,
        type: 'suite',
        children: [],
    };

    for (const t of metadata.targets) {
        if ((t as any).test === undefined) {
            continue;
        }

        const targetObj = metadataTargetToTarget(t, ext.projectRoot, metadata.project.build_dir);
        const spec: any = (t as any).test;

        const testId = `${targetObj.fullname}:${spec.name}`;
        const program = spec.command && spec.command.length > 0
            ? spec.command[0]
            : undefined;

        const testInfo: TestInfo = {
            id: testId,
            label: spec.name,
            type: 'test',
            file: path.resolve(ext.projectRoot, t.defined_at.file),
            line: t.defined_at.line - 1, // Convert to 0-based line number
            target: targetObj.fullname,
            workingDirectory: spec.cwd ? path.resolve(ext.projectRoot, spec.cwd) : ext.buildPath,
            args: spec.command && Array.isArray(spec.command) ? spec.command.slice(1) : [],
            program: program,
            debuggable: program !== undefined,
            dependencies: t.dependencies,
            out: path.join(ext.buildPath, `${testId}.out`),
            err: path.join(ext.buildPath, `${testId}.err`),
        };

        // Group tests per-target under a suite
        const existing = root.children.find((c) => c.type === 'suite' && (c as TestSuiteInfo).id === `target:${targetObj.fullname}`) as TestSuiteInfo | undefined;
        if (existing) {
            existing.children.push(testInfo);
        } else {
            const suite: TestSuiteInfo = {
                id: `target:${targetObj.fullname}`,
                label: targetObj.fullname,
                type: 'suite',
                children: [testInfo],
            };
            root.children.push(suite);
        }
    }

    return root;
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
