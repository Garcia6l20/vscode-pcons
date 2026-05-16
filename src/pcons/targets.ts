type Environment = Record<string, string>;

export interface Target {
    name: string;
    fullname: string;
    output: string;
    srcPath: string;
    buildPath: string;
    executable: boolean;
    type: string;
    env?: Environment;
};

export function isTarget(object: any): object is Target {
    return object instanceof Object
        && 'name' in object
        && 'fullname' in object
        && 'output' in object
        // && 'srcPath' in object // may not be available in older pcons versions
        && 'buildPath' in object
        && 'executable' in object
        && 'type' in object;
}
