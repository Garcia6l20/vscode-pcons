import * as path from 'path';
import { promises as fsPromises } from 'fs';
import {
    readMetadata,
    metadataFilePath,
    PconsMetadata,
    PconsMetadataTarget,
    PconsMetadataAlias,
    PconsMetadataTest,
    TargetType,
} from './metadata';
import { TestInfo, TestSuiteInfo } from './testAdapter';

export { TargetType };

type Environment = Record<string, string>;

// Proxy that owns the parsed metadata for one build folder.
export class BuildInfo {
    private _raw: PconsMetadata | undefined;
    private _buildPath: string | undefined;

    constructor(readonly projectRoot: string) { }

    get isLoaded(): boolean { return this._raw !== undefined; }
    get raw(): PconsMetadata | undefined { return this._raw; }
    get buildPath(): string | undefined { return this._buildPath; }

    async load(buildPath: string): Promise<void> {
        this._raw = await readMetadata(buildPath);
        this._buildPath = buildPath;
    }

    // Loads only if the metadata file is newer than all tracked source files.
    // Returns true when metadata is now loaded, false when stale or missing.
    async tryLoadFresh(buildPath: string): Promise<boolean> {
        const metaPath = metadataFilePath(buildPath);
        let metaStat: import('fs').Stats;
        try {
            metaStat = await fsPromises.stat(metaPath);
        } catch {
            return false;
        }

        let raw: PconsMetadata | undefined;
        try {
            raw = await readMetadata(buildPath);
        } catch {
            return false;
        }
        if (!raw) { return false; }

        for (const filePath of buildScriptFiles(this.projectRoot, raw)) {
            try {
                const stat = await fsPromises.stat(filePath);
                if (stat.mtimeMs > metaStat.mtimeMs) { return false; }
            } catch {
                // file doesn't exist, skip
            }
        }

        this._raw = raw;
        this._buildPath = buildPath;
        return true;
    }

    clear(): void {
        this._raw = undefined;
        this._buildPath = undefined;
    }

    // Returns all targets and aliases as Target objects.
    targets(): Target[] {
        if (!this._raw) { return []; }
        const targets = this._raw.projects.flatMap(project =>
            project.targets.map(t => new Target(t, this.projectRoot, project.build_dir))
        );
        const targetNames = new Set(targets.map(t => t.fullname));
        const aliases = this._raw.projects.flatMap(p => p.aliases)
            .filter(a => !targetNames.has(a.name))
            .map(a => new Target(a, this.projectRoot));
        return [...targets, ...aliases];
    }

    // Returns test identifiers in the form "targetFullname:testName".
    tests(): string[] {
        if (!this._raw) { return []; }
        const tests: string[] = [];
        for (const project of this._raw.projects) {
            for (const t of project.targets) {
                if (!t.test) { continue; }
                const target = new Target(t, this.projectRoot, project.build_dir);
                tests.push(`${target.fullname}:${t.test.name}`);
            }
        }
        tests.sort();
        return tests;
    }

    rawTargets(): PconsMetadataTarget[] {
        return this._raw?.projects.flatMap(p => p.targets) ?? [];
    }

    findRawTarget(name: string): PconsMetadataTarget | undefined {
        return this.rawTargets().find(t => t.name === name);
    }

    // Resolves a dependency name to its build-relative output path.
    resolveBuildPath(depName: string): string | undefined {
        if (!this._raw) { return undefined; }
        for (const project of this._raw.projects) {
            const t = project.targets.find(m => m.name === depName);
            if (!t || t.outputs.length === 0) { continue; }
            const buildDir = project.build_dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
            const raw = t.outputs[0].replace(/\\/g, '/').replace(/^\.\//, '');
            const prefix = buildDir + '/';
            return raw.startsWith(prefix) ? raw.substring(prefix.length) : raw;
        }
        return undefined;
    }

    rootProjectName(): string | undefined {
        if (!this._raw) { return undefined; }
        return (this._raw.projects.find(p => p.parent === null) ?? this._raw.projects[0])?.name;
    }

    // Constructs a test suite hierarchy based on the metadata.
    getTestSuites(): TestSuiteInfo {
        if (!this._raw || !this._buildPath) {
            throw new Error('Metadata is not loaded');
        }

        const rootName = this.rootProjectName() ?? 'pcons';
        const root: TestSuiteInfo = {
            id: `pcons:${rootName}`,
            label: rootName,
            type: 'suite',
            children: [],
        };

        // Collect all test specs first so we can compute prefix groups.
        type TestEntry = { target: Target; raw: PconsMetadataTarget; spec: PconsMetadataTest };
        const entries: TestEntry[] = [];
        for (const project of this._raw.projects) {
            for (const t of project.targets) {
                if (t.test === undefined) { continue; }
                entries.push({ target: new Target(t, this.projectRoot, project.build_dir), raw: t, spec: t.test });
            }
        }

        const specNames = entries.map(e => e.spec.name);

        for (const { target: targetObj, raw: t, spec } of entries) {
            const testId = `${targetObj.fullname}:${spec.name}`;
            const { group, suffix } = computeTestGroup(spec.name, specNames);
            const program = spec.command.length > 0 ? spec.command[0] : undefined;

            const testInfo: TestInfo = {
                id: testId,
                label: suffix,
                testName: spec.name,
                type: 'test',
                file: path.resolve(this.projectRoot, t.defined_at.file),
                line: t.defined_at.line - 1,
                target: targetObj.fullname,
                workingDirectory: spec.cwd ? path.resolve(this.projectRoot, spec.cwd) : this._buildPath,
                args: spec.command.slice(1),
                program: program,
                debuggable: program !== undefined,
                dependencies: t.dependencies
                    .map(dep => this.resolveBuildPath(dep))
                    .filter((d): d is string => d !== undefined),
                out: path.join(this._buildPath, `${testId}.out`),
                err: path.join(this._buildPath, `${testId}.err`),
            };

            const existing = root.children.find(
                c => c.type === 'suite' && c.id === `group:${group}`
            ) as TestSuiteInfo | undefined;
            if (existing) {
                existing.children.push(testInfo);
            } else {
                root.children.push({
                    id: `group:${group}`,
                    label: group,
                    type: 'suite',
                    children: [testInfo],
                });
            }
        }

        return root;
    }

    // Set of source files that should invalidate the metadata when modified.
    buildScriptFiles(): Set<string> {
        return buildScriptFiles(this.projectRoot, this._raw);
    }
}

function longestCommonPrefix(a: string, b: string): string {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) { i++; }
    return a.slice(0, i);
}

function computeTestGroup(name: string, allNames: string[]): { group: string; suffix: string } {
    let bestGroup = '';
    for (const other of allNames) {
        if (other === name) { continue; }
        const lcp = longestCommonPrefix(name, other);
        const dashIdx = lcp.lastIndexOf('-');
        const snapped = dashIdx >= 0 ? lcp.slice(0, dashIdx) : '';
        if (snapped.length > bestGroup.length) { bestGroup = snapped; }
    }
    if (bestGroup) {
        return { group: bestGroup, suffix: name.slice(bestGroup.length + 1) };
    }
    const lastDash = name.lastIndexOf('-');
    return lastDash >= 0
        ? { group: name.slice(0, lastDash), suffix: name.slice(lastDash + 1) }
        : { group: name, suffix: name };
}

function buildScriptFiles(projectRoot: string, raw: PconsMetadata | undefined): Set<string> {
    const files = new Set<string>();
    files.add(path.join(projectRoot, 'pcons-build.py'));
    if (raw) {
        for (const target of raw.projects.flatMap(p => p.targets)) {
            files.add(path.resolve(projectRoot, target.defined_at.file));
        }
    }
    return files;
}

// Target is a runtime proxy that wraps raw metadata objects.
// It exposes normalized helpers used throughout the extension
// (fullname, output, buildPath, executable).
export class Target {
    private readonly metadata: PconsMetadataTarget | PconsMetadataAlias | PconsMetadataTest;

    public readonly name: string;
    public readonly fullname: string;
    public readonly output: string | undefined;
    public readonly srcPath: string;
    public readonly buildPath: string;
    public readonly executable: boolean;
    public readonly type: TargetType;
    public readonly env?: Environment;

    constructor(obj: PconsMetadataTarget | PconsMetadataAlias | PconsMetadataTest, projectRoot?: string, buildDir?: string) {
        this.metadata = obj;

        if ((obj as PconsMetadataAlias).entries !== undefined) {
            const a = obj as PconsMetadataAlias;
            this.name = a.name;
            this.fullname = a.name;
            this.output = "";
            this.srcPath = projectRoot ?? "";
            this.buildPath = projectRoot ?? "";
            this.executable = false;
            this.type = TargetType.Alias;
            return;
        }

        const mt = obj as PconsMetadataTarget;
        if (mt.outputs !== undefined) {
            const mainOutput = pickMainOutput(mt);
            const buildTargetName = stripBuildDirPrefix(mainOutput, buildDir ?? "");

            this.name = mt.name;
            this.fullname = buildTargetName.length > 0 ? buildTargetName : mt.name;
            this.output = mainOutput.length > 0 && projectRoot ? path.resolve(projectRoot, mainOutput) : undefined;
            this.srcPath = mt.sources.length > 0 && projectRoot ? path.resolve(projectRoot, path.dirname(mt.sources[0])) : (projectRoot ?? "");
            this.buildPath = this.output ? path.dirname(this.output) : (projectRoot ?? "");
            this.executable = mt.type === TargetType.Program && mainOutput.length > 0;
            this.type = mt.type as TargetType;
            return;
        }

        const tt = obj as PconsMetadataTest;
        this.name = tt.name ?? "";
        this.fullname = tt.name ?? "";
        this.output = "";
        this.srcPath = projectRoot ?? "";
        this.buildPath = projectRoot ?? "";
        this.executable = false;
        this.type = TargetType.Test;
    }

    public get dependencies(): string[] {
        if (!('dependencies' in this.metadata)) {
            return [];
        }
        return this.metadata.dependencies;
    }

    public getUnderlyingMetadata(): PconsMetadataTarget | PconsMetadataAlias | PconsMetadataTest | undefined {
        return this.metadata;
    }
}

function pickMainOutput(target: PconsMetadataTarget): string {
    if (target.outputs.length === 0) {
        return "";
    }

    if (target.type !== TargetType.Program) {
        return target.outputs[0];
    }

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

function stripBuildDirPrefix(outputPath: string, buildDir: string | undefined): string {
    if (!buildDir) {
        return outputPath.replace(/\\/g, "/").replace(/^\.\//, "");
    }

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

export function isTarget(object: unknown): object is Target {
    return object instanceof Target;
}
