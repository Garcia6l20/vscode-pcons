type Environment = Record<string, string>;

import { PconsMetadataTarget, PconsMetadataAlias, PconsMetadataTest, TargetType } from './metadata';

// re-export TargetType
export { TargetType } from './metadata';

// Target is a runtime proxy that wraps raw metadata objects
// (`PconsMetadataTarget` / `PconsMetadataAlias` / `PconsMetadataTest`).
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

        // Alias objects
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

        // Metadata target
        const mt = obj as PconsMetadataTarget;
        if (mt.outputs !== undefined) {
            const mainOutput = pickMainOutput(mt);
            const buildTargetName = stripBuildDirPrefix(mainOutput, buildDir ?? "");

            this.name = mt.name;
            this.fullname = buildTargetName.length > 0 ? buildTargetName : mt.name;
            this.output = mainOutput.length > 0 && projectRoot ? require('path').resolve(projectRoot, mainOutput) : undefined;
            this.srcPath = mt.sources.length > 0 && projectRoot ? require('path').resolve(projectRoot, require('path').dirname(mt.sources[0])) : (projectRoot ?? "");
            this.buildPath = this.output ? require('path').dirname(this.output) : (projectRoot ?? "");
            this.executable = mt.type === TargetType.Program && mainOutput.length > 0;
            this.type = mt.type as TargetType;
            return;
        }

        // Fallback for test objects or unknown shapes
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

export function isTarget(object: any): object is Target {
    return object instanceof Target;
}
