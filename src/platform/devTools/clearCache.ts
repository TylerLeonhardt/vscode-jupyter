import { commands } from 'vscode';
import { IExtensionContext } from '../common/types';
import { noop } from '../common/utils/misc';

export function addClearCacheCommand(context: IExtensionContext, isDevMode: boolean) {
    if (!isDevMode) {
        return;
    }
    commands.registerCommand('dataScience.ClearCache', () => {
        // eslint-disable-next-line no-restricted-syntax
        for (const key of context.globalState.keys()) {
            context.globalState.update(key, undefined).then(noop, noop);
        }
        // eslint-disable-next-line no-restricted-syntax
        for (const key of context.workspaceState.keys()) {
            context.workspaceState.update(key, undefined).then(noop, noop);
        }
    });
}
