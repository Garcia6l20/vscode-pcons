import { promises as fsPromises } from "fs";
import * as path from "path";
import { TargetType } from "./targets";

export interface TargetDefinitionLocation {
    file: string;
    line: number;
    function?: string;
}

export interface PconsMetadataTarget {
    name: string;
    type: TargetType;
    is_default: boolean;
    dependencies: string[];
    sources: string[];
    outputs: string[];
    defined_at: TargetDefinitionLocation;
    test?: PconsMetadataTest;
}

export interface PconsMetadataTest {
    name: string;
    command: string[];
    cwd: string | null;
    env: Record<string, string>;
    labels: string[];
    timeout: number | null;
    should_fail: boolean;
    serial: boolean;
    disabled: boolean;
    data: string[];
    depends_on: string[];
    defined_at: string;
}

export interface PconsMetadataAlias {
    name: string;
    entries: string[];
}

export interface PconsProjectMetadata {
    name: string;
    root_dir: string;
    build_dir: string;
}

export interface PconsMetadata {
    schema_version: number;
    generator: string;
    project: PconsProjectMetadata;
    targets: PconsMetadataTarget[];
    aliases: PconsMetadataAlias[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) {
        return false;
    }
    return Object.values(value).every((v) => typeof v === "string");
}

function isPconsMetadataTest(value: unknown): value is PconsMetadataTest {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.name !== "string") {
        return false;
    }
    if (!Array.isArray(value.command) || !value.command.every((c: unknown) => typeof c === "string")) {
        return false;
    }
    if (!(typeof value.cwd === "string" || value.cwd === null)) {
        return false;
    }
    if (!isStringRecord(value.env)) {
        return false;
    }
    if (!isStringArray(value.labels)) {
        return false;
    }
    if (!(typeof value.timeout === "number" || value.timeout === null)) {
        return false;
    }
    if (typeof value.should_fail !== "boolean") {
        return false;
    }
    if (typeof value.serial !== "boolean") {
        return false;
    }
    if (typeof value.disabled !== "boolean") {
        return false;
    }
    if (!isStringArray(value.data)) {
        return false;
    }
    if (!isStringArray(value.depends_on)) {
        return false;
    }
    if (typeof value.defined_at !== "string") {
        return false;
    }
    return true;
}

function isTargetDefinitionLocation(value: unknown): value is TargetDefinitionLocation {
    if (!isRecord(value)) {
        return false;
    }

    if (typeof value.file !== "string") {
        return false;
    }

    if (typeof value.line !== "number") {
        return false;
    }

    if (value.function !== undefined && typeof value.function !== "string") {
        return false;
    }

    return true;
}

function isPconsMetadataTarget(value: unknown): value is PconsMetadataTarget {
    if (!isRecord(value)) {
        return false;
    }

    const base = typeof value.name === "string"
        && typeof value.type === "string"
        && typeof value.is_default === "boolean"
        && isStringArray(value.dependencies)
        && isStringArray(value.sources)
        && isStringArray(value.outputs)
        && isTargetDefinitionLocation(value.defined_at);

    if (!base) {
        return false;
    }

    if (value.test !== undefined) {
        return isPconsMetadataTest(value.test);
    }

    return true;
}

function isPconsMetadataAlias(value: unknown): value is PconsMetadataAlias {
    if (!isRecord(value)) {
        return false;
    }

    return typeof value.name === "string"
        && isStringArray(value.entries);
}

function isPconsProjectMetadata(value: unknown): value is PconsProjectMetadata {
    if (!isRecord(value)) {
        return false;
    }

    return typeof value.name === "string"
        && typeof value.root_dir === "string"
        && typeof value.build_dir === "string";
}

export function isPconsMetadata(value: unknown): value is PconsMetadata {
    if (!isRecord(value)) {
        return false;
    }

    return typeof value.schema_version === "number"
        && typeof value.generator === "string"
        && isPconsProjectMetadata(value.project)
        && Array.isArray(value.targets)
        && value.targets.every(isPconsMetadataTarget)
        && Array.isArray(value.aliases)
        && value.aliases.every(isPconsMetadataAlias);
}

export function metadataFilePath(buildPath: string, fileName: string = "pcons_metadata.json"): string {
    return path.join(buildPath, fileName);
}

export function parseMetadata(data: string): PconsMetadata {
    const parsed: unknown = JSON.parse(data);
    if (!isPconsMetadata(parsed)) {
        throw new Error("Invalid pcons metadata payload");
    }
    return parsed;
}

export async function readMetadata(
    buildPath: string,
    fileName: string = "pcons_metadata.json"
): Promise<PconsMetadata | undefined> {
    const filePath = metadataFilePath(buildPath, fileName);

    try {
        const data = await fsPromises.readFile(filePath, "utf8");
        return parseMetadata(data);
    } catch (error) {
        const enoent = isRecord(error) && error.code === "ENOENT";
        if (enoent) {
            return undefined;
        }
        throw error;
    }
}

export function findMetadataTarget(
    metadata: PconsMetadata,
    targetName: string
): PconsMetadataTarget | undefined {
    return metadata.targets.find((target) => target.name === targetName);
}
