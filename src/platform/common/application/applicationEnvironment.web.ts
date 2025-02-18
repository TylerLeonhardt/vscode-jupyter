// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { injectable } from 'inversify';
import { Uri } from 'vscode';
import { BaseApplicationEnvironment } from './applicationEnvironment.base';

@injectable()
export class ApplicationEnvironment extends BaseApplicationEnvironment {
    public get userSettingsFile(): Uri | undefined {
        return undefined;
    }
    public get userCustomKeybindingsFile(): Uri | undefined {
        return undefined;
    }
}
