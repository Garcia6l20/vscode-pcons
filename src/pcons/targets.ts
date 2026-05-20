type Environment = Record<string, string>;

export enum TargetType {
    Program = "program",
    Library = "library",
    Test = "test",
    Alias = "alias",
}
import { PconsMetadataTarget, PconsMetadataAlias, PconsMetadataTest } from './metadata';

export interface LegacyTargetShape {
    name: string;
    fullname: string;
    output: string;
    srcPath: string;
    buildPath: string;
    executable: boolean;
    type: TargetType;
    env?: Environment;
}

// Target is a runtime proxy that wraps either raw metadata objects
// (`PconsMetadataTarget` / `PconsMetadataAlias` / `PconsMetadataTest`)
// or the legacy normalized shape. It exposes normalized helpers used
// throughout the extension (fullname, output, buildPath, executable).
export class Target {
    private readonly metadata?: PconsMetadataTarget | PconsMetadataAlias | PconsMetadataTest;

    public readonly name: string;
    public readonly fullname: string;
    public readonly output: string;
    public readonly srcPath: string;
    public readonly buildPath: string;
    public readonly executable: boolean;
    public readonly type: TargetType;
    public readonly env?: Environment;

    constructor(obj: PconsMetadataTarget | PconsMetadataAlias | PconsMetadataTest | LegacyTargetShape, projectRoot?: string, buildDir?: string) {
        // If the caller passed a normalized shape, just copy fields.
        if ((obj as LegacyTargetShape).fullname !== undefined && (obj as LegacyTargetShape).output !== undefined) {
            const s = obj as LegacyTargetShape;
            this.metadata = undefined;
            this.name = s.name;
            this.fullname = s.fullname;
            this.output = s.output;
            this.srcPath = s.srcPath;
            this.buildPath = s.buildPath;
            this.executable = s.executable;
            this.type = s.type;
            this.env = s.env;
            return;
        }

        // Otherwise assume it's one of the metadata shapes and store it.
        this.metadata = obj as PconsMetadataTarget | PconsMetadataAlias | PconsMetadataTest;

        // Alias objects
        if ((this.metadata as PconsMetadataAlias).entries !== undefined) {
            const a = this.metadata as PconsMetadataAlias;
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
        const mt = this.metadata as PconsMetadataTarget;
        if (mt.outputs !== undefined) {
            const mainOutput = pickMainOutput(mt);
            const buildTargetName = stripBuildDirPrefix(mainOutput, buildDir ?? "");

            this.name = mt.name;
            this.fullname = buildTargetName.length > 0 ? buildTargetName : mt.name;
            this.output = mainOutput.length > 0 && projectRoot ? require('path').resolve(projectRoot, mainOutput) : "";
            this.srcPath = mt.sources.length > 0 && projectRoot ? require('path').resolve(projectRoot, require('path').dirname(mt.sources[0])) : (projectRoot ?? "");
            this.buildPath = this.output.length > 0 ? require('path').dirname(this.output) : (projectRoot ?? "");
            this.executable = mt.type === TargetType.Program && mainOutput.length > 0;
            this.type = mt.type as TargetType;
            return;
        }

        // Fallback for test objects or unknown shapes
        const tt = this.metadata as PconsMetadataTest;
        this.name = tt.name ?? "";
        this.fullname = tt.name ?? "";
        this.output = "";
        this.srcPath = projectRoot ?? "";
        this.buildPath = projectRoot ?? "";
        this.executable = false;
        this.type = TargetType.Test;
    }

    public get dependencies(): string[] {
        if (!this.metadata || !('dependencies' in this.metadata)) {
            return [];
        }
        return (this.metadata as PconsMetadataTarget).dependencies ?? [];
    }

    public getUnderlyingMetadata(): PconsMetadataTarget | PconsMetadataAlias | PconsMetadataTest | undefined {
        return this.metadata;
    }
}

function pickMainOutput(target: PconsMetadataTarget): string {
    if (target.outputs.length === 0) {
        return "";
    }

    if (target.type !== "program") {
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
