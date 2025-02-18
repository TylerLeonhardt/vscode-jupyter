// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { IDisposable } from '../common/types';

export const IExtensionActivationManager = Symbol('IExtensionActivationManager');
/**
 * Responsible for activation of extension.
 *
 * @export
 * @interface IExtensionActivationManager
 * @extends {IDisposable}
 */
export interface IExtensionActivationManager extends IDisposable {
    /**
     * Method invoked when extension activates (invoked once).
     */
    activateSync(): void;
    /**
     * Method invoked when extension activates (invoked once).
     *
     * @returns {Promise<void>}
     * @memberof IExtensionActivationManager
     */
    activate(): Promise<void>;
}

export const IDownloadChannelRule = Symbol('IDownloadChannelRule');
export enum PlatformName {
    Windows32Bit = 'win-x86',
    Windows64Bit = 'win-x64',
    Mac64Bit = 'osx-x64',
    Linux64Bit = 'linux-x64'
}
export const IPlatformData = Symbol('IPlatformData');
export interface IPlatformData {
    readonly platformName: PlatformName;
    readonly engineDllName: string;
    readonly engineExecutableName: string;
}

export const IExtensionSingleActivationService = Symbol('IExtensionSingleActivationService');
/**
 * Classes implementing this interface will have their `activate` methods
 * invoked during the activation of the extension.
 * This is a great hook for extension activation code, i.e. you don't need to modify
 * the `extension.ts` file to invoke some code when extension gets activated.
 * @export
 * @interface IExtensionSingleActivationService
 */
export interface IExtensionSingleActivationService {
    activate(): Promise<void>;
}

export const IExtensionSyncActivationService = Symbol('IExtensionSyncActivationService');
/**
 * Classes implementing this interface will have their `activate` methods
 * invoked during the activation of the extension.
 * This is a great hook for extension activation code, i.e. you don't need to modify
 * the `extension.ts` file to invoke some code when extension gets activated.
 * Unlike `IExtensionSingleActivationService`, this is synchronous, & guaranteed to run before any other code.
 */
export interface IExtensionSyncActivationService {
    activate(): void;
}
