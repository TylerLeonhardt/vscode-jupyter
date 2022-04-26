// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import { inject, injectable } from 'inversify';
import { Uri, workspace } from 'vscode';
import { IApplicationShell, IWorkspaceService, IVSCodeNotebook } from '../platform/common/application/types';
import { IFileSystem } from '../platform/common/platform/types.node';
import { IPythonExecutionFactory } from '../platform/common/process/types.node';
import {
    IAsyncDisposableRegistry,
    IDisposableRegistry,
    IConfigurationService,
    IExtensionContext
} from '../platform/common/types';
import { CellHashProviderFactory } from '../interactive-window/editor-integration/cellHashProviderFactory';
import { InteractiveWindowView } from '../notebooks/constants';
import { CellOutputDisplayIdTracker } from '../notebooks/execution/cellDisplayIdTracker';
import { Kernel } from './kernel.node';
import { IKernel, INotebookProvider, KernelOptions } from './types';
import { IStatusProvider } from '../platform/progress/types';
import { BaseKernelProvider } from './kernelProvider.base';
import { getDisplayPath } from '../platform/common/platform/fs-paths';

@injectable()
export class KernelProvider extends BaseKernelProvider {
    constructor(
        @inject(IAsyncDisposableRegistry) asyncDisposables: IAsyncDisposableRegistry,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(INotebookProvider) private notebookProvider: INotebookProvider,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(IFileSystem) private readonly fs: IFileSystem,
        @inject(CellOutputDisplayIdTracker) private readonly outputTracker: CellOutputDisplayIdTracker,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(CellHashProviderFactory) private cellHashProviderFactory: CellHashProviderFactory,
        @inject(IVSCodeNotebook) notebook: IVSCodeNotebook,
        @inject(IPythonExecutionFactory) private readonly pythonExecutionFactory: IPythonExecutionFactory,
        @inject(IStatusProvider) private readonly statusProvider: IStatusProvider,
        @inject(IExtensionContext) private readonly context: IExtensionContext
    ) {
        super(asyncDisposables, disposables, notebook);
    }

    public getOrCreate(uri: Uri, options: KernelOptions): IKernel {
        const notebook = workspace.notebookDocuments.find((nb) => nb.uri.toString() === uri.toString());
        // If we're connecting to a live local kernel, then Uri will point to the Uri of the original kernel.
        if (options.metadata.kind === 'connectToLiveLocalKernel') {
            const kernelId = options.metadata.kernelId;
            const kernel = this.kernels.find((item) => item.id.toString() === kernelId.toString());
            if (!kernel) {
                throw new Error(`Could not find kernel with id: ${getDisplayPath(kernelId)}`);
            }
            // kernel.connectedResourceUris.add(uri.toString());
            return kernel;
        }
        const existingKernelInfo = this.getInternal(uri);
        if (existingKernelInfo && existingKernelInfo.options.metadata.id === options.metadata.id) {
            return existingKernelInfo.kernel;
        }
        this.disposeOldKernel(uri);

        const resourceUri = notebook?.notebookType === InteractiveWindowView ? options.resourceUri : uri;
        const waitForIdleTimeout = this.configService.getSettings(resourceUri).jupyterLaunchTimeout;
        const interruptTimeout = this.configService.getSettings(resourceUri).jupyterInterruptTimeout;
        const kernel = new Kernel(
            uri,
            resourceUri,
            options.metadata,
            this.notebookProvider,
            this.disposables,
            waitForIdleTimeout,
            interruptTimeout,
            this.appShell,
            this.fs,
            options.controller,
            this.configService,
            this.outputTracker,
            this.cellHashProviderFactory,
            this.workspaceService,
            this.pythonExecutionFactory,
            this.statusProvider,
            options.creator,
            this.context
        );
        // kernel.connectedResourceUris.add(uri.toString());
        kernel.onRestarted(() => this._onDidRestartKernel.fire(kernel), this, this.disposables);
        kernel.onDisposed(() => this._onDidDisposeKernel.fire(kernel), this, this.disposables);
        kernel.onStarted(() => this._onDidStartKernel.fire(kernel), this, this.disposables);
        kernel.onStatusChanged(
            (status) => this._onKernelStatusChanged.fire({ kernel, status }),
            this,
            this.disposables
        );
        this.asyncDisposables.push(kernel);
        if (notebook) {
            this.kernelsByNotebook.set(notebook, { options, kernel });
        } else {
            this.kernelsByUri.set(uri.toString(), { options, kernel });
        }
        this.deleteMappingIfKernelIsDisposed(uri, kernel);
        return kernel;
    }
}
