// /**
//  * Module for vscode-cpptools integration.
//  *
//  * This module uses the [vscode-cpptools API](https://www.npmjs.com/package/vscode-cpptools)
//  * to provide that extension with per-file configuration information.
import * as path from 'path';
import * as vscode from 'vscode';
import * as cpt from 'vscode-cpptools';
import { codeCommand } from './pcons/commands';
import { pcons } from './extension';

/**
 * The actual class that provides information to the cpptools extension. See
 * the `CustomConfigurationProvider` interface for information on how this class
 * should be used.
 */
export class ConfigurationProvider implements cpt.CustomConfigurationProvider {
    /** Our name visible to cpptools */
    readonly name = 'pcons';
    /** Our extension ID, visible to cpptools */
    readonly extensionId = 'pcons';

    private configurationCache: cpt.SourceFileConfigurationItem[] = [];

    constructor(private ext: pcons) {}

    private getWorkspaceBrowseConfiguration() {
        return codeCommand<cpt.WorkspaceBrowseConfiguration>(this.ext, 'get-workspace-browse-configuration');
    }


    resetCache() {
        this.configurationCache = [];
    }

    private async updateCache(uris: vscode.Uri[]) {
        const configs = await codeCommand<cpt.SourceFileConfigurationItem[]>(this.ext, 'get-source-configuration', ...uris.map(u => u.fsPath));
        for (const ii in configs) {
            let item = this.getCacheItem(configs[ii].uri);
            if (item !== undefined && !(item.uri instanceof vscode.Uri)) {
            }
            if (item === undefined) {
                let item = configs[ii];
                if (!(item.uri instanceof vscode.Uri)) {
                    item = {
                        uri: vscode.Uri.file(item.uri),
                        configuration: item.configuration
                    };
                }
                this.configurationCache.push(item);
            } else {
                configs[ii] = item;
            }
        }
    }

    private getCacheItem(uri: vscode.Uri | string): cpt.SourceFileConfigurationItem | undefined {
        if (!(uri instanceof vscode.Uri)) {
            uri = vscode.Uri.file(uri);
        }
        for (const item of this.configurationCache) {
            if (item.uri === uri || (item.uri instanceof vscode.Uri && item.uri.fsPath === uri.fsPath)) {
                return item;
            }
        }
        return undefined;
    }
    
    private getCacheItems(uris: vscode.Uri[]): cpt.SourceFileConfigurationItem[] {
        let result = [];
        for (const uri of uris) {
            const item = this.getCacheItem(uri);
            if (item !== undefined) {
                result.push(item);
            } else {
                console.warn(`cpptools.getCacheItems: item not found in cache (${uri})`);
            }
        }
        return result;
    }

    /**
     * Test if we are able to provide a configuration for the given URI
     * @param uri The URI to look up
     */
    async canProvideConfiguration(uri: vscode.Uri): Promise<boolean> {      
        const item =  this.getCacheItem(uri);
        if (item === undefined) {
            await this.updateCache([uri]);
            const available = this.getCacheItem(uri) !== undefined;
            if (!available) {
                console.debug(`cpptools.canProvideConfiguration: no config available for ${uri.fsPath}`);
            }
            return this.getCacheItem(uri) !== undefined;
        } else {
            return true;
        }
    }

    /**
     * Get the configurations for the given URIs. URIs for which we have no
     * configuration are simply ignored.
     * @param uris The file URIs to look up
     */
    async provideConfigurations(uris: vscode.Uri[]): Promise<cpt.SourceFileConfigurationItem[]> {
        return this.getCacheItems(uris);
    }

    /**
     * A request to determine whether this provider can provide a code browsing configuration for the workspace folder.
     * @param token (optional) The cancellation token.
     * @returns 'true' if this provider can provider a code browsing configuration for the workspace folder.
     */
    async canProvideBrowseConfiguration(): Promise<boolean> { return true; }

    /**
     * A request to get the code browsing configuration for the workspace folder.
     * @returns A [WorkspaceBrowseConfiguration](#WorkspaceBrowseConfiguration) with the information required to
     * construct the equivalent of `browse.path` from `c_cpp_properties.json`.
     */
    async provideBrowseConfiguration(): Promise<cpt.WorkspaceBrowseConfiguration> {
        return this.getWorkspaceBrowseConfiguration();
    }

    async canProvideBrowseConfigurationsPerFolder(): Promise<boolean> { return false; }

    async provideFolderBrowseConfiguration(_uri: vscode.Uri): Promise<cpt.WorkspaceBrowseConfiguration> {
        return this.getWorkspaceBrowseConfiguration();
    }

    /** No-op */
    dispose() { }
}
