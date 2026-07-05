// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as commands from './pcons/commands';
import * as debuggerModule from './pcons/debugger';
import { PconsCodeLensProvider } from './pcons/codelens';
import * as path from 'path';
import { Target, TargetType, BuildInfo } from './pcons/targets';
import { StatusBar } from './status';
import { pconsTestAdapter } from './pcons/testAdapter';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { Log, TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { str2cmdline } from './pcons/run';

class TargetPickItem {
	label: string;
	constructor(public readonly target: Target) {
		this.label = target.fullname;
	}
};

type StringMap = { [key: string]: string };

export class Pcons implements vscode.Disposable {
	codeConfig: vscode.WorkspaceConfiguration;
	workspaceFolder: vscode.WorkspaceFolder;
	projectRoot: string;
	targets: Target[];
	launchTarget: Target | undefined = undefined;
	launchTargetArguments: StringMap = {};
	_debugCommandArguments: string = "configure";
	_variant: string = 'Debug';
	variantChanged = new vscode.EventEmitter<string>();
	launchTargetChanged = new vscode.EventEmitter<Target | undefined>();
	buildTargets: Target[] = [];
	buildTargetsChanged = new vscode.EventEmitter<Target[]>();
	tests: string[] = [];
	testsChanged = new vscode.EventEmitter<string[]>();
	buildDiagnostics: vscode.DiagnosticCollection;
	readonly buildInfo: BuildInfo;
    private readonly _codeLensProvider: PconsCodeLensProvider;
	private _needsGenerate = true;
	private _buildScriptWatchers: vscode.Disposable[] = [];

	private readonly _statusBar = new StatusBar(this);

	constructor(public readonly extensionContext: vscode.ExtensionContext) {
		this.codeConfig = vscode.workspace.getConfiguration("pcons");
		this.buildDiagnostics = vscode.languages.createDiagnosticCollection('pcons');
		extensionContext.subscriptions.push(this.buildDiagnostics);
		if (vscode.workspace.workspaceFolders) {
			this.workspaceFolder = vscode.workspace.workspaceFolders[0];
			this.projectRoot = this.workspaceFolder.uri.fsPath;
		} else {
			throw new Error('Cannot resolve project root');
		}
		this.targets = [];
		this.buildInfo = new BuildInfo(this.projectRoot);
		this._codeLensProvider = new PconsCodeLensProvider(this);
		extensionContext.subscriptions.push(this._codeLensProvider);
		extensionContext.subscriptions.push(vscode.languages.registerCodeLensProvider(
			{ language: 'python', pattern: '**/pcons-build.py' },
			this._codeLensProvider,
		));
		vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
			this.codeConfig = vscode.workspace.getConfiguration("pcons");
		});
	}

	loadWorkspaceState() {
		const advancedCodeLens = this.extensionContext.workspaceState.get<boolean>('advancedCodeLens', false);
		this._codeLensProvider.setAdvancedMode(advancedCodeLens);

		this.tests = this.extensionContext.workspaceState.get<string[]>('selectedTests') ?? [];
		this.testsChanged.fire(this.tests);
		this.testsChanged.event((value: string[]) => {
			this.extensionContext.workspaceState.update('selectedTests', value);
		});

		this.buildTargets = this.extensionContext.workspaceState.get<Target[]>('buildTargets') ?? [];
		this.buildTargetsChanged.fire(this.buildTargets);
		this.buildTargetsChanged.event((value: Target[]) => {
			this.extensionContext.workspaceState.update('buildTargets', value);
		});

		this.launchTarget = this.extensionContext.workspaceState.get<Target>('launchTarget');
		this.launchTargetChanged.fire(this.launchTarget);
		this.launchTargetChanged.event((value: Target | undefined) => {
			this.extensionContext.workspaceState.update('launchTarget', value);
		});

		this.launchTargetArguments = this.extensionContext.workspaceState.get<StringMap>('launchTargetArguments', this.launchTargetArguments);
		this._debugCommandArguments = this.extensionContext.workspaceState.get<string>('debugCommandArguments', this._debugCommandArguments);

		this._variant = this.extensionContext.workspaceState.get<string>('variant', 'Debug');
		this.variantChanged.fire(this._variant);
		this.variantChanged.event((value: string) => {
			this.extensionContext.workspaceState.update('variant', value);
		});
	}

	getConfig<T>(name: string): T | undefined {
		return this.codeConfig.get<T>(name);
	}

	get variant(): string | undefined {
		return this._variant;
	}

	get buildPath(): string {
		const p = this.projectRoot + '/' + (this.getConfig<string>('buildFolder') ?? 'build');
		return p//
			.replace('${workspaceFolder}', this.workspaceFolder.uri.fsPath)//
			// Toolchain variable removed
			.replace('${variant}', this.variant ?? 'debug');
	}

	/**
	 * Create the instance
	 */
	static async create(context: vscode.ExtensionContext) {
		gExtension = new Pcons(context);

		await gExtension.registerCommands();
		await gExtension.onLoaded();
	}

	/**
	 * Dispose the instance
	 */
	dispose() {
		(async () => {
			this.cleanup();
		})();
	}

	async cleanup() {
		this._buildScriptWatchers.forEach(w => w.dispose());
		this._buildScriptWatchers = [];
	}

	private setupBuildScriptWatchers() {
		this._buildScriptWatchers.forEach(w => w.dispose());
		this._buildScriptWatchers = [];
		for (const filePath of this.buildInfo.buildScriptFiles()) {
			const watcher = vscode.workspace.createFileSystemWatcher(filePath);
			const invalidate = () => { this._needsGenerate = true; };
			watcher.onDidChange(invalidate);
			watcher.onDidCreate(invalidate);
			watcher.onDidDelete(invalidate);
			this._buildScriptWatchers.push(watcher);
		}
	}

	private sameTarget(a: Target, b: Target) {
		return a.fullname === b.fullname;
	}

	async refreshTargets() {
		this.targets = this.buildInfo.targets();

		const executableTargets = this.targets.filter((target) => target.executable);
		const resolvedLaunch = this.launchTarget !== undefined
			? executableTargets.find(t => this.sameTarget(t, this.launchTarget!))
			: executableTargets[0];
		const newLaunchTarget = resolvedLaunch ?? executableTargets[0];
		if (newLaunchTarget !== this.launchTarget) {
			this.launchTarget = newLaunchTarget;
			this.launchTargetChanged.fire(this.launchTarget);
		}

		if (this.buildTargets.length > 0) {
			const resolved = this.buildTargets
				.map(bt => this.targets.find(t => this.sameTarget(t, bt)))
				.filter((t): t is Target => t !== undefined);
			if (resolved.length !== this.buildTargets.length || resolved.some((t, i) => t !== this.buildTargets[i])) {
				this.buildTargets = resolved;
				this.buildTargetsChanged.fire(this.buildTargets);
			}
		}

		if (this.tests.length > 0) {
			const availableTests = new Set(this.buildInfo.tests());
			const validTests = this.tests.filter(t => availableTests.has(t));
			if (validTests.length !== this.tests.length) {
				this.tests = validTests;
				this.testsChanged.fire(this.tests);
			}
		}

		this._codeLensProvider.refresh();
	}

	private async promptOneOf(names: string[]): Promise<string | undefined> {
		if (names.length === 1) { return names[0]; }
		return vscode.window.showQuickPick(names, { placeHolder: 'Select target' });
	}

	private async promptAnyOf(names: string[]): Promise<string[] | undefined> {
		if (names.length === 1) { return names; }
		const pick = vscode.window.createQuickPick();
		pick.canSelectMany = true;
		pick.items = names.map(n => ({ label: n }));
		pick.selectedItems = pick.items;
		return new Promise(resolve => {
			let selected: string[] | undefined;
			pick.onDidAccept(() => {
				const s = pick.selectedItems.map(i => i.label);
				selected = s.length > 0 ? s : undefined;
				pick.hide();
			});
			pick.onDidHide(() => { pick.dispose(); resolve(selected); });
			pick.show();
		});
	}

	private findTarget(name: string): Target | undefined {
		const normalizedName = name.replace(/\\/g, '/').replace(/^\.\//, '');
		const buildDirName = path.basename(this.buildPath).replace(/\\/g, '/');
		const prefix = `${buildDirName}/`;
		const strippedName = normalizedName.startsWith(prefix)
			? normalizedName.substring(prefix.length)
			: normalizedName;

		return this.targets.find((target) =>
			target.fullname === name
			|| target.fullname === normalizedName
			|| target.fullname === strippedName
			|| target.name === name
		);
	}

	private async ensureTargetsLoaded(): Promise<void> {
		if (this.targets.length === 0) {
			await this.refreshTargets();
		}
	}

	async buildTarget(nameOrNames: string | string[]) {
		await this.ensureGenerated();
		await this.ensureTargetsLoaded();
		const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
		const selected = await this.promptAnyOf(names);
		if (!selected) { return; }
		const targets: Target[] = [];
		for (const name of selected) {
			const target = this.findTarget(name);
			if (target === undefined) {
				throw new Error(`Target not found: ${name}`);
			}
			if (target.type === TargetType.Test) {
				targets.push(...target.dependencies.map(dep => this.findTarget(dep)).filter((t): t is Target => t !== undefined));
			} else {
				targets.push(target);
			}
		}
		await commands.build(this, targets);
		this.notifyUpdated();
	}

	async runTarget(nameOrNames: string | string[]) {
		await this.ensureGenerated();
		await this.ensureTargetsLoaded();
		const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
		const name = await this.promptOneOf(names);
		if (!name) { return; }
		const target = this.findTarget(name);
		if (target === undefined) {
			throw new Error(`Target not found: ${name}`);
		}
		if (!target.executable) {
			throw new Error(`Target is not executable: ${name}`);
		}
		this.launchTarget = target;
		this.launchTargetChanged.fire(this.launchTarget);
		await this.ensureBuilt();
		await commands.run(this);
	}

	async runTargetWithArgs(nameOrNames: string | string[]) {
		await this.ensureGenerated();
		await this.ensureTargetsLoaded();
		const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
		const name = await this.promptOneOf(names);
		if (!name) { return; }
		const target = this.findTarget(name);
		if (target === undefined) {
			throw new Error(`Target not found: ${name}`);
		}
		if (!target.executable) {
			throw new Error(`Target is not executable: ${name}`);
		}
		this.launchTarget = target;
		this.launchTargetChanged.fire(this.launchTarget);
		await this.executableArguments(target.fullname);
		await this.ensureBuilt();
		const args = this.makeArgumentList(this.launchTargetArguments[target.fullname] ?? "");
		await commands.run(this, args);
	}

	async debugTarget(nameOrNames: string | string[]) {
		await this.ensureGenerated();
		await this.ensureTargetsLoaded();
		const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
		const name = await this.promptOneOf(names);
		if (!name) { return; }
		const target = this.findTarget(name);
		if (target === undefined) {
			throw new Error(`Target not found: ${name}`);
		}
		if (!target.executable) {
			throw new Error(`Target is not executable: ${name}`);
		}
		this.launchTarget = target;
		this.launchTargetChanged.fire(this.launchTarget);
		await this.ensureBuilt();
		const args = this.makeArgumentList(this.launchTargetArguments[this.launchTarget.fullname] ?? "");
		await debuggerModule.debug(this.launchTarget, args);
	}

	async debugTargetWithArgs(nameOrNames: string | string[]) {
		await this.ensureGenerated();
		await this.ensureTargetsLoaded();
		const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
		const name = await this.promptOneOf(names);
		if (!name) { return; }
		const target = this.findTarget(name);
		if (target === undefined) {
			throw new Error(`Target not found: ${name}`);
		}
		if (!target.executable) {
			throw new Error(`Target is not executable: ${name}`);
		}
		this.launchTarget = target;
		this.launchTargetChanged.fire(this.launchTarget);
		await this.executableArguments(target.fullname);
		await this.ensureBuilt();
		const args = this.makeArgumentList(this.launchTargetArguments[target.fullname] ?? "");
		await debuggerModule.debug(target, args);
	}

	async invalidateConfig() {
		this.targets = [];
		this.launchTarget = undefined;
		this.launchTargetChanged.fire(this.launchTarget);
		this.buildTargets = [];
		this.buildTargetsChanged.fire(this.buildTargets);
		this.tests = [];
		this.testsChanged.fire(this.tests);
	}

	async promptVariant() {
		const variants = this.getConfig<string[]>('variants');
		if (!variants || variants.length === 0) {
			vscode.window.showInformationMessage('No variant defined in configuration');
			return;
		}
		const variant = await vscode.window.showQuickPick(variants);
		if (variant && variant !== this._variant) {
			this._variant = variant;
			this.variantChanged.fire(this._variant);
			// buildPath depends on the variant, so the loaded metadata and
			// resolved target paths point at the old variant. Invalidate and
			// reload so run/debug/build use the new variant's build folder.
			this.buildInfo.clear();
			this.targets = [];
			this._needsGenerate = true;
			try {
				await this.ensureGenerated();
			} catch (e: any) {
				vscode.window.showErrorMessage(e.toString());
			}
		}
		return variant;
	}

	async promptLaunchTarget(fireEvent: boolean = true) {
		let targets = this.targets = this.buildInfo.targets();
		// Only programs are valid launch targets
		targets = targets.filter(t => t.executable === true && t.type === 'program');
		targets.sort((l, r) => l.fullname < r.fullname ? -1 : 1);
		let target = await vscode.window.showQuickPick(targets.map(t => t.fullname));
		if (fireEvent && target) {
			this.launchTarget = targets.filter(t => t.fullname === target)[0];
			this.launchTargetChanged.fire(this.launchTarget);
		}
		return target;
	}

	async promptBuildTargets() {
		let targets = this.targets = this.buildInfo.targets();
		// Exclude test-type targets from build target selection
		targets = targets.filter(t => t.type !== 'test');
		targets.sort((l, r) => l.fullname < r.fullname ? -1 : 1);
		let pick = vscode.window.createQuickPick<TargetPickItem>();
		pick.canSelectMany = true;
		pick.items = targets.map(t => new TargetPickItem(t));
		let promise = new Promise<Target[]>((res, rej) => {
			pick.show();
			pick.onDidAccept(() => {
				pick.hide();
			});
			pick.onDidHide(() => {
				if (pick.selectedItems.length === 0) {
					rej();
				} else {
					if (pick.selectedItems.length === pick.items.length) {
						res([]); // aka.: all
					} else {
						res(pick.selectedItems.map(pt => pt.target));
					}
				}
			});
		});
		try {
			targets = await promise;
			this.buildTargets = targets;
			this.buildTargetsChanged.fire(this.buildTargets);
		} finally {
			return this.buildTargets;
		}
	}

	async promptTests() {
		let tests = this.tests = this.buildInfo.tests();
		class TestPick {
			constructor(public label: string) { }
		};
		let pick = vscode.window.createQuickPick<TestPick>();
		pick.canSelectMany = true;
		pick.items = tests.map(t => new TestPick(t));
		let promise = new Promise<string[]>((res, rej) => {
			pick.show();
			pick.onDidAccept(() => {
				pick.hide();
			});
			pick.onDidHide(() => {
				res(pick.selectedItems.map(pt => pt.label));
			});
		});
		tests = await promise;
		pick.dispose();
		this.tests = tests;
		this.testsChanged.fire(this.tests);
		return this.tests;
	}

	async debuggerPath() {
		const debuggerPath = this.getConfig<string>('debuggerPath');
		if (debuggerPath) {
			return debuggerPath;
		}
	}

	async ensureGenerated() {
		if (!this._needsGenerate) {
			return;
		}
		if (await this.buildInfo.tryLoadFresh(this.buildPath)) {
			this._needsGenerate = false;
			this.setupBuildScriptWatchers();
			if (this.targets.length === 0) {
				await this.refreshTargets();
			}
			return;
		}
		await this.generate();
	}

	async ensureBuilt() {
		if (this.launchTarget) {
			await commands.build(this, [this.launchTarget]);
		}
	}

	notifyUpdated() {
		// no op for now
	}

	async generate(debug = false) {
		await commands.generate(this, debug);
		this._needsGenerate = false;
		await this.buildInfo.load(this.buildPath);
		await this.refreshTargets();
		this.setupBuildScriptWatchers();
		this.notifyUpdated();
		this.extensionContext.environmentVariableCollection.replace('PCONS_BUILD_DIR', this.buildPath);
		this.extensionContext.environmentVariableCollection.replace('PCONS_SOURCE_DIR', this.projectRoot);
	}

	async build(debug = false) {
		await this.ensureGenerated();
		await commands.build(this, this.buildTargets, debug);
		this.notifyUpdated();
	}

	async clean() {
		await commands.clean(this);
	}

	makeArgumentList(str: string) {
		const testsIndex = str.indexOf('${selectedTests}');
		if (testsIndex !== -1) {
			str = str.replace('${selectedTests}', this.tests.join(' '));
		}
		let args = str2cmdline(str, {
			workspaceFolder: this.workspaceFolder.uri.fsPath,
			rootFolder: this.projectRoot,
			buildFolder: this.buildPath,
			launchTarget: this.launchTarget?.fullname,
			targetSrcFolder: this.launchTarget?.srcPath,
			targetBuildFolder: this.launchTarget?.buildPath,
		});
		return args;
	}

	async run() {
		await this.ensureGenerated();
		if (!this.launchTarget || !this.launchTarget.executable) {
			await this.promptLaunchTarget();
		}
		if (this.launchTarget && this.launchTarget.executable) {
			await this.ensureBuilt();
			const args = this.makeArgumentList(this.launchTargetArguments[this.launchTarget.fullname] ?? "");
			await commands.run(this, args);
		}
	}

	async debug() {
		await this.ensureGenerated();
		if (!this.launchTarget || !this.launchTarget.executable) {
			await this.promptLaunchTarget();
		}
		if (this.launchTarget && this.launchTarget.executable) {
			await this.ensureBuilt();
			const args = this.makeArgumentList(this.launchTargetArguments[this.launchTarget.fullname] ?? "");
			await debuggerModule.debug(this.launchTarget, args);
		}
	}

	async test() {
		await this.ensureGenerated();
		await this.ensureTargetsLoaded();
		await this.buildForTest();
		await commands.test(this);
	}

	private async buildForTest() {
		if (!this.buildInfo.isLoaded) { return; }

		const rawTargets = this.buildInfo.rawTargets();
		const testTargetNames = this.tests.length > 0
			? [...new Set(this.tests.map(id => id.substring(0, id.indexOf(':'))))]
			: rawTargets.filter(t => t.type === TargetType.Test).map(t => t.name);

		const depNames = new Set<string>(
			testTargetNames.flatMap(name => rawTargets.find(m => m.name === name)?.dependencies ?? [])
		);

		const buildPaths = [...depNames]
			.map(dep => this.buildInfo.resolveBuildPath(dep))
			.filter((p): p is string => p !== undefined);

		if (buildPaths.length > 0) {
			await commands.build(this, buildPaths);
		}
	}

	async executableArguments(target?: string) {
		if (!target) {
			target = await this.promptLaunchTarget(false);
		}
		if (!target) { return; }
		const args = await vscode.window.showInputBox({
			title: `Set ${target} arguments`,
			value: this.launchTargetArguments[target]
		});
		if (args === undefined) { return; }
		this.launchTargetArguments[target] = args;
		this.extensionContext.workspaceState.update('launchTargetArguments', this.launchTargetArguments);
	}

	async debugWithArgs() {
		await this.executableArguments(this.launchTarget?.fullname);
		await this.debug();
	}

	async debugCommandArguments() {
		const args = await vscode.window.showInputBox({
			title: 'pcons command arguments',
			value: this._debugCommandArguments
		});
		if (args === undefined) { return; }
		this._debugCommandArguments = args;
		this.extensionContext.workspaceState.update('debugCommandArguments', this._debugCommandArguments);
		return this._debugCommandArguments;
	}

	async commandDebug() {
		const command = await this.debugCommandArguments();
		if (command === undefined) { return; }
		const args = this.makeArgumentList(command);
		await commands.debugExec(this, args);
	}

	async registerCommands() {
		const register = (id: string, callback: (...args: any[]) => any, thisArg?: any) => {
			this.extensionContext.subscriptions.push(
				vscode.commands.registerCommand(`pcons.${id}`, callback, thisArg)
			);
		};

		// register('scanToolchains', async () => commands.scanToolchains(this));
		register('generate', async () => this.generate());
		register('build', async () => this.build());
		register('debugGenerate', async () => this.generate(true));
		register('clean', async () => this.clean());
		register('run', async () => this.run());
		register('debug', async () => this.debug());
		register('test', async () => this.test());
		register('clearDiags', () => {
			this.buildDiagnostics.clear();
		});
		register('selectLaunchTarget', async () => this.promptLaunchTarget());
		register('selectBuildTargets', async () => this.promptBuildTargets());
		register('selectVariant', async () => this.promptVariant());
		register('selectTestTargets', async () => this.promptTests());
		// register('selectToolchain', async () => this.selectToolchain());
		// register('currentToolchain', async () => this.currentToolchain());
		register('executableArguments', async () => this.executableArguments());
		register('debugWithArgs', async () => this.debugWithArgs());
		register('commandDebug', async () => this.commandDebug());
		register('buildTarget', async (name: string) => this.buildTarget(name));
		register('runTarget', async (name: string) => this.runTarget(name));
		register('runTargetWithArgs', async (name: string) => this.runTargetWithArgs(name));
		register('debugTarget', async (name: string) => this.debugTarget(name));
		register('debugTargetWithArgs', async (name: string) => this.debugTargetWithArgs(name));
		register('toggleAdvancedCodeLensMode', async () => {
			this._codeLensProvider.toggleAdvancedMode();
			await this.extensionContext.workspaceState.update(
				'advancedCodeLens',
				this._codeLensProvider.isAdvancedMode()
			);
		});
	}

	async initTestExplorer() {
		// setup Test Explorer
		const testExplorerExtension = vscode.extensions.getExtension<TestHub>(
			testExplorerExtensionId
		);

		if (testExplorerExtension) {
			const testHub = testExplorerExtension.exports;
			const log = new Log('pconsTestExplorer', this.workspaceFolder, 'pcons Explorer Log');
			this.extensionContext.subscriptions.push(log);

			// this will register a CmakeAdapter for each WorkspaceFolder
			this.extensionContext.subscriptions.push(
				new TestAdapterRegistrar(
					testHub,
					(workspaceFolder) => new pconsTestAdapter(this, log),
					log
				)
			);
		}
	}


	async onLoaded() {
		vscode.commands.executeCommand("setContext", "inPconsProject", true);

		this.loadWorkspaceState();

		try {
			await this.ensureGenerated();
		} catch (e: any) {
			vscode.window.showErrorMessage(e.toString());
		}

		await this.initTestExplorer();
	}
};


export let gExtension: Pcons | null = null;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	await Pcons.create(context);
}

// This method is called when your extension is deactivated
export async function deactivate() {
	await gExtension?.cleanup();
}
