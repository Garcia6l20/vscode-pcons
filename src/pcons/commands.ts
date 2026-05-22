import * as vscode from "vscode";
import * as path from "path";
import { channelExec, execInTerminal, getLogArgs } from "./run";
import { Pcons } from "../extension";
import { isTarget, Target } from "./targets";
import { TestSuiteInfo, TestInfo } from "./testAdapter";
import { DebuggerEnvironmentVariable } from "./debugger";
import { PconsMetadataAlias, PconsMetadataTarget, readMetadata, allAliases, rootProject, resolveBuildPath } from "./metadata";

export async function getTargets(ext: Pcons): Promise<Target[]> {
    const metadata = await readMetadata(ext.buildPath);
    if (metadata === undefined) {
        throw new Error(`pcons metadata not found in ${ext.buildPath}`);
    }

    const targets = metadata.projects.flatMap(project =>
        project.targets.map(target => metadataTargetToTarget(target, ext.projectRoot, project.build_dir))
    );
    const targetNames = new Set(targets.map(target => target.fullname));
    const aliases = allAliases(metadata)
        .filter(alias => !targetNames.has(alias.name))
        .map(alias => metadataAliasToTarget(alias, ext.projectRoot));

    return [...targets, ...aliases];
}

function metadataTargetToTarget(
    target: PconsMetadataTarget,
    projectRoot: string,
    buildDir: string
): Target {
    return new Target(target, projectRoot, buildDir);
}

function metadataAliasToTarget(alias: PconsMetadataAlias, projectRoot: string): Target {
    return new Target(alias, projectRoot, undefined);
}


export async function getTests(ext: Pcons): Promise<string[]> {
    const metadata = await readMetadata(ext.buildPath);
    if (!metadata) {
        throw new Error(`pcons metadata not found in ${ext.buildPath}`);
    }

    const tests: string[] = [];
    for (const project of metadata.projects) {
        for (const t of project.targets) {
            if (t.test === undefined) { continue; }
            const targetObj = metadataTargetToTarget(t, ext.projectRoot, project.build_dir);
            tests.push(`${targetObj.fullname}:${t.test.name}`);
        }
    }
    tests.sort();
    return tests;
}

export async function getTestSuites(ext: Pcons): Promise<TestSuiteInfo> {
    const metadata = await readMetadata(ext.buildPath);
    if (!metadata) {
        throw new Error(`pcons metadata not found in ${ext.buildPath}`);
    }

    const root: TestSuiteInfo = {
        id: `pcons:${rootProject(metadata).name}`,
        label: rootProject(metadata).name,
        type: 'suite',
        children: [],
    };

    for (const project of metadata.projects) {
        for (const t of project.targets) {
            if (t.test === undefined) { continue; }

            const targetObj = metadataTargetToTarget(t, ext.projectRoot, project.build_dir);
            const spec = t.test;
            const testId = `${targetObj.fullname}:${spec.name}`;
            const program = spec.command.length > 0 ? spec.command[0] : undefined;

            const testInfo: TestInfo = {
                id: testId,
                label: spec.name,
                type: 'test',
                file: path.resolve(ext.projectRoot, t.defined_at.file),
                line: t.defined_at.line - 1,
                target: targetObj.fullname,
                workingDirectory: spec.cwd ? path.resolve(ext.projectRoot, spec.cwd) : ext.buildPath,
                args: spec.command.slice(1),
                program: program,
                debuggable: program !== undefined,
                dependencies: t.dependencies
                    .map(dep => resolveBuildPath(dep, metadata))
                    .filter((d): d is string => d !== undefined),
                out: path.join(ext.buildPath, `${testId}.out`),
                err: path.join(ext.buildPath, `${testId}.err`),
            };

            const existing = root.children.find(
                c => c.type === 'suite' && (c as TestSuiteInfo).id === `target:${targetObj.fullname}`
            ) as TestSuiteInfo | undefined;
            if (existing) {
                existing.children.push(testInfo);
            } else {
                root.children.push({
                    id: `target:${targetObj.fullname}`,
                    label: targetObj.fullname,
                    type: 'suite',
                    children: [testInfo],
                });
            }
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
    if (!target || !target.executable || !target.output) {
        throw new Error('No executable launch target selected');
    }

    const targetDirectory = path.dirname(target.output);

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
