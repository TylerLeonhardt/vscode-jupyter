// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { injectable } from 'inversify';
import { InterpreterUri } from '../platform/common/types';
import { PythonEnvironment } from '../platform/pythonEnvironments/info';
import { IInterpreterPackages } from './types';

/**
 * Tracks packages in use for interpreters. In the web version this isn't implemented yet.
 */
@injectable()
export class InterpreterPackages implements IInterpreterPackages {
    public async getPackageVersions(_interpreter: PythonEnvironment): Promise<Map<string, string>> {
        return new Map<string, string>();
    }
    public async getPackageVersion(_interpreter: PythonEnvironment, _packageName: string): Promise<string | undefined> {
        return undefined;
    }
    public trackPackages(_interpreterUri: InterpreterUri, _ignoreCache?: boolean) {
        // Not supported yet
    }
}
