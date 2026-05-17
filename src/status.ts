import * as vscode from 'vscode';
import { Pcons } from './extension';
import { Target } from './pcons/targets';

// Button class
abstract class Button {
    readonly settingsName: string | null = null;
    protected readonly button: vscode.StatusBarItem;
    private _forceHidden: boolean = false;
    private _hidden: boolean = false;
    private _text: string = '';
    private _tooltip: string | null = null;
    private _icon: string | null = null;

    constructor(protected readonly priority: number) {
        this.button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, this.priority);
    }

    protected set command(v: string | null) { this.button.command = v || undefined; }
    protected set icon(v: string | null) { this._icon = v ? `$(${v})` : null; }
    get tooltip(): string | null { return this._tooltip; }
    set tooltip(v: string | null) {
        this._tooltip = v;
        this.update();
    }

    get hidden() { return this._hidden; }
    set hidden(v: boolean) {
        this._hidden = v;
        this.update();
    }
    protected isVisible(): boolean { return !this.hidden; }

    get bracketText(): string { return `[${this._text}]`; }

    set text(text:string) {
        this._text = text;
    }

    protected getTextNormal(): string {
        if (this._text.length > 0) {
            return this.bracketText;
        }
        return '';
    }

    private _getText(icon: boolean = false): string {
        if(this._icon) {
            return this._icon;
        }
        return this.getTextNormal();
    }
    dispose(): void { this.button.dispose(); }
    update(): void {
        if (!this.isVisible() || this._forceHidden) {
            this.button.hide();
            return;
        }
        const text = this._getText(true);
        if (text === '') {
            this.button.hide();
            return;
        }
        this.button.text = text;
        this.button.tooltip = this._tooltip || undefined;
        this.button.show();
    }
}


class BuildButton extends Button {
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.build';
        this.text = 'Build';
        this.icon = 'gear';
        this.tooltip = 'Build the selected target(s) in the terminal window';
        ext.launchTargetChanged.event((target: Target|undefined) => {
            this.target = target;
        });
    }

    private _target: Target | undefined = undefined;

    set target(v: Target | undefined) {
        this._target = v;
        this.update();
    }

    protected getTooltipNormal(): string | null {
        if (!!this._target) {
            return `${this.tooltip}: [${this._target}]`;
        }
        return this.tooltip;
    }
}

class LaunchButton extends Button {
    settingsName = 'launch';
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.run';
        this.icon = 'play';
        this.text = 'Run';
        this.tooltip = 'Launch the selected target in the terminal window';
        ext.launchTargetChanged.event((target: Target | undefined) => {
            this.target = target;
        });
    }

    private _target: Target | undefined = undefined;

    set target(v: Target | undefined) {
        this._target = v;
        this.update();
    }

    protected getTooltipNormal(): string | null {
        if (!!this._target) {
            return `${this.tooltip}: [${this._target}]`;
        }
        return this.tooltip;
    }
}

class DebugButton extends Button {
    settingsName = 'debug';
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.debug';
        this.icon = 'debug-alt';
        this.text = 'Debug';
        this.tooltip = 'Debug the selected target in the terminal window';
        ext.launchTargetChanged.event((target: Target | undefined) => {
            this.target = target;
        });
    }

    private _target: Target | undefined = undefined;

    set target(v: Target | undefined) {
        this._target = v;
        this.update();
    }

    protected getTooltipNormal(): string | null {
        if (!!this._target) {
            return `${this.tooltip}: [${this._target}]`;
        }
        return this.tooltip;
    }
}

class TestButton extends Button {
    settingsName = 'test';
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.test';
        this.icon = 'beaker';
        this.text = 'Test';
        this.tooltip = 'Test the selected target(s) in the terminal window';
    }
}

class SelectLaunchTargetButton extends Button {
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.selectLaunchTarget';
        this.text = 'none';
        this.tooltip = 'Select run/debug target';
        ext.launchTargetChanged.event((target: Target | undefined) => {
            this.text = target?.name ?? 'none';
            this.update();
        });
    }
}

class SelectBuildTypeButton extends Button {
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.selectBuildType';
        this.text = 'debug';
        this.tooltip = 'Select build type';
        ext.buildTypeChanged.event((type: string) => {
            this.text = type;
            this.update();
        });
    }
}

class SelectBuildTargetsButton extends Button {
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.selectBuildTargets';
        this.text = 'all';
        this.tooltip = 'Select build targets';
        ext.buildTargetsChanged.event((targets: Target[]) => {
            if (targets.length === 0) {
                this.text = 'all';
            } else if(targets.length === 1) {
                this.text = targets[0].name;
            } else {
                this.text = 'multiple';
            }
            this.update();
        });
    }
}

class SelectTestTargetsButton extends Button {
    constructor(ext: Pcons, protected readonly priority: number) {
        super(priority);
        this.command = 'pcons.selectTestTargets';
        this.text = 'test all';
        this.tooltip = 'Select test(s)';
        ext.testsChanged.event((tests: string[]) => {
            if (tests.length === 0) {
                this.text = 'test all';
            } else if(tests.length === 1) {
                this.text = `test ${tests[0]}`;
            } else {
                this.text = 'test multiple';
            }
            this.update();
        });
    }
}

export class StatusBar implements vscode.Disposable {

  private readonly _buttons: Button[];
    constructor(ext: Pcons) {
        this._buttons = [
        new SelectBuildTypeButton(ext, 0.95),
        new SelectLaunchTargetButton(ext, 0.9),
        new DebugButton(ext, 0.8),
        new LaunchButton(ext, 0.7),
        new SelectBuildTargetsButton(ext, 0.5),
        new BuildButton(ext, 0.4),
        new SelectTestTargetsButton(ext, 0.2),
        new TestButton(ext, 0.1),
    ];
    this.update();
  }
  dispose(): void { this._buttons.forEach(btn => btn.dispose()); }
  update(): void { this._buttons.forEach(btn => btn.update()); }
}
