import * as vscode from "vscode";
import * as path from 'path';
import * as commands from "./commands";
import * as run from "./run";
import * as debuggerModule from './debugger';
import {
    RetireEvent,
    TestAdapter,
    TestEvent,
    TestLoadFinishedEvent,
    TestLoadStartedEvent,
    TestRunFinishedEvent,
    TestRunStartedEvent,
    TestSuiteEvent,
    TestSuiteInfo as APITestSuiteInfo,
    TestInfo as APITestInfo,
} from "vscode-test-adapter-api";
import { promises as fsPromises } from 'fs';
import { Log } from "vscode-test-adapter-util";
import { Pcons } from "../extension";
import { Target } from "./targets";
import { existsSync as fileExists } from 'fs';
import { Stream, getOutputChannel } from "./run";

export interface TestSuiteInfo extends APITestSuiteInfo {
    children: (TestSuiteInfo | TestInfo)[];
};

export interface TestInfo extends APITestInfo {
    /** The target ID associated to the test */
    target: string;

    /** The working directory of the test */
    workingDirectory: string;

    /** Arguments for the test */
    args?: string[];
    /** Resolved program path (absolute) */
    program?: string;
    /** Dependent test names that must be included/built before this test */
    dependencies?: string[];

    /** stdout file */
    out: string;
    /** stderr file */
    err: string;
};


export class pconsTestAdapter implements TestAdapter {
    private disposables: { dispose(): void }[] = [];
    private root: TestSuiteInfo | undefined = undefined;

    private readonly testsEmitter = new vscode.EventEmitter<
        TestLoadStartedEvent | TestLoadFinishedEvent
    >();
    private readonly testStatesEmitter = new vscode.EventEmitter<
        TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
    >();

    constructor(
        private readonly ext: Pcons,
        private readonly log: Log
    ) {
        this.log.info('Initializing pcons test adapter');

        this.disposables.push(
            this.testsEmitter,
            this.testStatesEmitter
        );
    }
    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }

    get workspaceFolder() {
        return this.ext.workspaceFolder;
    }
    async load(): Promise<void> {
        this.log.info('Loading pcons tests');
        this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

        try {
            this.root = await commands.getTestSuites(this.ext);
            this.testsEmitter.fire(<TestLoadFinishedEvent>{
                type: 'finished',
                suite: this.root,
            });
        } catch (e: any) {
            this.testsEmitter.fire(<TestLoadFinishedEvent>{
                type: 'finished',
                errorMessage: e.toString(),
            });
        }
    }

    getInfo(test: string, suite: TestSuiteInfo | undefined = undefined): TestInfo | TestSuiteInfo | undefined {
        if (suite === undefined) {
            suite = this.root;
        }
        if (suite === undefined) {
            return undefined;
        }
        if (test === suite.id) {
            return suite;
        }
        for (const child of suite.children) {
            if (child.id === test) {
                return child;
            }
            if (child.type === 'suite') {
                const info = this.getInfo(test, child);
                if (info !== undefined) {
                    return info;
                }
            }
        }
        return undefined;
    }

    private runnintTests: Stream[] = [];
    private escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async runTest(test: TestInfo): Promise<void> {
        this.testStatesEmitter.fire(<TestEvent>{ type: "test", test: test.id, state: "running" });
        // Use the test runner module directly and pass the manifest and a
        // regex that matches the test's name (label). Avoid unsupported
        // flags like -B/-q which the test runner doesn't accept.
        const channel = getOutputChannel();
        const manifestPath = path.join(this.ext.buildPath, 'tests.json');
        const nameRegex = `^${this.escapeRegex(test.label ?? '')}$`;

        channel.appendLine(`Running test ${test.id} with command: python -m pcons.test_runner --manifest ${manifestPath} -R ${nameRegex} -j 1`);

        let stream = new Stream('python', ['-m', 'pcons.test_runner', '--manifest', manifestPath, '-R', nameRegex, '-j', '1'], {
            cwd: this.ext.projectRoot,
        });

        let killed = false;
        this.runnintTests.push(stream);
        let out: string = '';
        stream.onLine((line, isError) => {
            out += line;
            channel.appendLine(line);
        });
        let res = await stream.finished();
        const index = this.runnintTests.indexOf(stream);
        this.runnintTests.splice(index, 1);
        let log: string = '';
        let logFile = path.join(test.out);
        if (fileExists(logFile)) {
            log += await fsPromises.readFile(logFile, 'utf-8');
        }
        logFile = path.join(test.err);
        if (fileExists(logFile)) {
            log += await fsPromises.readFile(logFile, 'utf-8');
        }
        let event = <TestEvent>{
            type: "test",
            test: test.id,
            file: test.file,
            line: test.line,
        };
        if (killed) {
            res = -1;
            log += 'KILLED\n';
        }
        if (log.length > 0) {
            event.message = log;
        } else {
            event.message = out;
        }
        if (res !== 0) {
            event.state = 'failed';
        } else {
            event.state = "passed";
        }
        this.testStatesEmitter.fire(event);
        this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished', testRunId: test.id });
    }

    async runSuite(suite: TestSuiteInfo): Promise<void> {
        let promises: Promise<void>[] = [];
        for (const test of suite.children) {
            if (test.type === 'test') {
                promises.push(this.runTest(test));
            } else {
                promises.push(this.runSuite(test));
            }
        }
        await Promise.all(promises);
    }

    getSuiteTargets(suite: TestSuiteInfo) {
        let targets: string[] = [];
        for (const info of suite.children) {
            if (info === undefined) {
                throw Error(`Cannot find infos of test ${test}`);
            }

            if (info.type === 'test') {
                targets.push(info.target);
            } else {
                for (const child of info.children) {
                    if (child.type === 'test') {
                        targets.push(child.target);
                    } else {
                        targets.push(...this.getSuiteTargets(child));
                    }
                }
            }
        }
        return targets;
    }

    getTargets(tests: string[]) {
        const targets: string[] = [];
        const seenTests = new Set<string>();

        const gather = (info: TestInfo | TestSuiteInfo) => {
            if (info.type === 'suite') {
                for (const child of info.children) {
                    gather(child as TestInfo | TestSuiteInfo);
                }
                return;
            }
            // info is TestInfo
            if (seenTests.has(info.id)) {
                return;
            }
            seenTests.add(info.id);
            if (info.dependencies) {
                targets.push(...info.dependencies);
            }
        };

        for (const test of tests) {
            const info = this.getInfo(test);
            if (info === undefined) {
                throw Error(`Cannot find infos of test ${test}`);
            }
            gather(info as TestInfo | TestSuiteInfo);
        }

        return targets;
    }

    async run(tests: string[]): Promise<void> {
        this.log.info(`Running tests ${JSON.stringify(tests)}`);

        this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests });
        await commands.build(this.ext, this.getTargets(tests), false);
        let promises: Promise<void>[] = [];
        for (const test of tests) {
            const info = this.getInfo(test);
            if (info === undefined) {
                throw Error(`Cannot find infos of test ${test}`);
            }
            if (info.type === 'test') {
                promises.push(this.runTest(info));
            } else {
                promises.push(this.runSuite(info));
            }
        }
        try {
            await Promise.all(promises);
            this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
        } catch (err) {
            this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
            throw err;
        }
    }
    async debug(tests: string[]): Promise<void> {
        for (const test of tests) {
            const info = this.getInfo(test);
            if (info === undefined) {
                throw Error(`Cannot find infos of test ${test}`);
            } else if (info.type === 'suite') {
                throw Error('Cannot debug a test suite');
            }
            // Build required targets including dependencies before debugging.
            const targetsToBuild = this.getTargets([test]);
            await commands.build(this.ext, targetsToBuild);

            let target: Target | undefined = undefined;
            for (const t of this.ext.targets) {
                if (t.fullname === info.program) {
                    target = t;
                    break;
                }
            }
            if (target === undefined) {
                throw Error(`Cannot find target ${info.program}`);
            }
            await debuggerModule.debug(target, info.args);
        }
    }
    cancel(): void {
        this.runnintTests.forEach((stream: Stream) => stream.kill());
    }
    get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
        return this.testsEmitter.event;
    }
    get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> {
        return this.testStatesEmitter.event;
    }
    retire?: vscode.Event<RetireEvent> | undefined;
    autorun?: vscode.Event<void> | undefined;
};
